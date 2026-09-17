/**
 * Turns raw rows into what a chart draws.
 *
 * This is the whole reason the API serves period-free data: every point
 * below is computed in the browser, so dragging a range redraws without
 * asking anyone anything.
 */
import { type DateStr, daysInclusive, today } from './dates.ts';
import {
  type CostRow, type Period, type Reservation,
  portfolioMetrics, prorateCosts, unitMetrics
} from './finance.ts';
import { type Granularity, bucketLabel, bucketPeriod, granularityFor, isPartial } from './ranges.ts';

export interface SeriesPoint {
  label: string;
  from: DateStr; to: DateStr;
  days: number;
  revenue: number; cost: number; net: number;
  occupancy: number | null; adr: number | null; revpan: number | null;
  /** True while the bucket is still filling — render it visibly different. */
  partial: boolean;
}

export interface Dataset {
  reservations: Reservation[];
  costs: CostRow[];
  listingIds: string[];
}

function metricsFor(data: Dataset, p: Period) {
  const costs = prorateCosts(data.costs, data.listingIds, p);
  const byUnit = data.listingIds.map(id =>
    unitMetrics(
      id,
      data.reservations.filter(r => r.listingId === id),
      costs[id] ?? { total: 0, fixed: 0, variable: 0, shared: 0, byCategory: {} },
      p
    ));
  return { byUnit, portfolio: portfolioMetrics(byUnit, p) };
}

/** One point per bucket, for the whole portfolio. */
export function portfolioSeries(
  data: Dataset, period: Period,
  g: Granularity = granularityFor(period), now: DateStr = today()
): SeriesPoint[] {
  return bucketPeriod(period, g).map(b => {
    const m = metricsFor(data, b).portfolio;
    return {
      label: bucketLabel(b, g),
      from: b.from, to: b.to,
      days: daysInclusive(b.from, b.to),
      revenue: m.revenue, cost: m.costs.total, net: m.net,
      occupancy: m.occupancy, adr: m.adr, revpan: m.revpan,
      partial: isPartial(b, g, now)
    };
  });
}

/** The same series for one unit — what a per-unit drill-down draws. */
export function unitSeries(
  data: Dataset, listingId: string, period: Period,
  g: Granularity = granularityFor(period), now: DateStr = today()
): SeriesPoint[] {
  const scoped: Dataset = {
    reservations: data.reservations.filter(r => r.listingId === listingId),
    // Shared costs still apply, and are still divided by the FULL unit
    // count — a unit's share of the accountant does not grow just because
    // you are looking at it alone.
    costs: data.costs,
    listingIds: data.listingIds
  };
  return bucketPeriod(period, g).map(b => {
    const m = metricsFor(scoped, b).byUnit.find(u => u.listingId === listingId);
    return {
      label: bucketLabel(b, g),
      from: b.from, to: b.to,
      days: daysInclusive(b.from, b.to),
      revenue: m?.revenue ?? 0, cost: m?.costs.total ?? 0, net: m?.net ?? 0,
      occupancy: m?.occupancy ?? null, adr: m?.adr ?? null, revpan: m?.revpan ?? null,
      partial: isPartial(b, g, now)
    };
  });
}

/**
 * The scoreboard: where each unit sits against its target.
 *
 * Bands come from the client's spec — green at or above target, amber
 * 70–99%, red below 70%. The target itself is per-unit config × nothing
 * else; the PORTFOLIO target is active units × that, computed by the API
 * so a unit going offline moves the target rather than faking a miss.
 */
export type Band = 'green' | 'amber' | 'red';

export function bandFor(net: number, target: number): Band {
  if (!target) return 'red';
  const ratio = net / target;
  if (ratio >= 1) return 'green';
  if (ratio >= 0.7) return 'amber';
  return 'red';
}

export function scoreboard(data: Dataset, period: Period, perUnitTarget: number) {
  const { byUnit, portfolio } = metricsFor(data, period);
  // Targets are monthly; a period that is not a month must scale or the
  // comparison is meaningless — eleven days against a month's target is
  // a guaranteed red that means nothing.
  const scale = daysInclusive(period.from, period.to) / 30.44;
  const scaled = perUnitTarget * scale;

  return {
    period, scale,
    perUnitTarget: scaled,
    portfolioTarget: scaled * byUnit.length,
    portfolio,
    units: byUnit
      .map(u => ({ ...u, target: scaled, delta: u.net - scaled, band: bandFor(u.net, scaled) }))
      .sort((a, b) => a.delta - b.delta)   // worst first: that is what needs a decision
  };
}
