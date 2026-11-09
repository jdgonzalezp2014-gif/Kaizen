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
  /** The house's check-in guide, from its Repository record (null = none yet). Served only once the guide opens. */
  guide?: GuestGuide | null;
  /** House prices from the Repository's Fees, overriding the UPSELLS placeholders. */
  prices?: Partial<Record<UpsellKind, number>>;
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
  return out;
}

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
  per: 'stay' | 'night' | 'item';
  /** What the guest picks: a time, a number of nights, a quantity, or nothing. */
  pick: { type: 'time'; options: string[] } | { type: 'nights' } | { type: 'qty'; max: number } | { type: 'none' };
}

export const UPSELLS: Upsell[] = [
  { kind: 'extra-nights', title: 'Extra nights', icon: 'bed', price: null, per: 'night', pick: { type: 'nights' } },
  { kind: 'early-checkin', title: 'Early check-in', icon: 'clock', price: 45, per: 'stay', pick: { type: 'time', options: ['12:00 PM', '1:00 PM', '2:00 PM'] } },
  { kind: 'late-checkout', title: 'Late check-out', icon: 'clock', price: 45, per: 'stay', pick: { type: 'time', options: ['12:00 PM', '1:00 PM', '2:00 PM'] } },
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
  status: 'new' | 'confirmed' | 'declined' | 'paid';
  at: string;                 // ISO
}

export function upsellRequest(s: GuestStay, u: Upsell, c: Choice, now: Date): UpsellRequest {
  const choice: Choice = u.pick.type === 'time' ? { time: c.time }
    : u.pick.type === 'nights' ? clampNights(s, c)
    : u.pick.type === 'qty' ? { qty: Math.max(1, Math.min(c.qty ?? 1, u.pick.max)) } : {};
  const a = availability(s, u);
  return { stayId: s.id, kind: u.kind, title: u.title, choice, quote: quote(s, u, choice), turnover: a.ok && a.flag === 'turnover', status: 'new', at: now.toISOString() };
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
