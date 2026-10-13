/**
 * /api/inventory — supplies by place (§134, §150): the Repository's storages and the houses' closets.
 *
 *   GET                                               every place: stock, average per clean, what its units need, to order
 *   POST { action: 'count', place, counts: [{ itemId, qty }] }          a count of a place — reconciles it
 *   POST { action: 'mins', place, mins: [{ itemId, qty }] }             the minimum to keep there ('' = the item's)
 *   POST { action: 'adjusts', place, note, adjusts: [{ itemId, qty }] } corrections (+/−) to the record, with why
 *   POST { action: 'draft', lines, forTodo? }                           the order kept as a draft (no lines = discard)
 *   POST { action: 'hide', place, itemId, hide }                        "not kept here" (or back)
 *   POST { action: 'newItem', name, measure?, category? }               a supply added on the spot
 * A count, a correction or a take may leave a place below its minimum → "Low stock" to-do, if Setup has it on.
 *   POST { action: 'order', lines: [{ itemId, place, qty }], forTodo? }  the ORDER: ONE to-do (or onto a field to-do), a line per item
 *   POST { action: 'purchase', lines, total, todoId?, note? } + receipt  what was BOUGHT: stock per place + one Restock expense
 *
 * GET with `operations`, POST with `operations.edit` (roles.ts). To-dos made
 * here are mirrored to Hostaway after the response.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { createOrder, fieldPhotos, hideItem, lowStock, mirrorTodos, newItem, overview, recordMove, recordPurchase, saveDraft, setMins } from '../_lib/inventory.ts';

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

    if (b.action === 'count') {
      const counts = Array.isArray(b.counts) ? b.counts as { itemId: unknown; qty: unknown }[] : [];
      const given = counts.filter(c => c.qty !== '' && c.qty != null);
      if (!given.length) return bad('Count at least one item.');
      for (const c of given) await recordMove(sql, me, { kind: 'count', itemId: c.itemId, place: b.place, qty: c.qty, note: b.note });
      waitUntil(lowStock(sql, [String(b.place ?? '')]).then(ids => mirrorTodos(sql, env.ENCRYPTION_KEY, ids, who.email)).catch(() => {}));
    } else if (b.action === 'purchase') {
      const photos = await fieldPhotos(sql, env.ENCRYPTION_KEY, files, 'inventory purchase');
      await recordPurchase(sql, who.email, b, photos);
    } else if (b.action === 'adjusts') {
      // §150: − / + on "On record", saved together with why.
      const list = Array.isArray(b.adjusts) ? (b.adjusts as { itemId: unknown; qty: unknown }[]).filter(a => Number(a.qty)) : [];
      if (!list.length) return bad('Nothing to correct.');
      if (!String(b.note ?? '').trim()) return bad('Say why it is corrected.');
      for (const a of list) await recordMove(sql, me, { kind: 'adjust', itemId: a.itemId, place: b.place, qty: a.qty, note: b.note });
      waitUntil(lowStock(sql, [String(b.place ?? '')]).then(ids => mirrorTodos(sql, env.ENCRYPTION_KEY, ids, who.email)).catch(() => {}));
    } else if (b.action === 'hide') {
      await hideItem(sql, who.email, b.place, b.itemId, b.hide !== false);
    } else if (b.action === 'newItem') {
      const id = await newItem(sql, b);
      return Response.json({ ok: true, itemId: id, ...(await overview(sql)) });
    } else if (b.action === 'draft') {
      // §150: the order kept as a draft — no to-do until it is created; no lines = discard it.
      const lines = Array.isArray(b.lines) ? (b.lines as { itemId: unknown; place: unknown; qty: unknown }[])
        .map(l => ({ itemId: String(l.itemId), place: String(l.place ?? ''), qty: Number(l.qty) || 0 })) : [];
      await saveDraft(sql, who.email, lines, b.forTodo ? String(b.forTodo) : null);
    } else if (b.action === 'mins') {
      await setMins(sql, who.email, b.place, Array.isArray(b.mins) ? b.mins as { itemId: unknown; qty: unknown }[] : []);
    } else if (b.action === 'order') {
      const lines = Array.isArray(b.lines) ? (b.lines as { itemId: unknown; place: unknown; qty: unknown }[])
        .map(l => ({ itemId: String(l.itemId), place: String(l.place ?? ''), qty: Number(l.qty) || 0 })) : [];
      const o = await createOrder(sql, who.email, lines, b.forTodo ? String(b.forTodo) : null);
      waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [o.id], who.email, o.fresh));
      return Response.json({ ok: true, todoId: o.id, ...(await overview(sql)) });
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
