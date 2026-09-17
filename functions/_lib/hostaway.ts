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

export interface HostawayCredentials {
  accountId: string;
  apiKey: string;
}

import type { DateStr } from '../../src/lib/dates.ts';
import { addDays, daysBetween } from '../../src/lib/dates.ts';

const BASE = 'https://api.hostaway.com/v1';

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
}

export interface CalendarDay {
  date: DateStr;
  price: number | null;
  status: string;
  available: boolean;
}

let cachedToken: { token: string; expires: number } | null = null;

/**
 * Tokens last hours; a Worker instance lives minutes. Caching in module
 * scope helps within one warm isolate and costs nothing on a cold one.
 */
export async function getAccessToken(creds: HostawayCredentials): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;

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

  cachedToken = {
    token: json.access_token,
    expires: Date.now() + (json.expires_in ?? 3600) * 1000
  };
  return cachedToken.token;
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
  const t = token ?? await getAccessToken(creds);
  const raw = await apiGet<Record<string, any>>('/listings', t);

  return raw.map(l => ({
    listingId: String(l.id),
    name: l.internalListingName || l.name || '',
    // Hostaway spells "switched off" several ways depending on plan.
    active: l.isActive !== false && l.status !== 'inactive' && l.listingStatus !== 'inactive',
    bedrooms: firstNumber(l, ['bedroomsNumber', 'bedrooms']) || null,
    bathrooms: firstNumber(l, ['bathroomsNumber', 'bathrooms']) || null,
    capacity: firstNumber(l, ['personCapacity', 'maxGuests', 'accommodates']) || null,
    propertyTypeId: Number.isFinite(Number(l.propertyTypeId)) ? Number(l.propertyTypeId) : null,
    lat: Number(l.lat ?? l.latitude) || null,
    lng: Number(l.lng ?? l.longitude) || null,
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

const PAGE = 500;

/**
 * Every reservation in the account, paginated.
 *
 * NOT one request per listing, and that is a correctness fix rather than
 * an optimisation. Two documented Hostaway behaviours compound:
 *
 *   · `/reservations` ignores `listingMapId` and returns account-wide
 *     rows anyway, which is why every result is re-filtered by listing.
 *   · It pages at 100 rows by default and says so only in a `limit`
 *     field nobody reads.
 *
 * Together those truncated silently: we asked for one listing, got 100
 * rows belonging to the whole account, and kept the two that matched.
 * Across 27 listings that returned 57 of 2,020 reservations — revenue at
 * three percent of reality, with nothing erroring.
 *
 * Fetching account-wide and grouping locally is also five requests
 * instead of twenty-nine, and about a second instead of seventeen.
 */
export async function fetchAllReservations(
  creds: HostawayCredentials, from: DateStr, to: DateStr
): Promise<HostawayReservation[]> {
  const token = await getAccessToken(creds);

  // The first page reports the account total, so the rest are fetched at
  // once rather than discovered one round trip at a time. Sequential
  // paging cost ~3 seconds per page; the whole point of a single call is
  // that the page is not left blank while it happens.
  const first = await apiGetEnvelope<Record<string, any>>(`/reservations?limit=${PAGE}&offset=0`, token);
  const raw: Record<string, any>[] = [...first.result];

  const total = Math.min(first.count || first.result.length, 50_000);
  const offsets: number[] = [];
  for (let o = PAGE; o < total; o += PAGE) offsets.push(o);

  if (offsets.length) {
    const pages = await Promise.all(offsets.map(o =>
      apiGet<Record<string, any>>(`/reservations?limit=${PAGE}&offset=${o}`, token)
        .catch(() => [])));
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
        cleaningFee: paid ? firstNumber(r, ['cleaningFee', 'cleaningFeeAmount']) : 0
      };
    })
    // Overlap, not containment: a stay that began before the window and
    // runs into it still earns nights inside it.
    .filter(r => r.arrival && r.departure && r.listingId &&
                 r.departure >= from && r.arrival <= to);
}

/** One listing's reservations, filtered from the account-wide pull. */
export async function fetchReservations(
  creds: HostawayCredentials, listingId: string, from: DateStr, to: DateStr
): Promise<HostawayReservation[]> {
  const all = await fetchAllReservations(creds, from, to);
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
        available: String(d.status ?? '').toLowerCase() === 'available' && d.isAvailable !== 0
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
  const token = await getAccessToken(creds);
  const out: Record<string, CalendarDay[]> = {};
  const results = await Promise.all(
    listingIds.map(id => fetchCalendar(creds, id, from, to, token).catch(() => [] as CalendarDay[]))
  );
  listingIds.forEach((id, i) => { out[id] = results[i]!; });
  return out;
}
