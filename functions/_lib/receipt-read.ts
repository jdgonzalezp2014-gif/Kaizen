/**
 * ✨ Read receipt (owner, 2026-10-14): a purchase's receipt — a photo or a PDF,
 * attached to the form or the cleaner's own from Drive — sent to the AI with the
 * supplies list and the open orders; its answer checked by `readReceipt`
 * (src/lib/receipt.ts) before the form sees it. Nothing is saved: the person
 * checks the filled-in form and records it with the usual button.
 */
import type { SqlFn } from './accounts.ts';
import type { Env } from './db.ts';
import { askJson, toBase64, type AiFile } from './ai-chain.ts';
import { driveToken, fileIdFromUrl } from './gdrive.ts';
import { invItems, openOrders } from './inventory.ts';
import { aliasKey, readReceipt, type Receipt } from '../../src/lib/receipt.ts';
import { parseOrderMd, readOrder, storeProduct, withProduct, type BuyOption } from '../../src/lib/store-order.ts';

// Gemini takes ~20 MB per request in all; base64 adds a third. A long screenshot arrives as several parts (the browser cuts it).
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_FILES = 12;

const SYSTEM = `You read store receipts for a short-term-rental cleaning company and match what was bought to its supplies list.
Answer ONLY JSON: {"store": string|null, "date": "YYYY-MM-DD"|null, "total": number|null, "tax": number|null, "orderNo": the order or invoice number printed (e.g. "2000156-31789057") or null,
"lines": [{"text": the product as printed (no price, no quantity), "qty": number|null, "unitPrice": number|null, "amount": number|null (the line's price, negative for a discount),
"kind": "item"|"tax"|"fee"|"discount"|"other", "itemId": a supply id or null, "sure": true|false, "itemQty": number|null,
"alternatives": [up to 4 supply ids], "orderId": an open order id or null,
"size": the size printed that tells products apart (King, Queen, Twin, Full, 13 gal, 30 gal…) or null — not a weight or a count,
"name": a short generic name for it as a supply (e.g. "Duvet cover set", "Mattress protector") — no brand, no size,
"measure": for a line with no sure supply, what it is counted in once opened (unit, pod, roll, bottle, kit, set, pair…) or null,
"furniture": true when it is the house's own thing (linens, towels, dishes, appliances, decor, hardware) rather than a consumable supply}]}.
Rules: one entry per purchased line; tax, bag fees, deposits, discounts and coupons are their own lines with their kind; subtotal/total/payment lines are NOT lines.
"itemId" + "sure": true ONLY when the line is clearly that same product (brand names are fine: "Bounty" = paper towels) —
a different product with a similar use (microfiber cloths vs washcloths) is NOT sure; a set of different things (a duvet cover set with
pillowcases) is NOT sure unless the list has that set; a supply with a size (shown after "—") is sure only for that same size. If unsure, "sure": false, "itemId" null,
and "alternatives" = the likely supplies. Never invent ids. "itemQty" = how many of the supply's own measure (a 12-pack of rolls bought once = 12 rolls).
"orderId" only when that order asks for that supply. "total" = what was paid in all, tax included.
Online orders (Walmart, Amazon — a PDF's text, a screenshot of the order page, or a long page cut into several images in order;
overlapping parts repeat a line: count it once): "amount" is the line's price AS PRINTED, which is the total for the line —
"Qty 4  $3.76" with "$0.94 ea" is 4 for $3.76 (qty 4, unitPrice 0.94, amount 3.76): never multiply it again.
"Multipack Quantity", "Count Per Pack", "42 Count", "4 Rolls", "40 Bags" tell "itemQty" in the supply's measure (qty × pack count).
"Subtotal (19 items)" = the sum of the quantities: check your lines against it. Ignore pickup, delivery, tracking, payment card,
store address, navigation and "how can we help" text. "date" = the day it was ordered or bought — never a pickup, delivery or
arrival date ("Pick up by Oct 19", "Arrives Monday"); null when the order date is not shown. "store" from the page too (walmart.com = Walmart).`;

/** `repeat`: this order (or these very files) was read before — the person checks it is not recorded twice. */
export type ReadResult = { ok: true; receipt: Receipt; by: string; repeat: { at: string; orderNo: string | null } | null } | { ok: false; message: string };

/** The receipt files the form sent, or a cleaner's purchase's own receipt from Drive. */
export async function receiptFiles(sql: SqlFn, env: Env, files: File[], fieldExpenseId?: unknown): Promise<AiFile[]> {
  const out: AiFile[] = [];
  let bytes = 0;
  const add = (mimeType: string, buf: ArrayBuffer) => {
    if (!/^(image\/|application\/pdf$)/.test(mimeType)) return;
    bytes += buf.byteLength;
    if (bytes > MAX_BYTES) throw new Error('The receipt is too big to read (12 MB at most).');
    out.push({ mimeType, data: toBase64(buf) });
  };
  for (const f of files.slice(0, MAX_FILES)) add(f.type, await f.arrayBuffer());
  if (!out.length && fieldExpenseId) {
    const [p] = await sql`SELECT photos FROM field_expenses WHERE account_id = 1 AND id = ${Number(fieldExpenseId) || 0}` as { photos: { url: string }[] | null }[];
    const ids = (p?.photos ?? []).map(x => fileIdFromUrl(x.url)).filter((x): x is string => !!x).slice(0, 5);
    if (ids.length) {
      const token = await driveToken(sql, env.ENCRYPTION_KEY);
      for (const id of ids) {
        const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
        if (r.ok) add((r.headers.get('Content-Type') ?? '').split(';')[0]!, await r.arrayBuffer());
      }
    }
  }
  return out;
}

/**
 * A cleaner's receipt photos (from Drive). The same files read again come from receipt_reads, not the AI; the
 * reading is re-checked against today's supplies. The team's Walmart/Amazon orders are Markdown: `readOrderMds`.
 */
export async function readReceiptFiles(sql: SqlFn, env: Env, files: AiFile[], withOrders: boolean): Promise<ReadResult> {
  if (!files.length) return { ok: false, message: 'Their receipt could not be found in Drive.' };
  const [items, orders, learned] = await Promise.all([invItems(sql), withOrders ? openOrders(sql) : Promise.resolve([]),
    sql`SELECT text, item_id::text AS "itemId" FROM inventory_receipt_aliases WHERE account_id = 1` as Promise<{ text: string; itemId: string }[]>]);
  const aliases = new Map(learned.map(a => [a.text, a.itemId]));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([files.map(f => f.data), []])));
  const hash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  const [seen] = await sql`SELECT raw, by, created_at::text AS at, order_no FROM receipt_reads WHERE account_id = 1 AND hash = ${hash}` as
    { raw: Record<string, unknown>; by: string; at: string; order_no: string | null }[];
  if (seen) {
    return { ok: true, receipt: readReceipt(seen.raw, items, orders, aliases), by: `${seen.by} — read before, not asked again`,
             repeat: { at: seen.at, orderNo: seen.order_no } };
  }
  const active = items.filter(i => i.active);
  const name = new Map(active.map(i => [i.id, i.name]));
  const user = `Supplies list (id | name | measure):\n${active.map(i => `${i.id} | ${i.name} | ${i.measure}`).join('\n')}\n\n` +
    (orders.length ? `Open orders (id | title | supplies asked for):\n${orders.map(o => `${o.todoId} | ${o.title} | ${o.lines.map(l => name.get(l.itemId) ?? '').filter(Boolean).join(', ')}`).join('\n')}\n\n` : '') +
    `Read the attached receipt${files.length > 1 ? ` (${files.length} images, in order)` : ''}.`;
  const r = await askJson(sql, env, SYSTEM, user, files);
  if (!r.ok) return { ok: false, message: r.error };
  const receipt = readReceipt(r.json, items, orders, aliases);
  const [before] = receipt.orderNo ? await sql`SELECT created_at::text AS at FROM receipt_reads WHERE account_id = 1 AND order_no = ${receipt.orderNo}
                                                ORDER BY created_at LIMIT 1` as { at: string }[] : [];
  await sql`INSERT INTO receipt_reads (account_id, hash, raw, by, store, order_no) VALUES (1, ${hash}, ${JSON.stringify(r.json)}::jsonb, ${r.by}, ${receipt.store}, ${receipt.orderNo})
            ON CONFLICT DO NOTHING`.catch(() => {});
  return { ok: true, receipt, by: r.by, repeat: before ? { at: before.at, orderNo: receipt.orderNo } : null };
}

/** The receipt lines a person decided (picked, changed, added as new): next time that text is that supply. */
export async function learnAliases(sql: SqlFn, by: string, raw: unknown) {
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? JSON.parse(raw) as unknown[] : []) as { text?: unknown; itemId?: unknown }[];
  for (const a of list.slice(0, 80)) {
    const text = aliasKey(String(a.text ?? '')), itemId = Number(a.itemId);
    if (text.length < 3 || !itemId) continue;
    await sql`INSERT INTO inventory_receipt_aliases (account_id, text, item_id, by_name) VALUES (1, ${text}, ${itemId}, ${by})
              ON CONFLICT (account_id, text) DO UPDATE SET item_id = EXCLUDED.item_id, by_name = EXCLUDED.by_name, updated_at = now()`;
  }
}

/** What reading Markdown orders answers: one receipt per file, in order, and which were read before. */
export type OrdersResult = { ok: true; receipts: Receipt[]; repeats: ({ at: string; orderNo: string | null } | null)[] } | { ok: false; message: string };

/**
 * The team's Walmart/Amazon orders saved with MarkDownload (owner, 2026-10-15): read as printed, no AI
 * (store-order.ts). Each file is one order; an order (or the same text) read before is said, so it is not
 * recorded twice — the same receipt_reads as the AI's, `by` = 'Markdown'.
 */
export async function readOrderMds(sql: SqlFn, mds: string[], withOrders: boolean): Promise<OrdersResult> {
  const list = mds.map(t => t.slice(0, 200_000)).filter(t => t.trim()).slice(0, 5);
  if (!list.length) return { ok: false, message: 'Attach the order saved as Markdown (.md) first.' };
  const [items, orders, learned] = await Promise.all([invItems(sql), withOrders ? openOrders(sql) : Promise.resolve([]),
    sql`SELECT text, item_id::text AS "itemId" FROM inventory_receipt_aliases WHERE account_id = 1` as Promise<{ text: string; itemId: string }[]>]);
  const aliases = new Map(learned.map(a => [a.text, a.itemId]));
  const receipts: Receipt[] = [], repeats: ({ at: string; orderNo: string | null } | null)[] = [];
  for (const md of list) {
    const o = parseOrderMd(md);
    if (!o.lines.length) {
      return { ok: false, message: o.store === 'walmart' || o.total != null
        ? 'No products in that file — the whole page was saved. On the order page, select from the order\'s title down to its Total and save the selection with MarkDownload.'
        : 'That file is not a Walmart or Amazon order page saved with MarkDownload.' };
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(md));
    const hash = [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
    const [seen] = await sql`SELECT created_at::text AS at, order_no FROM receipt_reads WHERE account_id = 1
                              AND (hash = ${hash} OR (${o.orderNo}::text IS NOT NULL AND order_no = ${o.orderNo})) ORDER BY created_at LIMIT 1` as { at: string; order_no: string | null }[];
    const receipt = readOrder(o, items, orders, aliases);
    receipts.push(receipt);
    repeats.push(seen ? { at: seen.at, orderNo: seen.order_no ?? o.orderNo } : null);
    await sql`INSERT INTO receipt_reads (account_id, hash, raw, by, store, order_no) VALUES (1, ${hash}, ${JSON.stringify(o)}::jsonb, 'Markdown', ${receipt.store}, ${o.orderNo})
              ON CONFLICT DO NOTHING`.catch(() => {});
  }
  return { ok: true, receipts, repeats };
}

/**
 * The store products a recorded purchase confirmed (owner, 2026-10-15): each goes first among its supply's
 * buying options with how many of the supply's measure come in one — the next receipt matches it by number and
 * the next order opens it in the store's cart.
 */
export async function learnProducts(sql: SqlFn, raw: unknown) {
  const list = (Array.isArray(raw) ? raw : typeof raw === 'string' && raw ? JSON.parse(raw) as unknown[] : []) as { itemId?: unknown; url?: unknown; pack?: unknown }[];
  for (const p of list.slice(0, 80)) {
    const itemId = Number(p.itemId), url = String(p.url ?? ''), pack = Number(p.pack);
    if (!itemId || !storeProduct(url)) continue;
    const [it] = await sql`SELECT buy_options FROM inventory_items WHERE account_id = 1 AND id = ${itemId}` as { buy_options: BuyOption[] | null }[];
    if (!it) continue;
    const next = withProduct(it.buy_options ?? [], url, pack > 0 ? Math.round(pack * 100) / 100 : null);
    await sql`UPDATE inventory_items SET buy_options = ${JSON.stringify(next)}::jsonb, updated_at = now() WHERE account_id = 1 AND id = ${itemId}`;
  }
}
