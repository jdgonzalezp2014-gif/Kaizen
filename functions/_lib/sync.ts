/**
 * Populating `units` from Hostaway.
 *
 * Everything downstream is blocked on this: `expenses.unit_id` and
 * `claims.unit_id` are foreign keys, so no cost and no claim can be
 * recorded until the units exist. That constraint is deliberate — it
 * stops a typo creating a cost nobody can attribute — but it makes this
 * the first thing that has to run.
 *
 * Takes a query function rather than a connection, so the same code runs
 * from a Pages Function (Neon HTTP driver) and from a local script or a
 * GitHub Action (Pool over WebSocket). Nothing here knows which.
 */
import { fetchListings, fetchCalendars, type HostawayCredentials } from './hostaway.ts';
import { poolType, unitType } from './classify.ts';

export type SqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export interface SyncResult {
  fetched: number;
  active: number;
  inactive: number;
  parked: string[];
  deactivated: string[];
  units: { id: string; name: string; active: boolean; parked: boolean;
           unitType: string; poolType: string }[];
}

export async function syncUnits(
  creds: HostawayCredentials, sql: SqlFn, offlineAfterDays = 45, accountId = 1
): Promise<SyncResult> {
  const listings = await fetchListings(creds);

  // Hostaway's `active` flag only says the listing exists. Four listings
  // on this account are flagged active with the calendar blocked solid
  // for months — a unit between tenants, one mid-renovation. Counting
  // them as active divides every portfolio average by units nobody could
  // book, and sets the target against the same inflated count.
  //
  // Done here rather than per dashboard load because it costs one
  // calendar request per listing.
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + (offlineAfterDays - 1) * 864e5).toISOString().slice(0, 10);
  const calendars = await fetchCalendars(creds, listings.map(l => l.listingId), from, to);
  const isParked = (id: string) => {
    const cal = calendars[id] ?? [];
    // No calendar means unknown, and unknown must not be reported as
    // parked — that would quietly drop a working unit from the target.
    return cal.length > 0 && cal.every(d => !d.available && !/reserv|book/i.test(d.status));
  };

  const rows = listings.map(l => ({
    id: l.listingId,
    name: l.name,
    active: l.active,
    specialStatus: l.specialStatus,
    parked: isParked(l.listingId),
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    capacity: l.capacity,
    unitType: unitType(l.propertyTypeId, l.name),
    poolType: poolType(l.amenities),
    lat: l.lat,
    lng: l.lng
  }));

  // One statement per unit rather than a single multi-row upsert: the
  // HTTP driver has no array-of-composite binding, and 27 small writes
  // on a job that runs nightly is not worth the SQL gymnastics.
  //
  // The conflict target is (account_id, id), not (id). Migration 002
  // made the primary key composite for multi-tenancy and this upsert was
  // left naming the old one; Postgres rejects an ON CONFLICT target with
  // no matching unique index, so every sync failed outright and the
  // units table stayed empty — which in turn blocked costs, claims and
  // price decisions, all of which are foreign-keyed to it.
  for (const u of rows) {
    await sql`
      INSERT INTO units (account_id, id, name, active, special_status, parked, parked_checked_at,
                         bedrooms, bathrooms, capacity,
                         unit_type, pool_type, lat, lng, synced_at)
      VALUES (${accountId}, ${u.id}, ${u.name}, ${u.active}, ${u.specialStatus}, ${u.parked}, now(),
              ${u.bedrooms}, ${u.bathrooms},
              ${u.capacity}, ${u.unitType}, ${u.poolType}, ${u.lat}, ${u.lng}, now())
      ON CONFLICT (account_id, id) DO UPDATE SET
        name = EXCLUDED.name, active = EXCLUDED.active,
        special_status = EXCLUDED.special_status,
        parked = EXCLUDED.parked, parked_checked_at = EXCLUDED.parked_checked_at,
        bedrooms = EXCLUDED.bedrooms, bathrooms = EXCLUDED.bathrooms,
        capacity = EXCLUDED.capacity, unit_type = EXCLUDED.unit_type,
        pool_type = EXCLUDED.pool_type, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
        synced_at = now()
    `;
  }

  // A listing that vanished from Hostaway is marked inactive, never
  // deleted: its expenses and claims are still real history, and a
  // delete would either orphan them or cascade them away.
  const ids = rows.map(r => r.id);
  const gone = ids.length
    ? await sql`UPDATE units SET active = FALSE
                WHERE account_id = ${accountId} AND active = TRUE AND id <> ALL(${ids}::text[])
                RETURNING id` as { id: string }[]
    : [];

  return {
    fetched: rows.length,
    // "Active" here means listed AND taking bookings. A parked unit is
    // counted out of both, because the number's only job downstream is
    // being the denominator of a per-unit average and the multiplier of
    // the portfolio target.
    active: rows.filter(r => r.active && !r.parked).length,
    inactive: rows.filter(r => !r.active).length,
    parked: rows.filter(r => r.parked).map(r => r.name),
    deactivated: gone.map(g => g.id),
    units: rows.map(r => ({
      id: r.id, name: r.name, active: r.active, parked: r.parked,
      unitType: r.unitType, poolType: r.poolType
    }))
  };
}
