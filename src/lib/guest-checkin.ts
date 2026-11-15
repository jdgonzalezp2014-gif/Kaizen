/**
 * Online check-in (guests module, 2026-11-15): the steps a guest completes before the door code and the house
 * manual open — the boss's reference is Hostop's portal (docs/modules/guests.md, "Reference: Hostop demo").
 * Owner's cut: the guest's name, email, phone and party come from the Hostaway reservation (confirm, never retype);
 * identity verification is a placeholder until Truvi vs Stripe Identity is decided; one payment at the end
 * (protection + paid extras) through Stripe — demo only for now. Pure: no fetch, no React.
 */
import { UPSELLS, priceOf, quote, availability, requestMode, type Choice, type GuestStay, type UpsellKind } from './guest-portal.ts';

/** Protection values depend on what is rented: a room is not a house (owner, 2026-11-15). Per listing later. */
export type UnitType = 'room' | 'apartment' | 'house';
export interface Protection { waiver: { price: number; cap: number }; deposit: { hold: number } }

/** Placeholders until the owner sets them — Hostop's demo: waiver $49 covers $1,500; deposit $250 hold. */
export const PROTECTION_DEFAULTS: Record<UnitType, Protection> = {
  room: { waiver: { price: 29, cap: 1000 }, deposit: { hold: 150 } },
  apartment: { waiver: { price: 49, cap: 1500 }, deposit: { hold: 250 } },
  house: { waiver: { price: 79, cap: 3000 }, deposit: { hold: 500 } },
};

export interface ProtectionOverride { waiverPrice?: number | null; waiverCap?: number | null; depositHold?: number | null }

/** The unit type's defaults, with whatever the listing sets on top (a blank field keeps the default). */
export function protectionFor(type: UnitType, o: ProtectionOverride = {}): Protection {
  const d = PROTECTION_DEFAULTS[type];
  const n = (v: number | null | undefined, def: number) => (v != null && Number.isFinite(v) && v >= 0 ? v : def);
  return { waiver: { price: n(o.waiverPrice, d.waiver.price), cap: n(o.waiverCap, d.waiver.cap) }, deposit: { hold: n(o.depositHold, d.deposit.hold) } };
}

/** The record's "Guest portal" section (migration 110): unit type + protection values; blanks keep the defaults. */
export function portalFrom(vals: Record<string, unknown> | null | undefined): { unitType: UnitType | null; protection: ProtectionOverride } {
  const num = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[$,\s]/g, '')) : NaN; return Number.isFinite(n) && n >= 0 ? n : null; };
  const t = typeof vals?.unit_type === 'string' ? vals.unit_type.toLowerCase() : '';
  return {
    unitType: t === 'room' || t === 'apartment' || t === 'house' ? t : null,
    protection: { waiverPrice: num(vals?.waiver_price), waiverCap: num(vals?.waiver_cap), depositHold: num(vals?.deposit_hold) },
  };
}

/** Airbnb covers damage itself (AirCover) and takes no waiver — the step is done for those guests. */
export const channelCovers = (s: Pick<GuestStay, 'channel'>) => s.channel === 'airbnb';

export type Arrival = 'early' | 'mid' | 'late';
export interface Flow {
  details: boolean;
  arrival: Arrival | null;
  pet: boolean | null;
  identity: boolean;
  protection: 'waiver' | 'deposit' | null;
  rules: boolean;
  /** Extras picked during check-in, with the guest's choice (time, …). */
  extras: Partial<Record<UpsellKind, Choice>>;
  extrasSeen: boolean;
  paid: boolean;
}
/** The check-in answers kept in the tab while the guest is on Stripe Checkout (the page reloads when they come back). */
export const FLOW_KEY = 'kaizen-guest-flow';
export const newFlow = (): Flow => ({ details: false, arrival: null, pet: null, identity: false, protection: null, rules: false, extras: {}, extrasSeen: false, paid: false });
/** A finished check-in (the demo's "checked in" stay). */
export const doneFlow = (): Flow => ({ details: true, arrival: 'mid', pet: false, identity: true, protection: 'waiver', rules: true, extras: {}, extrasSeen: true, paid: true });

/** Extras offered inside check-in. Early / late follow requestMode: in time and no turnover → charged now; else on request. */
export const FLOW_EXTRAS: UpsellKind[] = ['early-checkin', 'late-checkout', 'mid-clean', 'welcome'];
export const onRequest = (s: GuestStay, k: UpsellKind, now: Date) => (k === 'early-checkin' || k === 'late-checkout') && requestMode(s, { kind: k }, now).mode === 'approval';

export type StepKey = 'details' | 'identity' | 'protection' | 'rules' | 'extras' | 'pay';
export interface Step { key: StepKey; title: string; sub: string; done: boolean; required: boolean }

/** The steps in order. Extras are optional; Pay shows only when something is charged or held. */
export function steps(f: Flow, s: GuestStay, p: Protection, now: Date = new Date()): Step[] {
  const covered = channelCovers(s);
  const out: Step[] = [
    { key: 'details', title: 'Your details', sub: 'Confirm who is staying', done: f.details, required: true },
    { key: 'identity', title: 'Identity', sub: 'ID and a quick selfie', done: f.identity, required: true },
    { key: 'protection', title: 'Damage protection', sub: covered ? 'Covered by Airbnb' : 'Waiver or deposit', done: covered || f.protection != null, required: true },
    { key: 'rules', title: 'House rules', sub: 'Read and agree', done: f.rules, required: true },
    { key: 'extras', title: 'Extras', sub: 'Optional', done: f.extrasSeen, required: false },
  ];
  if (bill(f, s, p, now).lines.some(l => l.kind !== 'request')) out.push({ key: 'pay', title: 'Review and pay', sub: 'One payment, then you are in', done: f.paid, required: true });
  return out;
}

export const progress = (st: Step[]) => { const r = st.filter(x => x.required); return { done: r.filter(x => x.done).length, of: r.length }; };
/** The next step to do: the first required one not done (extras once, before paying). */
export function nextStep(st: Step[]): StepKey | null {
  for (const x of st) if (!x.done && (x.required || x.key === 'extras')) return x.key;
  return null;
}

export interface BillLine { label: string; amount: number; kind: 'charge' | 'hold' | 'request'; note?: string }
const cents = (n: number) => Math.round(n * 100) / 100;

/** What the one payment covers: charges today, a hold that is released, and requests charged only once confirmed. */
export function bill(f: Flow, s: GuestStay, p: Protection, now: Date = new Date()): { lines: BillLine[]; today: number; hold: number } {
  const lines: BillLine[] = [];
  if (!channelCovers(s)) {
    if (f.protection === 'waiver') lines.push({ label: 'Damage waiver', amount: p.waiver.price, kind: 'charge', note: `Covers up to $${p.waiver.cap.toLocaleString('en-US')}` });
    if (f.protection === 'deposit') lines.push({ label: 'Security deposit', amount: p.deposit.hold, kind: 'hold', note: 'Held on your card, released after check-out' });
  }
  for (const k of FLOW_EXTRAS) {
    const c = f.extras[k];
    const u = UPSELLS.find(x => x.kind === k);
    if (!c || !u) continue;
    const q = quote(s, u, c);
    if (q == null) continue;
    lines.push({ label: u.title, amount: q, kind: onRequest(s, k, now) ? 'request' : 'charge', note: c.time ? (k === 'early-checkin' ? `From ${c.time}` : `Until ${c.time}`) : undefined });
  }
  const sum = (k: BillLine['kind']) => cents(lines.filter(l => l.kind === k).reduce((a, l) => a + l.amount, 0));
  return { lines, today: sum('charge'), hold: sum('hold') };
}

/** Which extras the stay can take during check-in (the calendar and the stay length still decide). */
export function flowExtras(s: GuestStay) {
  return FLOW_EXTRAS.map(k => UPSELLS.find(u => u.kind === k)!).filter(u => availability(s, u).ok && priceOf(s, u) != null)
    .map(u => ({ u, turnover: (availability(s, u) as { flag?: string }).flag === 'turnover' }));
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

