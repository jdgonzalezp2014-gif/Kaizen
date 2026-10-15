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

// Gemini takes ~20 MB per request in all; base64 adds a third.
const MAX_BYTES = 12 * 1024 * 1024;

const SYSTEM = `You read store receipts for a short-term-rental cleaning company and match what was bought to its supplies list.
Answer ONLY JSON: {"store": string|null, "date": "YYYY-MM-DD"|null, "total": number|null, "tax": number|null,
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
"orderId" only when that order asks for that supply. "total" = what was paid in all, tax included.`;

export type ReadResult = { ok: true; receipt: Receipt; by: string } | { ok: false; message: string };

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
  for (const f of files.slice(0, 5)) add(f.type, await f.arrayBuffer());
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
  if (!out.length) throw new Error('Attach the receipt first — a photo or a PDF.');
  return out;
}

export async function readReceiptFiles(sql: SqlFn, env: Env, files: AiFile[], withOrders: boolean): Promise<ReadResult> {
  const [items, orders, learned] = await Promise.all([invItems(sql), withOrders ? openOrders(sql) : Promise.resolve([]),
    sql`SELECT text, item_id::text AS "itemId" FROM inventory_receipt_aliases WHERE account_id = 1` as Promise<{ text: string; itemId: string }[]>]);
  const active = items.filter(i => i.active);
  const name = new Map(active.map(i => [i.id, i.name]));
  const user = `Supplies list (id | name | measure):\n${active.map(i => `${i.id} | ${i.name} | ${i.measure}`).join('\n')}\n\n` +
    (orders.length ? `Open orders (id | title | supplies asked for):\n${orders.map(o => `${o.todoId} | ${o.title} | ${o.lines.map(l => name.get(l.itemId) ?? '').filter(Boolean).join(', ')}`).join('\n')}\n\n` : '') +
    'Read the attached receipt.';
  const r = await askJson(sql, env, SYSTEM, user, files);
  if (!r.ok) return { ok: false, message: r.error };
  return { ok: true, receipt: readReceipt(r.json, items, orders, new Map(learned.map(a => [a.text, a.itemId]))), by: r.by };
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
