/**
 * Charging an upsell from the team's side (owner, 2026-11-19, §178; round 2 the same day): an upsell case opened in the
 * Inbox or in Operations → To-do is carried out from there.
 *
 *  - **How the guest pays** (`methodsFor`): any channel → a card pay link (Stripe Checkout, also on the guest's stay
 *    page as a pending payment). Airbnb also → the Resolution Center (the team asks there, then marks it received).
 *    An Airbnb date change made as an alteration is done on Airbnb itself (the links) — not a charge here.
 *  - **Nothing moves before the money** (owner): the nights, the hour are applied once the payment is confirmed —
 *    Stripe says paid, or the team marks the Resolution Center money received.
 *  - **Then** (`applyPlan`): an hour → written on the reservation (every channel, Airbnb too). Extra nights on a direct
 *    booking → the reservation itself is extended in Hostaway (the lock code, the clean and the messages follow it);
 *    on a channel booking (Airbnb paid outside, Vrbo, Booking.com, Expedia) → the nights are blocked on the calendar
 *    and the team gets an urgent to-do for what the reservation no longer knows (door code, clean, check-out messages).
 *
 * Pure: the server (functions/_lib/upsell-charge.ts, charge-settle.ts) reads Hostaway and Stripe and calls these.
 */
import { addDays, type DateStr } from './dates.ts';

/** What an upsell kind needs besides the money. */
export type ChargeNeed = 'nights' | 'checkin' | 'checkout' | 'amount';
export function needOf(category: string | null | undefined): ChargeNeed {
  if (category === 'Extra nights') return 'nights';
  if (category === 'Early check-in') return 'checkin';
  if (category === 'Late checkout') return 'checkout';
  return 'amount';
}

/** Hostaway's channelName (`airbnbOfficial`, `airbnb`…) — Airbnb collects its own money. */
export const isAirbnb = (channel: string | null | undefined) => /airbnb/i.test(channel ?? '');

/** $20 an hour, every house (owner, 2026-11-15) — the same rate the guest portal charges. */
export const HOUR_RATE = 20;

/** "2:00 PM" for a whole hour 0–23. */
export function hourLabel(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * The hours the guest may pick: an earlier check-in (from 8 AM up to an hour before the stay's), or a later check-out
 * (an hour after the stay's up to 6 PM — later than that is another night).
 */
export function hourOptions(need: 'checkin' | 'checkout', stayHour: number): number[] {
  const out: number[] = [];
  if (need === 'checkin') for (let h = 8; h < stayHour; h++) out.push(h);
  else for (let h = stayHour + 1; h <= 18; h++) out.push(h);
  return out;
}

/** What an hour change costs: $20 per hour moved. */
export function hourPrice(need: 'checkin' | 'checkout', stayHour: number, hour: number): number {
  const diff = need === 'checkin' ? stayHour - hour : hour - stayHour;
  return diff > 0 ? diff * HOUR_RATE : 0;
}

/** The nights an extension adds: `before` nights ending the night before arrival, `after` from the departure night on. */
export function extraNights(arrival: DateStr, departure: DateStr, before: number, after: number): DateStr[] {
  const out: DateStr[] = [];
  for (let i = before; i >= 1; i--) out.push(addDays(arrival, -i));
  for (let i = 0; i < after; i++) out.push(addDays(departure, i));
  return out;
}

export interface NightDay { date: DateStr; available: boolean; price: number | null }

/** How many free nights touch the stay on each side (up to `max`) — a gap stops at the first night that is taken. */
export function freeAround(days: NightDay[], arrival: DateStr, departure: DateStr, max = 7) {
  const by = new Map(days.map(d => [d.date, d]));
  let before = 0, after = 0;
  while (before < max && by.get(addDays(arrival, -(before + 1)))?.available) before++;
  while (after < max && by.get(addDays(departure, after))?.available) after++;
  return { before, after };
}

/** The calendar's price for the nights asked (null if any night has none — the team types the amount). */
export function nightsPrice(days: NightDay[], dates: DateStr[]): number | null {
  const by = new Map(days.map(d => [d.date, d]));
  let sum = 0;
  for (const d of dates) { const p = by.get(d)?.price; if (p == null || !(p > 0)) return null; sum += p; }
  return Math.round(sum * 100) / 100;
}

/** What the guest sees on the payment page and the portal: "Extra nights · Nov 21 – Nov 23". */
export function chargeLabel(category: string, detail: { nights?: DateStr[]; hour?: number | null }): string {
  if (detail.nights?.length) {
    const first = detail.nights[0]!, last = detail.nights[detail.nights.length - 1]!;
    const md = (d: DateStr) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const n = detail.nights.length;
    return `${category} · ${n} night${n === 1 ? '' : 's'} (${first === last ? md(first) : `${md(first)} – ${md(last)}`})`;
  }
  if (detail.hour != null) return `${category} · ${hourLabel(detail.hour)}`;
  return category;
}

/** The upsell item key the books use (guest_payments lines, Revenue → Portal sales). */
export function itemOf(category: string): string {
  return ({ 'Extra nights': 'extra-nights', 'Early check-in': 'early-checkin', 'Late checkout': 'late-checkout', 'Pet fee': 'pet',
    'Extra guest': 'extra-guest', 'Late check-in': 'late-checkin' } as Record<string, string>)[category] ?? 'other';
}

/** Airbnb's own doors: where a host asks for money, and the reservation's page (Change reservation lives there). */
export const AIRBNB_RESOLUTION = 'https://www.airbnb.com/resolutions';
export function airbnbLinks(confirmationCode: string | null | undefined) {
  const code = (confirmationCode ?? '').trim();
  return {
    resolution: AIRBNB_RESOLUTION,
    reservation: /^HM[A-Z0-9]{6,12}$/.test(code) ? `https://www.airbnb.com/hosting/reservations/details/${code}` : null,
  };
}

/** How the guest can pay: a card link anywhere; on Airbnb also its Resolution Center. */
export type ChargeMethod = 'card' | 'rc';
export const methodsFor = (airbnb: boolean): ChargeMethod[] => airbnb ? ['rc', 'card'] : ['card'];

/** A booking Kaizen owns (no channel behind it): its own dates can be moved in Hostaway. */
export const isDirect = (channel: string | null | undefined) => /^(direct|website|bookingengine|manual|owner)$/i.test((channel ?? '').replace(/[^a-z]/gi, ''));

/** What applying a paid upsell does in Hostaway. */
export type ApplyPlan = { kind: 'none' } | { kind: 'hour'; field: 'checkin' | 'checkout'; hour: number }
  | { kind: 'extend'; arrival: DateStr; departure: DateStr } | { kind: 'block'; nights: DateStr[] };
export function applyPlan(c: { need: ChargeNeed; hour: number | null; nights: DateStr[] }, stay: { channel: string; arrival: DateStr | null; departure: DateStr | null }): ApplyPlan {
  if ((c.need === 'checkin' || c.need === 'checkout') && c.hour != null) return { kind: 'hour', field: c.need, hour: c.hour };
  if (c.need !== 'nights' || !c.nights.length) return { kind: 'none' };
  if (isDirect(stay.channel) && stay.arrival && stay.departure) {
    const sorted = [...c.nights].sort();
    const arrival = sorted[0]! < stay.arrival ? sorted[0]! : stay.arrival;
    const last = sorted[sorted.length - 1]!;
    const departure = last >= stay.departure ? addDays(last, 1) : stay.departure;
    return { kind: 'extend', arrival, departure };
  }
  return { kind: 'block', nights: [...c.nights].sort() };
}

/** Contiguous runs of nights — one calendar write per run. */
export function runsOf(nights: DateStr[]): { from: DateStr; to: DateStr }[] {
  const out: { from: DateStr; to: DateStr }[] = [];
  for (const d of [...nights].sort()) {
    const last = out[out.length - 1];
    if (last && addDays(last.to, 1) === d) last.to = d; else out.push({ from: d, to: d });
  }
  return out;
}

/** The urgent to-do when the nights are blocked but the reservation still ends (or starts) on its old day. */
export function followUp(unit: string, guest: string | null, stay: { arrival: DateStr | null; departure: DateStr | null }, nights: DateStr[]) {
  const sorted = [...nights].sort();
  const after = sorted.filter(d => stay.departure && d >= stay.departure);
  const before = sorted.filter(d => stay.arrival && d < stay.arrival);
  const who = guest ?? 'The guest';
  const out = after.length ? addDays(after[after.length - 1]!, 1) : null;
  const lines = [
    out ? `${who} now leaves ${out} instead of ${stay.departure}.` : '',
    before.length ? `${who} now arrives ${before[0]} instead of ${stay.arrival}.` : '',
    'The nights are blocked in Hostaway, but the reservation keeps its dates (paid outside the channel). Do now:',
    '1. Door code: make it work for the new dates (the lock follows the reservation).',
    out ? `2. Clean: move the check-out clean from ${stay.departure} to ${out} and tell the cleaner.` : '2. Clean: the arrival clean must be ready for the earlier day.',
    '3. Messages: cancel the check-out messages planned for the old day (CRM → the stay → Scheduled) and send them on the new one.',
  ].filter(Boolean);
  return { title: `Extended stay — ${unit}: door code, clean, messages`, description: lines.join('\n') };
}

/** The message for an Airbnb guest asked through the Resolution Center (agents draft, humans send). */
export function rcGuestText(label: string, amount: number): string {
  return `All set for ${label} ($${amount.toFixed(2)})! I just sent you a payment request through Airbnb's Resolution Center — you can accept it from your Airbnb messages or at ${AIRBNB_RESOLUTION}. As soon as it is paid we set everything up.`;
}

/** The message with the card link (and the stay page, when the portal has an address). */
export function payGuestText(label: string, amount: number, url: string, stayPage?: string | null): string {
  return `Here is the link to pay for ${label} ($${amount.toFixed(2)}): ${url} — as soon as it is paid we set everything up.${stayPage ? ` You will also find it on your stay page: ${stayPage}` : ''}`;
}

export type ChargeStatus = 'pending' | 'paid' | 'cancelled';
/** One charge as the team and the portal see it. */
export interface UpsellCharge {
  id: string; claimId: string; reservationId: string; label: string; amount: number; status: ChargeStatus; method: ChargeMethod;
  /** The card link — pending card charges only. */
  payUrl: string | null;
  /** What was sold: applied in Hostaway only once paid. */
  nights: DateStr[]; hour: number | null; need: ChargeNeed;
  /** What Kaizen did in Hostaway after the payment, in words ("reservation extended to 2026-11-30", "2 nights blocked"). */
  holds: string[]; applyError: string | null; refunded: number;
  createdBy: string; createdAt: string; paidAt: string | null; livemode: boolean;
}
