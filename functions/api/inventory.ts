/**
 * /api/inventory — supplies by place (§134, §150): the Repository's storages and the houses' closets.
 *
 *   GET                                               every place: stock, average per clean, what its units need, to order
 *   POST { action: 'count', place, counts: [{ itemId, qty }], look? } (+ photos)  a count of a place — reconciles it;
 *        photos and `look` (a note) say how the storage looked — either alone is fine, without counting
 *   POST { action: 'settings', place, items: [{ itemId, name?, measure?, perClean?, min? }] }   edit settings, one save
 *   POST { action: 'removeItem', itemId }                               off the list everywhere (history kept)
 *   POST { action: 'adjusts', place, note, adjusts: [{ itemId, qty }] } corrections (+/−) to the record, with why
 *   POST { action: 'draft', lines, forTodo? }                           the order kept as a draft (no lines = discard)
 *   POST { action: 'todoOrder', todoId, lines }                         a to-do's own order, saved as a draft (replaces it)
 *   POST { action: 'paidBack', id }                                     a purchase someone paid, paid back to them
 *   POST { action: 'hide', place, itemId, hide }                        "not kept here" (or back)
 *   POST { action: 'newItem', name, measure?, category? }               a supply added on the spot
 * A count, a correction or a take may leave a place below its minimum → "Low stock" to-do, if Setup has it on.
 *   POST { action: 'order', lines: [{ itemId, place, qty }], forTodo? }  the ORDER: ONE to-do (or onto a field to-do), a line per item
 *   POST { action: 'purchase', lines, total, todoId?, note?, paidBy?, date? } + receipt  what was BOUGHT: stock per place + one Restock expense
 *   POST { action: 'purchase', splits: [{ todoId?, lines, total }], … } + receipt  one receipt, several orders: a purchase each
 *   POST { action: 'readRequest', text }   ✨ build the cart from what was asked — nothing saved (§159)
 *   POST { action: 'readReceipt', orders? } + receipt (or fieldExpenseId)   ✨ the AI reads it — the form is filled in, nothing saved
 *        (a purchase's `aliases` [{ text, itemId }] = receipt lines a person decided: learned for the next receipt)
 *   POST { action: 'newItem', name, size?, … }                         a supply added on the spot (also from a receipt line)
 *
 * GET with `operations`, POST with `operations.edit` (roles.ts). To-dos made
 * here are mirrored to Hostaway after the response.
 */
import { db, type Env } from '../_lib/db.ts';
import { commentToThread } from '../_lib/slack.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { createOrder, fieldPhotos, recordLook, hideItem, lowStock, mirrorTodos, newItem, overview, paidBack, recordMove, recordPurchase, recordPurchases, removeItem, saveDraft, saveSettings, saveTodoOrder } from '../_lib/inventory.ts';
import { learnAliases, readReceiptFiles, receiptFiles } from '../_lib/receipt-read.ts';
import { readRequestText } from '../_lib/request-read.ts';

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
      // Multipart (with photos) sends the counts as JSON text.
      const raw = typeof b.counts === 'string' ? JSON.parse(b.counts) as unknown : b.counts;
      const counts = Array.isArray(raw) ? raw as { itemId: unknown; qty: unknown }[] : [];
      const given = counts.filter(c => c.qty !== '' && c.qty != null);
      const look = String(b.look ?? '').trim();
      if (!given.length && !files.length && !look) return bad('Count at least one item, or add a photo or a note.');
      const photos = await fieldPhotos(sql, env.ENCRYPTION_KEY, files, `storage ${String(b.place ?? '')}`);
      await recordLook(sql, who.email, b.place, look, photos, given.length);
      for (const c of given) await recordMove(sql, me, { kind: 'count', itemId: c.itemId, place: b.place, qty: c.qty, note: b.note });
      waitUntil(lowStock(sql, [String(b.place ?? '')]).then(ids => mirrorTodos(sql, env.ENCRYPTION_KEY, ids, who.email)).catch(() => {}));
    } else if (b.action === 'readRequest') {
      // §159: ✨ Build the cart — the AI reads what was asked; nothing is saved.
      const r = await readRequestText(sql, env, String(b.text ?? ''));
      return Response.json(r.ok ? r : { ok: false, error: 'unreadable', message: r.message });
    } else if (b.action === 'readReceipt') {
      // Owner, 2026-10-14: the AI only fills the form in — this saves nothing.
      const r = await readReceiptFiles(sql, env, await receiptFiles(sql, env, files, b.fieldExpenseId), b.orders !== 'no');
      return Response.json(r.ok ? r : { ok: false, error: 'unreadable', message: r.message });
    } else if (b.action === 'purchase') {
      // One receipt for several orders: uploaded once, every part checked before any is saved, a purchase per order.
      const split = typeof b.splits === 'string' && b.splits !== '';
      const photos = await fieldPhotos(sql, env.ENCRYPTION_KEY, files, 'inventory purchase');
      const todoIds = split ? (await recordPurchases(sql, who.email, b, photos)).todoIds
                            : (await recordPurchase(sql, who.email, b, photos), b.todoId ? [String(b.todoId)] : []);
      await learnAliases(sql, who.email, b.aliases).catch(() => {});
      // Owner, Oct 2026: an order's news is told in its to-do's Slack thread — what was bought, and for how much.
      for (const id of todoIds) {
        const [n] = await sql`SELECT body FROM work_updates WHERE account_id = 1 AND subject = 'task' AND subject_id = ${id} AND kind = 'note'
                               ORDER BY id DESC LIMIT 1` as { body: string }[];
        if (n) waitUntil(commentToThread(sql, env.ENCRYPTION_KEY, 'task', id, `🧾 ${n.body}${b.note ? `\n— ${String(b.note)}` : ''}`, who.email).catch(() => {}));
      }
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
      // Added from a place: kept there, even if it was "not kept here" before.
      if (b.place) await hideItem(sql, who.email, b.place, id, false);
      return Response.json({ ok: true, itemId: id, ...(await overview(sql)) });
    } else if (b.action === 'paidBack') {
      await paidBack(sql, who.email, b.id);
    } else if (b.action === 'todoOrder') {
      const lines = Array.isArray(b.lines) ? (b.lines as { itemId: unknown; place: unknown; qty: unknown }[])
        .map(l => ({ itemId: String(l.itemId), place: String(l.place ?? ''), qty: Number(l.qty) || 0 })) : [];
      const said = await saveTodoOrder(sql, who.email, b.todoId, lines);
      if (said) waitUntil(commentToThread(sql, env.ENCRYPTION_KEY, 'task', String(b.todoId), `🛒 ${said.replace(/^Order draft saved/, 'Purchase order saved')}`, who.email).catch(() => {}));
    } else if (b.action === 'draft') {
      // §150: the order kept as a draft — no to-do until it is created; no lines = discard it.
      const lines = Array.isArray(b.lines) ? (b.lines as { itemId: unknown; place: unknown; qty: unknown }[])
        .map(l => ({ itemId: String(l.itemId), place: String(l.place ?? ''), qty: Number(l.qty) || 0 })) : [];
      await saveDraft(sql, who.email, lines, b.forTodo ? String(b.forTodo) : null);
    } else if (b.action === 'settings') {
      await saveSettings(sql, who.email, b.place, b.items);
      waitUntil(lowStock(sql, [String(b.place ?? '')]).then(ids => mirrorTodos(sql, env.ENCRYPTION_KEY, ids, who.email)).catch(() => {}));
    } else if (b.action === 'removeItem') {
      await removeItem(sql, b.itemId);
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
