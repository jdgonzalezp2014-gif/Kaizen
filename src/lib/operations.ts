/**
 * The operations board — the daily file's Main tab, rebuilt here.
 *
 * Pure: no fetch, no framework. The inputs are Hostaway's reservations
 * (what is happening) and the daily file's logs (what the team decided
 * about it). Nothing is re-decided here. WHO cleans and WHAT it pays are
 * the sheet's decisions, read from its Cleanings Log; a second copy of the
 * tier rule would be a second answer the first time the two disagreed.
 *
 * What IS computed here is what the sheet computes from Hostaway alone
 * — the next booking, the gap, the inspection flags — ported from
 * `03 MainSheet` and `07 Inspections` rule for rule, so the two screens
 * agree on the same day.
 */
import { addDays, daysBetween, type DateStr } from './dates.ts';

export interface OpsListing { id: string; name: string; bedrooms: number | null; active: boolean }

export interface OpsReservation {
  reservationId: string; listingId: string;
  arrival: DateStr; departure: DateStr; nights: number;
  totalPaid: number; channel: string;
  guestName?: string; guests?: number | null;
}

/** One row of the Cleanings Log, as imported into `cleanings`. */
export interface OpsCleaning {
  cleaner: string | null;
  assignment: 'assigned' | 'tbd' | 'not_needed';
  price: number | null;
  deep: boolean;
  urgency: string | null;
  checkoutTime: string | null;
  beds: number | null;
}

export interface OpsInspection { date: DateStr; unit: string; by: string; result: string; notes: string }

export interface OpsRules {
  longVacancyDays: number;
  nextResValueHorizonDays: number;
  inspectionIntervalDays: number;
  inspectionSoonDays: number;
  inspectionValueTrigger: number;
}

export type InspectionKey = 'req' | 'due' | 'ok' | 'none';
export type InspectionTier = 'never' | 'overdue' | 'soon' | 'ok';

export interface NextStay {
  arrival: DateStr;
  gapDays: number;
  /** Null past the value horizon: a booking a month out is not today's business. */
  total: number | null;
  longVacancy: boolean;
}

export interface BoardRow {
  date: DateStr;
  kind: 'in' | 'out';
  resId: string;
  unitId: string;
  unit: string;
  beds: number | null;
  guest: string;
  guests: number | null;
  nights: number;
  channel: string;
  total: number;
  /** Checkout time as set on Main; null on arrivals (the sheet does not log those). */
  time: string | null;
  note: string;
  /* departures */
  next: NextStay | null;
  cleaner: string | null;
  assignment: OpsCleaning['assignment'] | 'unknown';
  price: number | null;
  deep: boolean;
  urgency: string | null;
  /** False when the daily file has not seen this checkout yet. */
  inDailyFile: boolean;
  inspection: { key: InspectionKey; reason: string };
  /* arrivals */
  preppedBy: string | null;
}

export interface UnitInspection {
  unitId: string; unit: string;
  last: DateStr | null; lastBy: string; lastResult: string; lastNotes: string;
  count: number; daysSince: number | null; tier: InspectionTier;
  /** The first booking in the look-ahead big enough to force one. */
  nextBig: { arrival: DateStr; total: number } | null;
  scheduled: DateStr | null;
}

/** How far ahead the panel looks for a booking that forces an inspection. */
export const INSPECTION_LOOKAHEAD_DAYS = 45;

/** Unit names are matched loosely: "P2 - 1406" and "p2-1406" are one unit. */
export const unitKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export function inspectionTier(daysSince: number | null, r: OpsRules): InspectionTier {
  if (daysSince === null) return 'never';
  if (daysSince >= r.inspectionIntervalDays) return 'overdue';
  if (daysSince >= r.inspectionSoonDays) return 'soon';
  return 'ok';
}

/** The next stay in the same unit that arrives on or after `from`. */
function nextStay(
  byUnit: Map<string, OpsReservation[]>, listingId: string, from: DateStr, exceptId: string, r: OpsRules
): NextStay | null {
  const next = (byUnit.get(listingId) ?? [])
    .find(x => x.reservationId !== exceptId && x.arrival >= from);
  if (!next) return null;
  const gapDays = daysBetween(from, next.arrival);
  return {
    arrival: next.arrival,
    gapDays,
    total: gapDays <= r.nextResValueHorizonDays ? next.totalPaid : null,
    longVacancy: gapDays >= r.longVacancyDays
  };
}

export function inspectionPanel(
  listings: OpsListing[], reservations: OpsReservation[], done: OpsInspection[],
  scheduled: OpsInspection[], today: DateStr, r: OpsRules
): UnitInspection[] {
  // Newest first, so the first entry per unit is the last inspection.
  const log = [...done].sort((a, b) => b.date.localeCompare(a.date));
  const horizon = addDays(today, INSPECTION_LOOKAHEAD_DAYS);
  const order: Record<InspectionTier, number> = { never: 0, overdue: 1, soon: 2, ok: 3 };

  return listings.filter(l => l.active).map(l => {
    const k = unitKey(l.name);
    const mine = log.filter(e => unitKey(e.unit) === k);
    const last = mine[0] ?? null;
    const daysSince = last ? daysBetween(last.date, today) : null;
    const big = reservations
      .filter(x => x.listingId === l.id && x.arrival >= today && x.arrival <= horizon &&
                   x.totalPaid >= r.inspectionValueTrigger)
      .sort((a, b) => a.arrival.localeCompare(b.arrival))[0];
    const plan = scheduled.find(e => unitKey(e.unit) === k && e.date >= today);
    return {
      unitId: l.id, unit: l.name,
      last: last?.date ?? null, lastBy: last?.by ?? '', lastResult: last?.result ?? '',
      lastNotes: last?.notes ?? '', count: mine.length, daysSince,
      tier: inspectionTier(daysSince, r),
      nextBig: big ? { arrival: big.arrival, total: big.totalPaid } : null,
      scheduled: plan?.date ?? null
    };
  }).sort((a, b) => order[a.tier] - order[b.tier] || (b.daysSince ?? 0) - (a.daysSince ?? 0));
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function buildBoard(input: {
  today: DateStr;
  /** Days AFTER today; the sheet's "Next 10 days" shows today + 10. */
  windowDays: number;
  listings: OpsListing[];
  reservations: OpsReservation[];
  cleanings: Map<string, OpsCleaning>;
  notes: Map<string, string>;
  inspections: UnitInspection[];
  rules: OpsRules;
  /**
   * False when the Inspection Log could not be read. Then nothing is
   * known about past inspections, and "never inspected" would be a claim
   * about sixteen units made from zero evidence — so only the rule that
   * needs no history (a big booking next) still fires.
   */
  inspectionLogRead?: boolean;
}): BoardRow[] {
  const { today, windowDays, listings, reservations, cleanings, notes, inspections, rules } = input;
  const logRead = input.inspectionLogRead ?? true;
  const end = addDays(today, windowDays);
  const listing = new Map(listings.map(l => [l.id, l]));
  const insp = new Map(inspections.map(i => [i.unitId, i]));

  const byUnit = new Map<string, OpsReservation[]>();
  for (const x of [...reservations].sort((a, b) => a.arrival.localeCompare(b.arrival))) {
    const list = byUnit.get(x.listingId) ?? [];
    list.push(x);
    byUnit.set(x.listingId, list);
  }

  const rows: BoardRow[] = [];
  for (const x of reservations) {
    const l = listing.get(x.listingId);
    if (!l) continue;
    const base = {
      resId: x.reservationId, unitId: l.id, unit: l.name, beds: l.bedrooms,
      guest: x.guestName ?? '', guests: x.guests ?? null, nights: x.nights,
      channel: x.channel, total: x.totalPaid,
      next: null, cleaner: null, assignment: 'unknown' as const, price: null, deep: false,
      urgency: null, inDailyFile: false,
      inspection: { key: 'none' as InspectionKey, reason: '' }, preppedBy: null
    };
    if (x.arrival >= today && x.arrival <= end) {
      rows.push({ ...base, date: x.arrival, kind: 'in', time: null,
                  note: notes.get(`${x.reservationId}|checkin`) ?? '' });
    }
    if (x.departure >= today && x.departure <= end) {
      const c = cleanings.get(x.reservationId);
      rows.push({
        ...base, date: x.departure, kind: 'out',
        time: c?.checkoutTime ?? null,
        note: notes.get(`${x.reservationId}|checkout`) ?? '',
        next: nextStay(byUnit, x.listingId, x.departure, x.reservationId, rules),
        cleaner: c?.cleaner ?? null,
        assignment: c ? c.assignment : 'unknown',
        price: c?.price ?? null,
        deep: c?.deep ?? false,
        urgency: c?.urgency ?? null,
        beds: c?.beds ?? l.bedrooms,
        inDailyFile: !!c
      });
    }
  }

  // Date, then departures before arrivals — the clean comes before the
  // guest — then unit, so the order is the order the day happens in.
  rows.sort((a, b) => a.date.localeCompare(b.date) ||
    (a.kind === b.kind ? 0 : a.kind === 'out' ? -1 : 1) || a.unit.localeCompare(b.unit));

  // Inspections, the sheet's way: jobs in date order, so the monthly flag
  // lands on the unit's FIRST turnover in the window and not on every one.
  const flagged = new Set<string>();
  for (const row of rows) {
    if (row.kind !== 'out') continue;
    const rec = insp.get(row.unitId);
    const tier = rec?.tier ?? 'never';
    const nextVal = row.next?.total ?? 0;
    if (logRead && rec?.last && rec.last >= row.date) {
      row.inspection = { key: 'ok', reason:
        `Inspected ${rec.last}${rec.lastBy ? ` by ${rec.lastBy}` : ''}` +
        `${rec.lastResult ? ` — ${rec.lastResult}` : ''}.` };
    } else if (nextVal >= rules.inspectionValueTrigger) {
      row.inspection = { key: 'req', reason:
        `Next booking is ${money(nextVal)} (≥ ${money(rules.inspectionValueTrigger)}). ` +
        'Inspect at this turnover, before that guest arrives.' };
      flagged.add(row.unitId);
    } else if (logRead && !flagged.has(row.unitId) && (tier === 'overdue' || tier === 'never')) {
      row.inspection = { key: 'due', reason: rec?.last
        ? `Last inspected ${rec.last} — ${rec.daysSince} days ago (limit is ${rules.inspectionIntervalDays}).`
        : 'No inspection has ever been logged for this unit.' };
      flagged.add(row.unitId);
    }
  }

  // Who prepped each arrival: the last departure clean in that unit
  // before the guest walks in.
  for (const row of rows) {
    if (row.kind !== 'in') continue;
    const prep = rows.filter(o => o.kind === 'out' && o.unitId === row.unitId && o.date <= row.date &&
                                  o.assignment === 'assigned' && o.cleaner).pop();
    row.preppedBy = prep?.cleaner ?? null;
  }

  return rows;
}

export interface BoardSummary {
  arrivals: number; departures: number;
  /** Departures that need a clean — "no clean needed" is not a clean. */
  cleanings: number;
  /** Out and in on the same day, same unit: the tightest cleans. */
  turnovers: number;
  inspections: number;
  unassigned: number;
  unpriced: number;
  notInDailyFile: number;
  /** Cleaner pay for the window; only priced cleans count. */
  cleaningCost: number;
  arriving: number;
  pipeline: number;
}

export function summarize(rows: BoardRow[]): BoardSummary {
  const outs = rows.filter(r => r.kind === 'out');
  const cleans = outs.filter(r => r.assignment !== 'not_needed');
  return {
    arrivals: rows.length - outs.length,
    departures: outs.length,
    cleanings: cleans.length,
    turnovers: outs.filter(r => r.next?.gapDays === 0).length,
    inspections: outs.filter(r => r.inspection.key === 'req' || r.inspection.key === 'due').length,
    unassigned: cleans.filter(r => r.assignment === 'tbd').length,
    unpriced: cleans.filter(r => r.assignment === 'assigned' && r.price == null).length,
    notInDailyFile: outs.filter(r => !r.inDailyFile).length,
    cleaningCost: cleans.reduce((a, r) => a + (r.price ?? 0), 0),
    arriving: rows.filter(r => r.kind === 'in').reduce((a, r) => a + r.total, 0),
    pipeline: outs.reduce((a, r) => a + (r.next?.total ?? 0), 0)
  };
}
