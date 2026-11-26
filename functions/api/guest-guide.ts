/**
 * GET /api/guest-guide (guests module, 2026-11-09) — a house's check-in guide and extras prices for the guest
 * portal, read from its Repository record (guideFrom / pricesFrom). Staff only for now (permission
 * `repository`): guide = the builder's steps (checkin_guides) + the record's fields; it powers the house picker on /guest/demo. The guest's own signed link will reuse
 * `guestHouse()` once that door exists — Wi-Fi never goes out on an open route.
 *   no params      → { units: [{ id, name }] } (active units)
 *   ?unit=<id>     → { unitName, photo, guide, prices } — photo = the record's "Portal photo" link, else Hostaway's cover
 *   &arrival=&departure=  → also { calendar }: free nights each side and turnovers, from Hostaway's live calendar
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { fetchCalendar, fetchListingCover, fetchListingDeposit, fetchReservationsTouching, fetchStandardHours, type HostawayCredentials } from '../_lib/hostaway.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { repoMatch, type RepoRow } from '../../src/lib/unit-access.ts';
import { UNIT_TABLES } from '../../src/lib/repo-checks.ts';
import { calendarFit, emptyGuide, type Neighbor, guideFrom, notOfferedFrom, pricesFrom } from '../../src/lib/guest-portal.ts';
import { portalFrom } from '../../src/lib/guest-checkin.ts';
import { hourOf } from '../../src/lib/stay-time.ts';
import { composeGuide, tokenVals, type CheckinStep, type HouseItem } from '../../src/lib/checkin.ts';

const isDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const shift = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/**
 * The other guest on a same-day turnover (owner, 2026-11-23): who leaves the day this stay arrives / arrives the day it
 * leaves, their hour, and whether it is already moved the way that eats the clean — a later check-out / earlier check-in
 * set in Kaizen (turnover_overrides), on the Hostaway reservation, paid in the portal or asked for by the team. Any
 * read failing → null (not known), and early / late is not offered on that side.
 */
async function turnoverGuests(sql: SqlFn, creds: HostawayCredentials, unitId: string, arrival: string, departure: string,
                              fit: { turnIn: boolean; turnOut: boolean }): Promise<{ turnInGuest: Neighbor | null; turnOutGuest: Neighbor | null }> {
  const none = { turnInGuest: null, turnOutGuest: null };
  if (!fit.turnIn && !fit.turnOut) return none;
  try {
    const [res, std] = await Promise.all([fetchReservationsTouching(creds, arrival, departure), fetchStandardHours(creds, unitId)]);
    if (!std) return none;
    const here = res.filter(r => r.listingId === unitId);
    const prev = fit.turnIn ? here.find(r => r.departure === arrival) : undefined;
    const next = fit.turnOut ? here.find(r => r.arrival === departure) : undefined;
    const ids = [prev?.reservationId, next?.reservationId].filter((x): x is string => !!x);
    if (!ids.length) return none;
    const [ov, paid, asked] = await Promise.all([
      sql`SELECT reservation_id, checkout_time, checkin_time FROM turnover_overrides WHERE account_id = 1 AND reservation_id = ANY(${ids})` as Promise<{ reservation_id: string; checkout_time: string | null; checkin_time: string | null }[]>,
      sql`SELECT reservation_id, lines FROM guest_payments WHERE account_id = 1 AND reservation_id = ANY(${ids}) AND status IN ('paid', 'held')` as Promise<{ reservation_id: string; lines: { item?: string }[] }[]>,
      sql`SELECT reservation_id, need FROM upsell_charges WHERE account_id = 1 AND reservation_id = ANY(${ids}) AND status IN ('pending', 'paid')` as Promise<{ reservation_id: string; need: string }[]>,
    ]);
    const bought = (id: string, item: string, need: string) =>
      paid.some(p => p.reservation_id === id && (p.lines ?? []).some(l => l.item === item)) || asked.some(a => a.reservation_id === id && a.need === need);
    const leaving = (r: typeof prev): Neighbor | null => {
      if (!r) return null;
      const o = ov.find(x => x.reservation_id === r.reservationId)?.checkout_time ?? null;
      const hour = (o ? hourOf(o) : null) ?? r.checkOutHour ?? std.checkOutTime;
      return { hour, agreed: !!o || hour > std.checkOutTime || bought(r.reservationId, 'late-checkout', 'checkout') };
    };
    const arriving = (r: typeof next): Neighbor | null => {
      if (!r) return null;
      const o = ov.find(x => x.reservation_id === r.reservationId)?.checkin_time ?? null;
      const hour = (o ? hourOf(o) : null) ?? r.checkInHour ?? std.checkInTime;
      return { hour, agreed: !!o || hour < std.checkInTime || bought(r.reservationId, 'early-checkin', 'checkin') };
    };
    return { turnInGuest: leaving(prev), turnOutGuest: arriving(next) };
  } catch { return none; }
}

/** `stay` (arrival/departure) adds `calendar` — what Extras may offer around those dates. Null when Hostaway does not answer. */
export async function guestHouse(sql: SqlFn, unitId: string, encryptionKey?: string, stay?: { arrival?: string | null; departure?: string | null }) {
  const [units, recs] = await Promise.all([
    sql`SELECT id::text AS id, name FROM units WHERE account_id = 1 AND id::text = ${unitId}` as Promise<{ id: string; name: string }[]>,
    sql`SELECT table_key AS "table", id, vals FROM repo_records
         WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) AND archived_at IS NULL` as Promise<RepoRow[]>,
  ]);
  const u = units[0];
  if (!u) return null;
  const rec = repoMatch(u.name, recs);
  // The builder (107–109): the unit's own steps/items, after its building's shared guide; tokens filled per unit.
  // A missing table or column must not take the guide down with it.
  type G = { steps: CheckinStep[]; house: HouseItem[]; uses?: string | null };
  const own = await (sql`SELECT steps, house, uses FROM checkin_guides WHERE account_id = 1 AND unit_id = ${unitId}` as Promise<G[]>).then(r => r[0] ?? null, () => null);
  const shared = own?.uses ? await (sql`SELECT steps, house FROM checkin_guides WHERE account_id = 1 AND unit_id = ${own.uses}` as Promise<G[]>).then(r => r[0] ?? null, () => null) : null;
  const { steps, house } = composeGuide(shared, own, tokenVals(rec?.vals, rec ? String(rec.vals.name ?? u.name) : u.name));
  const guide = guideFrom(rec?.vals);
  // Cover (owner, 2026-11-15): Hostaway's first listing photo (units.id is the listing id); a record may set its own.
  const ownPhoto = typeof rec?.vals?.portal_photo === 'string' && rec.vals.portal_photo.startsWith('https://') ? rec.vals.portal_photo : null;
  const creds = encryptionKey ? await getCredentials(sql, encryptionKey).catch(() => null) : null;
  const dated = isDay(stay?.arrival) && isDay(stay?.departure) && stay.arrival < stay.departure;
  const [photo, fit, channelDeposit] = await Promise.all([
    ownPhoto ?? (creds ? fetchListingCover(creds, unitId).catch(() => null) : null),
    creds && dated ? fetchCalendar(creds, unitId, shift(stay.arrival!, -8), shift(stay.departure!, 8))
      .then(days => days.length ? calendarFit(days, stay.arrival!, stay.departure!) : null, () => null) : null,
    // Not read → null: the portal keeps offering "None of them" on Airbnb, as before this rule.
    creds ? fetchListingDeposit(creds, unitId).catch(() => null) : null,
  ]);
  const calendar = fit && creds ? { ...fit, ...await turnoverGuests(sql, creds, unitId, stay!.arrival!, stay!.departure!, fit) } : fit;
  const portal = portalFrom(rec?.vals);
  // Door code by Lock type (doorCodeFor): staff-only route; the guest's signed link must send it only once entry() opens.
  const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
  return { unitName: u.name, photo, lockType: str(rec?.vals?.lock_type), guestCode: str(rec?.vals?.guest_code), unitType: portal.unitType, protection: portal.protection, guide: guide || steps.length || house.length ? { ...(guide ?? emptyGuide()), steps, house } : null, prices: pricesFrom(rec?.vals), notOffered: notOfferedFrom(rec?.vals), calendar, channelDeposit };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!identify(request, env)) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const q = new URL(request.url).searchParams;
  const unit = q.get('unit');
  if (!unit) {
    const units = await sql`SELECT id, name FROM units WHERE account_id = 1 AND active ORDER BY name` as { id: string; name: string }[];
    return Response.json({ units: units.map(u => ({ id: String(u.id), name: u.name })) });
  }
  const house = await guestHouse(sql, unit, env.ENCRYPTION_KEY, { arrival: q.get('arrival'), departure: q.get('departure') });
  return house ? Response.json(house) : Response.json({ error: 'unknown_unit' }, { status: 404 });
};
