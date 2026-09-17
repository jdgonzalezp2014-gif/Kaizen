/**
 * Date ranges and chart bucketing — shared by every screen so two views
 * cannot disagree about what "Last 90" means.
 */
import {
  type DateStr, addDays, addMonths, daysInclusive,
  endOfMonth, startOfMonth, startOfWeek, today
} from './dates.ts';
import type { Period } from './finance.ts';

export type PresetId = 'mtd' | 'last30' | 'last90' | 'lastMonth' | 'qtd' | 'ytd' | 'custom';

export interface Preset { id: PresetId; label: string; resolve: (now?: DateStr) => Period }

export const PRESETS: Preset[] = [
  { id: 'mtd',       label: 'Month to date', resolve: (n = today()) => ({ from: startOfMonth(n), to: n }) },
  { id: 'last30',    label: 'Last 30 days',  resolve: (n = today()) => ({ from: addDays(n, -29), to: n }) },
  { id: 'last90',    label: 'Last 90 days',  resolve: (n = today()) => ({ from: addDays(n, -89), to: n }) },
  { id: 'lastMonth', label: 'Last month',
    resolve: (n = today()) => {
      const prev = addMonths(startOfMonth(n), -1);
      return { from: prev, to: endOfMonth(prev) };
    } },
  { id: 'qtd',       label: 'Quarter to date',
    resolve: (n = today()) => {
      const q = Math.floor((Number(n.slice(5, 7)) - 1) / 3) * 3 + 1;
      return { from: `${n.slice(0, 4)}-${String(q).padStart(2, '0')}-01`, to: n };
    } },
  { id: 'ytd',       label: 'Year to date',  resolve: (n = today()) => ({ from: `${n.slice(0, 4)}-01-01`, to: n }) }
];

export function resolvePreset(id: PresetId, now: DateStr = today()): Period | null {
  const p = PRESETS.find(x => x.id === id);
  return p ? p.resolve(now) : null;
}

/** Typed backwards is still an answer; swap rather than refuse. */
export function normalisePeriod(from: DateStr, to: DateStr): Period {
  return from <= to ? { from, to } : { from: to, to: from };
}

export type Granularity = 'day' | 'week' | 'month';

/**
 * Chosen from the span, not offered to the user.
 *
 * Nobody wants to pick a bucket size, and the wrong pick is unreadable:
 * two years of daily bars is 730 of them. These thresholds are where a
 * chart stops being legible at a normal width, not anything deeper.
 */
export function granularityFor(p: Period): Granularity {
  const days = daysInclusive(p.from, p.to);
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

/**
 * Splits a period into contiguous buckets. The first and last are
 * CLIPPED to the period, so a month view starting mid-month reports a
 * part-month as the part it actually covers — a full month's costs
 * prorated into eleven days would otherwise read as a catastrophic loss.
 */
export function bucketPeriod(p: Period, g: Granularity = granularityFor(p)): Period[] {
  const out: Period[] = [];
  let cursor = p.from;

  while (cursor <= p.to) {
    let end: DateStr;
    if (g === 'day') end = cursor;
    else if (g === 'week') end = addDays(startOfWeek(cursor), 6);
    else end = endOfMonth(cursor);

    const to = end > p.to ? p.to : end;
    out.push({ from: cursor, to });
    cursor = addDays(to, 1);
  }
  return out;
}

/** Short axis label for a bucket, given how wide the bucket is. */
export function bucketLabel(b: Period, g: Granularity): string {
  if (g === 'day')   return b.from.slice(5);            // MM-DD
  if (g === 'month') return b.from.slice(0, 7);         // YYYY-MM
  return b.from.slice(5);                               // week starts on MM-DD
}

/**
 * Whether a bucket is still filling. The last bucket of a range ending
 * today is a partial week or month, and plotting it beside complete ones
 * makes every chart look like it falls off a cliff at the right-hand
 * edge. Charts should render these differently rather than hide them.
 */
export function isPartial(b: Period, g: Granularity, now: DateStr = today()): boolean {
  if (g === 'day') return false;
  const full = g === 'week' ? addDays(startOfWeek(b.from), 6) : endOfMonth(b.from);
  return b.to < full || b.to >= now;
}
