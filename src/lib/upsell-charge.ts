/**
 * Charging an upsell from the team's side (owner, 2026-11-19): an upsell case opened in the Inbox (the chat's +) or in
 * Operations → To-do is carried out from there — the money through Stripe, the dates held in Hostaway — instead of
 * someone doing it by hand in three places.
 *
 *  - **Airbnb**: Airbnb collects. Kaizen charges nothing and blocks nothing (an alteration needs the nights open): it
 *    hands the team the Resolution Center (money) and the reservation's page (change the dates), and a message for
 *    the guest.
 *  - **Every other channel**: Kaizen holds what the upsell takes — the extra nights blocked on the calendar, the
 *    new check-in / check-out hour on the reservation — and makes a payment link (Stripe Checkout) that also shows
 *    on the guest's portal page as a pending payment. Paid → the case gets its price and closes as Paid.
 *
 * Pure: the server (functions/_lib/upsell-charge.ts) reads Hostaway and Stripe and calls these.
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

/** The message the team pastes in the chat for an Airbnb guest (agents draft, humans send). */
export function airbnbGuestText(need: ChargeNeed, label: string, amount: number | null): string {
  const usd = amount && amount > 0 ? ` ($${amount.toFixed(2)})` : '';
  return need === 'nights'
    ? `Happy to extend your stay! I just sent you a change request for your reservation on Airbnb${usd} — please accept it from your trip in the Airbnb app and the nights are yours.`
    : `All set for ${label}${usd}! I just sent you a payment request through Airbnb's Resolution Center — you can accept it from your Airbnb messages or at ${AIRBNB_RESOLUTION}.`;
}

/** The message for any other guest: the payment link. */
export function payGuestText(label: string, amount: number, url: string): string {
  return `Here is the link to pay for ${label} ($${amount.toFixed(2)}): ${url} — it is also on your stay page under Pending payments.`;
}

export type ChargeStatus = 'pending' | 'paid' | 'cancelled';
/** One charge as the team and the portal see it. */
export interface UpsellCharge {
  id: string; claimId: string; reservationId: string; label: string; amount: number; status: ChargeStatus;
  payUrl: string | null; nights: DateStr[]; hour: number | null; need: ChargeNeed;
  /** What Kaizen did in Hostaway, in words ("3 nights blocked", "check-out 2:00 PM set") — or why it could not. */
  holds: string[]; createdBy: string; createdAt: string; paidAt: string | null; livemode: boolean;
}
