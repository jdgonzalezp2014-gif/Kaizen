/**
 * Hostaway client — server-side only.
 *
 * Every function here reads `HOSTAWAY_ACCOUNT_ID` / `HOSTAWAY_API_KEY`
 * from the environment, so this module must only ever be imported from
 * `app/api/**` or a GitHub Action. Importing it into a component ships
 * the credential to the browser, and that credential is full read/write
 * on bookings and guest data.
 *
 * The defensive bits below are not paranoia. They are behaviours
 * observed against this account:
 *
 *   · The calendar endpoint accepts three different spellings of its
 *     date parameters depending on plan, and ignores the ones it does
 *     not recognise — returning everything rather than erroring.
 *   · `/reservations` filtered by listing sometimes returns the whole
 *     account. Unfiltered, every unit reports the portfolio total and
 *     nothing looks wrong.
 *   · A reservation with `totalPrice` 0 is an iCal block or an owner
 *     stay. The listing's default cleaning fee still resolves, so the
 *     naive `(total - cleaning) / nights` invents negative revenue.
 */
import type { DateStr } from './dates.ts';
import { addDays, daysBetween } from './dates.ts';

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

/** Never logged, never returned to a client. */
function credentials() {
  const accountId = process.env.HOSTAWAY_ACCOUNT_ID;
  const apiKey = process.env.HOSTAWAY_API_KEY;
  if (!accountId || !apiKey) {
    throw new Error('HOSTAWAY_ACCOUNT_ID and HOSTAWAY_API_KEY must be set in the server environment.');
  }
  return { accountId, apiKey };
}

let cachedToken: { token: string; expires: number } | null = null;

/**
 * Tokens last hours; a serverless instance lives minutes. Caching in
 * module scope helps within one warm instance and costs nothing when a
 * cold one starts.
 */
export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;

  const { accountId, apiKey } = credentials();
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

async function apiGet<T>(path: string, token: string): Promise<T[]> {
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

    const json = await res.json() as { result?: T[] } | T[];
    if (Array.isArray(json)) return json;
    return (json.result ?? []) as T[];
  }
  throw new Error(`Hostaway ${path} kept failing after 4 attempts.`);
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

export async function fetchListings(token?: string): Promise<HostawayListing[]> {
  const t = token ?? await getAccessToken();
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
      : []
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
 * Reservations for one listing.
 *
 * The result is re-filtered by listing id even though the query asks for
 * one: when the endpoint ignores `listingMapId` it returns the entire
 * account, and without this every unit would report the portfolio total.
 * That bug is silent — the numbers look plausible and are all identical.
 */
export async function fetchReservations(
  listingId: string, from: DateStr, to: DateStr, token?: string
): Promise<HostawayReservation[]> {
  const t = token ?? await getAccessToken();
  // A long lookback catches stays that began well before the window and
  // still overlap it.
  const buffered = addDays(from, -400);

  const variants = [
    `/reservations?listingMapId=${listingId}&arrivalStartDate=${buffered}&arrivalEndDate=${to}`,
    `/reservations?listingMapId=${listingId}&fromDate=${buffered}&toDate=${to}`,
    `/reservations?listingMapId=${listingId}`
  ];

  for (const path of variants) {
    let raw: Record<string, any>[];
    try { raw = await apiGet<Record<string, any>>(path, t); } catch { continue; }

    const owned = raw.filter(r =>
      String(r.listingMapId ?? r.listingId ?? r.listing_id ?? '') === String(listingId));
    if (!owned.length) continue;

    return owned
      .filter(r => reservationCounts(String(r.status ?? '')))
      .map(r => {
        const arrival = asDate(r.arrivalDate ?? r.checkInDate ?? r.startDate);
        const departure = asDate(r.departureDate ?? r.checkOutDate ?? r.endDate);
        const total = firstNumber(r, ['totalPrice', 'totalPaid', 'price', 'baseRate']);
        // No payout means no cleaning fee to deduct. See the header note.
        const paid = total > 0;

        return {
          listingId: String(listingId),
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
      .filter(r => r.arrival && r.departure);
  }

  return [];
}

/**
 * Calendar for one listing.
 *
 * Clamped to the requested window because the endpoint sometimes honours
 * none of its date parameters and returns the full horizon regardless.
 */
export async function fetchCalendar(
  listingId: string, from: DateStr, to: DateStr, token?: string
): Promise<CalendarDay[]> {
  const t = token ?? await getAccessToken();
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

/** Every listing's reservations, fetched concurrently but politely. */
export async function fetchAllReservations(
  from: DateStr, to: DateStr, concurrency = 4
): Promise<HostawayReservation[]> {
  const token = await getAccessToken();
  const listings = await fetchListings(token);
  const out: HostawayReservation[] = [];

  // Batched rather than all-at-once: twenty-seven simultaneous requests
  // is how a rate limit is discovered in production.
  for (let i = 0; i < listings.length; i += concurrency) {
    const batch = listings.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(l => fetchReservations(l.listingId, from, to, token).catch(() => []))
    );
    results.forEach(rs => out.push(...rs));
  }
  return out;
}
