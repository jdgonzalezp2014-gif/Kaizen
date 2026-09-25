/**
 * The read of each unit — the verdict behind the Units screen's light.
 *
 * Extracted so every screen that says a unit is "red" says it by the SAME
 * rule. The Units list and the Home page showing different reds for the
 * same unit on the same morning would make both untrustworthy.
 *
 * Red is a verdict with tone `bad` — priced above what it earns, or not
 * moving — on a unit that is live and taking bookings. The alert pass
 * (alerts.ts) is deliberately stricter: it also wants $2,000 at stake
 * before a phone buzzes. A screen can show more than a channel should
 * interrupt for.
 */
import { rank, type ForwardUnit, type RankedUnit } from './forward.ts';
import {
  findGaps, median, portfolioAskRatio, signals, verdict, type Signal, type Verdict
} from './revenue.ts';

export interface Read { v: Verdict; rest: Signal[]; orphanNights: number; gaps: ReturnType<typeof findGaps> }
export type Light = 'bad' | 'warn' | 'ok' | 'info' | 'off';

export function diagnose(u: RankedUnit, portfolioAdr: number | null,
                         askRatio: number | null, asOf: string): Read {
  const gaps = findGaps(u.days);
  const orphans = gaps.filter(g => g.orphaned);
  const input = {
    occupancy: u.occupancy, nightsOpen: u.nightsOpen, pickup7: u.pickup7,
    leadTime: u.leadTime, adr: u.adr, openAsk: u.openAsk, lastBookedOn: u.lastBookedOn,
    orphanNights: orphans.reduce((a, g) => a + g.nights, 0),
    orphanRuns: orphans.length,
    portfolioAdr: portfolioAdr == null ? null : Math.round(portfolioAdr),
    portfolioAskRatio: askRatio,
    today: asOf
  };
  const v = verdict(input);
  // The headline already carries its own evidence; repeating it under
  // itself is noise, so the signal that produced it is filtered out.
  const rest = signals(input).filter(s => !v.reason.includes(s.text.slice(0, 24)));
  return { v, rest, orphanNights: input.orphanNights, gaps };
}

/** Every unit, ranked, with its read and its light — the portfolio as the Units screen sees it. */
export function readPortfolio(units: ForwardUnit[], occFloor: number, asOf: string) {
  const ranked = rank(units, occFloor);
  const live = ranked.filter(u => u.active);
  // Benchmarks come from units that can actually be booked — parked ones
  // would drag them towards zero and make everything look healthy.
  const portfolioAdr = median(live.filter(u => u.adr != null && u.adr > 0).map(u => u.adr as number));
  const askRatio = portfolioAskRatio(live);
  const reads = new Map(ranked.map(u => [u.listingId, diagnose(u, portfolioAdr, askRatio, asOf)]));
  // A unit not taking bookings has no diagnosis — its light is off rather
  // than a verdict it never earned.
  const lightOf = (u: RankedUnit): Light => u.active && u.listedActive ? reads.get(u.listingId)!.v.tone : 'off';
  return { ranked, live, portfolioAdr, askRatio, reads, lightOf };
}

/** The units in red, the most money at stake first. */
export function redUnits(units: ForwardUnit[], occFloor: number, asOf: string) {
  const p = readPortfolio(units, occFloor, asOf);
  return p.ranked
    .filter(u => p.lightOf(u) === 'bad')
    .map(u => ({ unit: u, read: p.reads.get(u.listingId)! }))
    .sort((a, b) => b.unit.exposure - a.unit.exposure);
}
