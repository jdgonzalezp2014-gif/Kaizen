/**
 * Guest portal (guests module, 2026-11-05): one page per stay — the stay, what is due, the arrival guide,
 * extras. Pure: the page and, later, the API share these rules. Nothing here charges or writes to Hostaway:
 * an extra is a *request* the team confirms; the money goes through the stay's pay link (Hostaway Payments).
 */

import type { CheckinStep, HouseItem } from './checkin.ts';

export type Channel = 'direct' | 'airbnb' | 'vrbo' | 'booking' | 'partner' | 'other';

/**
 * Where the guest pays. Kaizen never takes card data — it opens a link. Hostaway is the path being
 * evaluated (the business already charges through Hostaway Payments / Stripe); until a stay has a link,
 * the page says so instead of showing a button that does nothing.
 */
export interface PayLink { provider: 'hostaway' | 'none'; url: string | null }

export interface GuestStay {
  id: string;                 // Hostaway reservation id
  guestFirst: string;
  unitName: string;
  address: string | null;
  photo: string | null;
  arrival: string;            // YYYY-MM-DD
  departure: string;          // YYYY-MM-DD
  checkInTime: string;        // "4:00 PM", as Hostaway keeps it
  checkOutTime: string;       // "11:00 AM"
  guests: number;
  channel: Channel;
  total: number;              // what Kaizen collects for the stay (0 when the channel collects)
  paid: number;
  nightly: number | null;     // rate for extra nights, when known
  freeBefore: number;         // free nights on the calendar right before arrival
  freeAfter: number;          // …and right after departure
  turnIn: boolean;            // someone checks out the day this guest arrives
  turnOut: boolean;           // someone checks in the day this guest leaves
  guideReleaseAt: string | null; // ISO; check-in instructions open from here (and only when nothing is due)
  pay: PayLink;
  /** From the Hostaway reservation (online check-in confirms them; the guest never retypes them). */
  guest?: { name: string; email: string | null; phone: string | null; adults: number; children: number; infants: number; pets: number } | null;
  maxGuests?: number | null;
  /** The Repository's unit type and protection values (defaults by type until a listing sets its own). */
  unitType?: 'room' | 'apartment' | 'house';
  /** Online check-in already finished (kept by Kaizen per reservation — demo flag for now). */
  checkedIn?: boolean;
  /** The guest's door code (Hostaway's per-reservation code when set) — shown only once check-in opens the entry. */
  doorCode?: string | null;
  protection?: { waiverPrice?: number | null; waiverCap?: number | null; depositHold?: number | null } | null;
  /** The house's check-in guide, from its Repository record (null = none yet). Served only once the guide opens. */
  guide?: GuestGuide | null;
  /** House prices from the Repository's Fees, overriding the UPSELLS placeholders. */
  prices?: Partial<Record<UpsellKind, number>>;
  /** Extras the unit does not offer (Repository "Guest services" = No) — never shown. */
  notOffered?: UpsellKind[];
}

/**
 * The check-in guide = the Units record's existing fields (2026-11-09), nothing new to fill:
 * hw_address · wifi_network / password_2 ("Wifi password") · checkin_from / checkout_time · parking,
 * parking_free_street, parking_extra_price · guest_access · house_manual · house_rules · hw_contact_phone.
 * Door codes are NOT here: cleaner_code / lockbox / admin / backup are the team's (unit-access.ts).
 */
export interface GuestGuide {
  address: string | null;
  wifi: { network: string; password: string | null } | null;
  checkIn: string | null;     // "4 PM"
  checkOut: string | null;    // "11 AM"
  parking: { notes: string | null; freeStreet: boolean; coveredPerNight: number | null } | null;
  access: string | null;      // House description → Guest access
  manual: string | null;      // a link
  rules: string | null;
  phone: string | null;
  /** Arrival steps from Repository → Check-in builder (checkin.ts), shown before the fields above. */
  steps?: CheckinStep[];
  /** House manual items from the builder (e.g. Trash), after the record's Wi-Fi / times / parking. */
  house?: HouseItem[];
}
export const emptyGuide = (): GuestGuide => ({ address: null, wifi: null, checkIn: null, checkOut: null, parking: null, access: null, manual: null, rules: null, phone: null });

const txt = (v: unknown) => { const t = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''; return t || null; };
const num = (v: unknown) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };
const isUrl = (v: string | null) => v && /^https?:\/\//i.test(v) ? v : null;

export function guideFrom(vals: Record<string, unknown> | null | undefined): GuestGuide | null {
  if (!vals) return null;
  const net = txt(vals.wifi_network);
  const pNotes = txt(vals.parking), free = vals.parking_free_street === true, covered = num(vals.parking_extra_price);
  return {
    address: txt(vals.hw_address),
    wifi: net ? { network: net, password: txt(vals.password_2) } : null,
    checkIn: txt(vals.checkin_from), checkOut: txt(vals.checkout_time),
    parking: pNotes || free || covered ? { notes: pNotes, freeStreet: free, coveredPerNight: covered } : null,
    access: txt(vals.guest_access), manual: isUrl(txt(vals.house_manual)), rules: txt(vals.house_rules),
    phone: txt(vals.hw_contact_phone),
  };
}

/** The extras the Repository already prices (Fees): a pet = pet_fee. The rest stay placeholders for now. */
export function pricesFrom(vals: Record<string, unknown> | null | undefined): Partial<Record<UpsellKind, number>> {
  const out: Partial<Record<UpsellKind, number>> = {};
  const pet = num(vals?.pet_fee); if (pet != null) out.pet = pet;
  const mid = num(vals?.mid_clean_price); if (mid != null) out['mid-clean'] = mid;
  const crib = num(vals?.crib_price); if (crib != null) out.crib = crib;
  const welcome = num(vals?.welcome_price); if (welcome != null) out.welcome = welcome;
  return out;
}

/** Repository "Guest services" (112): the extras a unit does NOT offer — "No" only; blank = offered. */
const SVC_KEY: Record<UpsellKind, string> = { 'extra-nights': 'svc_extra_nights', 'early-checkin': 'svc_early_checkin', 'late-checkout': 'svc_late_checkout',
  'mid-clean': 'svc_mid_clean', pet: 'svc_pet', crib: 'svc_crib', welcome: 'svc_welcome' };
export function notOfferedFrom(vals: Record<string, unknown> | null | undefined): UpsellKind[] {
  return (Object.keys(SVC_KEY) as UpsellKind[]).filter(k => /^no$/i.test(String(vals?.[SVC_KEY[k]] ?? '').trim()));
}
/** The extras this stay's unit offers (the catalog minus the Repository's "No"). */
export const offered = (s: Pick<GuestStay, 'notOffered'>) => UPSELLS.filter(u => !s.notOffered?.includes(u.kind));

/** The price a card shows and quotes: the house's, else the catalog placeholder. */
export const priceOf = (s: Pick<GuestStay, 'prices'>, u: Upsell) => s.prices?.[u.kind] ?? u.price;
export const mapsUrl = (address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

const DAY = 86_400_000;
const ymd = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const nights = (s: Pick<GuestStay, 'arrival' | 'departure'>) => Math.max(0, Math.round((ymd(s.departure) - ymd(s.arrival)) / DAY));
const cents = (n: number) => Math.round(n * 100) / 100;

export type PayState = 'channel' | 'unpaid' | 'partial' | 'paid';

/** Airbnb and Vrbo collect themselves: no gate, no warning (as the reference demo). */
export function payState(s: Pick<GuestStay, 'channel' | 'total' | 'paid'>): { state: PayState; due: number } {
  if ((s.channel === 'airbnb' || s.channel === 'vrbo') && s.total <= 0) return { state: 'channel', due: 0 };
  const due = cents(Math.max(0, s.total - s.paid));
  if (due <= 0) return { state: s.total > 0 ? 'paid' : 'channel', due: 0 };
  return { state: s.paid > 0 ? 'partial' : 'unpaid', due };
}

/** Check-in instructions: nothing due AND the release time passed — the reference's two locks. */
export function guide(s: GuestStay, now: Date): { open: true } | { open: false; why: 'unpaid' | 'release'; at?: string } {
  if (payState(s).due > 0) return { open: false, why: 'unpaid' };
  if (!s.guideReleaseAt || Date.parse(s.guideReleaseAt) > now.getTime()) return { open: false, why: 'release', at: s.guideReleaseAt ?? undefined };
  return { open: true };
}

export type UpsellKind = 'extra-nights' | 'early-checkin' | 'late-checkout' | 'mid-clean' | 'pet' | 'crib' | 'welcome';

export interface Upsell {
  kind: UpsellKind;
  title: string;
  icon: string;               // Icon.tsx name
  /** Placeholder prices until the owner sets them (per house later). null = priced from the stay (nightly). */
  price: number | null;
  per: 'stay' | 'night' | 'item' | 'hour';
  /** What the guest picks: a time, a number of nights, a quantity, or nothing. */
  pick: { type: 'time'; options: string[] } | { type: 'nights' } | { type: 'qty'; max: number } | { type: 'none' };
}

export const UPSELLS: Upsell[] = [
  { kind: 'extra-nights', title: 'Extra nights', icon: 'bed', price: null, per: 'night', pick: { type: 'nights' } },
  // $20 per hour, every house (owner, 2026-11-15); the hours count from the stay's own times.
  { kind: 'early-checkin', title: 'Early check-in', icon: 'clock', price: 20, per: 'hour', pick: { type: 'time', options: ['12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM'] } },
  { kind: 'late-checkout', title: 'Late check-out', icon: 'clock', price: 20, per: 'hour', pick: { type: 'time', options: ['12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM'] } },
  { kind: 'mid-clean', title: 'Mid-stay clean', icon: 'brush', price: 95, per: 'stay', pick: { type: 'none' } },
  { kind: 'pet', title: 'Bring a pet', icon: 'home', price: 75, per: 'item', pick: { type: 'qty', max: 2 } },
  { kind: 'crib', title: 'Crib / pack ’n play', icon: 'bed', price: 25, per: 'item', pick: { type: 'qty', max: 2 } },
  { kind: 'welcome', title: 'Welcome basket', icon: 'sparkles', price: 35, per: 'item', pick: { type: 'none' } },
];

export type Availability = { ok: true; flag?: 'turnover' } | { ok: false; why: 'calendar' | 'price' | 'short' };

/**
 * Never promise what the calendar can't give: extra nights up to the free gap; early / late on a same-day
 * turnover are still asked for, flagged — the team confirms after the clean is planned.
 */
export function availability(s: GuestStay, u: Upsell): Availability {
  if (u.kind === 'extra-nights') {
    if (s.freeBefore + s.freeAfter <= 0) return { ok: false, why: 'calendar' };
    if (s.nightly == null) return { ok: false, why: 'price' };
    return { ok: true };
  }
  if (u.kind === 'mid-clean' && nights(s) < 4) return { ok: false, why: 'short' };
  if ((u.kind === 'early-checkin' && s.turnIn) || (u.kind === 'late-checkout' && s.turnOut)) return { ok: true, flag: 'turnover' };
  return { ok: true };
}

/** "4:00 PM" / "4 PM" / "16:00" → minutes after midnight. */
export function minutesOf(t: string | null | undefined): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])?$/.exec((t ?? '').trim());
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] ?? 0);
  if (m[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0); } else if (h > 23) return null;
  return h * 60 + min;
}

/** Hours an early check-in / late check-out adds over the stay's own times, rounded up; null when the time adds none. */
export function hoursOf(s: Pick<GuestStay, 'checkInTime' | 'checkOutTime'>, u: Pick<Upsell, 'kind'>, time: string | undefined): number | null {
  const t = minutesOf(time);
  const std = minutesOf(u.kind === 'early-checkin' ? s.checkInTime : s.checkOutTime);
  if (t == null || std == null) return null;
  const diff = u.kind === 'early-checkin' ? std - t : t - std;
  return diff > 0 ? Math.ceil(diff / 60) : null;
}

/** A wall-clock time in Texas (Central) as an instant — the houses' time, whatever the guest's phone says. */
export function centralInstant(ymd: string, hour: number): Date {
  const [y, mo, d] = ymd.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, mo - 1, d, hour);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(guess)).map(x => [x.type, x.value]));
  const seen = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return new Date(guess - (seen - guess));
}

/**
 * Early check-in / late check-out (owner, 2026-11-15): asked by 8 PM (Central) the day before → confirmed on its own;
 * later, or the same day → the team approves. A turnover that day (another guest leaving / arriving) always needs
 * approval — the clean decides, however early the guest asked.
 */
export type RequestMode = { mode: 'auto' } | { mode: 'approval'; why: 'late' | 'turnover' };
export function requestMode(s: GuestStay, u: Pick<Upsell, 'kind'>, now: Date): RequestMode {
  if (u.kind !== 'early-checkin' && u.kind !== 'late-checkout') return { mode: 'approval', why: 'late' };
  if ((u.kind === 'early-checkin' && s.turnIn) || (u.kind === 'late-checkout' && s.turnOut)) return { mode: 'approval', why: 'turnover' };
  const day = u.kind === 'early-checkin' ? s.arrival : s.departure;
  const before = new Date(`${day}T12:00:00Z`); before.setUTCDate(before.getUTCDate() - 1);
  const cutoff = centralInstant(before.toISOString().slice(0, 10), 20);
  return now.getTime() < cutoff.getTime() ? { mode: 'auto' } : { mode: 'approval', why: 'late' };
}

/** What the guest picked: a time, nights before/after, or a quantity. */
export interface Choice { time?: string; before?: number; after?: number; qty?: number }

/** The total the card shows; null when it can't be priced (the team quotes). */
export function quote(s: GuestStay, u: Upsell, c: Choice): number | null {
  if (u.kind === 'extra-nights') {
    const n = clampNights(s, c).before + clampNights(s, c).after;
    return s.nightly == null ? null : cents(n * s.nightly);
  }
  const price = priceOf(s, u);
  if (price == null) return null;
  if (u.per === 'hour') { const h = hoursOf(s, u, c.time); return h == null ? null : cents(price * h); }
  return cents(price * (u.per === 'item' ? Math.max(1, Math.min(c.qty ?? 1, u.pick.type === 'qty' ? u.pick.max : 1)) : 1));
}

export function clampNights(s: GuestStay, c: Choice) {
  return { before: Math.max(0, Math.min(c.before ?? 0, s.freeBefore)), after: Math.max(0, Math.min(c.after ?? 0, s.freeAfter)) };
}

/** A choice the request can be sent with: a time when it asks for one, at least one night. */
export function ready(s: GuestStay, u: Upsell, c: Choice): boolean {
  if (!availability(s, u).ok) return false;
  if (u.pick.type === 'time') return !!c.time && u.pick.options.includes(c.time);
  if (u.pick.type === 'nights') { const n = clampNights(s, c); return n.before + n.after > 0; }
  return true;
}

/** "New upselling request" — what the system receives. Status lives on the team side. */
export interface UpsellRequest {
  stayId: string;
  kind: UpsellKind;
  title: string;
  choice: Choice;
  quote: number | null;
  turnover: boolean;
  /** Early / late asked in time with no turnover → confirmed on its own (a task + Slack line, no approval). */
  mode: 'auto' | 'approval';
  status: 'new' | 'confirmed' | 'declined' | 'paid';
  at: string;                 // ISO
}

export function upsellRequest(s: GuestStay, u: Upsell, c: Choice, now: Date): UpsellRequest {
  const choice: Choice = u.pick.type === 'time' ? { time: c.time }
    : u.pick.type === 'nights' ? clampNights(s, c)
    : u.pick.type === 'qty' ? { qty: Math.max(1, Math.min(c.qty ?? 1, u.pick.max)) } : {};
  const a = availability(s, u);
  const mode = requestMode(s, u, now).mode;
  return { stayId: s.id, kind: u.kind, title: u.title, choice, quote: quote(s, u, choice), turnover: a.ok && a.flag === 'turnover',
    mode, status: mode === 'auto' ? 'confirmed' : 'new', at: now.toISOString() };
}

/** One line for the request list and, later, the team's Slack line. */
export function choiceLine(r: Pick<UpsellRequest, 'kind' | 'choice'>): string {
  const c = r.choice;
  if (r.kind === 'extra-nights') return [c.before ? `${c.before} before` : '', c.after ? `${c.after} after` : ''].filter(Boolean).join(' · ');
  if (c.time) return r.kind === 'early-checkin' ? `from ${c.time}` : `until ${c.time}`;
  if (c.qty && c.qty > 1) return `× ${c.qty}`;
  return '';
}

/**
 * The guest's link (owner, 2026-11-05: a bypass on the Hostaway reservation id): /guest/<id>.<sig>.
 * Reservation ids run in sequence, so the id alone would let anyone walk through other guests' stays;
 * <sig> is an HMAC of the id with a server key (functions side, not written yet) — no token table, and
 * the team can rebuild a guest's link from the id. "/guest/demo" is the demo stay.
 */
export function guestLink(path: string): { id: string; sig: string | null } | null {
  const p = path.replace(/\/+$/, '');
  if (p.toLowerCase() === '/guest/demo') return { id: 'demo', sig: null };
  const m = /^\/guest\/(\d{1,12})\.([A-Za-z0-9_-]{6,64})$/.exec(p);
  return m ? { id: m[1]!, sig: m[2]! } : null;
}

/**
 * The pay side, read from the Hostaway reservation (checked on real stays, 2026-11-05): every reservation has
 * `guestPortalUrl` (guest-portal.hostaway.com/<id>/… — Hostaway's own portal, where the guest sees the stay,
 * signs and pays through Hostaway Payments / Stripe) and `paymentStatus` ("Paid", "Unknown", …). So the Pay
 * button opens the guest's own Hostaway portal: nothing to build for cards, and it is automatic per stay.
 * The URL is a login token: only ever handed to that guest's signed page — never logged, never in Slack.
 * `remainingBalance` came back null on every stay checked, so "due" stays ours (total − paid) until it fills.
 */
export function payFromHostaway(d: { guestPortalUrl?: unknown; paymentStatus?: unknown; remainingBalance?: unknown }):
  { pay: PayLink; hostawayPaid: boolean | null; balance: number | null } {
  const url = typeof d.guestPortalUrl === 'string' && /^https:\/\/guest-portal\.hostaway\.com\//.test(d.guestPortalUrl) ? d.guestPortalUrl : null;
  const st = typeof d.paymentStatus === 'string' ? d.paymentStatus.toLowerCase() : '';
  return {
    pay: { provider: url ? 'hostaway' : 'none', url },
    // "Unknown" (Expedia collects) is not "unpaid": no warning on what Hostaway does not know.
    hostawayPaid: st === 'paid' ? true : st === 'unpaid' || st === 'partially paid' || st === 'partial' ? false : null,
    balance: typeof d.remainingBalance === 'number' ? d.remainingBalance : null,
  };
}

/**
 * Extra nights and turnovers from the listing's live Hostaway calendar (owner, 2026-11-15: "connect the extension to
 * the calendar"). `days` = the nights around the stay (date = the night that starts that day). A night the calendar
 * does not list counts as taken — never offer what we cannot see. At most `max` nights each side.
 */
export type CalNight = { date: string; available: boolean };
export function calendarFit(days: CalNight[], arrival: string, departure: string, max = 7) {
  const free = new Map(days.map(d => [d.date, d.available]));
  const shift = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  let freeBefore = 0; while (freeBefore < max && free.get(shift(arrival, -(freeBefore + 1))) === true) freeBefore++;
  let freeAfter = 0; while (freeAfter < max && free.get(shift(departure, freeAfter)) === true) freeAfter++;
  // Someone sleeps the night before arrival → they leave that morning; someone takes the departure night → they arrive that day.
  return { freeBefore, freeAfter, turnIn: free.get(shift(arrival, -1)) === false, turnOut: free.get(departure) === false };
}
