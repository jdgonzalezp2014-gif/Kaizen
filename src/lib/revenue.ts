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
  /**
   * The portfolio's own median ask-to-ADR ratio.
   *
   * Asking sits ABOVE achieved rate everywhere, always: the nights still
   * on sale are the less wanted ones, and length-of-stay discounts pull
   * the achieved figure down further. A flat "25% above ADR is
   * overpriced" test fired on eleven of twenty-three units here, which
   * is not a signal, it is wallpaper. Measuring each unit against how
   * far apart the two normally sit in THIS portfolio makes the flag mean
   * "unusual" again, and it self-calibrates per host and per season
   * instead of encoding one market's habits as a constant.
   */
  portfolioAskRatio: number | null;
  today: string;
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);

export function signals(u: SignalInput): Signal[] {
  const out: Signal[] = [];

  // Asking unusually far above what this unit achieves — judged against
  // the gap the rest of the portfolio runs, not an absolute multiple.
  if (u.openAsk != null && u.adr != null && u.adr > 0) {
    const ratio = u.openAsk / u.adr;
    const normal = u.portfolioAskRatio ?? 1.3;
    if (ratio > normal * 1.25 && ratio > 1.3) {
      out.push({ kind: 'ask-above-adr', tone: 'bad',
        text: `Asking $${u.openAsk} against the $${u.adr} it achieves — a ${Math.round((ratio - 1) * 100)}% gap, ` +
              `where the portfolio typically runs ${Math.round((normal - 1) * 100)}%.` });
    }
  }
  // No achieved rate to compare against, so fall back to the portfolio.
  if (u.openAsk != null && (u.adr == null || u.adr === 0) &&
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

  // Silence only matters if there is something left to sell. A unit
  // that is full has no reason to have taken a booking lately.
  if (u.lastBookedOn && u.nightsOpen > 0) {
    const quiet = daysBetween(u.lastBookedOn, u.today);
    if (quiet >= 21) {
      out.push({ kind: 'no-recent-booking', tone: 'warn',
        text: `No booking of any kind for ${quiet} days.` });
    }
  }

  return out;
}

/**
 * The one-line diagnosis: what is actually wrong, if anything.
 *
 * A card that prints seven metrics of equal weight makes the reader do
 * the diagnosis every time, for every unit, and that work does not get
 * done — it gets skipped, and the list stops being read. The metrics are
 * still there underneath; this is what the card LEADS with.
 *
 * Order matters: the checks run most-actionable first, because a unit
 * can be several of these at once and the headline should name the thing
 * worth doing something about.
 */
export type VerdictKind =
  | 'unbookable' | 'overpriced' | 'stuck' | 'early' | 'filling' | 'full' | 'quiet';

export interface Verdict {
  kind: VerdictKind;
  /** Two or three words. The headline. */
  label: string;
  /** One sentence, with the numbers that justify it. */
  reason: string;
  tone: 'bad' | 'warn' | 'ok' | 'info';
}

export function verdict(u: SignalInput & { orphanRuns: number }): Verdict {
  const sig = signals(u);
  const has = (k: SignalKind) => sig.some(s => s.kind === k);

  // Cheapest fix first, and the only one a price cannot solve.
  if (u.orphanNights > 0 && u.orphanNights >= u.nightsOpen * 0.5) {
    return { kind: 'unbookable', tone: 'warn', label: 'Gaps too short to book',
      reason: `${u.orphanNights} of ${u.nightsOpen} open nights sit in stretches shorter than the minimum stay. Lowering the minimum opens them; lowering the price does nothing.` };
  }

  if (has('ask-above-adr')) {
    const over = u.adr && u.adr > 0
      ? `a ${Math.round((u.openAsk! / u.adr - 1) * 100)}% gap over the $${u.adr} it achieves, ` +
        `against ${Math.round(((u.portfolioAskRatio ?? 1.3) - 1) * 100)}% across the portfolio`
      : `well above the $${u.portfolioAdr} portfolio average, with nothing booked`;
    return { kind: 'overpriced', tone: 'bad', label: 'Priced above what it earns',
      reason: `Asking $${u.openAsk}, ${over}${has('no-pickup') ? ', and nothing has booked in a week' : ''}.` };
  }

  // Books late, still under the floor — the common false alarm.
  if (has('books-late')) {
    return { kind: 'early', tone: 'info', label: 'Too early to tell',
      reason: `This unit books about ${u.leadTime} day(s) out, so ${u.nightsOpen} open nights this far ahead is its normal pattern. Discounting now gives away rate for nothing.` };
  }

  if (has('no-pickup')) {
    return { kind: 'stuck', tone: 'bad', label: 'Not moving',
      reason: `${u.nightsOpen} nights open and none booked in the last 7 days${u.openAsk ? `, asking $${u.openAsk}` : ''}. Demand is not finding this price.` };
  }

  if (has('no-recent-booking')) {
    return { kind: 'quiet', tone: 'warn', label: 'Gone quiet',
      reason: 'No booking of any kind recently, though the open window is small.' };
  }

  if (u.nightsOpen <= 2) {
    return { kind: 'full', tone: 'ok', label: 'Effectively full',
      reason: `Only ${u.nightsOpen} night(s) left to sell in this window.` };
  }

  return { kind: 'filling', tone: 'ok', label: 'Filling',
    reason: `${u.pickup7} night(s) booked in the last week with ${u.nightsOpen} still open.` };
}

/**
 * The portfolio's median ask-to-ADR ratio — the benchmark
 * `ask-above-adr` calibrates against. Units with no achieved rate are
 * excluded: they have no ratio, and treating a missing one as 1 would
 * drag the benchmark down and flag everyone.
 */
export function portfolioAskRatio(
  units: { openAsk: number | null; adr: number | null }[]
): number | null {
  const ratios = units
    .filter(u => u.openAsk != null && u.adr != null && u.adr > 0)
    .map(u => u.openAsk! / u.adr!);
  return median(ratios);
}
