/**
 * /api/report-link — the person helping on one clean reports from the field,
 * no account (§134). The cleaner shares the link from that clean's Options;
 * whoever holds it can report for THAT clean — its unit and day are fixed by
 * the link, never sent by the page — and read nothing else.
 *
 *   GET                       the clean (unit, day, until when), the cleaner's name and language, the supplies
 *   POST { kind: used, reporter, lines: [{ itemId, qty }] }          what was taken, all at once
 *   POST { kind: purchase|missing, reporter, itemId, qty, note?, cost? }
 *   POST { kind: problem|request, reporter, text }
 *   POST { kind: photo, stage: before|after, reporter } + one or more photos     to the clean's Drive folder
 *   POST { kind: done|reopened, reporter }                                         done needs an AFTER photo
 *   (multipart for photos)
 *
 * Refused once the link expires (two days after the clean), when the clean
 * is no longer that cleaner's, or the cleaner is inactive. Behind a
 * Cloudflare Access BYPASS (with /report and /assets/*), so it reads no
 * identity header: the `X-Report-Token` secret is the only credential,
 * matched by its SHA-256. SELF_AUTHENTICATING in the middleware.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { sha256 } from '../_lib/crew.ts';
import { esMessage, fieldPhotos, fieldTodo, invItems, mirrorTodos, recordMove, recordUses } from '../_lib/inventory.ts';
import { todayIn } from '../../src/lib/dates.ts';
import { tellCleanThread } from '../_lib/clean-slack.ts';
import { addPhotos, cleanStates, ensureRecord, markClean, type Stage } from '../_lib/clean-record.ts';

interface Link { cleaner: string; lang: 'en' | 'es'; cleaning_key: string; unit_id: string | null; unit_name: string; clean_date: string; expires_on: string }

async function linkOf(sql: SqlFn, request: Request): Promise<Link | Response> {
  const token = request.headers.get('X-Report-Token') ?? '';
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return gone();
  const [l] = await sql`
    SELECT l.cleaner, c.lang, l.cleaning_key, l.unit_id, l.unit_name, l.clean_date::text, l.expires_on::text
      FROM clean_links l JOIN cleaners c ON c.account_id = l.account_id AND c.name = l.cleaner AND c.active
     WHERE l.account_id = 1 AND l.token_hash = ${await sha256(token)}` as Link[];
  if (!l) return gone();
  if (l.expires_on < todayIn('America/New_York')) return gone(true);
  // Given to someone else, or cancelled, since it was shared: the helper is not on it any more.
  const [rec] = await sql`SELECT cleaner, void_reason FROM cleanings WHERE account_id = 1 AND key = ${l.cleaning_key}` as
    { cleaner: string | null; void_reason: string | null }[];
  if (rec && (rec.void_reason || (rec.cleaner && rec.cleaner !== l.cleaner))) return gone(true);
  await ensureRecord(sql, { key: l.cleaning_key, cleaner: l.cleaner, unitId: l.unit_id, unitName: l.unit_name, date: l.clean_date });
  return l;
}
const gone = (ended = false) => Response.json({ ok: false, error: 'bad_link', message: ended
  ? 'This clean is over or changed, so this link is closed. / Esta limpieza terminó o cambió, así que este enlace ya está cerrado.'
  : 'This link is not valid — ask for it again. / Este enlace no es válido — pídelo de nuevo.' }, { status: 403 });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;
  const l = await linkOf(sql, request);
  if (l instanceof Response) return l;
  const items = (await invItems(sql)).filter(i => i.active).map(i => ({ id: i.id, name: i.name, measure: i.measure, category: i.category }));
  return Response.json({ ok: true, team: l.cleaner, lang: l.lang, items,
                         clean: { unit: l.unit_name, date: l.clean_date, until: l.expires_on },
                         state: (await cleanStates(sql, [l.cleaning_key]))[l.cleaning_key] });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const sql = db(env) as unknown as SqlFn;
  const l = await linkOf(sql, request);
  if (l instanceof Response) return l;
  const es = l.lang === 'es';
  try {
    let b: Record<string, unknown> = {};
    const files: File[] = [];
    if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
      const form = await request.formData();
      for (const [k, v] of form.entries()) { if (k === 'file') { if (typeof v !== 'string') files.push(v); } else b[k] = v; }
    } else b = await request.json().catch(() => ({})) as Record<string, unknown>;
    const reporter = String(b.reporter ?? '').trim().slice(0, 60);
    if (!reporter) return bad(es ? 'Escribe tu nombre.' : 'Your name, please.');
    // The place is the link's, whatever the page sent.
    b = { ...b, unitId: l.unit_id, cleaningKey: l.cleaning_key };
    const who = { name: `${l.cleaner}'s team: ${reporter}`, source: 'link' as const };
    if (b.kind === 'photo') {
      const stage = String(b.stage) as Stage;
      await addPhotos(sql, env.ENCRYPTION_KEY, l.cleaning_key, stage, files, { name: who.name, source: 'link' });
      waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, l.cleaning_key, { kind: 'photos', stage }));
    } else if (b.kind === 'done' || b.kind === 'reopened') {
      if (await markClean(sql, l.cleaning_key, b.kind, { name: who.name, source: 'link' }))
        waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, l.cleaning_key, { kind: b.kind }));
    } else if (b.kind === 'problem' || b.kind === 'request') {
      const photos = await fieldPhotos(sql, env.ENCRYPTION_KEY, files, `${l.unit_name} ${String(b.kind)}`);
      const id = await fieldTodo(sql, who, b, photos);
      waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [id], who.name));
    } else if (b.kind === 'used') {
      await recordUses(sql, who, b);
    } else if (b.kind === 'purchase' || b.kind === 'missing') {
      const photos = await fieldPhotos(sql, env.ENCRYPTION_KEY, files, `${l.unit_name} ${String(b.kind)}`);
      const r = await recordMove(sql, who, b, photos);
      waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [r.todoId], who.name));
    } else return bad('Unknown report.');
    return Response.json({ ok: true, state: (await cleanStates(sql, [l.cleaning_key]))[l.cleaning_key] });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return bad(es ? esMessage(m) : m);
  }
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
