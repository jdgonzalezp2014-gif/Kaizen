/**
 * Inventory (§134) — pure: the stock from the moves, how far a count found
 * the record off, what each clean uses, and what to order.
 *
 * Nothing stores "the stock". A count (by the team) says what is really
 * there; after it, purchases add, uses take away, adjustments correct. A
 * "missing" report is an observation, not a move of stock: it asks for a
 * count instead of silently zeroing the record on one person's word.
 */

/**
 * Every move happens in a PLACE (§150): a storage, or a house's own closet — a
 * Repository record, `table/ROW-id`. Units hold no stock of their own. `taken`
 * = out of the place for a clean: `unitId` and `cleaningKey` say which. The
 * place is written on the move when it happens, so moving a unit to another
 * storage later leaves the past where it was. `place` null = the unit had no
 * place then (shown as ▲, never guessed).
 */
export type MoveKind = 'count' | 'used' | 'purchase' | 'adjust' | 'missing' | 'taken';
export const CATEGORIES = ['kitchen', 'bathroom', 'cleaning', 'linens', 'other'] as const;

export interface InvItem { id: string; name: string; category: string; measure: string; perClean: number | null; reorderAt: number | null; active: boolean }
export interface Move {
  itemId: string; place: string | null; unitId: string | null; kind: MoveKind; qty: number; at: string;
  cleaningKey?: string | null; byName?: string; source?: string;
}

/** The key of a place in `stockLevels` — '' for moves of a unit that had no place. */
export const placeKey = (place: string | null | undefined) => place ?? '';

export interface Level {
  itemId: string; place: string;
  /** What the record says is there now. Null: never counted and nothing recorded. */
  qty: number | null;
  /** The last count, and when. */
  countedAt: string | null;
  /** Someone reported not finding it since the last count — a count is due. */
  missingSince: string | null;
}

/** The stock of every item in every place, from the moves (in any order). Keyed `item|place`. */
export function stockLevels(moves: Move[]): Map<string, Level> {
  const out = new Map<string, Level>();
  const sorted = [...moves].sort((a, b) => a.at.localeCompare(b.at));
  for (const m of sorted) {
    const place = placeKey(m.place);
    const key = `${m.itemId}|${place}`;
    const l = out.get(key) ?? { itemId: m.itemId, place, qty: null, countedAt: null, missingSince: null };
    switch (m.kind) {
      case 'count': l.qty = m.qty; l.countedAt = m.at; l.missingSince = null; break;
      case 'purchase': l.qty = (l.qty ?? 0) + m.qty; break;
      case 'used': case 'taken': l.qty = (l.qty ?? 0) - m.qty; break;
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
 * What a unit's cleans took of an item since a day, and over how many cleans —
 * whichever place it came from: a unit moved to another storage keeps what it
 * learned. Every clean that answered step 2 counts (`answered`, its keys),
 * "nothing" and other items included: the average per clean is what cleaners
 * say they take, not what they take when they take some.
 */
export function unitUses(moves: Move[], itemId: string, unitId: string, since: string, answered: string[] = []): { qty: number; cleans: number } {
  const uses = moves.filter(m => m.itemId === itemId && m.unitId === unitId && (m.kind === 'used' || m.kind === 'taken') && m.at >= since);
  return { qty: uses.reduce((a, u) => a + u.qty, 0), cleans: new Set([...answered, ...uses.map(u => u.cleaningKey ?? u.at.slice(0, 10))]).size };
}

/**
 * What one clean takes of an item: the average of what cleaners reported over
 * the cleans in the window (once there are 3 reported cleans), else the
 * item's estimate — only a starting value.
 */
export function perClean(item: InvItem, usedInWindow: number, cleansWithUses: number): { rate: number | null; learned: boolean } {
  if (cleansWithUses >= 3) return { rate: Math.round(usedInWindow / cleansWithUses * 100) / 100, learned: true };
  return { rate: item.perClean, learned: false };
}

/**
 * What the coming cleans will take out of each place, for one item: every
 * unit counts toward the place it is assigned to NOW (its next cleans come
 * from there), whatever it took from before.
 */
export function needByPlace(units: { place: string | null; rate: number | null; cleansAhead: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const u of units) if (u.place) out.set(u.place, (out.get(u.place) ?? 0) + (u.rate ?? 0) * u.cleansAhead);
  return out;
}

/**
 * What to order for one place: what its units' coming cleans will take, plus
 * the minimum to keep there, minus what it holds — rounded up. Nothing for a
 * place never counted (the caller passes null): guessing "empty" turned every
 * place into a full order — 273 lines on the first try. Count it instead.
 */
export function toOrder(level: number | null, need: number, min: number | null): number {
  if (level === null) return 0;
  return Math.max(0, Math.ceil(need + (min ?? 0) - level));
}

/**
 * The shopping list as one to-do: a line per ITEM (what is bought), saying
 * which place each part goes to — one place, or split between several (§150).
 */
export function orderList(lines: { item: InvItem; place: string; qty: number }[]): { title: string; items: string[] } | null {
  const byItem = new Map<string, { item: InvItem; parts: { place: string; qty: number }[] }>();
  for (const l of lines) if (l.qty > 0) {
    const e = byItem.get(l.item.id) ?? { item: l.item, parts: [] };
    const same = e.parts.find(p => p.place === l.place);
    if (same) same.qty += l.qty; else e.parts.push({ place: l.place, qty: l.qty });
    byItem.set(l.item.id, e);
  }
  const ls = [...byItem.values()];
  if (!ls.length) return null;
  const total = (e: typeof ls[number]) => e.parts.reduce((a, p) => a + p.qty, 0);
  const unit = (e: typeof ls[number], n: number) => `${e.item.measure}${n === 1 ? '' : 's'}`;
  return {
    title: ls.length === 1 ? `Buy supplies: ${ls[0]!.item.name} × ${total(ls[0]!)}` : `Buy supplies: ${ls.length} items`,
    items: ls.map(e => `Buy: ${e.item.name} × ${total(e)} ${unit(e, total(e))} — ` +
      (e.parts.length === 1 ? e.parts[0]!.place : e.parts.map(p => `${p.place} ${p.qty}`).join(' · ')))
  };
}
