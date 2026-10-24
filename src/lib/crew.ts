/**
 * The crew page (§122) — what one cleaner sees: their cleans, what each
 * paid, what was flagged or left out, extras they asked for, and the
 * invoice Kaizen builds from all of it.
 *
 * Pure: the server reads the record, this decides what is billed. The
 * same function draws the cleaner's page and the team's preview of it,
 * so the two can never show different totals.
 */
import { addDays, addMonths, endOfMonth, startOfMonth, type DateStr } from './dates.ts';

export type InvoicePeriod = 'weekly' | 'monthly';

export interface Period {
  from: DateStr; to: DateStr; label: string;
  /** When it is paid: the Saturday after a week; a month, from the first of the next one. */
  payday: DateStr;
  /** The same, in words: "Saturday, Oct 17" or "the first days of November". */
  payNote: string;
  /** Dates the team picked (Operations → Cleaners), not one of the cleaner's invoice periods. */
  custom?: boolean;
}

export interface CrewClean {
  key: string; unit: string; date: DateStr; beds: number | null; deep: boolean;
  /** 'checkout', or a manual clean's kind (§79). */
  kind: string;
  price: number | null;
  assignment: string;
  /** Excluded from the record — never paid — and why. */
  voidReason: string | null;
  /** Flagged by hand by the team; does not change the pay. */
  flagNote: string | null;
  /** Corrected by the team after the fact (deep, price), and why (§123). */
  editNote?: string | null;
}

export type ExtraStatus = 'pending' | 'approved' | 'denied' | 'cancelled';
export interface CrewExtra {
  id: string; key: string; amount: number; description: string; status: ExtraStatus;
  decisionNote: string | null; decidedBy: string | null; createdAt: string;
  /** Evidence — receipts, invoices, photos — in Drive. */
  files?: { id: string; name: string; url: string }[];
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (d: DateStr) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

const dow = (d: DateStr) => new Date(`${d}T12:00:00Z`).getUTCDay();   // 0 = Sunday, 6 = Saturday
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The invoice period holding a day. Kaizen's crew week runs Saturday to
 * Friday and is paid the next day, Saturday; a monthly invoice covers the
 * whole month and is paid in the first days of the next — no fixed day.
 */
export function periodOf(d: DateStr, kind: InvoicePeriod): Period {
  if (kind === 'weekly') {
    const from = addDays(d, -((dow(d) - 6 + 7) % 7)), to = addDays(from, 6);
    const payday = addDays(to, 1);
    return { from, to, label: `${md(from)} – ${md(to)}, ${to.slice(0, 4)}`, payday, payNote: `Saturday, ${md(payday)}` };
  }
  const from = startOfMonth(d), to = endOfMonth(d), payday = addDays(to, 1);
  return { from, to, label: `${MON[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`, payday,
           payNote: `the first days of ${MONTH[Number(payday.slice(5, 7)) - 1]}` };
}

/**
 * Any span the team picks to review a cleaner's cleans (owner, 2026-10-24). It pays on
 * no day of its own: each clean is still paid with the invoice period it falls in.
 */
export function customPeriod(from: DateStr, to: DateStr): Period {
  return { from, to, label: `${md(from)} – ${md(to)}, ${to.slice(0, 4)}`, payday: periodOf(to, 'weekly').payday,
           payNote: 'with the invoice period each clean falls in', custom: true };
}

/** The current period and the `n - 1` before it, newest first. */
export function recentPeriods(today: DateStr, kind: InvoicePeriod, n: number): Period[] {
  const out: Period[] = [];
  let p = periodOf(today, kind);
  for (let i = 0; i < n; i++) {
    out.push(p);
    p = periodOf(kind === 'weekly' ? addDays(p.from, -1) : addMonths(p.from, -1), kind);
  }
  return out;
}

/** A clean counts on the invoice: theirs, done, not excluded. */
export const isBilled = (c: CrewClean, today: DateStr) =>
  c.assignment === 'assigned' && !c.voidReason && c.date <= today;

export interface Invoice {
  number: string;
  period: Period;
  /** The period has not ended: the invoice can still grow. */
  open: boolean;
  lines: { key: string; date: DateStr; unit: string; what: string; amount: number | null; flag: string | null }[];
  extras: { id: string; key: string; date: DateStr; unit: string; description: string; amount: number }[];
  /** In the period but not paid, with the reason. */
  excluded: { key: string; date: DateStr; unit: string; reason: string }[];
  pendingExtras: number;
  /** Cleans with no rate on the card — counted, never as $0. */
  unpriced: number;
  cleansTotal: number;
  extrasTotal: number;
  total: number;
}

const slug = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'CREW';

export function buildInvoice(name: string, period: Period, cleans: CrewClean[], extras: CrewExtra[],
                             today: DateStr): Invoice {
  const inPeriod = cleans.filter(c => c.date >= period.from && c.date <= period.to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.unit.localeCompare(b.unit));
  const billed = inPeriod.filter(c => isBilled(c, today));
  const byKey = new Map(billed.map(c => [c.key, c]));
  const what = (c: CrewClean) => [c.beds ? `${c.beds}BR` : null, c.deep ? 'deep clean' : 'clean',
    c.kind === 'early_departure' ? '(early departure)' : c.kind === 'mid_stay' ? '(mid-stay)' : c.kind === 'extra' ? '(extra)' : null]
    .filter(Boolean).join(' ');
  const lines = billed.map(c => ({ key: c.key, date: c.date, unit: c.unit, what: what(c), amount: c.price, flag: c.flagNote }));
  // An extra is paid with its clean: approved, and on a clean this invoice pays.
  const paidExtras = extras.filter(e => e.status === 'approved' && byKey.has(e.key)).map(e => {
    const c = byKey.get(e.key)!;
    return { id: e.id, key: e.key, date: c.date, unit: c.unit, description: e.description, amount: e.amount };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const cleansTotal = lines.reduce((a, l) => a + (l.amount ?? 0), 0);
  const extrasTotal = paidExtras.reduce((a, e) => a + e.amount, 0);
  const keys = new Set(inPeriod.map(c => c.key));
  return {
    number: `KZ-${slug(name)}-${period.from.replace(/-/g, '')}`,
    period, open: period.to >= today,
    lines, extras: paidExtras,
    excluded: inPeriod.filter(c => c.voidReason).map(c => ({ key: c.key, date: c.date, unit: c.unit, reason: c.voidReason! })),
    pendingExtras: extras.filter(e => e.status === 'pending' && keys.has(e.key)).length,
    unpriced: lines.filter(l => l.amount == null).length,
    cleansTotal, extrasTotal, total: cleansTotal + extrasTotal
  };
}

/** Limits on an extra a cleaner asks for. */
export const EXTRA_MAX_AMOUNT = 500;
export const EXTRA_MAX_AGE_DAYS = 60;

/* ── the confirmed schedule and what moved since (§122) ───────────── */

/** One assigned clean, as the schedule holds it. */
export interface ScheduleItem {
  key: string; cleaner: string; date: DateStr; unit: string; time: string;
  /** Assigned by a person — shown to the cleaner even before the whole schedule is (§123). */
  byHand?: boolean;
}

/**
 * What a cleaner can see ahead (§127): everything once the schedule is
 * published; until then what a person assigned, plus the rule's picks
 * within `autoDays` of the day — close enough that they rarely move. The
 * team's board marks these with 👁, so nobody has to confirm anything.
 */
export interface Visibility { published: boolean; autoDays: number }
export const visibleAhead = (i: { date: DateStr; byHand?: boolean }, day: DateStr, v: Visibility) =>
  v.published || !!i.byHand || i.date <= addDays(day, v.autoDays);

/** What became of a confirmed clean that is no longer on this cleaner's schedule. */
export type Fate =
  | { status: 'cancelled' }
  /** The checkout moved out of the schedule's window (a long extension). */
  | { status: 'moved'; to: DateStr }
  | { status: 'declined' }
  /** e.g. the guest left early and the unit was cleaned then (§79). */
  | { status: 'not_needed' }
  | { status: 'unassigned' }
  | { status: 'reassigned' };

export type Movement =
  | { kind: 'added'; key: string; unit: string; date: DateStr }
  /** later = the stay was extended; earlier = cut short. */
  | { kind: 'moved'; key: string; unit: string; from: DateStr; to: DateStr; later: boolean }
  | { kind: 'time'; key: string; unit: string; date: DateStr; from: string; to: string }
  | { kind: 'removed'; key: string; unit: string; date: DateStr; why: 'cancelled' | 'declined' | 'not_needed' | 'unassigned' | 'reassigned' };

/**
 * One cleaner's movements between the last snapshot of the schedule and
 * now — only among what they could see. A clean that merely came into
 * view as the days passed is not "new"; one that is new (or newly theirs)
 * and would have been in view is. Cleans already in the past are left
 * out — the schedule is about what is coming.
 */
export function scheduleMovements(
  cleaner: string,
  snap: { items: ScheduleItem[]; day: DateStr; through: DateStr; vis: Visibility },
  now: ScheduleItem[], today: DateStr, visNow: Visibility, fate: (key: string) => Fate
): Movement[] {
  const before = new Map(snap.items.filter(i => i.cleaner === cleaner && i.date >= today && visibleAhead(i, snap.day, snap.vis))
    .map(i => [i.key, i]));
  const all = now.filter(i => i.cleaner === cleaner);
  const mine = all.filter(i => visibleAhead(i, today, visNow));
  const out: Movement[] = [];
  for (const n of mine) {
    const b = before.get(n.key);
    if (!b) {
      if (n.date <= snap.through && visibleAhead(n, snap.day, snap.vis)) out.push({ kind: 'added', key: n.key, unit: n.unit, date: n.date });
      continue;
    }
    if (b.date !== n.date) out.push({ kind: 'moved', key: n.key, unit: n.unit, from: b.date, to: n.date, later: n.date > b.date });
    else if (b.time && n.time && b.time !== n.time) out.push({ kind: 'time', key: n.key, unit: n.unit, date: n.date, from: b.time, to: n.time });
  }
  const still = new Set(all.map(n => n.key));
  for (const b of before.values()) {
    if (still.has(b.key)) continue;
    const f = fate(b.key);
    if (f.status === 'moved') out.push({ kind: 'moved', key: b.key, unit: b.unit, from: b.date, to: f.to, later: f.to > b.date });
    else out.push({ kind: 'removed', key: b.key, unit: b.unit, date: b.date, why: f.status });
  }
  const at = (m: Movement) => 'date' in m ? m.date : m.from;
  return out.sort((a, b) => at(a).localeCompare(at(b)));
}

/** A movement in a sentence — to the cleaner ("you"), or to the team about them. */
export function movementText(m: Movement, day: (d: DateStr) => string, you = true): string {
  switch (m.kind) {
    case 'added': return `New: ${m.unit} on ${day(m.date)}`;
    case 'moved': return `${m.unit}: checkout moved from ${day(m.from)} to ${day(m.to)} (${m.later ? 'stay extended' : 'stay shortened'})`;
    case 'time': return `${m.unit} on ${day(m.date)}: checkout time changed from ${m.from} to ${m.to}`;
    // §134, the owner: a cleaner is told only that it is cancelled for them — not that someone else got it.
    case 'removed': return `${m.unit} on ${day(m.date)}: ${({
      cancelled: 'booking cancelled — no clean', declined: you ? 'you declined it' : 'declined',
      not_needed: 'no clean needed any more', unassigned: you ? 'cancelled' : 'taken off their schedule, not given to anyone yet',
      reassigned: you ? 'cancelled' : 'given to someone else' })[m.why]}`;
  }
}
