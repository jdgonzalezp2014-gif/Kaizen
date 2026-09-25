/**
 * Operations — who cleans each turnover, what it pays, what needs
 * inspecting. The engine the daily file ran, now run here.
 *
 * Pure: no fetch, no framework. Ported from the operations sheet rule
 * for rule (`03 MainSheet`, `11 Settings`, `07 Inspections`,
 * `14 HostawayNote`), because for a while both will run side by side and
 * any difference between them has to be a finding, not a porting slip.
 *
 * Three layers, applied in order, and a row always says which one
 * decided it:
 *
 *   1. the RULE      — tier by the value of the next booking, promoted
 *                      for long stays; deep by stay length
 *   2. an OVERRIDE   — what a person chose for this stay
 *   3. the SHEET     — shadow mode only: what the daily file decided,
 *                      shown beside ours so the two can be compared
 */
import { addDays, daysBetween, type DateStr } from './dates.ts';

/* ── inputs ───────────────────────────────────────────────────────── */

export interface OpsListing { id: string; name: string; bedrooms: number | null; active: boolean }

export interface OpsReservation {
  reservationId: string; listingId: string;
  arrival: DateStr; departure: DateStr; nights: number;
  totalPaid: number; channel: string;
  guestName?: string; guests?: number | null;
  /** Only used to recognise the same guest booking again. Never shown. */
  phone?: string;
}

export type Assignment = 'assigned' | 'tbd' | 'not_needed';

/** A decision about one checkout — the sheet's, or a person's. */
export interface OpsCleaning {
  cleaner: string | null;
  assignment: Assignment;
  price: number | null;
  deep: boolean;
  urgency: string | null;
  checkoutTime: string | null;
  beds: number | null;
}

export interface Override {
  assignment: Assignment | null;
  cleaner: string | null;
  /** Null: the stay-length rule decides. */
  deep: boolean | null;
  checkoutTime: string | null;
  checkinTime: string | null;
}

export interface Cleaner {
  name: string;
  tier: 'high' | 'mid' | 'low';
  position: number;
  rates: Record<string, number | null>;
  deepRates: Record<string, number | null>;
  active: boolean;
}

export interface OpsInspection { date: DateStr; unit: string; by: string; result: string; notes: string }

export interface OpsRules {
  cleanerHighThreshold: number;
  cleanerLowThreshold: number;
  longStayPromoteNights: number;
  deepCleanNights: number;
  longVacancyDays: number;
  nextResValueHorizonDays: number;
  inspectionIntervalDays: number;
  inspectionSoonDays: number;
  inspectionValueTrigger: number;
}

/** The sheet's compiled-in defaults (`00 Config`), for a key nobody has set. */
export const DEFAULT_RULES: OpsRules = {
  cleanerHighThreshold: 1500,
  cleanerLowThreshold: 900,
  longStayPromoteNights: 20,
  deepCleanNights: 20,
  longVacancyDays: 25,
  nextResValueHorizonDays: 30,
  inspectionIntervalDays: 30,
  inspectionSoonDays: 24,
  inspectionValueTrigger: 2000
};

/** Stored rules over the defaults. A missing or non-numeric key never reads as zero. */
export function withDefaults(raw: Record<string, unknown> | null | undefined): OpsRules {
  const out = { ...DEFAULT_RULES };
  for (const k of Object.keys(DEFAULT_RULES) as (keyof OpsRules)[]) {
    const n = Number(raw?.[k]);
    if (raw && raw[k] !== null && raw[k] !== '' && Number.isFinite(n) && n >= 0) out[k] = n;
  }
  return out;
}

export const DEFAULT_CHECKOUT_TIME = '10:00 AM';
export const DEFAULT_CHECKIN_TIME = '4:00 PM';
export const IMPLICIT_INSPECTORS = ['Manager', 'Owner'];
export const INSPECTION_RESULTS = ['OK', 'Minor issues', 'Maintenance needed', 'Urgent'] as const;
/** How far ahead the panel looks for a booking that forces an inspection. */
export const INSPECTION_LOOKAHEAD_DAYS = 45;
export const BEDROOM_SIZES = ['1', '2', '3', '4', '5'];

/* ── outputs ──────────────────────────────────────────────────────── */

export type InspectionKey = 'req' | 'due' | 'ok' | 'none';
export type InspectionTier = 'never' | 'overdue' | 'soon' | 'ok';
export type Urgency = 'turnover' | 'same_guest' | 'no_next' | null;
export type Tier = 'high' | 'mid' | 'low' | 'none';

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
  time: string;
  note: string;
  /* departures */
  next: NextStay | null;
  /** What the rule says, before any person. */
  auto: { cleaner: string | null; tier: Tier; reason: string };
  cleaner: string | null;
  assignment: Assignment | 'unknown';
  price: number | null;
  deep: boolean;
  urgency: Urgency;
  /** Which fields a person chose rather than the rule. */
  manual: { cleaner: boolean; deep: boolean; time: boolean };
  inspection: { key: InspectionKey; reason: string };
  /** Shadow mode: what the daily file decided, and whether it has seen this stay. */
  sheet: OpsCleaning | null;
  inDailyFile: boolean;
  /** Shadow mode: fields where the sheet and Kaizen disagree. */
  differs: ('cleaner' | 'price' | 'deep')[];
  /* arrivals */
  preppedBy: string | null;
}

export interface UnitInspection {
  unitId: string; unit: string;
  last: DateStr | null; lastBy: string; lastResult: string; lastNotes: string;
  count: number; daysSince: number | null; tier: InspectionTier;
  nextBig: { arrival: DateStr; total: number } | null;
  scheduled: DateStr | null;
}

/* ── small rules ──────────────────────────────────────────────────── */

/** Unit names are matched loosely: "P2 - 1406" and "p2-1406" are one unit. */
export const unitKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export function inspectionTier(daysSince: number | null, r: OpsRules): InspectionTier {
  if (daysSince === null) return 'never';
  if (daysSince >= r.inspectionIntervalDays) return 'overdue';
  if (daysSince >= r.inspectionSoonDays) return 'soon';
  return 'ok';
}

/** The first ACTIVE cleaner in a tier, by position — the one the rule picks. */
export function primaryFor(roster: Cleaner[], tier: 'high' | 'mid' | 'low'): string | null {
  return roster.filter(c => c.active && c.tier === tier)
    .sort((a, b) => a.position - b.position)[0]?.name ?? null;
}

/**
 * What a clean pays. Null — never 0 — when there is no rate: an unknown
 * cleaner, an unknown size, a blank on the card. A deep clean reads the
 * deep card first and FALLS BACK to the ordinary rate for a blank size,
 * which is what lets a roster with no deep card price exactly as before.
 */
export function rateFor(roster: Cleaner[], cleaner: string | null, beds: number | null, deep: boolean): number | null {
  if (!cleaner || !beds || !BEDROOM_SIZES.includes(String(beds))) return null;
  const c = roster.find(x => x.name === cleaner);
  if (!c) return null;
  const cell = (card: Record<string, number | null>) => {
    const v = card?.[String(beds)];
    return v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  return (deep ? cell(c.deepRates) : null) ?? cell(c.rates);
}

const digits = (p: string | undefined) => String(p ?? '').replace(/\D/g, '').slice(-10);
const plain = (n: string | undefined) => String(n ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The same guest booking again, back to back. BOTH name and a real phone
 * must match — a blank phone is "cannot tell", never a match, because a
 * name alone collides.
 */
export function sameGuest(a: OpsReservation, b: OpsReservation | null): boolean {
  if (!b) return false;
  const pa = digits(a.phone), pb = digits(b.phone);
  return !!pa && pa === pb && plain(a.guestName) === plain(b.guestName);
}

/**
 * The tier rule. Long stays are promoted first — a long stay leaves more
 * behind, whatever comes next. Then the value of the next booking, but
 * only one inside the horizon: a $2,000 stay a month out is not today's
 * turnover.
 */
export function assign(
  stayNights: number, next: NextStay | null, roster: Cleaner[], r: OpsRules
): { cleaner: string | null; tier: Tier; reason: string } {
  const pick = (tier: 'high' | 'mid' | 'low', reason: string) => {
    const name = primaryFor(roster, tier);
    return { cleaner: name, tier, reason: name ? reason : `${reason} — nobody is in the ${tier} tier` };
  };
  if (stayNights >= r.longStayPromoteNights) {
    return pick('high', `stay of ${stayNights} nights ≥ ${r.longStayPromoteNights} — long-stay promotion`);
  }
  const val = next?.total ?? null;          // null past the horizon
  if (val !== null && val >= r.cleanerHighThreshold) {
    return pick('high', `next booking $${Math.round(val)} ≥ $${r.cleanerHighThreshold}`);
  }
  if (val !== null && val > 0 && val <= r.cleanerLowThreshold) {
    return pick('low', `next booking $${Math.round(val)} ≤ $${r.cleanerLowThreshold}`);
  }
  const reason = val !== null ? 'next booking in the middle band'
    : next ? `next booking is ${next.gapDays} days out, beyond the ${r.nextResValueHorizonDays}-day horizon`
    : 'nothing booked next';
  return pick('mid', reason);
}

/* ── inspections ──────────────────────────────────────────────────── */

export function inspectionPanel(
  listings: OpsListing[], reservations: OpsReservation[], done: OpsInspection[],
  scheduled: OpsInspection[], today: DateStr, r: OpsRules
): UnitInspection[] {
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
    const plan = scheduled.filter(e => unitKey(e.unit) === k && e.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))[0];
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

/**
 * Who may inspect a turnover: anyone but the person who cleaned it. An
 * inspection audits the clean, and an audit by its own author is not one.
 */
export function eligibleInspectors(roster: Cleaner[], extra: string[], cleanedBy: string | null): string[] {
  const all = [...roster.filter(c => c.active).map(c => c.name), ...extra, ...IMPLICIT_INSPECTORS];
  return [...new Set(all)].filter(n => n !== cleanedBy);
}

/**
 * Inspections to book: each unit that is due (monthly) or has a big
 * booking coming (required) gets one at its NEXT checkout, the moment
 * someone is in the unit anyway. Required wins over monthly on the same
 * checkout. Units already holding a scheduled inspection are left alone,
 * so running it twice books nothing twice.
 */
export function proposeInspections(
  panel: UnitInspection[], reservations: OpsReservation[], today: DateStr, r: OpsRules
): { unitId: string; unit: string; date: DateStr; reservationId: string; reason: string }[] {
  const out = [];
  for (const p of panel) {
    if (p.scheduled) continue;
    const due = p.tier !== 'ok';
    if (!due && !p.nextBig) continue;
    const checkout = reservations
      .filter(x => x.listingId === p.unitId && x.departure >= today)
      .sort((a, b) => a.departure.localeCompare(b.departure))[0];
    if (!checkout) continue;
    const reason = p.nextBig
      ? `Required — a $${Math.round(p.nextBig.total)} booking arrives ${p.nextBig.arrival}`
      : p.tier === 'never' ? 'Monthly — never inspected'
      : `Monthly — ${p.daysSince} days since the last one (limit ${r.inspectionIntervalDays})`;
    out.push({ unitId: p.unitId, unit: p.unit, date: checkout.departure,
               reservationId: checkout.reservationId, reason });
  }
  return out;
}

/* ── the board ────────────────────────────────────────────────────── */

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

export function buildBoard(input: {
  today: DateStr;
  /** Days AFTER today; the sheet's "Next 10 days" shows today + 10. */
  windowDays: number;
  listings: OpsListing[];
  reservations: OpsReservation[];
  roster: Cleaner[];
  rules: OpsRules;
  overrides: Map<string, Override>;
  /** Current note per `${resId}|${kind}`. */
  notes: Map<string, string>;
  inspections: UnitInspection[];
  /** Shadow mode only: the daily file's decisions, by reservation. */
  sheet?: Map<string, OpsCleaning> | null;
  /** False when no inspection history is known — see below. */
  inspectionLogRead?: boolean;
}): BoardRow[] {
  const { today, windowDays, listings, reservations, roster, rules, overrides, notes, inspections } = input;
  const end = addDays(today, windowDays);
  const listing = new Map(listings.map(l => [l.id, l]));
  const insp = new Map(inspections.map(i => [i.unitId, i]));
  const logRead = input.inspectionLogRead ?? true;

  const byUnit = new Map<string, OpsReservation[]>();
  for (const x of [...reservations].sort((a, b) => a.arrival.localeCompare(b.arrival) ||
                                                   a.departure.localeCompare(b.departure))) {
    byUnit.set(x.listingId, [...(byUnit.get(x.listingId) ?? []), x]);
  }
  const nextOf = (x: OpsReservation) =>
    (byUnit.get(x.listingId) ?? []).find(y => y.reservationId !== x.reservationId && y.arrival >= x.departure) ?? null;

  const rows: BoardRow[] = [];
  for (const x of reservations) {
    const l = listing.get(x.listingId);
    if (!l) continue;
    const ov = overrides.get(x.reservationId);
    const base: BoardRow = {
      date: x.arrival, kind: 'in', resId: x.reservationId, unitId: l.id, unit: l.name,
      beds: l.bedrooms, guest: x.guestName ?? '', guests: x.guests ?? null, nights: x.nights,
      channel: x.channel, total: x.totalPaid, time: '', note: '',
      next: null, auto: { cleaner: null, tier: 'none', reason: '' },
      cleaner: null, assignment: 'unknown', price: null, deep: false, urgency: null,
      manual: { cleaner: false, deep: false, time: false },
      inspection: { key: 'none', reason: '' }, sheet: null, inDailyFile: false, differs: [],
      preppedBy: null
    };

    if (x.arrival >= today && x.arrival <= end) {
      rows.push({ ...base, time: ov?.checkinTime || DEFAULT_CHECKIN_TIME,
                  manual: { ...base.manual, time: !!ov?.checkinTime },
                  note: notes.get(`${x.reservationId}|checkin`) ?? '' });
    }
    if (x.departure < today || x.departure > end) continue;

    const nx = nextOf(x);
    const gapDays = nx ? daysBetween(x.departure, nx.arrival) : 0;
    const next: NextStay | null = nx ? {
      arrival: nx.arrival, gapDays,
      total: gapDays <= rules.nextResValueHorizonDays ? nx.totalPaid : null,
      longVacancy: gapDays >= rules.longVacancyDays
    } : null;

    const auto = assign(x.nights, next, roster, rules);
    const manualCleaner = !!ov?.assignment;
    const assignment: Assignment = ov?.assignment ?? (auto.cleaner ? 'assigned' : 'tbd');
    const cleaner = assignment === 'assigned' ? (manualCleaner ? ov!.cleaner : auto.cleaner) : null;
    const deep = ov?.deep ?? (x.nights >= rules.deepCleanNights);
    const price = assignment === 'assigned' ? rateFor(roster, cleaner, l.bedrooms, deep) : null;

    const sameDayIn = reservations.some(y => y.listingId === x.listingId && y.arrival === x.departure &&
                                             y.reservationId !== x.reservationId);
    const urgency: Urgency = sameDayIn && sameGuest(x, nx) ? 'same_guest'
      : sameDayIn ? 'turnover' : !nx ? 'no_next' : null;

    const sheet = input.sheet?.get(x.reservationId) ?? null;
    const differs: BoardRow['differs'] = [];
    if (sheet) {
      if ((sheet.assignment !== assignment) || (assignment === 'assigned' && sheet.cleaner !== cleaner)) differs.push('cleaner');
      if (assignment === 'assigned' && sheet.assignment === 'assigned' && (sheet.price ?? null) !== price) differs.push('price');
      if (sheet.deep !== deep) differs.push('deep');
    }

    rows.push({
      ...base, date: x.departure, kind: 'out',
      time: ov?.checkoutTime || DEFAULT_CHECKOUT_TIME,
      note: notes.get(`${x.reservationId}|checkout`) ?? '',
      next, auto, cleaner, assignment, deep, price, urgency,
      manual: { cleaner: manualCleaner, deep: ov?.deep != null, time: !!ov?.checkoutTime },
      sheet, inDailyFile: !!sheet, differs
    });
  }

  // Date, then departures before arrivals — the clean comes before the
  // guest — then unit, so the order is the order the day happens in.
  rows.sort((a, b) => a.date.localeCompare(b.date) ||
    (a.kind === b.kind ? 0 : a.kind === 'out' ? -1 : 1) || a.unit.localeCompare(b.unit));

  // Inspections, the sheet's way: in date order, so the monthly flag
  // lands on a unit's FIRST turnover in the window and not every one.
  const flagged = new Set<string>();
  for (const row of rows) {
    if (row.kind !== 'out') continue;
    const rec = insp.get(row.unitId);
    const tier = rec?.tier ?? 'never';
    const nextVal = row.next?.total ?? 0;
    if (logRead && rec?.last && rec.last >= row.date) {
      row.inspection = { key: 'ok', reason:
        `Inspected ${rec.last}${rec.lastBy ? ` by ${rec.lastBy}` : ''}${rec.lastResult ? ` — ${rec.lastResult}` : ''}.` };
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

  // Who prepped each arrival: the last clean in that unit before the guest.
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
  turnovers: number;
  inspections: number;
  unassigned: number;
  unpriced: number;
  /** Shadow mode: checkouts the daily file has not seen, and ones it decided differently. */
  notInDailyFile: number;
  differing: number;
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
    turnovers: outs.filter(r => r.urgency === 'turnover').length,
    inspections: outs.filter(r => r.inspection.key === 'req' || r.inspection.key === 'due').length,
    unassigned: cleans.filter(r => r.assignment === 'tbd').length,
    unpriced: cleans.filter(r => r.assignment === 'assigned' && r.price == null).length,
    notInDailyFile: outs.filter(r => !r.inDailyFile).length,
    differing: outs.filter(r => r.differs.length > 0).length,
    cleaningCost: cleans.reduce((a, r) => a + (r.price ?? 0), 0),
    arriving: rows.filter(r => r.kind === 'in').reduce((a, r) => a + r.total, 0),
    pipeline: outs.reduce((a, r) => a + (r.next?.total ?? 0), 0)
  };
}

/* ── the Host Note in Hostaway ────────────────────────────────────── */

const oneLine = (t: string) => String(t ?? '').replace(/\s*\n+\s*/g, ' ').trim();

/**
 * The lines Kaizen owns in a reservation's Host Note. No labels beyond
 * which end of the stay each line is about, and a note never shares a
 * line with a person's name — "Michelle: guest wants to extend" reads as
 * something Michelle said.
 */
export function hostNoteBlock(m: {
  checkin?: { time: string; note: string } | null;
  checkout?: { time: string; cleaner: string; note: string } | null;
}): string {
  const lines: string[] = [];
  if (m.checkin) {
    if (m.checkin.time && m.checkin.time !== DEFAULT_CHECKIN_TIME) lines.push(`Check-in ${m.checkin.time}`);
    if (m.checkin.note) lines.push(`Check-in note: ${oneLine(m.checkin.note)}`);
  }
  if (m.checkout) {
    lines.push(`Check-out ${m.checkout.time || DEFAULT_CHECKOUT_TIME} · Cleaner: ${m.checkout.cleaner || '—'}`);
    if (m.checkout.note) lines.push(`Check-out note: ${oneLine(m.checkout.note)}`);
  }
  return lines.join('\n');
}

const OUR_LINE = /^Check-(in|out)\b/;
const LEGACY_BLOCK = /⟦[^⟧\n]*KAIZEN[^⟧\n]*⟧[\s\S]*?⟦\/KAIZEN⟧/m;

/**
 * Our block into whatever the Host Note already holds, replacing the
 * block written last time and keeping everything a person typed. Ours is
 * the FIRST contiguous run of lines starting "Check-in"/"Check-out" —
 * the same recognition the sheet used, so a note it wrote is replaced
 * rather than duplicated when Kaizen takes over.
 */
export function mergeHostNote(existing: string, block: string): string {
  const cur = String(existing ?? '').replace(LEGACY_BLOCK, '').trim();
  const lines = cur ? cur.split('\n') : [];
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (OUR_LINE.test(lines[i]!.trim())) {
      if (start < 0) start = i;
      end = i;
    } else if (start >= 0) {
      break;   // the run ended — only the FIRST one is ours
    }
  }
  if (start >= 0) {
    return [...lines.slice(0, start), ...(block ? [block] : []), ...lines.slice(end + 1)]
      .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  if (!block) return cur;
  return cur ? `${cur}\n\n${block}` : block;
}

/** The block for one reservation, from the board's rows for it. */
export function blockForReservation(rows: BoardRow[], resId: string): string {
  const inRow = rows.find(r => r.resId === resId && r.kind === 'in');
  const outRow = rows.find(r => r.resId === resId && r.kind === 'out');
  // Spelled exactly as the daily file wrote them, emoji included. The Host
  // Notes already in Hostaway carry these words; matching them means the
  // day Kaizen takes over, a note that says the same thing reads as
  // unchanged instead of being rewritten across the whole calendar.
  const cleanerText = (r: BoardRow) =>
    r.assignment === 'not_needed' ? '🚫 Not needed' : r.assignment === 'assigned' ? (r.cleaner ?? '—') : '❓ TBD';
  return hostNoteBlock({
    checkin: inRow ? { time: inRow.time, note: inRow.note } : null,
    checkout: outRow ? { time: outRow.time, cleaner: cleanerText(outRow), note: outRow.note } : null
  });
}
