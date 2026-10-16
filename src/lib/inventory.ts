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

/**
 * The name two items are the same thing by (owner, 2026-10-15: no "Mattress protector" beside "Mattress protectors"):
 * case, punctuation, spacing and plurals ignored — "Lock box" stays apart from "Lockbox" only by its words.
 */
export const itemKey = (name: string) => name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
  .map(w => w.length > 3 ? w.replace(/ies$/, 'y').replace(/(ch|sh|x|ss)es$/, '$1').replace(/(?<!s)s$/, '') : w).join(' ');
/** Another item that is the same thing in the same size (or none), if there is one. */
export const sameItem = <T extends { id: string; name: string; baseName?: string; size?: string | null }>(items: T[], name: string, size: string | null, notId?: string) =>
  items.find(i => i.id !== notId && itemKey(i.baseName ?? i.name) === itemKey(name) && (i.size ?? '').toLowerCase() === (size ?? '').toLowerCase());

/** How an item reads everywhere: its name, and its size when it has one. */
export const itemLabel = (name: string, size?: string | null) => size ? `${name} — ${size}` : name;

export interface InvItem {
  id: string; name: string; category: string; measure: string; perClean: number | null; reorderAt: number | null; active: boolean;
  /** §150: 'supply' is consumed by cleans (what cleaners take); 'furniture' is the house's things (counted only). */
  kind?: 'supply' | 'furniture';
  /** Owner, 2026-10-14: a size tells two items of one name apart; `name` then reads "Name — Size", `baseName` is the name alone. */
  baseName?: string; size?: string | null;
  /** Where to buy it; `pack` = how many of its measure come in one (store-order.ts). */
  buyOptions?: { label: string; url: string; pack?: number | null }[];
}
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

/**
 * Where something asked for is already on hand (owner, 2026-10-14 — §159): before buying, ops sends the
 * cleaner to look. Places holding at least one, most first; a place whose count is unknown says nothing.
 */
export function onHand(itemIds: string[], places: { name: string; items: { itemId: string; qty: number | null }[] }[]):
  Map<string, { place: string; qty: number }[]> {
  const out = new Map<string, { place: string; qty: number }[]>();
  for (const id of new Set(itemIds)) {
    const at = places.flatMap(p => p.items.filter(i => i.itemId === id && (i.qty ?? 0) > 0).map(i => ({ place: p.name, qty: i.qty! })))
      .sort((a, b) => b.qty - a.qty);
    if (at.length) out.set(id, at);
  }
  return out;
}

/**
 * What is left of an order once some of it is kept (owner, 2026-10-15): per item, the ordered quantity less what
 * was bought (or is still on the cart), taken from its parts in order — each left line keeps its place and store.
 * Nothing ordered is lost: it stays on the to-do, or goes on a new order for later.
 */
export function leftOver<L extends { itemId: string; place: string; qty: number }>(ordered: L[], kept: { itemId: string; qty: number }[]): L[] {
  const got = new Map<string, number>();
  for (const k of kept) if (k.qty > 0) got.set(String(k.itemId), (got.get(String(k.itemId)) ?? 0) + k.qty);
  const out: L[] = [];
  for (const l of ordered) {
    const id = String(l.itemId);
    const take = Math.min(l.qty, got.get(id) ?? 0);
    got.set(id, (got.get(id) ?? 0) - take);
    const n = Math.ceil(l.qty - take);
    if (n > 0) out.push({ ...l, itemId: id, qty: n });
  }
  return out;
}
