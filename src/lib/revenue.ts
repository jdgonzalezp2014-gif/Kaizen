/**
 * The numbers a revenue manager actually decides on.
 *
 * Pure: no fetch, no React. Everything here answers one of three
 * questions — is this unit filling, is demand moving, and can the empty
 * nights physically be sold.
 */
import type { CalendarNight } from './forward.ts';

/**
 * Runs of consecutive open nights, with the minimum stay that applies.
 *
 * The reason this exists: a gap shorter than its own minimum stay is
 * UNSELLABLE. Two open nights between two bookings, under a three-night
 * minimum, cannot be booked at any price — so it will sit in the
 * "discount this" pile forever while discounts do nothing, because the
 * blocker was never the price.
 *
 * These are the highest-yield fix in short-term rentals and the one no
 * occupancy percentage will ever show you.
 */
export interface Gap {
  from: string; to: string; nights: number;
  minStay: number | null;
  /** The gap is shorter than the minimum stay required to book it. */
  orphaned: boolean;
  askAvg: number | null;
}

export function findGaps(days: CalendarNight[]): Gap[] {
  const gaps: Gap[] = [];
  let run: CalendarNight[] = [];

  const close = () => {
    if (!run.length) return;
    const mins = run.map(d => d.m).filter((n): n is number => n != null && n > 0);
    const minStay = mins.length ? Math.max(...mins) : null;
    const prices = run.map(d => d.p).filter((n): n is number => n != null && n > 0);
    gaps.push({
      from: run[0]!.d, to: run[run.length - 1]!.d, nights: run.length, minStay,
      orphaned: minStay != null && run.length < minStay,
      askAvg: prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null
    });
    run = [];
  };

  for (const d of days) { if (d.s === 'o') run.push(d); else close(); }
  close();
  return gaps;
}

/**
 * Pace: how full this unit is compared with the rest of the portfolio
 * over the same nights.
 *
 * Occupancy alone is not a verdict. 45% thirty days out is healthy in one
 * market and a crisis in another, and the only honest benchmark available
 * here is the portfolio itself — until real comp data exists, which is
 * deliberately not faked in the meantime.
 *
 * Returned in percentage POINTS against the portfolio median, so −18
 * reads as "eighteen points behind the rest of the portfolio".
 */
export function paceVsPortfolio(occupancy: number | null, portfolioMedian: number | null): number | null {
  if (occupancy == null || portfolioMedian == null) return null;
  return Math.round((occupancy - portfolioMedian) * 1000) / 10;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
}

/**
 * Days between booking and arrival, median.
 *
 * Decides whether an empty night is a problem YET. A unit that
 * habitually books six days out is not in trouble because week five is
 * empty; a unit that books sixty days out, with week five empty, is.
 */
export function leadTimeDays(res: { bookedOn: string; arrival: string }[]): number | null {
  const gaps = res
    .filter(r => r.bookedOn && r.arrival)
    .map(r => Math.round((Date.parse(`${r.arrival}T00:00:00Z`) - Date.parse(`${r.bookedOn}T00:00:00Z`)) / 864e5))
    .filter(n => n >= 0 && n < 730);
  return median(gaps);
}

/**
 * Pickup: nights booked in the last N days for stays inside the window.
 *
 * The one number that says whether demand is MOVING. Occupancy is a
 * level; pickup is the derivative. A unit at 40% with strong pickup is
 * filling and needs nothing; a unit at 40% with zero pickup for two
 * weeks is stuck, and that is a different decision entirely.
 */
export function pickup(
  res: { bookedOn: string; arrival: string; departure: string; nights: number }[],
  since: string, windowFrom: string, windowTo: string
): { bookings: number; nights: number } {
  let bookings = 0, nights = 0;
  for (const r of res) {
    if (!r.bookedOn || r.bookedOn < since) continue;
    if (r.departure <= windowFrom || r.arrival > windowTo) continue;
    bookings++;
    // Only the nights that fall inside the window count — a 20-night
    // stay straddling the edge is not 20 nights of pickup for it.
    const a = r.arrival > windowFrom ? r.arrival : windowFrom;
    const b = r.departure < windowTo ? r.departure : windowTo;
    nights += Math.max(0, Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5));
  }
  return { bookings, nights };
}

/**
 * The read a revenue manager would give a unit in one glance.
 *
 * Each signal is a specific, falsifiable claim with a number behind it,
 * not a mood. They exist because occupancy on its own routinely points
 * the wrong way: a unit that books two days out is not in trouble for
 * being empty in week four, and a unit asking well above what it has
 * ever achieved is not short of demand, it is short of a realistic price.
 */
export type SignalKind =
  | 'no-pickup' | 'ask-above-adr' | 'orphan-nights' | 'books-late'
  | 'no-recent-booking' | 'rate-below-peers';

export interface Signal {
  kind: SignalKind;
  /** Plain sentence, with the number that justifies it. */
  text: string;
  tone: 'bad' | 'warn' | 'info';
}

export interface SignalInput {
  occupancy: number | null;
  nightsOpen: number;
  pickup7: number;
  leadTime: number | null;
  adr: number | null;
  openAsk: number | null;
  lastBookedOn: string | null;
  orphanNights: number;
  portfolioAdr: number | null;
  today: string;
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

export function signals(u: SignalInput): Signal[] {
  const out: Signal[] = [];

  // Asking far above what this unit has ever actually achieved. The
  // clearest overpricing tell there is, and invisible in occupancy.
  if (u.openAsk != null && u.adr != null && u.adr > 0 && u.openAsk > u.adr * 1.25) {
    out.push({ kind: 'ask-above-adr', tone: 'bad',
      text: `Asking $${u.openAsk} but only achieving $${u.adr} — ${Math.round((u.openAsk / u.adr - 1) * 100)}% above its own rate.` });
  }
  // No achieved rate to compare against, so fall back to the portfolio.
  else if (u.openAsk != null && (u.adr == null || u.adr === 0) &&
           u.portfolioAdr != null && u.openAsk > u.portfolioAdr * 1.5) {
    out.push({ kind: 'ask-above-adr', tone: 'bad',
      text: `Asking $${u.openAsk} with nothing booked, against a portfolio average of $${u.portfolioAdr}.` });
  }

  // Occupancy is a level; pickup is the derivative. Stuck is a different
  // problem from merely empty, and it is the one a price can fix.
  if (u.pickup7 === 0 && u.nightsOpen > 5) {
    out.push({ kind: 'no-pickup', tone: 'bad',
      text: `No nights booked in the last 7 days, with ${u.nightsOpen} still open.` });
  }

  // A gap shorter than its own minimum stay cannot be booked at any
  // price. Discounting it is wasted; the minimum is the lever.
  if (u.orphanNights > 0) {
    out.push({ kind: 'orphan-nights', tone: 'warn',
      text: `${u.orphanNights} night(s) sit in gaps too short for the minimum stay — unbookable until the minimum drops.` });
  }

  // The reason a low number may be fine. Stated explicitly so nobody
  // discounts a unit that simply has not reached its booking window.
  if (u.leadTime != null && u.leadTime <= 4 && u.occupancy != null && u.occupancy < 0.5) {
    out.push({ kind: 'books-late', tone: 'info',
      text: `Typically books ${u.leadTime} day(s) out — being empty this far ahead is normal for this unit.` });
  }

  if (u.lastBookedOn) {
    const quiet = daysBetween(u.lastBookedOn, u.today);
    if (quiet >= 21) {
      out.push({ kind: 'no-recent-booking', tone: 'warn',
        text: `No booking of any kind for ${quiet} days.` });
    }
  }

  return out;
}
