/**
 * /api/reports (owner, 2026-10-15) — bugs and requests about Kaizen itself.
 * Every member sends and follows their own; who holds Settings sees them all and
 * moves them along (new → seen → in progress → done / won't do).
 *   GET              → the list (own, or all for Settings), with comments
 *   GET ?photo=<id>  → a report's photo
 *   POST {action:'create'|'status'|'comment', …}
 * Slack hears about it after the answer (waitUntil), never failing it.
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { can } from '../_lib/roles.ts';
import { postReport, reportCommentToSlack, reportStatusToSlack } from '../_lib/report-slack.ts';
import { readReport, REPORT_STATUSES, type ReportStatus } from '../../src/lib/reports.ts';

const bad = (message: string, status = 400) => Response.json({ ok: false, message }, { status });
/** A photo is resized in the browser first; this is the ceiling, not the expectation. */
const MAX_PHOTO = 1_500_000;

async function who(request: Request, env: Env, sql: SqlFn) {
  const id = identify(request, env);
  if (!id) return null;
  const access = await accessOf(sql, id);
  return { email: id.email.trim().toLowerCase(), all: can(access.permissions, 'settings') };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;
  const me = await who(request, env, sql);
  if (!me) return unauthorised();
  const photo = new URL(request.url).searchParams.get('photo');
  if (photo) {
    const [p] = await sql`SELECT encode(photo, 'base64') AS b64, photo_type, reporter FROM reports
                           WHERE account_id = 1 AND id::text = ${photo} AND photo IS NOT NULL` as { b64: string; photo_type: string; reporter: string }[];
    if (!p || (!me.all && p.reporter !== me.email)) return new Response('No such photo.', { status: 404 });
    const bytes = Uint8Array.from(atob(p.b64.replace(/\s/g, '')), c => c.charCodeAt(0));
    return new Response(bytes, { headers: { 'Content-Type': p.photo_type || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
  }
  const rows = await sql`SELECT r.id::text, r.kind, r.body, r.urgency, r.status, r.where_from, r.device, r.source, r.reporter,
                                r.photo IS NOT NULL AS has_photo, r.created_at, r.updated_at,
                                COALESCE((SELECT json_agg(json_build_object('body', c.body, 'author', c.author, 'createdAt', c.created_at) ORDER BY c.created_at)
                                            FROM report_comments c WHERE c.report_id = r.id), '[]') AS comments
                           FROM reports r WHERE r.account_id = 1 AND (${me.all} OR r.reporter = ${me.email})
                          ORDER BY (r.status IN ('done', 'wontfix')), r.created_at DESC LIMIT 300` as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  return Response.json({ ok: true, all: me.all, me: me.email, reports: rows.map(r => ({
    id: r.id, kind: r.kind, body: r.body, urgency: r.urgency, status: r.status, whereFrom: r.where_from, device: r.device,
    source: r.source, reporter: r.reporter, hasPhoto: r.has_photo, createdAt: r.created_at, updatedAt: r.updated_at, comments: r.comments })) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const sql = db(env) as unknown as SqlFn;
  const me = await who(request, env, sql);
  if (!me) return unauthorised();
  const b = await request.json().catch(() => ({})) as Record<string, unknown>;

  if (b.action === 'create') {
    const r = readReport(b);
    if ('error' in r) return bad(r.error);
    // A photo: a data URL from the app, or bytes Slack's form already fetched (base64, same shape).
    let hex: string | null = null, type: string | null = null;
    const m = typeof b.photo === 'string' ? /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(b.photo) : null;
    if (m) {
      const bin = atob(m[2]!);
      if (bin.length > MAX_PHOTO) return bad('That photo is too big (1.5 MB at most).');
      hex = [...bin].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
      type = m[1]!;
    }
    const source = b.source === 'slack' ? 'slack' : 'app';
    const slackUser = typeof b.slackUser === 'string' ? b.slackUser : null;
    const [row] = await sql`INSERT INTO reports (account_id, kind, body, urgency, where_from, device, source, reporter, slack_user, photo, photo_type)
                            VALUES (1, ${r.kind}, ${r.body}, ${r.urgency}, ${r.whereFrom ?? null}, ${r.device ?? null}, ${source}, ${me.email}, ${slackUser},
                                    decode(${hex}, 'hex'), ${type})
                            RETURNING id::text` as { id: string }[];
    const thread = b.thread as { channel: string; ts: string } | undefined;
    waitUntil(postReport(sql, env.ENCRYPTION_KEY, row!.id, thread?.channel && thread.ts ? thread : undefined).catch(() => {}));
    return Response.json({ ok: true, id: row!.id });
  }

  const id = String(b.id ?? '');
  const [rep] = await sql`SELECT reporter, status FROM reports WHERE account_id = 1 AND id::text = ${id}` as { reporter: string; status: ReportStatus }[];
  if (!rep) return bad('No such report.', 404);

  if (b.action === 'status') {
    if (!me.all) return bad('Only who holds Settings moves a report along.', 403);
    const status = REPORT_STATUSES.find(s => s === b.status);
    if (!status) return bad('Which status?');
    if (status === rep.status) return Response.json({ ok: true, unchanged: true });
    await sql`UPDATE reports SET status = ${status}, updated_at = now() WHERE account_id = 1 AND id::text = ${id}`;
    if (b.via !== 'slack-message') waitUntil(reportStatusToSlack(sql, env.ENCRYPTION_KEY, id, status, me.email).catch(() => {}));
    return Response.json({ ok: true });
  }

  if (b.action === 'comment') {
    if (!me.all && rep.reporter !== me.email) return bad('Not your report.', 403);
    const body = String(b.body ?? '').trim().slice(0, 3000);
    if (!body) return bad('Write something.');
    await sql`INSERT INTO report_comments (report_id, body, author) VALUES (${id}::bigint, ${body}, ${me.email})`;
    await sql`UPDATE reports SET updated_at = now() WHERE id::text = ${id}`;
    // A comment that came from the Slack thread is already there.
    if (b.via !== 'slack-thread') waitUntil(reportCommentToSlack(sql, env.ENCRYPTION_KEY, id, body, me.email).catch(() => {}));
    return Response.json({ ok: true });
  }
  return bad('What should happen?');
};
