/**
 * The portal's real door (Phase 2, owner 2026-11-23: "create it"): a Hostaway reservation → the GuestStay the portal
 * shows, and the rules the server applies before it hands out anything that opens a door. Pure and tested; the reads
 * and writes are in functions/_lib/guest-stay.ts.
 *
 * What the server decides, never the page: whether the ID check and the payment really happened (Stripe), when the
 * arrival details are released, and the bill. The page's own copy of the check-in is only a convenience.
 */
import { zonedInstant } from './inbox.ts';
import type { Channel, GuestGuide, GuestStay } from './guest-portal.ts';
import { newFlow, type Flow } from './guest-checkin.ts';
import type { UpsellKind } from './guest-portal.ts';

export const STAY_TZ = 'America/Chicago';
/** Arrival details open at noon (Central) the day before arrival, once the check-in is done (owner may change it). */
export const RELEASE_HOUR = 12;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const prevDay = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

/** Hostaway's channelName → the portal's channel (only Airbnb changes what is asked: AirCover, no waiver). */
export function channelOf(name: unknown): Channel {
  const c = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (c.startsWith('airbnb')) return 'airbnb';
  if (/homeaway|vrbo/.test(c)) return 'vrbo';
  if (/booking/.test(c)) return 'booking';
  if (/direct|website|bookingengine|manual/.test(c) || !c) return 'direct';
  if (/partner|expedia|marriott|google/.test(c)) return 'partner';
  return 'other';
}

/** Hostaway keeps hours as 0–23 → "4:00 PM"; nothing → the fallback. */
export function hourLabel(h: unknown, fallback: string): string {
  const n = Number(h);
  if (!Number.isInteger(n) || n < 0 || n > 23 || h === null || h === '') return fallback;
  return `${n % 12 || 12}:00 ${n < 12 ? 'AM' : 'PM'}`;
}

export const releaseAt = (arrival: string) => zonedInstant(prevDay(arrival), RELEASE_HOUR, STAY_TZ).toISOString();

/** A booking the portal may serve: confirmed (new / modified / ownerStay); anything else is shown as closed. */
export const isLive = (status: unknown) => /^(new|modified|ownerstay)$/i.test(String(status ?? ''));

/** What the server needs of the house (guest-guide.ts `guestHouse`). */
export interface HouseFacts {
  unitName: string; photo: string | null; lockType: string | null; guestCode: string | null;
  unitType: GuestStay['unitType'] | null; protection: GuestStay['protection'] | null; guide: GuestGuide | null;
  prices: GuestStay['prices']; notOffered?: UpsellKind[];
  calendar?: Pick<GuestStay, 'freeBefore' | 'freeAfter' | 'turnIn' | 'turnOut' | 'nightPrices'> | null;
}

/** The reservation as the portal shows it — with the whole guide; `lockedStay` takes out what must wait. */
export function stayFrom(r: Record<string, unknown>, h: HouseFacts, o: { checkedIn: boolean; doorCode: string | null }): GuestStay | null {
  const arrival = String(r.arrivalDate ?? ''), departure = String(r.departureDate ?? '');
  if (!DAY.test(arrival) || !DAY.test(departure) || arrival >= departure) return null;
  const first = str(r.guestFirstName) ?? str(r.guestName)?.split(/\s+/)[0] ?? 'there';
  return {
    id: String(r.id), guestFirst: first, unitName: h.unitName, address: h.guide?.address ?? null, photo: h.photo,
    arrival, departure,
    checkInTime: hourLabel(r.checkInTime, h.guide?.checkIn ? `${h.guide.checkIn}` : '4:00 PM'),
    checkOutTime: hourLabel(r.checkOutTime, h.guide?.checkOut ? `${h.guide.checkOut}` : '11:00 AM'),
    guests: num(r.numberOfGuests) || num(r.adults) || 1,
    channel: channelOf(r.channelName),
    // Hostaway (or the channel) collects the booking itself: the portal charges only protection and extras.
    total: 0, paid: 0, nightly: null,
    freeBefore: h.calendar?.freeBefore ?? 0, freeAfter: h.calendar?.freeAfter ?? 0,
    turnIn: h.calendar?.turnIn ?? false, turnOut: h.calendar?.turnOut ?? false, nightPrices: h.calendar?.nightPrices ?? null,
    guideReleaseAt: releaseAt(arrival), pay: { provider: 'none', url: null },
    guest: { name: str(r.guestName) ?? first, email: str(r.guestEmail), phone: str(r.phone),
      adults: num(r.adults) || num(r.numberOfGuests) || 1, children: num(r.children), infants: num(r.infants), pets: num(r.pets) },
    maxGuests: null, unitType: h.unitType ?? 'house', checkedIn: o.checkedIn, doorCode: o.doorCode,
    protection: h.protection, guide: h.guide, prices: h.prices, notOffered: h.notOffered ?? [],
  };
}

/**
 * Before the entry opens, the page gets only what the check-in itself needs: the house rules (to agree to) and the
 * times. No address, Wi-Fi, arrival steps, manual, phone or door code — the link is in messages and could be forwarded.
 */
export function lockedStay(s: GuestStay): GuestStay {
  const g = s.guide;
  return { ...s, doorCode: null, address: null,
    guide: g ? { address: null, wifi: null, checkIn: g.checkIn, checkOut: g.checkOut, parking: null, access: null, manual: null, rules: g.rules, phone: null } : null };
}

const EXTRA_KEYS = new Set<UpsellKind>(['early-checkin', 'late-checkout', 'mid-clean', 'parking', 'welcome']);

/**
 * The page's check-in, kept on the server — only the guest's own answers. `identity` and `paid` are never taken from
 * the page: they are set from Stripe (`server`), so a page cannot open the door by saying so.
 */
export function cleanFlow(raw: unknown, server: { identity: boolean; paid: boolean; paidTotal?: number | null }): Flow {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const f = newFlow();
  f.details = o.details === true;
  f.arrival = typeof o.arrival === 'string' && o.arrival.length <= 20 ? o.arrival : null;
  f.changeAsk = typeof o.changeAsk === 'string' && o.changeAsk.trim() ? o.changeAsk.trim().slice(0, 600) : null;
  f.protection = o.protection === 'waiver' || o.protection === 'deposit' || o.protection === 'none' ? o.protection : null;
  f.rules = o.rules === true;
  f.extrasSeen = o.extrasSeen === true;
  const ex = (o.extras && typeof o.extras === 'object' ? o.extras : {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(ex)) {
    if (!EXTRA_KEYS.has(k as UpsellKind) || !v || typeof v !== 'object') continue;
    const c = v as Record<string, unknown>;
    f.extras[k as UpsellKind] = { ...(typeof c.time === 'string' ? { time: c.time.slice(0, 12) } : {}), ...(Number.isFinite(Number(c.qty)) ? { qty: Math.max(0, Math.min(20, Math.round(Number(c.qty)))) } : {}) };
  }
  f.identity = server.identity;
  f.paid = server.paid;
  f.paidTotal = server.paid ? server.paidTotal ?? null : null;
  return f;
}
