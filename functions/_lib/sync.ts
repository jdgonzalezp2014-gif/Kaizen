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
import { fetchListings, type HostawayCredentials } from './hostaway.ts';
import { poolType, unitType } from './classify.ts';

export type SqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export interface SyncResult {
  fetched: number;
  active: number;
  inactive: number;
  deactivated: string[];
  units: { id: string; name: string; active: boolean; unitType: string; poolType: string }[];
}

export async function syncUnits(creds: HostawayCredentials, sql: SqlFn): Promise<SyncResult> {
  const listings = await fetchListings(creds);

  const rows = listings.map(l => ({
    id: l.listingId,
    name: l.name,
    active: l.active,
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
  for (const u of rows) {
    await sql`
      INSERT INTO units (id, name, active, bedrooms, bathrooms, capacity,
                         unit_type, pool_type, lat, lng, synced_at)
      VALUES (${u.id}, ${u.name}, ${u.active}, ${u.bedrooms}, ${u.bathrooms},
              ${u.capacity}, ${u.unitType}, ${u.poolType}, ${u.lat}, ${u.lng}, now())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, active = EXCLUDED.active,
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
                WHERE active = TRUE AND id <> ALL(${ids}::text[])
                RETURNING id` as { id: string }[]
    : [];

  return {
    fetched: rows.length,
    active: rows.filter(r => r.active).length,
    inactive: rows.filter(r => !r.active).length,
    deactivated: gone.map(g => g.id),
    units: rows.map(r => ({
      id: r.id, name: r.name, active: r.active, unitType: r.unitType, poolType: r.poolType
    }))
  };
}
