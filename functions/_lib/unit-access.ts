/**
 * Access to the units for cleaners (§136), server side: the units (address and
 * Wi-Fi synced from Hostaway) joined to their Repository records (lock type,
 * cleaner code, lockbox) by `repoMatch`. Codes leave the server only to the
 * cleaner of a clean that day, or to the helper link of that clean.
 */
import type { SqlFn } from './accounts.ts';
import { repoMatch, unitAccess, type RepoRow, type UnitAccess, type UnitRow } from '../../src/lib/unit-access.ts';
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
    out.set(u.name, { ...unitAccess(u, rec), unitId: u.id, recordId: rec ? `${rec.table}/${rec.id}` : null });
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
