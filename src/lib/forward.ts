/**
 * Ranking the forward window: which unit needs a decision first.
 *
 * Pure. No fetch, no React — the same rules run in a test, in the
 * browser, and later in whatever suggests a price automatically.
 */

export interface ForwardUnit {
  listingId: string;
  name: string;
  /** Hostaway's flag. Says the listing exists, not that it takes bookings. */
  listedActive: boolean;
  /** Blocked solid across the whole parked horizon — off, whatever the flag says. */
  parked: boolean;
  parkedDays: number;
  /** listedActive AND not parked. This is the one worth counting. */
  active: boolean;
  basePrice: number | null;
  /** What the guest pays, from Hostaway. Revenue. */
  cleaningFeeCharged: number | null;
  /** What the cleaner is paid, from the host's sheet. Cost. */
  cleaningCost: number | null;
  weeklyDiscountPct: number | null;
  monthlyDiscountPct: number | null;
  nights: number;
  nightsOpen: number;
  nightsSold: number;
  nightsBlocked: number;
  occupancy: number | null;
  onBooks: number;
  askAvg: number | null;
  openDates: string[];
  hasCalendar: boolean;
  days: { d: string; s: 'o' | 's' | 'b'; p: number | null }[];
}

/**
 * Why a unit is not in the ranking, or how urgently it is.
 *
 *   offline    every night blocked — an owner stay, a renovation, a unit
 *              switched off. Not a pricing problem and not vacancy.
 *   unknown    no calendar came back. Unknown is not empty.
 *   thin       below the floor with nights still sellable.
 *   watch      under the floor but with little left to sell.
 *   ok         at or above the floor.
 */
export type ForwardState = 'parked' | 'offline' | 'unknown' | 'thin' | 'watch' | 'ok';

export interface RankedUnit extends ForwardUnit {
  state: ForwardState;
  /** Nights that a price change could still act on. */
  atRisk: number;
  /** Money left on the table if every open night stays open. */
  exposure: number;
  urgency: number;
}

/**
 * An all-blocked unit is NOT zero-occupancy.
 *
 * This portfolio has four units blocked solid for the next month. With
 * calendar nights as the denominator they read 0% and sort to the very
 * top of "needs a discount" — a recommendation to cut the price of a
 * unit nobody can book. Occupancy is measured against SELLABLE nights,
 * and a unit with none is reported as offline rather than ranked.
 */
export function classify(u: ForwardUnit, occFloor: number): ForwardState {
  if (!u.hasCalendar) return 'unknown';
  // Parked outranks offline: both are unbookable, but parked says the
  // block runs past this window and is a standing decision, not a gap.
  if (u.parked) return 'parked';
  if (u.nightsOpen + u.nightsSold === 0) return 'offline';
  if (u.occupancy == null) return 'unknown';
  if (u.occupancy >= occFloor) return 'ok';
  // Under the floor, but if almost nothing is left to sell there is no
  // decision to make — the window is already spent.
  return u.nightsOpen >= 3 ? 'thin' : 'watch';
}

export function rank(units: ForwardUnit[], occFloor: number): RankedUnit[] {
  const ranked = units.map(u => {
    const state = classify(u, occFloor);
    const atRisk = state === 'thin' || state === 'watch' ? u.nightsOpen : 0;
    const ask = u.askAvg ?? u.basePrice ?? 0;
    const exposure = atRisk * ask;

    // Urgency is nights-at-risk weighted by the gap to the floor, in
    // money. A 40%-occupied studio with four open nights is a smaller
    // problem than a 55%-occupied house with eighteen, and occupancy
    // alone ranks them the other way round.
    const gap = u.occupancy == null ? 0 : Math.max(0, occFloor - u.occupancy);
    const urgency = state === 'thin' || state === 'watch' ? exposure * (0.5 + gap) : -1;

    return { ...u, state, atRisk, exposure, urgency };
  });

  const order: Record<ForwardState, number> = {
    thin: 0, watch: 1, ok: 2, unknown: 3, offline: 4, parked: 5 };
  return ranked.sort((a, b) => {
    if (order[a.state] !== order[b.state]) return order[a.state] - order[b.state];
    if (a.urgency !== b.urgency) return b.urgency - a.urgency;
    // Zero occupancy is the most urgent case there is, so it must never
    // fall through to a name sort by being treated as absent. `a || b`
    // does exactly that, which is why these are explicit null checks.
    const ao = a.occupancy == null ? 2 : a.occupancy;
    const bo = b.occupancy == null ? 2 : b.occupancy;
    if (ao !== bo) return ao - bo;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Listings that look like the same unit twice.
 *
 * A duplicated listing double-counts its revenue in every portfolio
 * total, and the only sign is that two rows agree exactly. Reported,
 * never merged automatically — two genuinely identical units are
 * possible, and guessing wrong silently halves someone's revenue.
 */
export function suspectedDuplicates(units: ForwardUnit[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i]!, b = units[j]!;
      if (a.onBooks > 0 && a.onBooks === b.onBooks &&
          a.nightsSold === b.nightsSold && a.basePrice === b.basePrice) {
        out.push([a.name, b.name]);
      }
    }
  }
  return out;
}
