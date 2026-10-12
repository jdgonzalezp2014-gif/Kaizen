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
 *   1. the RULE      — by stars (§121): the stars each clean requires
 *                      against the stars each cleaner has; or, until the
 *                      switch, the old tier by the value of the next
 *                      booking. Deep by stay length either way
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
  /** The name on the guest's documents folder (§73). */
  docName?: string;
  /** The rental agreement in Hostaway's guest portal (§89). */
  agreement?: 'signed' | 'not_signed' | null;
  /** Hostaway's identity verification (§89). */
  idVerified?: boolean;
  /** Only used to recognise the same guest booking again. Never shown. */
  phone?: string;
  /** A cancelled booking (§123): when, in New York time ("YYYY-MM-DD HH:MM"). */
  cancelledAt?: string | null;
  /** The guest's id on the channel (Airbnb's "-guest-<id>-"), to recognise a rebooking. */
  guestKey?: string | null;
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
  /** The old rule's tier; read only while `assignRule` is 'tiers'. */
  tier: 'high' | 'mid' | 'low';
  position: number;
  rates: Record<string, number | null>;
  deepRates: Record<string, number | null>;
  active: boolean;
  /** ★1–★5, set by hand (§121). */
  stars: number;
  /** Zones covered (see zoneOf). Empty is every zone. */
  zones: string[];
  /** Cleans a day at most; null is no limit. */
  maxPerDay: number | null;
  /** The levels rule (§125): high, standard, or manual (never picked by a rule). */
  level?: Level;
  /** The crew page (§122): the address they sign in with, how their invoice runs, whether a secret link exists. */
  email?: string | null;
  invoicePeriod?: 'weekly' | 'monthly';
  hasLink?: boolean;
}

/** Which rule decides who cleans (§121, §125). */
export type AssignRule = 'tiers' | 'stars' | 'levels';

/** A cleaner's level (§125). `manual` is only ever assigned by a person — emergencies, mid-stays. */
export type Level = 'high' | 'standard' | 'manual';
export const LEVELS: Level[] = ['high', 'standard', 'manual'];

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
  /** Stars (§121): the next guest's nightly price from which a clean needs ★2…★5. */
  starBand2From: number;
  starBand3From: number;
  starBand4From: number;
  starBand5From: number;
  /** The outgoing stay's nights from which it adds +1 / +2 stars. */
  starStayPlus1Nights: number;
  starStayPlus2Nights: number;
  /** Required when there is no price to go by at all. */
  starDefault: number;
  /** Levels (§125): the next guest's nightly price from which a clean needs the high level. */
  levelHighFromNightly: number;
  /** A stay this long needs the high level unless a mid-stay clean came recently. */
  levelLongStayNights: number;
  /** "Recently": a mid-stay clean this many days or fewer before the checkout. */
  levelMidStayDays: number;
  /** Assign only when the next guest checks in fewer than this many days after the checkout; else TBD. */
  levelNextWithinDays: number;
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
  inspectionValueTrigger: 2000,
  starBand2From: 100,
  starBand3From: 150,
  starBand4From: 200,
  starBand5From: 300,
  starStayPlus1Nights: 7,
  starStayPlus2Nights: 20,
  starDefault: 2,
  levelHighFromNightly: 200,
  levelLongStayNights: 10,
  levelMidStayDays: 5,
  levelNextWithinDays: 4
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

/** A reservation in Hostaway's dashboard (§90) — one place, so the link is fixed once if Hostaway moves it. */
export const hostawayReservationUrl = (resId: string) => `https://dashboard.hostaway.com/reservations/${encodeURIComponent(resId)}`;

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
  /** The next guest's price per night — null past the horizon, or for an iCal block. */
  nightly: number | null;
  longVacancy: boolean;
}

/** What the levels rule says about one clean (§125) — shown even while another rule decides, to compare. */
export interface LevelDecision {
  /** Null: nothing to go by yet — TBD until a booking lands close enough, or a person assigns it. */
  required: 'high' | 'standard' | null;
  why: string;
  cleaner: string | null;
  reason: string;
  /** TBD waiting for a booking within the window. */
  waiting: boolean;
}

/** What the star rule says about one clean — shown even while tiers decide, to compare. */
export interface StarDecision {
  required: number;
  /** How the required stars were reached, e.g. "next guest $180/night ★3 · 8-night stay +1". */
  why: string;
  cleaner: string | null;
  /** The picked cleaner's stars fall short — nobody available had enough. */
  below: boolean;
  reason: string;
}

export interface BoardRow {
  date: DateStr;
  kind: 'in' | 'out';
  resId: string;
  unitId: string;
  unit: string;
  beds: number | null;
  guest: string;
  /** The name on the guest's documents folder in Drive (§73). */
  docName: string;
  /** Rental agreement signed in Hostaway's guest portal (§89); null when Hostaway says nothing. */
  agreement: 'signed' | 'not_signed' | null;
  /** The guest's ID verified in Hostaway (§89). */
  idVerified: boolean;
  guests: number | null;
  nights: number;
  channel: string;
  total: number;
  time: string;
  note: string;
  /* departures */
  next: NextStay | null;
  /**
   * A deep clean is a person's call (§126): `deep` is true only when someone
   * set it. A long stay only suggests one.
   */
  deepSuggested: boolean;
  /** What the rule in charge says, before any person. */
  auto: { cleaner: string | null; tier: Tier; reason: string };
  /** The star rule's answer (§121), whichever rule is in charge; null when no clean is needed. */
  stars: StarDecision | null;
  /** The levels rule's answer (§125), whichever rule is in charge; null when no clean is needed. */
  levels: LevelDecision | null;
  /** Cleaners who turned this clean down on their page (§122), latest last. */
  declined: { cleaner: string; reason: string | null }[];
  /**
   * Cancelled on or after its arrival day (§123), New York time: the unit
   * may have been used. Held as TBD for a person to confirm; never assigned
   * by the rule.
   */
  cancelled: string | null;
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
  /**
   * Another reservation leaving this unit the same day owns the clean.
   * One unit, one day, one clean — see oneCleanPerUnitDay.
   */
  sameDayOf: string | null;
  /**
   * The listing is live in Hostaway. An archived listing can still have a
   * stay on the board (it earned what it earned, §50), but Hostaway
   * refuses any write to it — a Host Note included.
   */
  listed: boolean;
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

/* ── cancellations (§123) ─────────────────────────────────────────── */

/** Cancelled before noon, the unit is cleaned that day; later, the next. */
export const CANCEL_SAME_DAY_BEFORE_HOUR = 12;

/**
 * Hostaway's cancellation timestamp ("YYYY-MM-DD HH:MM:SS", taken as UTC)
 * in a time zone, as "YYYY-MM-DD HH:MM". Null when it cannot be read.
 */
export function utcToLocal(ts: string | null | undefined, timeZone: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(String(ts ?? ''));
  if (!m) return null;
  const at = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  if (Number.isNaN(at.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/**
 * A cancelled booking's clean, if it may have one: cancelled ON OR AFTER
 * the arrival day — the guest may have come — proposed that day when
 * before noon, else the next, never past the original checkout. Before
 * the arrival day nobody came: null, no clean.
 */
export function cancelledClean(arrival: DateStr, departure: DateStr, cancelledLocal: string | null): DateStr | null {
  if (!cancelledLocal) return null;
  const day = cancelledLocal.slice(0, 10), hour = Number(cancelledLocal.slice(11, 13));
  if (day < arrival) return null;
  const date = hour < CANCEL_SAME_DAY_BEFORE_HOUR ? day : addDays(day, 1);
  return date > departure ? departure : date;
}

const guestName = (n: string | undefined) => String(n ?? '').trim().toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ');

/**
 * A cancelled booking that is really a change: the same guest has a live
 * booking in the same unit whose nights overlap — an Airbnb change is a
 * cancel plus a new reservation minutes later (P2-4308, 10 Oct: "Jennifer
 * Dawn" cancelled at 18:06, "Jennifer Dawn Alvarez" booked at 18:12, same
 * dates). The same guest is the channel's guest id, else the phone, else
 * one name starting with the other. A different guest overlapping is NOT
 * a rebooking — the unit may well need a clean between them. Returns the
 * live reservation's id, or null.
 */
export function rebookedAs(c: OpsReservation, active: OpsReservation[]): string | null {
  const phone = digits(c.phone);
  const name = guestName(c.guestName);
  const hit = active.find(a => {
    if (a.listingId !== c.listingId || a.reservationId === c.reservationId) return false;
    if (!(a.arrival < c.departure && a.departure > c.arrival)) return false;
    if (c.guestKey && a.guestKey) return c.guestKey === a.guestKey;
    if (phone && phone === digits(a.phone)) return true;
    const other = guestName(a.guestName);
    return !!name && !!other && (other.startsWith(name) || name.startsWith(other));
  });
  return hit?.reservationId ?? null;
}

/* ── the star rule (§121) ─────────────────────────────────────────── */

/**
 * A unit's zone: the building for an apartment named "<building><number>"
 * ("CL1250", "CL 1125", "P2-1406" → CL, P2), "Houses" for everything
 * else. A cleaner covers zones, which is how "P2 goes to Veronica" stops
 * being an override typed every day.
 */
export const HOUSES_ZONE = 'Houses';
export function zoneOf(unitName: string): string {
  // The digits glued to the letters belong to the building only when a
  // separator follows them: "P2-1406" is P2, but "CL1250" is CL.
  const m = /^([a-z]+(?:\d+(?=[\s-]))?)[\s-]*\d{3,}$/i.exec(String(unitName ?? '').trim());
  return m ? m[1]!.toUpperCase() : HOUSES_ZONE;
}

export const covers = (c: Cleaner, zone: string) => !c.zones?.length || c.zones.includes(zone);

/** Stars a cleaner has, kept in 1–5 whatever was stored. */
export const starsOf = (c: Cleaner | undefined) => Math.min(5, Math.max(1, Math.round(Number(c?.stars) || 1)));

const isBlockStay = (x: OpsReservation) => /ical|block/i.test(x.channel) || x.totalPaid <= 0;

/**
 * Each unit's usual price per night: the median over its guest stays in
 * what was loaded (today through the look-ahead). Used when nothing is
 * booked next — the unit, not an empty calendar, sets the standard.
 */
export function typicalNightly(reservations: OpsReservation[]): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const x of reservations) {
    if (isBlockStay(x) || !(x.nights > 0)) continue;
    by.set(x.listingId, [...(by.get(x.listingId) ?? []), x.totalPaid / x.nights]);
  }
  const out = new Map<string, number>();
  for (const [id, v] of by) {
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    out.set(id, s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
  }
  return out;
}

/**
 * The stars one clean requires: a base from the next guest's nightly
 * price (the unit's usual price when nothing is booked inside the
 * horizon, ★default when no price is known at all), plus the outgoing
 * stay's length (a long stay leaves more behind), plus one for a
 * same-day turnover (no slack to fix a miss). Capped at ★5.
 */
export function requiredStars(
  nightly: number | null, typical: number | null, stayNights: number, sameDay: boolean, r: OpsRules
): { stars: number; why: string } {
  const bands = [r.starBand5From, r.starBand4From, r.starBand3From, r.starBand2From];
  const band = (p: number) => { const i = bands.findIndex(b => p >= b); return i < 0 ? 1 : 5 - i; };
  const parts: string[] = [];
  let base: number;
  if (nightly != null) { base = band(nightly); parts.push(`next guest $${Math.round(nightly)}/night ★${base}`); }
  else if (typical != null) { base = band(typical); parts.push(`nothing booked next — the unit's usual $${Math.round(typical)}/night ★${base}`); }
  else { base = Math.min(5, Math.max(1, Math.round(r.starDefault))); parts.push(`no price to go by ★${base}`); }
  const stay = stayNights >= r.starStayPlus2Nights ? 2 : stayNights >= r.starStayPlus1Nights ? 1 : 0;
  if (stay) parts.push(`${stayNights}-night stay +${stay}`);
  if (sameDay) parts.push('same-day turnover +1');
  const raw = base + stay + (sameDay ? 1 : 0);
  if (raw > 5) parts.push('capped at ★5');
  return { stars: Math.min(5, raw), why: parts.join(' · ') };
}

/**
 * Who cleans, by stars. Among cleaners who are active, cover the unit's
 * zone and are under their max that day: those with enough stars, the
 * cheapest for this clean (an unpriced one last), a tie going to whoever
 * has fewer cleans that day. When nobody available has enough stars, the
 * one with the most — flagged, never silently.
 */
export function pickByStars(
  required: number, zone: string, beds: number | null, deep: boolean,
  roster: Cleaner[], load: Map<string, number>,
  /** Cleaners who turned this clean down (§122) — never handed it back. */
  declined: Set<string> = new Set()
): { cleaner: string | null; below: boolean; reason: string } {
  const cost = (c: Cleaner) => rateFor(roster, c.name, beds, deep) ?? Infinity;
  const count = (c: Cleaner) => load.get(c.name) ?? 0;
  const active = roster.filter(c => c.active && !declined.has(c.name));
  const inZone = active.filter(c => covers(c, zone));
  const free = inZone.filter(c => c.maxPerDay == null || count(c) < c.maxPerDay);
  const byCost = (a: Cleaner, b: Cleaner) => cost(a) - cost(b) || count(a) - count(b) ||
    starsOf(b) - starsOf(a) || a.position - b.position || a.name.localeCompare(b.name);
  const price = (c: Cleaner) => Number.isFinite(cost(c)) ? `$${cost(c)}` : 'not priced';

  const ok = free.filter(c => starsOf(c) >= required).sort(byCost);
  if (ok.length) {
    const c = ok[0]!;
    return { cleaner: c.name, below: false, reason: ok.length === 1
      ? `${c.name} ★${starsOf(c)} is the only one with ★${required}+ free in ${zone} (${price(c)})`
      : `${c.name} ★${starsOf(c)} is the cheapest of ${ok.length} with ★${required}+ free in ${zone} (${price(c)})` };
  }
  const best = [...free].sort((a, b) => starsOf(b) - starsOf(a) || byCost(a, b))[0];
  if (best) {
    return { cleaner: best.name, below: true,
      reason: `nobody free in ${zone} has ★${required} — ${best.name} ★${starsOf(best)} has the most (${price(best)})` };
  }
  return { cleaner: null, below: false, reason: !active.length ? 'nobody is on the roster'
    : !inZone.length ? `nobody covers ${zone}` : `everyone who covers ${zone} is at their max that day` };
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
  /** Which rule decides (§121). The star rule's answer rides along either way. */
  assignRule?: AssignRule;
  /** Cleans turned down by a cleaner (§122), by reservation. */
  declines?: Map<string, { cleaner: string; reason: string | null }[]>;
  /** Cancelled bookings, each with `cancelledAt` (§123); those cancelled on or after arrival get a clean to confirm. */
  cancelled?: OpsReservation[];
  /** Mid-stay cleans done or planned, by unit id (§125) — they lighten a long stay's checkout. */
  midStays?: Map<string, DateStr[]>;
}): BoardRow[] {
  const { today, windowDays, listings, reservations, roster, rules, overrides, notes, inspections } = input;
  const end = addDays(today, windowDays);
  const listing = new Map(listings.map(l => [l.id, l]));
  const insp = new Map(inspections.map(i => [i.unitId, i]));
  const logRead = input.inspectionLogRead ?? true;
  const byStars = input.assignRule === 'stars';
  const typical = typicalNightly(reservations);

  const byUnit = new Map<string, OpsReservation[]>();
  for (const x of [...reservations].sort((a, b) => a.arrival.localeCompare(b.arrival) ||
                                                   a.departure.localeCompare(b.departure))) {
    byUnit.set(x.listingId, [...(byUnit.get(x.listingId) ?? []), x]);
  }
  const nextOf = (x: OpsReservation) =>
    (byUnit.get(x.listingId) ?? []).find(y => y.reservationId !== x.reservationId && y.arrival >= x.departure) ?? null;

  const rows: BoardRow[] = [];
  // A booking cancelled on or after its arrival day leaves on the proposed
  // day instead of its original checkout (§123).
  const cancelledStays = (input.cancelled ?? []).flatMap(x => {
    // Cancelled and booked again by the same guest is a change, not a cancellation (§126).
    if (rebookedAs(x, reservations)) return [];
    const d = cancelledClean(x.arrival, x.departure, x.cancelledAt ?? null);
    return d ? [{ ...x, departure: d }] : [];
  });
  for (const x of [...reservations, ...cancelledStays]) {
    const l = listing.get(x.listingId);
    if (!l) continue;
    const ov = overrides.get(x.reservationId);
    const cx = x.cancelledAt ?? null;
    const base: BoardRow = {
      date: x.arrival, kind: 'in', resId: x.reservationId, unitId: l.id, unit: l.name,
      beds: l.bedrooms, guest: x.guestName ?? '', docName: x.docName || x.guestName || 'Guest', agreement: x.agreement ?? null, idVerified: !!x.idVerified, guests: x.guests ?? null, nights: x.nights,
      channel: x.channel, total: x.totalPaid, time: '', note: '',
      next: null, auto: { cleaner: null, tier: 'none', reason: '' }, stars: null, levels: null,
      declined: input.declines?.get(x.reservationId) ?? [], cancelled: cx,
      cleaner: null, assignment: 'unknown', price: null, deep: false, deepSuggested: false, urgency: null,
      manual: { cleaner: false, deep: false, time: false },
      inspection: { key: 'none', reason: '' }, sheet: null, inDailyFile: false, differs: [],
      sameDayOf: null, listed: l.active, preppedBy: null
    };

    if (!cx && x.arrival >= today && x.arrival <= end) {
      rows.push({ ...base, time: ov?.checkinTime || DEFAULT_CHECKIN_TIME,
                  manual: { ...base.manual, time: !!ov?.checkinTime },
                  note: notes.get(`${x.reservationId}|checkin`) ?? '' });
    }
    if (x.departure < today || x.departure > end) continue;

    const nx = nextOf(x);
    const gapDays = nx ? daysBetween(x.departure, nx.arrival) : 0;
    const inHorizon = !!nx && gapDays <= rules.nextResValueHorizonDays;
    const next: NextStay | null = nx ? {
      arrival: nx.arrival, gapDays,
      total: inHorizon ? nx.totalPaid : null,
      nightly: inHorizon && !isBlockStay(nx) && nx.nights > 0 ? nx.totalPaid / nx.nights : null,
      longVacancy: gapDays >= rules.longVacancyDays
    } : null;

    // A cancelled stay is never assigned by a rule: a person confirms it was cleaned (§123).
    const stayed = cx ? daysBetween(x.arrival, x.departure) : x.nights;
    const auto = cx
      ? { cleaner: null, tier: 'none' as Tier, reason: `the booking was cancelled ${cx}, on or after its arrival — confirm whether the unit was used and who cleaned it` }
      : assign(x.nights, next, roster, rules);
    const manualCleaner = !!ov?.assignment;
    const assignment: Assignment = ov?.assignment ?? (auto.cleaner ? 'assigned' : 'tbd');
    const cleaner = assignment === 'assigned' ? (manualCleaner ? ov!.cleaner : auto.cleaner) : null;
    // Regular unless a person says deep (§126); a long stay only suggests it.
    const deep = ov?.deep ?? false;
    const deepSuggested = stayed >= rules.deepCleanNights;
    const price = assignment === 'assigned' ? rateFor(roster, cleaner, l.bedrooms, deep) : null;

    const sameDayIn = reservations.some(y => y.listingId === x.listingId && y.arrival === x.departure &&
                                             y.reservationId !== x.reservationId);
    const urgency: Urgency = sameDayIn && sameGuest(x, nx) ? 'same_guest'
      : sameDayIn ? 'turnover' : !nx ? 'no_next' : null;

    const sheet = input.sheet?.get(x.reservationId) ?? null;

    rows.push({
      ...base, date: x.departure, kind: 'out',
      time: ov?.checkoutTime || DEFAULT_CHECKOUT_TIME,
      note: notes.get(`${x.reservationId}|checkout`) ?? '',
      nights: stayed, next, auto, cleaner, assignment, deep, deepSuggested, price, urgency,
      manual: { cleaner: manualCleaner, deep: ov?.deep != null, time: !!ov?.checkoutTime },
      sheet, inDailyFile: !!sheet, differs: []
    });
  }

  // Date, then departures before arrivals — the clean comes before the
  // guest — then unit, so the order is the order the day happens in.
  rows.sort((a, b) => a.date.localeCompare(b.date) ||
    (a.kind === b.kind ? 0 : a.kind === 'out' ? -1 : 1) || a.unit.localeCompare(b.unit));
  oneCleanPerUnitDay(rows, overrides);
  assignByStars(rows, roster, rules, typical, byStars);
  assignByLevels(rows, roster, rules, input.midStays ?? new Map(), input.assignRule === 'levels', today);
  for (const r of rows) if (r.sheet) r.differs = sheetDiffers(r);

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

/* ── the levels rule (§125) ───────────────────────────────────────── */

export const levelOf = (c: Cleaner | undefined): Level => c?.level && LEVELS.includes(c.level) ? c.level : 'standard';
const LEVEL_WORD: Record<'high' | 'standard', string> = { high: 'high', standard: 'standard' };

/**
 * The level one clean needs. A long stay leaves a lot behind unless a
 * mid-stay clean came in its last days: high. Otherwise the next guest
 * decides — but only one checking in soon: further out, or nothing
 * booked, the clean stays TBD (a one-night guest a week away is not worth
 * the best cleaner now), until a booking lands close enough or a person
 * assigns it.
 */
export function requiredLevel(
  stayNights: number, midStayDaysBefore: number | null,
  next: { gapDays: number; nightly: number | null } | null, r: OpsRules
): { required: 'high' | 'standard' | null; why: string; waiting: boolean } {
  const recentMid = midStayDaysBefore !== null && midStayDaysBefore <= r.levelMidStayDays;
  if (stayNights >= r.levelLongStayNights && !recentMid) {
    return { required: 'high', waiting: false,
      why: `${stayNights}-night stay with no mid-stay clean in its last ${r.levelMidStayDays} days` };
  }
  const longNote = stayNights >= r.levelLongStayNights ? ` (${stayNights}-night stay, mid-stay clean ${midStayDaysBefore} days before)` : '';
  if (!next || next.gapDays >= r.levelNextWithinDays) {
    return { required: null, waiting: true, why: (next
      ? `next guest checks in ${next.gapDays} days later — only a check-in within ${r.levelNextWithinDays - 1} days is assigned`
      : 'nothing booked next') + longNote };
  }
  if (next.nightly == null) return { required: 'standard', waiting: false, why: `next is a block with no price${longNote}` };
  const high = next.nightly >= r.levelHighFromNightly;
  return { required: high ? 'high' : 'standard', waiting: false,
    why: `next guest $${Math.round(next.nightly)}/night ${high ? '≥' : '<'} $${r.levelHighFromNightly}${longNote}` };
}

/**
 * Who cleans, by level: active, not manual-only, the level or above,
 * covering the zone, under their max that day, not having declined it →
 * the cheapest for this clean (unpriced last); a tie goes to whoever has
 * fewer cleans that day. Nobody → TBD: a person decides.
 */
export function pickByLevel(
  required: 'high' | 'standard', zone: string, beds: number | null, deep: boolean,
  roster: Cleaner[], load: Map<string, number>, declined: Set<string> = new Set()
): { cleaner: string | null; reason: string } {
  const cost = (c: Cleaner) => rateFor(roster, c.name, beds, deep) ?? Infinity;
  const count = (c: Cleaner) => load.get(c.name) ?? 0;
  const fit = roster.filter(c => c.active && !declined.has(c.name) && levelOf(c) !== 'manual' &&
                                 (required === 'standard' || levelOf(c) === 'high'));
  const inZone = fit.filter(c => covers(c, zone));
  const free = inZone.filter(c => c.maxPerDay == null || count(c) < c.maxPerDay)
    .sort((a, b) => cost(a) - cost(b) || count(a) - count(b) || a.position - b.position || a.name.localeCompare(b.name));
  const c = free[0];
  if (c) {
    const price = Number.isFinite(cost(c)) ? `$${cost(c)}` : 'not priced';
    return { cleaner: c.name, reason: free.length === 1 ? `${c.name} is the only ${LEVEL_WORD[required]}-level cleaner free (${price})`
      : `${c.name} is the cheapest of ${free.length} free at ${LEVEL_WORD[required]} level or above (${price})` };
  }
  return { cleaner: null, reason: !fit.length ? `nobody at ${LEVEL_WORD[required]} level or above` : !inZone.length ? `nobody at that level covers ${zone}`
    : `everyone at that level who covers ${zone} is at their max that day — assign by hand` };
}

/**
 * The levels rule over the board's departures, one day at a time, the
 * high-level cleans first so they get the high-level cleaners' slots.
 * A person's choice takes its slot first. A cancelled stay (§123) and a
 * clean waiting for a booking are never assigned by the rule.
 */
export function assignByLevels(rows: BoardRow[], roster: Cleaner[], rules: OpsRules,
                               midStays: Map<string, DateStr[]>, apply: boolean, today: DateStr): void {
  const days = new Map<string, BoardRow[]>();
  for (const r of rows) {
    if (r.kind !== 'out' || (r.sameDayOf && !r.manual.cleaner)) continue;
    days.set(r.date, [...(days.get(r.date) ?? []), r]);
  }
  for (const day of days.values()) {
    const load = new Map<string, number>();
    for (const r of day) if (r.manual.cleaner && r.assignment === 'assigned' && r.cleaner) load.set(r.cleaner, (load.get(r.cleaner) ?? 0) + 1);
    const need = day.map(r => {
      // The latest mid-stay inside the stay, before its checkout.
      const arrival = addDays(r.date, -r.nights);
      const mid = (midStays.get(r.unitId) ?? []).filter(d => d >= arrival && d < r.date).sort().pop();
      return { r, req: requiredLevel(r.nights, mid ? daysBetween(mid, r.date) : null, r.next, rules) };
    });
    const rank = (x: typeof need[number]) => x.req.required === 'high' ? 0 : x.req.required === 'standard' ? 1 : 2;
    need.sort((a, b) => rank(a) - rank(b));
    for (const { r, req } of need) {
      const pick = req.required ? pickByLevel(req.required, zoneOf(r.unit), r.beds, r.deep, roster, load, new Set(r.declined.map(d => d.cleaner)))
        : { cleaner: null, reason: daysBetween(today, r.date) <= 1 ? 'TBD — assign by hand now' : `TBD until a booking lands close enough, or assign by hand by ${addDays(r.date, -1)}` };
      r.levels = { required: req.required, why: req.why, waiting: req.waiting, ...pick };
      if (apply && !r.cancelled) {
        r.auto = { cleaner: pick.cleaner, tier: 'none',
          reason: `${req.required ? `${LEVEL_WORD[req.required]} level` : 'no level yet'} (${req.why}) — ${pick.reason}` };
      }
      if (r.manual.cleaner || r.cancelled) continue;
      if (pick.cleaner) load.set(pick.cleaner, (load.get(pick.cleaner) ?? 0) + 1);
      if (!apply) continue;
      r.assignment = pick.cleaner ? 'assigned' : 'tbd';
      r.cleaner = pick.cleaner;
      r.price = pick.cleaner ? rateFor(roster, pick.cleaner, r.beds, r.deep) : null;
    }
  }
}

/** Shadow mode: the fields where the daily file decided differently. */
export function sheetDiffers(r: BoardRow): BoardRow['differs'] {
  const s = r.sheet, out: BoardRow['differs'] = [];
  if (!s || r.kind !== 'out') return out;
  if (s.assignment !== r.assignment || (r.assignment === 'assigned' && s.cleaner !== r.cleaner)) out.push('cleaner');
  if (r.assignment === 'assigned' && s.assignment === 'assigned' && (s.price ?? null) !== r.price) out.push('price');
  if (s.deep !== r.deep) out.push('deep');
  return out;
}

/**
 * The star rule over the board's departures, one day at a time (§121).
 *
 * A day's cleans are decided together because of the daily max: a
 * person's choice takes its slot first, then the rule fills the rest,
 * most demanding clean first — the ★5 turnover gets the scarce ★5
 * cleaner before a ★2 clean uses up her day.
 *
 * Every clean gets the star answer, so the board can show it beside the
 * tiers until the switch. Only with `apply` does it decide. A second
 * departure the same day carries no clean and gets none.
 */
export function assignByStars(rows: BoardRow[], roster: Cleaner[], rules: OpsRules,
                              typical: Map<string, number>, apply: boolean): void {
  const days = new Map<string, BoardRow[]>();
  for (const r of rows) {
    if (r.kind !== 'out' || (r.sameDayOf && !r.manual.cleaner)) continue;
    days.set(r.date, [...(days.get(r.date) ?? []), r]);
  }
  for (const day of days.values()) {
    const load = new Map<string, number>();
    for (const r of day) {
      if (r.manual.cleaner && r.assignment === 'assigned' && r.cleaner) load.set(r.cleaner, (load.get(r.cleaner) ?? 0) + 1);
    }
    const need = day.map(r => ({ r, req: requiredStars(r.next?.nightly ?? null, typical.get(r.unitId) ?? null,
                                                       r.nights, r.urgency === 'turnover', rules) }));
    need.sort((a, b) => b.req.stars - a.req.stars);
    for (const { r, req } of need) {
      const pick = pickByStars(req.stars, zoneOf(r.unit), r.beds, r.deep, roster, load,
                               new Set(r.declined.map(d => d.cleaner)));
      r.stars = { required: req.stars, why: req.why, ...pick };
      if (apply && !r.cancelled) r.auto = { cleaner: pick.cleaner, tier: 'none', reason: `★${req.stars} needed (${req.why}) — ${pick.reason}` };
      // A row a person decided is shown what the rule would say, and takes no slot for it;
      // a cancelled stay waits for a person (§123).
      if (r.manual.cleaner || r.cancelled) continue;
      if (pick.cleaner) load.set(pick.cleaner, (load.get(pick.cleaner) ?? 0) + 1);
      if (!apply) continue;
      r.assignment = pick.cleaner ? 'assigned' : 'tbd';
      r.cleaner = pick.cleaner;
      r.price = pick.cleaner ? rateFor(roster, pick.cleaner, r.beds, r.deep) : null;
    }
  }
}

/** An iCal import: a block mirrored from elsewhere, not a guest stay of its own. */
const isBlock = (r: BoardRow) => /ical|block/i.test(r.channel) || r.total <= 0;

/**
 * One unit, one day, one clean.
 *
 * Two reservations can leave the same unit on the same day — most often
 * an iCal block mirrored inside a real stay (Kingsford Home, 22 Sep: a
 * two-month direct stay and an "Airbnb (Not available)" block both ending
 * that day, recorded as $200 + $350 for one checkout). Only one clean
 * happens. It belongs to the real guest stay — not a block, the higher
 * value, the longer stay — and every other departure that day reads "no
 * clean needed", saying which reservation the clean belongs to.
 *
 * A person's choice still wins: a stay someone assigned by hand keeps it.
 */
export function oneCleanPerUnitDay(rows: BoardRow[], overrides: Map<string, Override>): void {
  const groups = new Map<string, BoardRow[]>();
  for (const r of rows) if (r.kind === 'out') groups.set(`${r.unitId}|${r.date}`, [...(groups.get(`${r.unitId}|${r.date}`) ?? []), r]);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const owner = [...group].sort((a, b) =>
      Number(isBlock(a)) - Number(isBlock(b)) || b.total - a.total || b.nights - a.nights)[0]!;
    for (const r of group) {
      if (r === owner) continue;
      r.sameDayOf = owner.resId;
      if (overrides.get(r.resId)?.assignment) continue;
      r.assignment = 'not_needed';
      r.cleaner = null;
      r.price = null;
      r.auto = { cleaner: null, tier: 'none',
        reason: `reservation ${owner.resId} also checks out of this unit today and carries the clean` };
    }
  }
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
