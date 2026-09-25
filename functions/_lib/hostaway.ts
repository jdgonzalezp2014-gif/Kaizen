/**
 * Hostaway client — server only, by construction.
 *
 * It lives under `functions/` rather than `src/` deliberately. Anything
 * in `src/` can be imported by a component and end up in the browser
 * bundle; nothing here can, because Vite never sees this directory. The
 * credential is full read/write on bookings and guest data, so "please
 * do not import this" is not a strong enough guarantee.
 *
 * Credentials are PASSED IN, never read from the environment. On the
 * Workers runtime there is no ambient `process.env` — Cloudflare hands
 * bindings to the request handler — and taking them as an argument also
 * means this module has no hidden inputs and can be tested.
 *
 * The defensive branches below are not caution. Each is a real failure
 * observed against this account:
 *
 *   · The calendar endpoint accepts three spellings of its date
 *     parameters depending on plan, and silently ignores the ones it
 *     does not recognise — returning the full horizon instead of erroring.
 *   · `/reservations` filtered by listing sometimes returns the whole
 *     account. Every unit then reports the portfolio total, all
 *     identical, with nothing looking wrong.
 *   · A reservation with `totalPrice` 0 is an iCal block or an owner
 *     stay. The listing's default cleaning fee still resolves, so the
 *     naive `(total - cleaning) / nights` invents negative revenue — a
 *     321-night owner block was quietly billing its unit.
 */

export interface HostawayToken { value: string; expires: number }

export interface HostawayCredentials {
  accountId: string;
  apiKey: string;
  /** A token kept from an earlier request (accounts.ts), reused while valid. */
  token?: HostawayToken | null;
  /** Told about a new token, or null when Hostaway refused the kept one. */
  onToken?: (t: HostawayToken | null) => Promise<void>;
}

/** Hostaway refused the token itself — distinct from any other failure, because it has a fix. */
export class HostawayAuthError extends Error {}

import type { DateStr } from '../../src/lib/dates.ts';
import { addDays, daysBetween } from '../../src/lib/dates.ts';

const BASE = 'https://api.hostaway.com/v1';

/**
 * `specialStatus` values that mean the listing is not taking bookings.
 * Confirmed on this account: one listing carries "archived" and shows as
 * Draft/Archived in the Hostaway UI, with every channel export null.
 */
const NOT_LIVE = new Set(['archived', 'draft', 'inactive', 'disabled', 'deleted']);

export interface ChannelStatus {
  key: 'airbnb' | 'vrbo' | 'bookingcom' | 'expedia' | 'marriott' | 'direct';
  label: string;
  /** Hostaway's export state: 'exported' when the listing is pushed there. */
  exportStatus: string | null;
  url: string | null;
  /** Exported AND reachable: the pair is what "bookable there" means. */
  live: boolean;
}

/**
 * Google is deliberately absent. Hostaway exports to Google Vacation
 * Rentals and reports a URL for it, but the listing there is not one
 * anybody here manages or prices against — carrying it produced a row
 * that could never be acted on.
 */
const CHANNELS: [ChannelStatus['key'], string, string, string][] = [
  ['airbnb',     'Airbnb',        'airbnbExportStatus',     'airbnbListingUrl'],
  ['vrbo',       'Vrbo',          'vrboExportStatus',       'vrboListingUrl'],
  ['bookingcom', 'Booking.com',   'bookingcomExportStatus', 'bookingcomListingUrl'],
  ['expedia',    'Expedia',       'expediaExportStatus',    'expediaListingUrl'],
  ['marriott',   'Marriott',      'marriotExportStatus',    'marriottListingUrl']
];

export interface HostawayListing {
  listingId: string;
  name: string;
  active: boolean;
  bedrooms: number | null;
  bathrooms: number | null;
  capacity: number | null;
  propertyTypeId: number | null;
  lat: number | null;
  lng: number | null;
  city: string;
  state: string;
  timeZone: string;
  /** Hostaway's publication flag: 'archived', 'draft', or null when live. */
  specialStatus: string | null;
  /**
   * Per-channel publication, straight from Hostaway.
   *
   * This answers "is it public and can it be booked there" without
   * fetching a single page: `exported` plus a live URL means the channel
   * has it. Only Airbnb is surfaced today; the rest are carried so the
   * next platform is a UI change rather than a data change.
   */
  channels: ChannelStatus[];
  amenities: string[];
  /** The listing's default nightly rate, before any calendar override. */
  basePrice: number | null;
  /** What the GUEST is charged to clean. Not what the cleaner is paid. */
  cleaningFee: number | null;
  /** Percent off, 0–100. See discountPct for why this is not the raw field. */
  weeklyDiscountPct: number | null;
  monthlyDiscountPct: number | null;
}

/**
 * Hostaway stores length-of-stay discounts as a MULTIPLIER: 0.85 means a
 * 15% discount. Everything a human types is a percent, so the conversion
 * happens once, here, in both directions.
 *
 * The zero guard is the whole reason this is a function. An unset
 * discount comes back as 0, and `(1 - 0) * 100` is 100% off — a free
 * stay, written to a live listing, from a field that meant "none".
 */
export function discountPct(multiplier: unknown): number | null {
  const m = Number(multiplier);
  if (!Number.isFinite(m) || m <= 0 || m > 1) return null;
  return Math.round((1 - m) * 10000) / 100;
}

export function discountMultiplier(pct: number): number {
  const p = Math.max(0, Math.min(90, Number(pct) || 0));
  return Math.round((1 - p / 100) * 10000) / 10000;
}

export interface HostawayReservation {
  listingId: string;
  reservationId: string;
  status: string;
  channel: string;
  bookedOn: DateStr | '';
  arrival: DateStr;
  departure: DateStr;
  nights: number;
  totalPaid: number;
  cleaningFee: number;
  /** For the operations board. Never the portal URL — that is a login token. */
  guestName?: string;
  /**
   * The guest as the daily file names their documents folder: first +
   * last, else guestName, else "Guest" (cliente-gas 05 documents.js). Kept
   * apart from guestName so Kaizen finds the SAME folder (§73).
   */
  docName?: string;
  guests?: number | null;
  /** Only to recognise the same guest booking again. Never sent to a browser. */
  phone?: string;
}

export interface CalendarDay {
  date: DateStr;
  price: number | null;
  status: string;
  available: boolean;
  /**
   * Minimum nights for a stay starting here. A lever as strong as price:
   * a two-night gap under a three-night minimum cannot be booked at any
   * price, so discounting it does nothing at all.
   */
  minStay: number | null;
}

/**
 * Per ACCOUNT, never one module-wide slot: a token belongs to one Hostaway
 * account, and a shared slot would hand one tenant's token to the next
 * request in the same isolate.
 */
const warm = new Map<string, HostawayToken>();
const pending = new Map<string, Promise<HostawayToken>>();
const valid = (t: HostawayToken | null | undefined) => !!t && t.expires > Date.now() + 60_000;

/**
 * A token for this account, in the cheapest way available: the one kept
 * from an earlier request (stored encrypted, accounts.ts), the one this
 * isolate already holds, or — only when neither is valid — a new one.
 * Requests racing for a new token share ONE request to Hostaway.
 */
export async function getAccessToken(creds: HostawayCredentials): Promise<string> {
  if (valid(creds.token)) return creds.token!.value;
  const held = warm.get(creds.accountId);
  if (valid(held)) return held!.value;

  let inflight = pending.get(creds.accountId);
  if (!inflight) {
    inflight = requestToken(creds).finally(() => pending.delete(creds.accountId));
    pending.set(creds.accountId, inflight);
  }
  const t = await inflight;
  creds.token = t;
  return t.value;
}

async function requestToken(creds: HostawayCredentials): Promise<HostawayToken> {
  const { accountId, apiKey } = creds;
  if (!accountId || !apiKey) {
    throw new Error('Hostaway credentials are missing from the environment.');
  }

  const res = await fetch(`${BASE}/accessTokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: accountId,
      client_secret: apiKey,
      scope: 'general'
    })
  });

  if (!res.ok) {
    // Deliberately does not echo the response body — it can contain the
    // credential that was rejected.
    throw new Error(`Hostaway auth failed (${res.status}).`);
  }

  const json = await res.json() as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('Hostaway returned no access token.');

  const t = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 };
  warm.set(accountId, t);
  // Kept for the next request. A failure to store it costs speed, never
  // the request.
  await creds.onToken?.(t).catch(() => {});
  return t;
}

/**
 * Runs `fn` with a token, and if Hostaway refuses that token — a key
 * rotated, a token revoked — drops it everywhere it is kept and tries
 * once more with a new one. Once: a second refusal is a real failure.
 */
async function withToken<T>(creds: HostawayCredentials, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await getAccessToken(creds);
  try {
    return await fn(token);
  } catch (e) {
    if (!(e instanceof HostawayAuthError)) throw e;
    warm.delete(creds.accountId);
    creds.token = null;
    await creds.onToken?.(null).catch(() => {});
    return fn(await getAccessToken(creds));
  }
}

async function apiGetEnvelope<T>(path: string, token: string): Promise<{ result: T[]; count: number }> {
  // Retries 429 and 5xx with a widening gap. Hostaway rate-limits a
  // full-portfolio sweep, and failing the whole sync because one call in
  // twenty-seven was throttled is the wrong trade.
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });

    if (res.status === 429 || res.status >= 500) {
      await new Promise(r => setTimeout(r, 400 * (attempt + 1) ** 2));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new HostawayAuthError(`Hostaway refused the access token (${res.status}).`);
    if (!res.ok) throw new Error(`Hostaway ${path} returned ${res.status}.`);

    const json = await res.json() as { result?: T[]; count?: number } | T[];
    if (Array.isArray(json)) return { result: json, count: json.length };
    return { result: (json.result ?? []) as T[], count: Number(json.count ?? 0) };
  }
  throw new Error(`Hostaway ${path} kept failing after 4 attempts.`);
}

async function apiGet<T>(path: string, token: string): Promise<T[]> {
  return (await apiGetEnvelope<T>(path, token)).result;
}

function firstNumber(o: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const n = Number(o[k]);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function asDate(v: unknown): DateStr | '' {
  const s = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

export async function fetchListings(creds: HostawayCredentials, token?: string): Promise<HostawayListing[]> {
  const raw = token ? await apiGet<Record<string, any>>('/listings', token)
    : await withToken(creds, t => apiGet<Record<string, any>>('/listings', t));

  return raw.map(l => ({
    listingId: String(l.id),
    name: l.internalListingName || l.name || '',
    // `isActive`, `status` and `listingStatus` were checked here for
    // months. NONE of them exist on the listing object — the expression
    // was always true, so every listing was "active" and the sync
    // reported 0 inactive forever. The field that actually carries this
    // is `specialStatus`, which is null on a live listing and
    // "archived" on one that was taken down.
    //
    // Only known non-live values disqualify. An unrecognised value keeps
    // the listing active and is carried through to the UI instead, so a
    // new Hostaway status shows up as a label to investigate rather than
    // silently deleting a working unit from the portfolio.
    active: !NOT_LIVE.has(String(l.specialStatus ?? '').toLowerCase()),
    specialStatus: l.specialStatus ? String(l.specialStatus) : null,
    channels: CHANNELS.map(([key, label, statusField, urlField]) => {
      const exportStatus = l[statusField] ? String(l[statusField]) : null;
      const url = l[urlField] ? String(l[urlField]) : null;
      return {
        key, label, exportStatus, url,
        // Both, deliberately. Expedia and Google hand back a generic
        // city-search URL for listings they do not actually carry, so a
        // URL alone proves nothing — and an export status alone does not
        // give anyone a link to check.
        live: exportStatus === 'exported' && !!url
      };
    }),
    bedrooms: firstNumber(l, ['bedroomsNumber', 'bedrooms']) || null,
    bathrooms: firstNumber(l, ['bathroomsNumber', 'bathrooms']) || null,
    capacity: firstNumber(l, ['personCapacity', 'maxGuests', 'accommodates']) || null,
    propertyTypeId: Number.isFinite(Number(l.propertyTypeId)) ? Number(l.propertyTypeId) : null,
    lat: Number(l.lat ?? l.latitude) || null,
    lng: Number(l.lng ?? l.longitude) || null,
    city: String(l.city ?? '').trim(),
    state: String(l.state ?? '').trim(),
    timeZone: String(l.timeZoneName ?? '').trim(),
    amenities: Array.isArray(l.listingAmenities)
      ? l.listingAmenities.map((a: any) => String(a?.amenityName ?? a ?? '')).filter(Boolean)
      : [],
    basePrice: Number(l.price) || null,
    cleaningFee: Number(l.cleaningFee) || null,
    weeklyDiscountPct: discountPct(l.weeklyDiscount),
    monthlyDiscountPct: discountPct(l.monthlyDiscount)
  }));
}

/** Reservation statuses that never occupied a night and never paid out. */
const NON_COUNTING = new Set([
  'cancelled', 'declined', 'expired', 'inquiry', 'inquirypreapproved',
  'inquirydenied', 'inquirytimedout', 'inquirynotpossible', 'awaitingpayment'
]);

export function reservationCounts(status: string): boolean {
  return !NON_COUNTING.has(String(status).toLowerCase().replace(/[^a-z]/g, ''));
}

/**
 * Small pages, fetched side by side. Hostaway's time grows with the rows
 * in a page but pages run concurrently — measured: one page of 500 in
 * 3.9 s, seven pages of 100 together in 1.4 s. The cap keeps a year of
 * history from becoming a burst Hostaway answers with 429s.
 */
const PAGE = 100;
const CONCURRENT_PAGES = 8;

/**
 * Every stay that touches [from, to]: departs on or after `from` AND
 * arrives on or before `to` — exactly the overlap test the account-wide
 * pull applied locally, asked of Hostaway instead.
 *
 * This is what makes a screen fast without making it stale. Measured on
 * this account: the stays touching the next 30 days are 62 rows in 1.2 s,
 * against 2,050 rows in five pages for the whole history. Nothing is
 * cached; a different range is simply a different question, asked live.
 * Still clamped locally, in case Hostaway ever stops honouring a filter —
 * then this is slow, never wrong.
 */
export async function fetchReservationsTouching(
  creds: HostawayCredentials, from: DateStr, to: DateStr
): Promise<HostawayReservation[]> {
  return (await pagedReservations(creds, `&departureStartDate=${from}&arrivalEndDate=${to}`))
    .filter(r => r.departure >= from && r.arrival <= to);
}

/**
 * Every reservation with activity — a booking, a change — since `since`,
 * whatever its stay dates. The only way to ask "who booked lately" of
 * Hostaway: it ignores a booking-date filter (`reservationDateStart`
 * returns all 2,050 rows) but honours `latestActivityStart` (65 rows for
 * one week, 0.7 s).
 */
export async function fetchReservationsActiveSince(
  creds: HostawayCredentials, since: DateStr
): Promise<HostawayReservation[]> {
  return pagedReservations(creds, `&latestActivityStart=${since}`);
}

/**
 * What a forward study of [asOf, to] needs, and no more:
 *
 *   · the stays touching the window, and the last 90 days before it —
 *     occupancy, pickup, and a recent sample for lead time
 *   · anything booked or changed in the last 30 days, whatever its dates —
 *     so "no booking of any kind for 21 days" is judged on real activity
 *
 * Lead time is therefore the median over RECENT stays rather than two
 * years of them — how the unit books now, which is the question.
 */
export async function fetchStudyReservations(
  creds: HostawayCredentials, asOf: DateStr, to: DateStr
): Promise<HostawayReservation[]> {
  const [window, recent] = await Promise.all([
    fetchReservationsTouching(creds, addDaysIso(asOf, -STUDY_LOOKBACK_DAYS), to),
    fetchReservationsActiveSince(creds, addDaysIso(asOf, -RECENT_ACTIVITY_DAYS))
  ]);
  const byId = new Map<string, HostawayReservation>();
  for (const r of [...window, ...recent]) byId.set(r.reservationId, r);
  return [...byId.values()];
}
const STUDY_LOOKBACK_DAYS = 90;
const RECENT_ACTIVITY_DAYS = 30;
const addDaysIso = (d: DateStr, n: number): DateStr =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

async function pagedReservations(creds: HostawayCredentials, query: string): Promise<HostawayReservation[]> {
  return withToken(creds, token => pagedReservationsWith(token, query));
}

async function pagedReservationsWith(token: string, query: string): Promise<HostawayReservation[]> {

  // The first page reports the total, so the rest are fetched together
  // rather than discovered one round trip at a time.
  const first = await apiGetEnvelope<Record<string, any>>(`/reservations?limit=${PAGE}&offset=0${query}`, token);
  const raw: Record<string, any>[] = [...first.result];

  const total = Math.min(first.count || first.result.length, 50_000);
  const offsets: number[] = [];
  for (let o = PAGE; o < total; o += PAGE) offsets.push(o);

  // A page that still fails after apiGetEnvelope's retries FAILS the
  // request. It used to be swallowed as an empty page, which quietly
  // returned part of the reservations — revenue short by a page, with
  // nothing on screen saying so. A refusal is honest; a partial total is
  // not.
  for (let i = 0; i < offsets.length; i += CONCURRENT_PAGES) {
    const pages = await Promise.all(offsets.slice(i, i + CONCURRENT_PAGES).map(o =>
      apiGet<Record<string, any>>(`/reservations?limit=${PAGE}&offset=${o}${query}`, token)));
    pages.forEach(pg => raw.push(...pg));
  }

  return raw
    .filter(r => reservationCounts(String(r.status ?? '')))
    .map(r => {
      const arrival = asDate(r.arrivalDate ?? r.checkInDate ?? r.startDate);
      const departure = asDate(r.departureDate ?? r.checkOutDate ?? r.endDate);
      const total = firstNumber(r, ['totalPrice', 'totalPaid', 'price', 'baseRate']);
      const paid = total > 0;

      return {
        listingId: String(r.listingMapId ?? r.listingId ?? r.listing_id ?? ''),
        reservationId: String(r.id ?? ''),
        status: String(r.status ?? ''),
        channel: String(r.channelName ?? r.source ?? r.channel ?? ''),
        bookedOn: asDate(r.reservationDate ?? r.insertedOn ?? r.confirmedOn ?? r.createdOn),
        arrival,
        departure,
        nights: arrival && departure ? Math.max(1, daysBetween(arrival, departure)) : 0,
        totalPaid: total,
        cleaningFee: paid ? firstNumber(r, ['cleaningFee', 'cleaningFeeAmount']) : 0,
        guestName: String(r.guestName ??
          [r.guestFirstName, r.guestLastName].filter(Boolean).join(' ')).trim(),
        docName: `${r.guestFirstName ?? ''} ${r.guestLastName ?? ''}`.trim() || String(r.guestName ?? '').trim() || 'Guest',
        guests: Number(r.numberOfGuests ?? r.adults) || null,
        phone: String(r.phone ?? '')
      };
    })
    .filter(r => r.arrival && r.departure && r.listingId);
}

/** One listing's reservations, filtered from the account-wide pull. */
export async function fetchReservations(
  creds: HostawayCredentials, listingId: string, from: DateStr, to: DateStr
): Promise<HostawayReservation[]> {
  const all = await fetchReservationsTouching(creds, from, to);
  return all.filter(r => r.listingId === String(listingId));
}

/**
 * Calendar for one listing.
 *
 * Clamped to the requested window because the endpoint sometimes honours
 * none of its date parameters and returns the full horizon regardless.
 */
export async function fetchCalendar(
  creds: HostawayCredentials, listingId: string, from: DateStr, to: DateStr, token?: string
): Promise<CalendarDay[]> {
  const t = token ?? await getAccessToken(creds);
  const variants = [
    `/listings/${listingId}/calendar?startDate=${from}&endDate=${to}`,
    `/listings/${listingId}/calendar?dateFrom=${from}&dateTo=${to}`,
    `/listings/${listingId}/calendar`
  ];

  for (const path of variants) {
    let raw: Record<string, any>[];
    try { raw = await apiGet<Record<string, any>>(path, t); } catch { continue; }

    const days = raw
      .map(d => ({
        date: asDate(d.date),
        price: Number(d.price) || null,
        status: String(d.status ?? ''),
        available: String(d.status ?? '').toLowerCase() === 'available' && d.isAvailable !== 0,
        minStay: Number(d.minimumStay) || null
      }))
      .filter(d => d.date && d.date >= from && d.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date)) as CalendarDay[];

    if (days.length) return days;
  }
  return [];
}

/* ── writes ──────────────────────────────────────────────────────────
 *
 * Everything below changes a live, guest-facing price. Two rules apply
 * to all of it.
 *
 * FIRST: never trust the response. Hostaway's calendar write is
 * under-documented — the published reference describes a price
 * CALCULATION endpoint and a changelog line from 2017 — so the request
 * shape here is the documented one plus fallbacks, and the only thing
 * that decides whether a write worked is reading the value back. A 200
 * that did nothing is the exact failure this table must never record as
 * a success, because the whole point of the log is to learn which price
 * changes filled nights, and a change that never happened poisons that.
 *
 * SECOND: send only what is being changed. A full-object PUT would carry
 * whatever the read returned, including fields this app does not model,
 * and quietly overwrite work someone did in Hostaway's own UI.
 */

async function apiSend(
  path: string, token: string, body: unknown, method: 'PUT' | 'POST'
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Cache-control': 'no-cache'
    },
    body: JSON.stringify(body)
  });
  return { ok: res.ok, status: res.status, text: (await res.text()).slice(0, 400) };
}

export interface WriteResult {
  ok: boolean;
  detail: string;
  /** What the value actually is after the write, read back from Hostaway. */
  verified: number | null;
}

/**
 * Set the nightly price across a date range.
 *
 * Verified by re-reading the range and checking every night, not the
 * first one: a partial apply (some nights taken, some refused because
 * they are reserved) is the likely failure and looks identical to
 * success from the response body.
 */
export async function updateCalendarPrice(
  creds: HostawayCredentials, listingId: string,
  from: DateStr, to: DateStr, price: number, token?: string
): Promise<WriteResult> {
  const t = token ?? await getAccessToken(creds);
  const want = Math.round(Number(price));
  if (!Number.isFinite(want) || want <= 0) {
    return { ok: false, detail: `Refusing to write a nightly price of ${price}.`, verified: null };
  }

  const attempts: [( 'PUT' | 'POST' ), string, unknown][] = [
    ['PUT',  `/listings/${listingId}/calendar`, { startDate: from, endDate: to, price: want }],
    ['POST', `/listings/${listingId}/calendar`, { startDate: from, endDate: to, price: want }],
    ['PUT',  `/listings/${listingId}/calendar`, [{ startDate: from, endDate: to, price: want }]]
  ];

  const tried: string[] = [];
  for (const [method, path, body] of attempts) {
    const r = await apiSend(path, t, body, method);
    tried.push(`${method} ${path} → ${r.status}`);
    if (!r.ok) continue;

    // The response said yes. That is not evidence.
    const days = await fetchCalendar(creds, listingId, from, to, t);
    const wrong = days.filter(d => Math.round(Number(d.price)) !== want);
    if (!days.length) {
      return { ok: false, detail: `Wrote, but could not read the range back to confirm. ${tried.join('; ')}`, verified: null };
    }
    if (wrong.length) {
      return {
        ok: false,
        detail: `${days.length - wrong.length} of ${days.length} night(s) took the new price. ` +
                `Unchanged: ${wrong.slice(0, 5).map(d => d.date).join(', ')}` +
                (wrong.length > 5 ? ` and ${wrong.length - 5} more` : '') +
                '. Nights that are already reserved cannot be repriced.',
        verified: Number(days[0]!.price) || null
      };
    }
    return { ok: true, detail: `${days.length} night(s) set to ${want}.`, verified: want };
  }

  return { ok: false, detail: `Hostaway refused every calendar write form. ${tried.join('; ')}`, verified: null };
}

/**
 * Set the weekly and/or monthly length-of-stay discount on the listing.
 *
 * This is documented: PUT /listings/{id} takes a partial object. It is
 * still read back, because the multiplier conversion is the kind of
 * thing that is wrong in exactly one direction and looks fine either way
 * until a guest books a month at 25% of the rate.
 */
export async function updateListingDiscounts(
  creds: HostawayCredentials, listingId: string,
  discounts: { weeklyPct?: number | null; monthlyPct?: number | null }, token?: string
): Promise<WriteResult> {
  const t = token ?? await getAccessToken(creds);

  const body: Record<string, number> = {};
  if (discounts.weeklyPct  != null) body.weeklyDiscount  = discountMultiplier(discounts.weeklyPct);
  if (discounts.monthlyPct != null) body.monthlyDiscount = discountMultiplier(discounts.monthlyPct);
  if (!Object.keys(body).length) {
    return { ok: false, detail: 'No discount supplied.', verified: null };
  }

  const r = await apiSend(`/listings/${listingId}`, t, body, 'PUT');
  if (!r.ok) return { ok: false, detail: `Hostaway rejected the update (${r.status}): ${r.text}`, verified: null };

  const after = (await fetchListings(creds, t)).find(l => l.listingId === String(listingId));
  if (!after) return { ok: false, detail: 'Wrote, but the listing did not come back to confirm.', verified: null };

  const checks: string[] = [];
  let ok = true;
  if (discounts.weeklyPct != null) {
    const got = after.weeklyDiscountPct;
    if (got == null || Math.abs(got - discounts.weeklyPct) > 0.51) { ok = false; checks.push(`weekly is ${got ?? 'unset'}%, asked for ${discounts.weeklyPct}%`); }
    else checks.push(`weekly ${got}%`);
  }
  if (discounts.monthlyPct != null) {
    const got = after.monthlyDiscountPct;
    if (got == null || Math.abs(got - discounts.monthlyPct) > 0.51) { ok = false; checks.push(`monthly is ${got ?? 'unset'}%, asked for ${discounts.monthlyPct}%`); }
    else checks.push(`monthly ${got}%`);
  }
  return { ok, detail: checks.join('; '), verified: after.monthlyDiscountPct ?? after.weeklyDiscountPct };
}

/**
 * Calendars for many listings at once.
 *
 * One request per listing is unavoidable here — unlike /reservations,
 * the calendar endpoint really is per listing — so they go out together
 * and a listing whose calendar fails yields an empty array rather than
 * failing the whole dashboard.
 */
export async function fetchCalendars(
  creds: HostawayCredentials, listingIds: string[], from: DateStr, to: DateStr
): Promise<Record<string, CalendarDay[]>> {
  const out: Record<string, CalendarDay[]> = {};
  // One listing's calendar failing leaves that unit "unknown" on screen,
  // which says so. A refused TOKEN is different — it would fail every
  // one — so it is let through to be renewed rather than swallowed.
  const results = await withToken(creds, token => Promise.all(
    listingIds.map(id => fetchCalendar(creds, id, from, to, token).catch(e => {
      if (e instanceof HostawayAuthError) throw e;
      return [] as CalendarDay[];
    }))
  ));
  listingIds.forEach((id, i) => { out[id] = results[i]!; });
  return out;
}

/* ── guest documents (§73) ────────────────────────────────────────── */

/**
 * One reservation in full. GET /reservations/{id} carries everything the
 * daily file found for documents (verified there on 2026-08-30): the
 * signed agreement PDF (`rentalAgreementFileUrl`, null until the guest
 * finishes the portal) and its state (`reservationAgreement`). The ID
 * image is never exposed, for any unit.
 */
export async function fetchReservationDetail(creds: HostawayCredentials, reservationId: string): Promise<Record<string, unknown> | null> {
  const token = await getAccessToken(creds);
  const res = await fetch(`${BASE}/reservations/${encodeURIComponent(reservationId)}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store'
  });
  if (!res.ok) return null;
  return ((await res.json()) as { result?: Record<string, unknown> }).result ?? null;
}

/** The signed agreement's bytes. Hostaway's own links want the token; others are public. */
export async function downloadAgreement(creds: HostawayCredentials, url: string): Promise<{ bytes: ArrayBuffer; mimeType: string }> {
  const headers: Record<string, string> = /hostaway\.com/i.test(new URL(url).hostname)
    ? { Authorization: `Bearer ${await getAccessToken(creds)}` } : {};
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`The agreement did not download (HTTP ${res.status}).`);
  return { bytes: await res.arrayBuffer(), mimeType: res.headers.get('Content-Type')?.split(';')[0] || 'application/pdf' };
}

/* ── the Host Note ────────────────────────────────────────────────── */

/**
 * A reservation's Host Note — the one field on the reservation popup in
 * Hostaway's calendar the team reads. Confirmed on this account by the
 * daily file (GET /reservations/{id} → `hostNote`, 2026-09-14).
 */
export async function fetchHostNote(creds: HostawayCredentials, reservationId: string): Promise<string | null> {
  const token = await getAccessToken(creds);
  const res = await fetch(`${BASE}/reservations/${encodeURIComponent(reservationId)}`, {
    headers: { Authorization: `Bearer ${token}` }, cache: 'no-store'
  });
  if (!res.ok) return null;
  const json = await res.json() as { result?: Record<string, unknown> };
  return String(json.result?.hostNote ?? '');
}

/**
 * Writes the Host Note — only that field, never the whole reservation,
 * so nothing typed elsewhere in Hostaway is overwritten — and then READS
 * IT BACK. A 200 that changed nothing is reported as a failure, the same
 * rule as every other write in this file.
 */
export async function writeHostNote(
  creds: HostawayCredentials, reservationId: string, note: string
): Promise<{ ok: boolean; detail: string }> {
  const token = await getAccessToken(creds);
  const put = await apiSend(`/reservations/${encodeURIComponent(reservationId)}`, token, { hostNote: note }, 'PUT');
  if (!put.ok) return { ok: false, detail: `Hostaway answered ${put.status}: ${put.text.slice(0, 160)}` };
  const back = await fetchHostNote(creds, reservationId);
  if (back === null) return { ok: false, detail: 'Written, but could not be read back to confirm.' };
  return back.trim() === note.trim()
    ? { ok: true, detail: 'written and confirmed' }
    : { ok: false, detail: 'Hostaway accepted the write but the note reads back differently.' };
}
