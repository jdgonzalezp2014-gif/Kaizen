/**
 * Access to the units for cleaners (§136), server side: the units (address and
 * Wi-Fi synced from Hostaway) joined to their Repository records (lock type,
 * cleaner code, lockbox) by `repoMatch`. Codes leave the server only to the
 * cleaner of a clean that day, or to the helper link of that clean.
 */
import type { SqlFn } from './accounts.ts';
import { inventoryPlaces, placeLabel, repoMatch, supplyPlace, unitAccess, type RepoRow, type UnitAccess, type UnitRow } from '../../src/lib/unit-access.ts';
import { unitTypeOf, type UnitType } from '../../src/lib/inspection.ts';

/** Every unit's access, by unit name. */
export async function accessByUnit(sql: SqlFn, onlyActive = false): Promise<Map<string, UnitAccess & { unitId: string; recordId: string | null }>> {
  const [units, recs] = await Promise.all([
    sql`SELECT id, name, address, wifi_name AS "wifiName", wifi_password AS "wifiPassword", door_code AS "doorCode", active
          FROM units WHERE account_id = 1 ORDER BY name`,
    sql`SELECT r.id, r.table_key AS "table", r.vals FROM repo_records r
          JOIN repo_tables t ON t.account_id = r.account_id AND t.key = r.table_key
         WHERE r.account_id = 1 AND t.section_key = 'units' AND t.archived_at IS NULL AND r.archived_at IS NULL`
  ]) as [(UnitRow & { active: boolean })[], RepoRow[]];
  const out = new Map<string, UnitAccess & { unitId: string; recordId: string | null }>();
  for (const u of units) {
    if (onlyActive && !u.active) continue;
    const rec = repoMatch(u.name, recs);
    const p = supplyPlace(rec, recs);
    out.set(u.name, { ...unitAccess(u, rec), supplies: p ? { label: placeLabel(p.name), self: p.self, code: p.code } : null,
                      unitId: u.id, recordId: rec ? `${rec.table}/${rec.id}` : null });
  }
  return out;
}

/** The Units tables of the Repository, live records only. */
const repoUnits = (sql: SqlFn) => sql`SELECT r.id, r.table_key AS "table", r.vals FROM repo_records r
    JOIN repo_tables t ON t.account_id = r.account_id AND t.key = r.table_key
   WHERE r.account_id = 1 AND t.section_key = 'units' AND t.archived_at IS NULL AND r.archived_at IS NULL` as Promise<RepoRow[]>;

/**
 * House or apartment for every unit (§138), from the Repository's "Property
 * type" of its record — null when it has no record or the column is empty.
 */
export async function unitTypes(sql: SqlFn): Promise<Map<string, { name: string; active: boolean; type: UnitType }>> {
  const [units, recs] = await Promise.all([
    sql`SELECT id, name, active FROM units WHERE account_id = 1 ORDER BY name` as Promise<{ id: string; name: string; active: boolean }[]>,
    repoUnits(sql)
  ]);
  return new Map(units.map(u => [u.id, { name: u.name, active: u.active, type: unitTypeOf(repoMatch(u.name, recs)?.vals?.property_type) }]));
}

/**
 * The inventory's places and who draws from each (§150), read from the
 * Repository every time — the assignment lives there and nowhere else.
 * `names` also knows archived records, so a past move keeps its place's name.
 */
export async function supplyPlaces(sql: SqlFn) {
  const [units, recs, all] = await Promise.all([
    sql`SELECT id, name, active FROM units WHERE account_id = 1 ORDER BY name` as Promise<{ id: string; name: string; active: boolean }[]>,
    repoUnits(sql),
    sql`SELECT table_key || '/' || id AS key, vals->>'name' AS name FROM repo_records WHERE account_id = 1` as Promise<{ key: string; name: string | null }[]>
  ]);
  return { ...inventoryPlaces(units, recs), names: new Map(all.map(r => [r.key, (r.name ?? r.key).trim()])) };
}
