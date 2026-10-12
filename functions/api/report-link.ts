/**
 * /api/report-link — a cleaner's team reporting from the field, no account (§134).
 * The link a cleaner shares (WhatsApp, copy) carries a secret; whoever holds it
 * can report for that cleaner's team, and nothing else: read nothing private,
 * change nothing but add reports.
 *
 *   GET                       the team's name, its language, the supplies and the units
 *   POST { kind: used|purchase|missing, reporter, itemId, unitId?, qty, note?, cost? }
 *   POST { kind: problem|request, reporter, text, unitId? }
 *   (multipart for photos)
 *
 * Behind a Cloudflare Access BYPASS (with /report and /assets/*), so it reads
 * no identity header: the `X-Report-Token` secret is the only credential,
 * matched by its SHA-256. SELF_AUTHENTICATING in the middleware.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { sha256 } from '../_lib/crew.ts';
import { activeUnits, esMessage, fieldPhotos, fieldTodo, invItems, mirrorTodos, recordMove } from '../_lib/inventory.ts';

async function team(sql: SqlFn, request: Request) {
  const token = request.headers.get('X-Report-Token') ?? '';
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const [c] = await sql`SELECT name, lang FROM cleaners WHERE account_id = 1 AND active AND report_token_hash = ${await sha256(token)}` as
    { name: string; lang: 'en' | 'es' }[];
  return c ?? null;
}
const gone = () => Response.json({ ok: false, error: 'bad_link',
  message: 'This link is not valid any more — ask for a new one. / Este enlace ya no es válido — pide uno nuevo.' }, { status: 403 });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;
  const t = await team(sql, request);
  if (!t) return gone();
  const items = (await invItems(sql)).filter(i => i.active).map(i => ({ id: i.id, name: i.name, measure: i.measure, category: i.category }));
  return Response.json({ ok: true, team: t.name, lang: t.lang, items, units: await activeUnits(sql) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const sql = db(env) as unknown as SqlFn;
  const t = await team(sql, request);
  if (!t) return gone();
  const es = t.lang === 'es';
  try {
    let b: Record<string, unknown> = {};
    let files: File[] = [];
    if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
      const form = await request.formData();
      for (const [k, v] of form.entries()) { if (k === 'file') { if (typeof v !== 'string') files.push(v); } else b[k] = v; }
    } else b = await request.json().catch(() => ({})) as Record<string, unknown>;
    const reporter = String(b.reporter ?? '').trim().slice(0, 60);
    if (!reporter) return bad(es ? 'Escribe tu nombre.' : 'Your name, please.');
    const who = { name: `${t.name}'s team: ${reporter}`, source: 'link' as const };
    const photos = await fieldPhotos(sql, env.ENCRYPTION_KEY, files, `${t.name} team ${String(b.kind)}`);
    if (b.kind === 'problem' || b.kind === 'request') {
      const id = await fieldTodo(sql, who, b, photos);
      waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [id]));
    } else if (b.kind === 'used' || b.kind === 'purchase' || b.kind === 'missing') {
      const r = await recordMove(sql, who, b, photos);
      waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [r.todoId]));
    } else return bad('Unknown report.');
    return Response.json({ ok: true });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return bad(es ? esMessage(m) : m);
  }
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
