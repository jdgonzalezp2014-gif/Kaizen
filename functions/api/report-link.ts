/**
 * /api/report-link — the person helping on one clean reports from the field,
 * no account (§134). The cleaner shares the link from that clean's Options;
 * whoever holds it can report for THAT clean — its unit and day are fixed by
 * the link, never sent by the page — and read nothing else.
 *
 *   GET                       the clean (unit, day, until when), the cleaner's name and language, the supplies
 *   POST { kind: taken, reporter, lines: [{ itemId, qty }] }         what was taken from the storage, all at once
 *   POST { kind: nothing, reporter }                                   nothing was taken (the step is required)
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
 *
 * §135: the same door answers an inspector's link — a request with
 * `X-Inspect-Token` instead goes to inspect-link.ts, so no new path needs a bypass. And `?bank=` is a
 * payee's bank form for Wise (owner, 2026-10-28; payouts.ts `bankLink`).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { namedLines, sha256, strip } from '../_lib/crew.ts';
import { accessByUnit } from '../_lib/unit-access.ts';
import { esMessage, fieldPhotos, fieldTodo, invItems, lowStock, mirrorTodos, nothingTaken, ranOut, recordMove, recordUses } from '../_lib/inventory.ts';
import { todayIn } from '../../src/lib/dates.ts';
import { tellCleanThread } from '../_lib/clean-slack.ts';
import { tellCleaner } from '../_lib/crew-slack.ts';
import type { HelperEvent } from '../../src/lib/crew-slack.ts';
import { addPhotos, cleanStates, ensureRecord, markClean, type Stage } from '../_lib/clean-record.ts';
import { inspectGet, inspectPost } from '../_lib/inspect-link.ts';
import { workAct, workOfToken, workPage, workPhoto } from '../_lib/vendor-work.ts';
import { bankLink } from '../_lib/payouts.ts';

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
  if (request.headers.has('X-Inspect-Token')) return inspectGet(sql, request);
  // Owner, 2026-10-28: a cleaner's or handyman's bank form for Wise — the same public door, no new bypass.
  if (new URL(request.url).searchParams.has('bank')) return bankLink(sql, env.ENCRYPTION_KEY, request);
  // §137: a handyman's link for one work order — the same door, its own header.
  if (request.headers.has('X-Work-Token')) {
    const w = await workOfToken(sql, request);
    if (w instanceof Response) return w;
    const photo = new URL(request.url).searchParams.get('photo');
    if (photo) return workPhoto(sql, env.ENCRYPTION_KEY, w.id, photo);
    return Response.json({ ok: true, vendor: w.vendor, page: await workPage(sql, w.id) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const l = await linkOf(sql, request);
  if (l instanceof Response) return l;
  const items = (await invItems(sql)).filter(i => i.active && i.kind !== 'furniture').map(i => ({ id: i.id, name: i.name, measure: i.measure, category: i.category }));
  return Response.json({ ok: true, team: l.cleaner, lang: l.lang, items,
                         clean: { unit: l.unit_name, date: l.clean_date, until: l.expires_on },
                         state: (await cleanStates(sql, [l.cleaning_key], l.cleaner))[l.cleaning_key],
                         // §136: how to get in — only while this clean's link lasts (it closes 2 days after).
                         access: (a => a ? strip(a) : null)((await accessByUnit(sql)).get(l.unit_name)) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const sql = db(env) as unknown as SqlFn;
  if (request.headers.has('X-Inspect-Token')) return inspectPost(sql, env.ENCRYPTION_KEY, request);
  if (new URL(request.url).searchParams.has('bank')) return bankLink(sql, env.ENCRYPTION_KEY, request);
  if (request.headers.has('X-Work-Token')) {
    const w = await workOfToken(sql, request);
    if (w instanceof Response) return w;
    let b: Record<string, unknown> = {};
    const files: File[] = [];
    if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
      const form = await request.formData();
      for (const [k, x] of form.entries()) { if (k === 'file') { if (typeof x !== 'string') files.push(x); } else b[k] = x; }
    } else b = await request.json().catch(() => ({})) as Record<string, unknown>;
    try { await workAct(sql, env.ENCRYPTION_KEY, w.id, { name: w.vendor, source: 'link' }, b, files, waitUntil); }
    catch (e) { return bad(e instanceof Error ? e.message : String(e)); }
    return Response.json({ ok: true, page: await workPage(sql, w.id) });
  }
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
    // §134: the cleaner hears what their helper did, in their own channel (if they have one and it is on).
    const tell = (e: { kind: HelperEvent['kind'] } & Record<string, unknown>, photosKey?: string, todoId?: string | null) =>
      waitUntil(tellCleaner(sql, env.ENCRYPTION_KEY, l.cleaner, { by: reporter, unit: l.unit_name, ...e } as HelperEvent, photosKey, todoId));
    if (b.kind === 'photo') {
      const stage = String(b.stage) as Stage;
      await addPhotos(sql, env.ENCRYPTION_KEY, l.cleaning_key, stage, files, { name: who.name, source: 'link' });
      waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, l.cleaning_key, { kind: 'photos', stage, by: who.name }));
      // One growing line per clean and stage; it names every helper who sent photos for it.
      const helpers = (await sql`SELECT by_name FROM clean_photos WHERE account_id = 1 AND cleaning_key = ${l.cleaning_key} AND stage = ${stage}
                                   AND source = 'link' GROUP BY by_name ORDER BY min(id)` as { by_name: string }[])
        .map(r => r.by_name.replace(/^.*'s team: /, ''));
      tell({ kind: 'photos', stage, n: helpers.length ? (await sql`SELECT count(*)::int AS n FROM clean_photos WHERE account_id = 1
             AND cleaning_key = ${l.cleaning_key} AND stage = ${stage} AND source = 'link'` as { n: number }[])[0]!.n : 0,
             by: helpers.join(', ') }, `photos:${l.cleaning_key}:${stage}`);
    } else if (b.kind === 'done' || b.kind === 'reopened') {
      if (await markClean(sql, l.cleaning_key, b.kind, { name: who.name, source: 'link' }, l.cleaner)) {
        waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, l.cleaning_key, { kind: b.kind }));
        tell({ kind: b.kind });
      }
    } else if (b.kind === 'problem' || b.kind === 'request') {
      const photos = await fieldPhotos(sql, env.ENCRYPTION_KEY, files, `${l.unit_name} ${String(b.kind)}`);
      const { todoId: id, fresh } = await fieldTodo(sql, who, b, photos);
      waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [id], who.name, fresh));
      waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, l.cleaning_key, { kind: 'event', by: who.name, event: {
        kind: 'report', what: b.kind, text: String(b.text ?? '').trim().slice(0, 300), priority: String(b.priority ?? '') || null, todoId: id } }));
      tell({ kind: 'report', what: String(b.kind), text: String(b.text ?? '').trim().slice(0, 300), priority: String(b.priority ?? '') || null }, undefined, id);
    } else if (b.kind === 'taken' || b.kind === 'used') {
      const out = await ranOut(sql, who, l.cleaning_key, l.unit_id, b.out);
      if (out) waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [out.todoId], who.name, out.fresh));
      const used = await recordUses(sql, who, b);
      waitUntil(lowStock(sql, [used.place]).then(ids => mirrorTodos(sql, env.ENCRYPTION_KEY, ids, 'Kaizen')).catch(() => {}));
      const lines = await namedLines(sql, b.lines);
      tell({ kind: 'taken', lines });
      waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, l.cleaning_key, { kind: 'event', by: who.name, event: { kind: 'taken', lines } }));
    } else if (b.kind === 'nothing') {
      const out = await ranOut(sql, who, l.cleaning_key, l.unit_id, b.out);
      if (out) waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [out.todoId], who.name, out.fresh));
      await nothingTaken(sql, who, l.cleaning_key);
      tell({ kind: 'nothing' });
      waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, l.cleaning_key, { kind: 'event', by: who.name, event: { kind: 'nothing' } }));
    } else if (b.kind === 'purchase') {
      // §141: money spent is the cleaner's to report, from their own page — a helper's link only says what is missing.
      return bad(es ? 'Las compras las reporta la limpiadora desde su página.' : "Purchases are reported by the cleaner, from their own page.");
    } else if (b.kind === 'missing') {
      const photos = await fieldPhotos(sql, env.ENCRYPTION_KEY, files, `${l.unit_name} ${String(b.kind)}`);
      const r = await recordMove(sql, who, b, photos);
      waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [r.todoId], who.name, r.fresh));
      const text = b.kind === 'missing' ? `${r.item} (found ${Number(b.qty) || 0})` : `${r.item} × ${Number(b.qty) || 0}`;
      tell({ kind: 'report', what: String(b.kind), text }, undefined, r.todoId);
      waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, l.cleaning_key, { kind: 'event', by: who.name, event: {
        kind: 'report', what: b.kind, text, todoId: r.todoId } }));
    } else return bad('Unknown report.');
    return Response.json({ ok: true, state: (await cleanStates(sql, [l.cleaning_key], l.cleaner))[l.cleaning_key] });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return bad(es ? esMessage(m) : m);
  }
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
