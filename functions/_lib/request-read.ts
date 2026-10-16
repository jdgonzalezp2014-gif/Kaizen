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
import type { InvItem } from '../../src/lib/inventory.ts';
import { readReceipt, type ReceiptLine } from '../../src/lib/receipt.ts';

const SYSTEM = `You turn what someone at a short-term-rental cleaning company asked to buy into a shopping cart matched to its supplies list.
Answer ONLY JSON: {"lines": [{"text": the thing as they asked for it (short), "qty": number|null (how many they asked for, null if not said),
"itemId": a supply id or null, "sure": true|false, "alternatives": [up to 4 supply ids], "size": a size they said (King, 13 gal…) or null,
"name": a short generic name for it as a supply (no brand, no size), "itemQty": how many of the supply's own measure when the words say it
("18 pack of washcloths" = 18) or null, "measure": what it is counted in (unit, set, pack, roll, bottle…), "furniture": true for a house's
things (linens, dishes, furniture, equipment, decor), false for what cleans use up (soap, paper, pods, bags, cleaners)}]}.
Rules: one entry per thing asked for, in the order written; ignore greetings, places, names, explanations and anything that is not something to buy.
Furniture, mattresses, linens, dishes, electronics, decor and equipment are things to buy too: never leave one out because it is not on
the supplies list — give it "itemId": null, "alternatives": [] unless a listed supply is really it, and its "name".
"itemId" + "sure": true ONLY when it is clearly that same supply ("TP" = toilet paper, "trash bags" = trash bags) — a similar thing with
another use is NOT sure; a supply with a size (after "—") is sure only for that size. If unsure, "sure": false, "itemId" null and
"alternatives" = the likely supplies. Never invent ids.`;

export type RequestRead = { ok: true; lines: ReceiptLine[]; by: string } | { ok: false; message: string };

/** `opts` (Slack's "@Kaizen order", 2026-10-15): a shorter budget — a Slack waitUntil has 30 s — and the lists already read. */
export async function readRequestText(sql: SqlFn, env: Env, text: string,
                                      opts: { budgetMs?: number; log?: boolean; items?: InvItem[]; learned?: { text: string; itemId: string }[] } = {}): Promise<RequestRead> {
  const said = text.trim().slice(0, 4000);
  if (!said) return { ok: false, message: 'Say what is needed first.' };
  const [items, learned] = await Promise.all([opts.items ?? invItems(sql), opts.learned ??
    sql`SELECT text, item_id::text AS "itemId" FROM inventory_receipt_aliases WHERE account_id = 1` as Promise<{ text: string; itemId: string }[]>]);
  const active = items.filter(i => i.active);
  const user = `Supplies list (id | name | measure):\n${active.map(i => `${i.id} | ${i.name} | ${i.measure}`).join('\n')}\n\nWhat was asked:\n${said}`;
  const r = await askJson(sql, env, SYSTEM, user, [], { ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}), ...(opts.log === false ? { log: false } : {}) });
  if (!r.ok) return { ok: false, message: r.error };
  // Every line is something to buy: the receipt's checks apply, its money fields are simply empty.
  const raw = { lines: (Array.isArray(r.json.lines) ? r.json.lines : []).map(l => ({ ...(l as object), kind: 'item' })) };
  return { ok: true, lines: readReceipt(raw, items, [], new Map(learned.map(a => [a.text, a.itemId]))).lines, by: r.by };
}
