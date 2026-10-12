/**
 * /api/inventory — supplies per unit and in storage (§134).
 *
 *   GET                                               every place: stock, use per clean, coming cleans, to order
 *   POST { action: 'move', kind, itemId, unitId?, qty, note?, cost? }    (multipart with photos too)
 *   POST { action: 'count', unitId?, counts: [{ itemId, qty }] }        a count of a place — reconciles it
 *   POST { action: 'order', lines: [{ itemId, unitId?, qty }] }         ONE to-do, a line per item
 *
 * GET with `operations`, POST with `operations.edit` (roles.ts). To-dos made
 * here are mirrored to Hostaway after the response.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { createOrder, fieldPhotos, mirrorTodos, overview, recordMove } from '../_lib/inventory.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  return Response.json({ ok: true, ...(await overview(db(env) as unknown as SqlFn)) }, { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const me = { name: who.email, email: who.email, source: 'team' as const };
  try {
    let b: Record<string, unknown> = {};
    let files: File[] = [];
    if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
      const form = await request.formData();
      for (const [k, v] of form.entries()) { if (k === 'file') { if (typeof v !== 'string') files.push(v); } else b[k] = v; }
    } else b = await request.json().catch(() => ({})) as Record<string, unknown>;

    if (b.action === 'move') {
      const photos = await fieldPhotos(sql, env.ENCRYPTION_KEY, files, `inventory ${String(b.kind)}`);
      const r = await recordMove(sql, me, b, photos);
      waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [r.todoId], who.email));
    } else if (b.action === 'count') {
      const counts = Array.isArray(b.counts) ? b.counts as { itemId: unknown; qty: unknown }[] : [];
      const given = counts.filter(c => c.qty !== '' && c.qty != null);
      if (!given.length) return bad('Count at least one item.');
      for (const c of given) await recordMove(sql, me, { kind: 'count', itemId: c.itemId, unitId: b.unitId, qty: c.qty, note: b.note });
    } else if (b.action === 'order') {
      const lines = Array.isArray(b.lines) ? (b.lines as { itemId: unknown; unitId: unknown; qty: unknown }[])
        .map(l => ({ itemId: String(l.itemId), unitId: l.unitId ? String(l.unitId) : null, qty: Number(l.qty) || 0 })) : [];
      const id = await createOrder(sql, who.email, lines);
      waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [id], who.email));
      return Response.json({ ok: true, todoId: id, ...(await overview(sql)) });
    } else {
      return bad('Unknown action.');
    }
    return Response.json({ ok: true, ...(await overview(sql)) });
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
