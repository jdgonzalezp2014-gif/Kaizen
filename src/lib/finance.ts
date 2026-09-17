/**
 * Proration — the arithmetic every number on every screen rests on.
 *
 * This is a deliberate second implementation of what `apps-script/
 * Finance.js` does, and CONTEXT.md §2c explains why: the browser cannot
 * ask a 1–3 second Web App for each of ninety chart buckets. The price of
 * that is two implementations of "what did this unit earn", which is
 * exactly the duplication this project refuses everywhere else.
 *
 * `finance.test.ts` is what keeps the two honest. Do not change a rule
 * here without a test that pins it.
 */
import { type DateStr, daysBetween, daysInclusive, overlapDays, addDays } from './dates.ts';

export interface Period { from: DateStr; to: DateStr }

/** A stay, as 🧾 Reservations stores it: raw, with no window baked in. */
export interface Reservation {
  listingId: string;
  arrival: DateStr;
  departure: DateStr;
  totalPaid: number;
  cleaningFee: number;
  bookedOn?: DateStr | '';
  channel?: string;
}

/** A cost row from 💸 Costs or 🏠 Fixed Monthly Costs. */
export interface CostRow {
  listingId: string;      // '' means it is shared
  shared: boolean;
  start: DateStr;
  end: DateStr | '';      // '' = open-ended
  category: string;
  frequency: 'One-time' | 'Monthly' | string;
  amount: number;
  source: 'fixed' | 'variable';
}

export interface CostBreakdown {
  total: number; fixed: number; variable: number; shared: number;
  byCategory: Record<string, number>;
}

export interface UnitMetrics {
  listingId: string;
  revenue: number; nights: number; bookings: number; cleaningCollected: number;
  occupancy: number | null; adr: number | null; revpan: number | null;
  costs: CostBreakdown;
  net: number; roi: number | null;
}

const OPEN_ENDED = '2999-12-31';

/** Statuses that never occupied a night and never paid out. */
const EXCLUDED = new Set(['cancelled', 'declined', 'expired', 'inquiry', 'awaitingpayment']);

export function reservationCounts(status?: string): boolean {
  if (!status) return true;
  return !EXCLUDED.has(status.toLowerCase().replace(/[^a-z]/g, ''));
}

/**
 * What one stay contributed inside the window.
 *
 * Nightly payout is spread evenly and only the nights inside the window
 * count, so a stay crossing the boundary is split rather than counted
 * twice or dropped. The cleaning fee is attributed whole on the checkout
 * date, because that is when it is actually realised.
 *
 * A stay with no payout is an OCCUPANCY fact, not a revenue one — iCal
 * blocks and owner stays come back with totalPaid 0 while the listing's
 * default cleaning fee still resolves, and subtracting that from nothing
 * produced negative revenue in the original. The nights still count.
 */
export function reservationContribution(r: Reservation, p: Period) {
  if (!r.arrival || !r.departure) return null;

  const nights = Math.max(1, daysBetween(r.arrival, r.departure));
  const paid = r.totalPaid > 0;
  const cleaning = paid ? (r.cleaningFee || 0) : 0;
  const nightlyNet = paid ? (r.totalPaid - cleaning) / nights : 0;

  const lastNight = addDays(r.departure, -1);
  const occupied = overlapDays(r.arrival, lastNight, p.from, p.to);
  const cleaningInWindow = r.departure >= p.from && r.departure <= p.to;
  if (occupied <= 0 && !cleaningInWindow) return null;

  return {
    revenue: nightlyNet * occupied + (cleaningInWindow ? cleaning : 0),
    nights: occupied,
    cleaning: cleaningInWindow ? cleaning : 0
  };
}

/** Monthly costs become a daily rate; one-off costs spread across their own span. */
export function costDailyRate(row: CostRow): number {
  if (row.frequency === 'Monthly') return (row.amount * 12) / 365;
  const end = row.end || row.start;
  return row.amount / Math.max(1, daysInclusive(row.start, end));
}

export function costContribution(row: CostRow, p: Period): number {
  const end = row.end || (row.frequency === 'Monthly' ? OPEN_ENDED : row.start);
  const days = overlapDays(row.start, end, p.from, p.to);
  return days > 0 ? costDailyRate(row) * days : 0;
}

/**
 * Costs attributed per listing. A shared row is divided evenly across
 * every active unit for each day it is in effect — scope decides that,
 * not an empty Listing ID.
 */
export function prorateCosts(rows: CostRow[], listingIds: string[], p: Period): Record<string, CostBreakdown> {
  const blank = (): CostBreakdown =>
    ({ total: 0, fixed: 0, variable: 0, shared: 0, byCategory: {} });

  const out: Record<string, CostBreakdown> = {};
  listingIds.forEach(id => { out[id] = blank(); });
  const split = Math.max(1, listingIds.length);

  for (const row of rows) {
    const amount = costContribution(row, p);
    if (!amount) continue;

    const isShared = row.shared || !row.listingId;
    const targets = isShared ? listingIds : [row.listingId];
    const share = isShared ? amount / split : amount;

    for (const id of targets) {
      if (!out[id]) out[id] = blank();
      const b = out[id];
      b.total += share;
      if (row.source === 'fixed') b.fixed += share; else b.variable += share;
      if (isShared) b.shared += share;
      b.byCategory[row.category] = (b.byCategory[row.category] || 0) + share;
    }
  }
  return out;
}

export function unitMetrics(
  listingId: string, reservations: Reservation[], costs: CostBreakdown, p: Period
): UnitMetrics {
  const days = daysInclusive(p.from, p.to);
  let revenue = 0, nights = 0, cleaningCollected = 0, bookings = 0;

  for (const r of reservations) {
    const c = reservationContribution(r, p);
    if (!c) continue;
    revenue += c.revenue; nights += c.nights; cleaningCollected += c.cleaning; bookings++;
  }

  const net = revenue - costs.total;
  return {
    listingId, revenue, nights, bookings, cleaningCollected, costs, net,
    occupancy: days ? nights / days : null,
    adr: nights ? revenue / nights : null,
    // Per AVAILABLE night, not per night sold — the one that falls when a
    // unit sits empty. ADR alone makes an empty month look like a good one.
    revpan: days ? revenue / days : null,
    // Blank, not zero, when nothing was spent: a unit with no costs
    // recorded has missing data, not infinite return.
    roi: costs.total > 0 ? net / costs.total : null
  };
}

/** Rates are recomputed from the totals, never averaged from per-unit rates. */
export function portfolioMetrics(units: UnitMetrics[], p: Period) {
  const days = daysInclusive(p.from, p.to);
  const sum = (f: (u: UnitMetrics) => number) => units.reduce((a, u) => a + (f(u) || 0), 0);

  const revenue = sum(u => u.revenue);
  const nights = sum(u => u.nights);
  const fixed = sum(u => u.costs.fixed);
  const variable = sum(u => u.costs.variable);
  const total = fixed + variable;
  const available = days * Math.max(1, units.length);

  return {
    units: units.length, revenue, nights,
    costs: { fixed, variable, total },
    net: revenue - total,
    roi: total > 0 ? (revenue - total) / total : null,
    // An average of per-unit occupancy would weight a unit listed for a
    // week the same as one listed all quarter.
    occupancy: available ? nights / available : null,
    adr: nights ? revenue / nights : null,
    revpan: available ? revenue / available : null
  };
}
