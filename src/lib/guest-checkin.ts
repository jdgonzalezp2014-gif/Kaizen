/**
 * Online check-in (guests module, 2026-11-15): the steps a guest completes before the door code and the house
 * manual open — the boss's reference is Hostop's portal (docs/modules/guests.md, "Reference: Hostop demo").
 * Owner's cut: the guest's name, email, phone and party come from the Hostaway reservation (confirm, never retype);
 * identity verification is a placeholder until Truvi vs Stripe Identity is decided; one payment at the end
 * (protection + paid extras) through Stripe — demo only for now. Pure: no fetch, no React.
 */
import { kindOf } from './unit-access.ts';
import { UPSELLS, APPROVAL_NOTE, needsApproval, priceOf, quote, availability, allowedTime, minutesOf, type Choice, type GuestStay, type UpsellKind } from './guest-portal.ts';

/** Protection values depend on what is rented: a room is not a house (owner, 2026-11-15). Per listing in the Repository. */
export type UnitType = 'room' | 'apartment' | 'house';
/** `waiver.price` is what this stay pays: the per-night rate × nights, never under the minimum (owner, 2026-11-23). */
export interface Protection { waiver: { price: number; min: number; perNight: number; cap: number }; deposit: { hold: number } }

/** Owner, 2026-11-23, every listing: $300 deposit, or a waiver of $12 a night with a $70 minimum. Caps are still placeholders. */
const STANDARD = { min: 70, perNight: 12, hold: 300 };
export const PROTECTION_DEFAULTS: Record<UnitType, { waiver: { min: number; perNight: number; cap: number }; deposit: { hold: number } }> = {
  room: { waiver: { min: STANDARD.min, perNight: STANDARD.perNight, cap: 1000 }, deposit: { hold: STANDARD.hold } },
  apartment: { waiver: { min: STANDARD.min, perNight: STANDARD.perNight, cap: 1500 }, deposit: { hold: STANDARD.hold } },
  house: { waiver: { min: STANDARD.min, perNight: STANDARD.perNight, cap: 3000 }, deposit: { hold: STANDARD.hold } },
};

export interface ProtectionOverride { waiverMin?: number | null; waiverNight?: number | null; waiverCap?: number | null; depositHold?: number | null }

/** The unit type's defaults, with whatever the listing sets on top (a blank field keeps the default), for a stay of `nights`. */
export function protectionFor(type: UnitType, o: ProtectionOverride = {}, nights = 1): Protection {
  const d = PROTECTION_DEFAULTS[type];
  const n = (v: number | null | undefined, def: number) => (v != null && Number.isFinite(v) && v >= 0 ? v : def);
  const min = n(o.waiverMin, d.waiver.min), perNight = n(o.waiverNight, d.waiver.perNight);
  const price = Math.round(Math.max(min, perNight * Math.max(1, Math.round(nights))) * 100) / 100;
  return { waiver: { price, min, perNight, cap: n(o.waiverCap, d.waiver.cap) }, deposit: { hold: n(o.depositHold, d.deposit.hold) } };
}

/**
 * The record's unit type (Guest portal, migration 110) and protection values — Fees since 2026-11-23 (migration 122):
 * Refundable damage deposit, Damage waiver per night (the same field as Hostaway's nightly fee), Damage waiver minimum.
 * Blanks keep the defaults.
 */
export function portalFrom(vals: Record<string, unknown> | null | undefined): { unitType: UnitType | null; protection: ProtectionOverride } {
  const num = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[$,\s]/g, '')) : NaN; return Number.isFinite(n) && n >= 0 ? n : null; };
  const t = typeof vals?.unit_type === 'string' ? vals.unit_type.toLowerCase() : '';
  // Blank Unit type → the record's existing Property type (Apartment, House, Condo, Private room…), so nothing is typed twice.
  const pt = typeof vals?.property_type === 'string' ? vals.property_type.toLowerCase() : '';
  const fromPt: UnitType | null = /room/.test(pt) ? 'room' : /apartment|condo|loft|studio|flat/.test(pt) ? 'apartment' : /house|home|villa|townhouse|cottage|cabin/.test(pt) ? 'house' : null;
  return {
    unitType: t === 'room' || t === 'apartment' || t === 'house' ? t : fromPt,
    protection: { waiverMin: num(vals?.waiver_price), waiverNight: num(vals?.insurance_fee), waiverCap: num(vals?.waiver_cap),
      depositHold: num(vals?.damage_deposit) ?? num(vals?.deposit_hold) },
  };
}

/**
 * Airbnb guests (owner, 2026-11-23) get the same waiver / deposit as everyone, plus a small "None of them": with no
 * protection, any damage goes to Airbnb as a claim. Other channels must pick one of the two.
 */
export const channelCovers = (s: Pick<GuestStay, 'channel'>) => s.channel === 'airbnb';
const protectionDone = (f: Pick<Flow, 'protection'>, s: Pick<GuestStay, 'channel'>) =>
  f.protection === 'waiver' || f.protection === 'deposit' || (f.protection === 'none' && channelCovers(s));

/** A phone number as the guest typed it → +E.164 (10 digits = US/Canada), or null when it cannot be one. */
export function cleanPhone(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const plus = v.trim().startsWith('+'), d = v.replace(/\D/g, '');
  if (!plus && d.length === 10) return `+1${d}`;
  if (!plus && d.length === 11 && d.startsWith('1')) return `+${d}`;
  return plus && d.length >= 8 && d.length <= 15 ? `+${d}` : null;
}

/** An email as typed → trimmed and lower-cased, or null when it is not one. */
export const cleanEmail = (v: unknown) => typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) && v.trim().length <= 200 ? v.trim().toLowerCase() : null;

/** The guest's arrival time as shown ("6:30 PM", or LATE_ARRIVAL) — picked on a sliding strip (owner, 2026-11-16). */
export type Arrival = string;
export const LATE_ARRIVAL = 'After midnight';
export interface Flow {
  details: boolean;
  arrival: Arrival | null;
  /** The mobile number the guest confirmed or typed at check-in (owner, 2026-11-23: Airbnb's number does not work) — +E.164. */
  phone?: string | null;
  /** The email the guest confirmed or corrected at check-in. */
  email?: string | null;
  /** "Something is wrong" on the booking details: what the guest wrote. The real link opens a task for the team. */
  changeAsk?: string | null;
  identity: boolean;
  protection: 'waiver' | 'deposit' | 'none' | null;
  rules: boolean;
  /** Extras picked during check-in, with the guest's choice (time, …). */
  extras: Partial<Record<UpsellKind, Choice>>;
  extrasSeen: boolean;
  paid: boolean;
  /** Nights added by a paid extension (extendStay) — the stay's dates follow it. */
  extended?: { before: number; after: number } | null;
  /** What Stripe says was paid today (shown as the confirmation). */
  paidTotal?: number | null;
}
/** The check-in answers kept in the tab while the guest is on Stripe Checkout (the page reloads when they come back). */
export const FLOW_KEY = 'kaizen-guest-flow';
/** The Stripe Identity session id, kept in the tab while the guest is on Stripe's page. */
export const VS_KEY = 'kaizen-guest-vs';
export const newFlow = (): Flow => ({ details: false, arrival: null, identity: false, protection: null, rules: false, extras: {}, extrasSeen: false, paid: false });
/** A finished check-in (the demo's "checked in" stay). */
export const doneFlow = (): Flow => ({ details: true, arrival: '6:00 PM', identity: true, protection: 'waiver', rules: true, extras: {}, extrasSeen: true, paid: true });

/** Extras offered inside check-in — charged with the one payment (owner, 2026-11-17: nothing waits for an OK). */
export const FLOW_EXTRAS: UpsellKind[] = ['early-checkin', 'late-checkout', 'mid-clean', 'parking', 'welcome'];

export type StepKey = 'details' | 'identity' | 'protection' | 'rules' | 'extras' | 'pay';
export interface Step { key: StepKey; title: string; sub: string; done: boolean; required: boolean }

/** Owner, 2026-11-23: the ID + selfie step stays hidden until Stripe Identity is approved and the flow finished — flip to true to bring it back. */
export const IDENTITY_STEP_ON = false;

/** The steps in order. Extras are optional; Pay shows only when something is charged or held. */
export function steps(f: Flow, s: GuestStay, p: Protection, now: Date = new Date()): Step[] {
  const out: Step[] = [
    { key: 'details', title: 'Your details', sub: 'Confirm who is staying', done: f.details, required: true },
    ...(IDENTITY_STEP_ON ? [{ key: 'identity' as const, title: 'Identity', sub: 'ID and a quick selfie', done: f.identity, required: true }] : []),
    { key: 'protection', title: 'Damage protection', sub: 'Waiver or deposit', done: protectionDone(f, s), required: true },
    { key: 'rules', title: 'House rules', sub: 'Read and agree', done: f.rules, required: true },
    { key: 'extras', title: 'Extras', sub: 'Optional', done: f.extrasSeen, required: false },
  ];
  if (bill(f, s, p, now).lines.length) out.push({ key: 'pay', title: 'Review and pay', sub: 'One payment, then you are in', done: f.paid, required: true });
  return out;
}

export const progress = (st: Step[]) => { const r = st.filter(x => x.required); return { done: r.filter(x => x.done).length, of: r.length }; };
/** The next step to do: the first required one not done (extras once, before paying). */
export function nextStep(st: Step[]): StepKey | null {
  for (const x of st) if (!x.done && (x.required || x.key === 'extras')) return x.key;
  return null;
}

/** `item` = the upsell kind, `waiver` or `deposit` — what the books record the line as (guest-payments.ts). */
export interface BillLine { label: string; amount: number; kind: 'charge' | 'hold'; note?: string; item?: string }
const cents = (n: number) => Math.round(n * 100) / 100;

/** What the one payment covers: charges today and a hold that is released after check-out. */
export function bill(f: Flow, s: GuestStay, p: Protection, now: Date = new Date()): { lines: BillLine[]; today: number; hold: number } {
  const lines: BillLine[] = [];
  if (f.protection === 'waiver') lines.push({ label: 'Damage waiver', amount: p.waiver.price, kind: 'charge', item: 'waiver', note: `Covers up to $${p.waiver.cap.toLocaleString('en-US')}` });
  if (f.protection === 'deposit') lines.push({ label: 'Security deposit', amount: p.deposit.hold, kind: 'hold', item: 'deposit', note: 'Held on your card, released after check-out' });
  for (const k of FLOW_EXTRAS) {
    const c = f.extras[k];
    const u = UPSELLS.find(x => x.kind === k);
    if (!c || !u) continue;
    const q = quote(s, u, c);
    // Not offered any more (a turnover came up since it was picked): it drops off the bill.
    if (q == null || !availability(s, u, now).ok || !allowedTime(s, u, c.time, now)) continue;
    lines.push({ label: u.title, amount: q, kind: 'charge', item: k, note: c.time ? (k === 'early-checkin' ? `From ${c.time}` : `Until ${c.time}`) + (needsApproval(s, u, now) ? ` · ${APPROVAL_NOTE}` : '') : undefined });
  }
  const sum = (k: BillLine['kind']) => cents(lines.filter(l => l.kind === k).reduce((a, l) => a + l.amount, 0));
  return { lines, today: sum('charge'), hold: sum('hold') };
}

/** Which extras the stay can take during check-in (the calendar and the stay length still decide). */
export function flowExtras(s: GuestStay) {
  return FLOW_EXTRAS.filter(k => !s.notOffered?.includes(k)).map(k => UPSELLS.find(u => u.kind === k)!).filter(u => availability(s, u).ok && priceOf(s, u) != null)
    .map(u => ({ u }));
}

/** The entry details (door code, Wi-Fi, guide): every required step done, then the release time. */
export function entry(f: Flow, s: GuestStay, p: Protection, now: Date): { open: true } | { open: false; why: 'steps' | 'release'; at?: string } {
  if (nextStep(steps(f, s, p, now).filter(x => x.required)) != null) return { open: false, why: 'steps' };
  if (!s.guideReleaseAt || Date.parse(s.guideReleaseAt) > now.getTime()) return { open: false, why: 'release', at: s.guideReleaseAt ?? undefined };
  return { open: true };
}

/**
 * House rules as short items (title + one line) from the Repository's free text: one per line or bullet;
 * "Title: detail" or "Title — detail" splits; a long line keeps its first sentence as the title.
 */
export function rulesList(text: string | null | undefined): { title: string; detail: string }[] {
  if (!text) return [];
  return text.split(/\r?\n|•|·(?=\s)|;\s+|(?<=\.)\s+(?=[A-Z])/).map(l => l.replace(/^\s*(?:[-*–]|\d+[.)])\s*/, '').trim()).filter(l => l.length > 1)
    .map(l => {
      const m = /^(.{3,48}?)\s*(?::|\s—\s|\s-\s)\s*(.+)$/.exec(l);
      if (m) return { title: m[1]!.trim(), detail: m[2]!.trim() };
      return { title: l.replace(/\.$/, ''), detail: '' };
    }).slice(0, 12);
}

/** The demo house's rules (Repository text shape) — what shows when a listing has none filled. */
export const SAMPLE_RULES = [
  'Check-out by 11:00 AM: so the team can get the home ready for the next guest',
  'Quiet hours 10 PM – 8 AM: please respect the neighbours',
  'No smoking indoors: a $250 cleaning fee applies',
  'No parties or events: only registered guests stay overnight',
  'Pets with approval only: a pet fee is added to the stay',
].join('\n');


/**
 * The door code the guest sees, read from the Repository's Lock type (owner, 2026-11-15 — never set per house in the portal):
 * a smart lock → the reservation's own Hostaway code, else the record's "Guest check-in code" (Preston: Hostaway has none);
 * fob / keys → no code, the guide's steps are the way in. No lock type → whatever code exists.
 */
export function doorCodeFor(lockType: string | null | undefined, guestCode: string | null | undefined, reservationCode: string | null | undefined): string | null {
  const t = (v: string | null | undefined) => { const x = String(v ?? '').trim(); return x && !/^none$/i.test(x) ? x : null; };
  const k = kindOf(t(lockType));
  if (k === 'fob' || k === 'keys') return null;
  return t(reservationCode) ?? t(guestCode);
}

/** Arrival times to slide through: from check-in to 11:30 PM every 30 minutes, then "After midnight". */
export function arrivalTimes(checkInTime: string): string[] {
  const start = minutesOf(checkInTime) ?? 16 * 60;
  const out: string[] = [];
  for (let m = Math.ceil(start / 30) * 30; m < 24 * 60; m += 30) {
    const h = Math.floor(m / 60), mm = m % 60;
    out.push(`${h % 12 || 12}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`);
  }
  return [...out, LATE_ARRIVAL];
}
