/**
 * Analytics (owner, 2026-11-23): a week at a time by default (any range can be picked) — what was spent and on what, how full the houses were night by
 * night, what came in net, and what the guests said. Pure: /api/analytics hands the week's rows, the screen draws them.
 *
 * Weekly leaves the monthly lines out on purpose (rent, utilities): they are billed a month at a time, and a week's
 * share of them only means something once they are prorated per unit — the monthly view, later (docs/modules/finance.md).
 */
import { addDays, type DateStr } from './dates.ts';
import { reservationContribution, type Reservation } from './finance.ts';

/** Sunday to Saturday — the team's week (owner, 2026-11-23; the cleaners' pay weeks too). Any range can be picked. */
export function weekOf(day: DateStr): { from: DateStr; to: DateStr } {
  const from = addDays(day, -new Date(`${day}T00:00:00Z`).getUTCDay()); // 0 = Sunday
  return { from, to: addDays(from, 6) };
}

export interface CostLine {
  id: string; on: DateStr; unitId: string | null; category: string; amount: number;
  label: string | null; source: string | null;
  /** Who did it, when the line is a clean or a cleaner's extra. */
  cleaner?: string | null;
}

export interface Slice { key: string; total: number; count: number; share: number }

/** Totals by a key, biggest first, each with its share of the whole (0–1). */
export function slices<T>(rows: T[], key: (r: T) => string, amount: (r: T) => number): Slice[] {
  const m = new Map<string, { total: number; count: number }>();
  for (const r of rows) {
    const k = key(r) || '—';
    const e = m.get(k) ?? { total: 0, count: 0 };
    e.total += amount(r); e.count++;
    m.set(k, e);
  }
  const all = [...m.values()].reduce((a, e) => a + e.total, 0);
  return [...m.entries()].map(([k, e]) => ({ key: k, total: e.total, count: e.count, share: all > 0 ? e.total / all : 0 }))
    .sort((a, b) => b.total - a.total || b.count - a.count);
}

export interface CleanRow {
  key: string; on: DateStr; unitId: string | null; unit: string; cleaner: string | null;
  price: number | null; deep: boolean;
}

/** The week's cleans: how many, how many still unpriced (not in Costs yet), and per cleaner. */
export function cleaningSummary(cleans: CleanRow[]) {
  const byCleaner = slices(cleans, c => c.cleaner ?? 'Unassigned', c => c.price ?? 0)
    .map(s => ({ ...s, avg: s.count ? s.total / s.count : 0 }));
  return {
    count: cleans.length,
    deep: cleans.filter(c => c.deep).length,
    unpriced: cleans.filter(c => c.price == null).length,
    total: cleans.reduce((a, c) => a + (c.price ?? 0), 0),
    byCleaner
  };
}

export interface Stay extends Reservation { reservationId: string; guestName?: string; status?: string }

export interface DayOccupancy {
  day: DateStr;
  occupied: number; units: number; rate: number | null;
  /** Listing ids with a guest that night, and who. */
  stays: { listingId: string; reservationId: string; guest: string | null; arrival: DateStr; departure: DateStr }[];
  arrivals: number; departures: number;
}

/**
 * Night by night: a night is occupied when a stay covers it (arrival ≤ night < departure). Measured against the
 * listings taking bookings (`units`), the same base Units uses — a blocked night is still counted as empty here,
 * which the screen says.
 */
export function occupancyByDay(stays: Stay[], unitIds: string[], from: DateStr, to: DateStr): DayOccupancy[] {
  const live = new Set(unitIds);
  const out: DayOccupancy[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const tonight = stays.filter(s => live.has(s.listingId) && s.arrival <= d && d < s.departure);
    const listings = new Set(tonight.map(s => s.listingId));
    out.push({
      day: d, occupied: listings.size, units: live.size, rate: live.size ? listings.size / live.size : null,
      stays: tonight.map(s => ({ listingId: s.listingId, reservationId: s.reservationId, guest: s.guestName ?? null,
                                 arrival: s.arrival, departure: s.departure })),
      arrivals: stays.filter(s => live.has(s.listingId) && s.arrival === d).length,
      departures: stays.filter(s => live.has(s.listingId) && s.departure === d).length
    });
  }
  return out;
}

/** Net revenue inside the week (finance.ts reservationContribution — the same rule as Revenue), per unit and in all. */
export function weekIncome(stays: Stay[], from: DateStr, to: DateStr) {
  const byUnit = new Map<string, { revenue: number; nights: number; stays: number }>();
  for (const s of stays) {
    const c = reservationContribution(s, { from, to });
    if (!c) continue;
    const e = byUnit.get(s.listingId) ?? { revenue: 0, nights: 0, stays: 0 };
    e.revenue += c.revenue; e.nights += c.nights; e.stays++;
    byUnit.set(s.listingId, e);
  }
  const units = [...byUnit.entries()].map(([listingId, e]) => ({ listingId, ...e })).sort((a, b) => b.revenue - a.revenue);
  return { revenue: units.reduce((a, u) => a + u.revenue, 0), nights: units.reduce((a, u) => a + u.nights, 0), units };
}

/** The whole week's occupancy: nights sold over nights available (not an average of the days). */
export function weekOccupancy(days: DayOccupancy[]): number | null {
  const avail = days.reduce((a, d) => a + d.units, 0);
  return avail ? days.reduce((a, d) => a + d.occupied, 0) / avail : null;
}

export const CHANNEL: Record<number, string> = { 2018: 'Airbnb', 2002: 'Vrbo', 2005: 'Booking.com', 2007: 'Expedia', 2000: 'Direct', 2013: 'Direct' };

export interface ReviewRow {
  id: string; listingId: string; channelId: number; status: string; rating: number | null;
  submittedAt: DateStr | ''; publicReview: string | null; privateFeedback: string | null;
  categories: { category: string; rating: number }[];
}

/** Hostaway's 10-point rating as stars (0–5). */
export const stars = (rating10: number | null) => (rating10 == null ? null : Math.round(rating10 * 5) / 10);

/** A review that needs someone to read it: under 5 stars on the whole, or any category under 4. */
export const isLow = (r: ReviewRow) => (r.rating != null && r.rating < 10) || r.categories.some(c => c.rating < 8);

/**
 * The week's reviews: average stars, by channel, by category (cleanliness, check-in…), and the ones to read.
 * `asked` = guests who checked out this week and could review; `wrote` = those who already did.
 */
export function reviewSummary(reviews: ReviewRow[], departures: { status: string }[] = []) {
  const rated = reviews.filter(r => r.rating != null);
  const avg = rated.length ? rated.reduce((a, r) => a + r.rating!, 0) / rated.length : null;
  const cat = new Map<string, number[]>();
  for (const r of reviews) for (const c of r.categories) cat.set(c.category, [...(cat.get(c.category) ?? []), c.rating]);
  return {
    count: reviews.length,
    stars: avg == null ? null : Math.round(avg * 50) / 100,
    five: rated.filter(r => r.rating === 10).length,
    low: reviews.filter(isLow).length,
    byChannel: slices(reviews, r => CHANNEL[r.channelId] ?? 'Other', () => 1),
    categories: [...cat.entries()].map(([category, xs]) => ({ category, stars: Math.round(xs.reduce((a, x) => a + x, 0) / xs.length * 50) / 100, count: xs.length }))
      .sort((a, b) => a.stars - b.stars),
    asked: departures.length,
    wrote: departures.filter(d => d.status === 'published' || d.status === 'submitted').length
  };
}
