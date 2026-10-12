/**
 * Inventory (§134) — pure: the stock from the moves, how far a count found
 * the record off, what each clean uses, and what to order.
 *
 * Nothing stores "the stock". A count (by the team) says what is really
 * there; after it, purchases add, uses take away, adjustments correct. A
 * "missing" report is an observation, not a move of stock: it asks for a
 * count instead of silently zeroing the record on one person's word.
 */

export type MoveKind = 'count' | 'used' | 'purchase' | 'adjust' | 'missing';
export const CATEGORIES = ['kitchen', 'bathroom', 'cleaning', 'linens', 'other'] as const;

export interface InvItem { id: string; name: string; category: string; measure: string; perClean: number | null; reorderAt: number | null; active: boolean }
export interface Move {
  itemId: string; unitId: string | null; kind: MoveKind; qty: number; at: string;
  cleaningKey?: string | null; byName?: string; source?: string;
}

/** Where a move happened: a unit, or the central storage. */
export const placeKey = (unitId: string | null | undefined) => unitId ?? 'storage';

export interface Level {
  itemId: string; place: string;
  /** What the record says is there now. Null: never counted and nothing recorded. */
  qty: number | null;
  /** The last count, and when. */
  countedAt: string | null;
  /** Someone reported not finding it since the last count — a count is due. */
  missingSince: string | null;
}

/** The stock of every item in every place, from the moves (in any order). */
export function stockLevels(moves: Move[]): Map<string, Level> {
  const out = new Map<string, Level>();
  const sorted = [...moves].sort((a, b) => a.at.localeCompare(b.at));
  for (const m of sorted) {
    const key = `${m.itemId}|${placeKey(m.unitId)}`;
    const l = out.get(key) ?? { itemId: m.itemId, place: placeKey(m.unitId), qty: null, countedAt: null, missingSince: null };
    switch (m.kind) {
      case 'count': l.qty = m.qty; l.countedAt = m.at; l.missingSince = null; break;
      case 'purchase': l.qty = (l.qty ?? 0) + m.qty; break;
      case 'used': l.qty = (l.qty ?? 0) - m.qty; break;
      case 'adjust': l.qty = (l.qty ?? 0) + m.qty; break;
      case 'missing': l.missingSince ??= m.at; break;
    }
    out.set(key, l);
  }
  // Used more than the record had: the record was wrong, not the stock negative.
  for (const l of out.values()) if (l.qty !== null && l.qty < 0) l.qty = 0;
  return out;
}

/** A count against the record: what it found, what the record said, and the gap (found − expected). */
export function reconcile(expected: number | null, found: number): { expected: number | null; found: number; gap: number | null } {
  return { expected, found, gap: expected === null ? null : Math.round((found - expected) * 100) / 100 };
}

/**
 * What one clean uses of an item in a place: reported uses over the cleans
 * in the window (only once there are a few reports — 3 cleans with uses),
 * else the item's estimate.
 */
export function perClean(item: InvItem, usedInWindow: number, cleansWithUses: number): { rate: number | null; learned: boolean } {
  if (cleansWithUses >= 3) return { rate: Math.round(usedInWindow / cleansWithUses * 100) / 100, learned: true };
  return { rate: item.perClean, learned: false };
}

/**
 * What to order for one place: what the coming cleans will use, plus the
 * minimum to keep, minus what is there — rounded up to whole units.
 * Nothing for a place whose item was never counted (the caller passes
 * null): guessing "empty" there turned every unit into a full order —
 * 273 lines on the first try. Those are listed to count instead.
 */
export function toOrder(level: number | null, rate: number | null, cleansAhead: number, reorderAt: number | null): number {
  if (level === null) return 0;
  const need = (rate ?? 0) * cleansAhead + (reorderAt ?? 0);
  return Math.max(0, Math.ceil(need - level));
}

/** To buy, for one item: what the units need beyond what the storage holds. */
export const toBuy = (unitsNeed: number, inStorage: number | null) => Math.max(0, Math.ceil(unitsNeed - (inStorage ?? 0)));

/** The shopping list as one to-do with a line per item (the same shape as an inspection's purchases). */
export function orderList(lines: { item: InvItem; place: string; qty: number }[]): { title: string; items: string[] } | null {
  const ls = lines.filter(l => l.qty > 0);
  if (!ls.length) return null;
  return {
    title: ls.length === 1 ? `Buy supplies: ${ls[0]!.item.name} × ${ls[0]!.qty}` : `Buy supplies: ${ls.length} items`,
    items: ls.map(l => `Buy: ${l.item.name} × ${l.qty} ${l.item.measure}${l.qty === 1 ? '' : 's'} — ${l.place}`)
  };
}
