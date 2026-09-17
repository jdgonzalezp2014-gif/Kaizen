/**
 * Dates are yyyy-MM-dd strings, never Date objects.
 *
 * Everything here is a calendar-day question — did this night fall inside
 * that window — and Date drags a timezone into it. A stay arriving
 * "2026-03-01" in a browser at UTC-5 becomes Feb 28 the moment it is
 * parsed locally, which silently moves a night from one month's revenue
 * into another's. Strings compare lexicographically for free and cannot
 * do that.
 */
export type DateStr = string;

const MS_PER_DAY = 86_400_000;

/** Parsed as UTC on purpose — see the note above. */
function toUTC(d: DateStr): number {
  return Date.parse(`${d}T00:00:00Z`);
}

export function isDateStr(v: unknown): v is DateStr {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export function daysBetween(a: DateStr, b: DateStr): number {
  return Math.round((toUTC(b) - toUTC(a)) / MS_PER_DAY);
}

export function addDays(d: DateStr, n: number): DateStr {
  return new Date(toUTC(d) + n * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Inclusive on both ends: 1st to 1st is one day, not zero. */
export function daysInclusive(from: DateStr, to: DateStr): number {
  return daysBetween(from, to) + 1;
}

/**
 * How many days two inclusive ranges share. 0 when they miss entirely —
 * the single function every proration in this file is built on.
 */
export function overlapDays(aFrom: DateStr, aTo: DateStr, bFrom: DateStr, bTo: DateStr): number {
  const from = aFrom > bFrom ? aFrom : bFrom;
  const to   = aTo   < bTo   ? aTo   : bTo;
  return from > to ? 0 : daysInclusive(from, to);
}

export function startOfMonth(d: DateStr): DateStr { return `${d.slice(0, 7)}-01`; }

export function endOfMonth(d: DateStr): DateStr {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function addMonths(d: DateStr, n: number): DateStr {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7)) - 1 + n;
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/** Monday-based: a week that starts on Sunday splits every weekend across two buckets. */
export function startOfWeek(d: DateStr): DateStr {
  const dow = new Date(toUTC(d)).getUTCDay();      // 0 = Sunday
  return addDays(d, dow === 0 ? -6 : 1 - dow);
}

export function today(): DateStr {
  return new Date().toISOString().slice(0, 10);
}
