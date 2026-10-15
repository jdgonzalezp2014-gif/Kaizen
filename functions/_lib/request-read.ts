/**
 * ✨ Build the cart (owner, 2026-10-14 — §159): what someone asked to buy, in their own words (a cleaner's
 * request, an inspector's list, a note from Home), turned into lines of the supplies list by the AI — and
 * checked by the same `readReceipt` as a receipt's reading: a supply only when the model is sure and it exists,
 * else "is it one of these?". A text a person decided before (an alias) wins. Nothing is saved: the person
 * checks the cart and saves the order.
 */
import type { SqlFn } from './accounts.ts';
import type { Env } from './db.ts';
import { askJson } from './ai-chain.ts';
import { invItems } from './inventory.ts';
import { readReceipt, type ReceiptLine } from '../../src/lib/receipt.ts';

const SYSTEM = `You turn what someone at a short-term-rental cleaning company asked to buy into a shopping cart matched to its supplies list.
Answer ONLY JSON: {"lines": [{"text": the thing as they asked for it (short), "qty": number|null (how many they asked for, null if not said),
"itemId": a supply id or null, "sure": true|false, "alternatives": [up to 4 supply ids], "size": a size they said (King, 13 gal…) or null,
"name": a short generic name for it as a supply (no brand, no size)}]}.
Rules: one entry per thing asked for; ignore greetings, places, names and anything that is not something to buy.
"itemId" + "sure": true ONLY when it is clearly that same supply ("TP" = toilet paper, "trash bags" = trash bags) — a similar thing with
another use is NOT sure; a supply with a size (after "—") is sure only for that size. If unsure, "sure": false, "itemId" null and
"alternatives" = the likely supplies. Never invent ids.`;

export type RequestRead = { ok: true; lines: ReceiptLine[]; by: string } | { ok: false; message: string };

export async function readRequestText(sql: SqlFn, env: Env, text: string): Promise<RequestRead> {
  const said = text.trim().slice(0, 4000);
  if (!said) return { ok: false, message: 'Say what is needed first.' };
  const [items, learned] = await Promise.all([invItems(sql),
    sql`SELECT text, item_id::text AS "itemId" FROM inventory_receipt_aliases WHERE account_id = 1` as Promise<{ text: string; itemId: string }[]>]);
  const active = items.filter(i => i.active);
  const user = `Supplies list (id | name | measure):\n${active.map(i => `${i.id} | ${i.name} | ${i.measure}`).join('\n')}\n\nWhat was asked:\n${said}`;
  const r = await askJson(sql, env, SYSTEM, user);
  if (!r.ok) return { ok: false, message: r.error };
  // Every line is something to buy: the receipt's checks apply, its money fields are simply empty.
  const raw = { lines: (Array.isArray(r.json.lines) ? r.json.lines : []).map(l => ({ ...(l as object), kind: 'item' })) };
  return { ok: true, lines: readReceipt(raw, items, [], new Map(learned.map(a => [a.text, a.itemId]))).lines, by: r.by };
}
