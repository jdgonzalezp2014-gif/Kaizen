/**
 * GET /api/guest-guide (guests module, 2026-11-09) — a house's check-in guide and extras prices for the guest
 * portal, read from its Repository record (guideFrom / pricesFrom). Staff only for now (permission
 * `repository`): guide = the builder's steps (checkin_guides) + the record's fields; it powers the house picker on /guest/demo. The guest's own signed link will reuse
 * `guestHouse()` once that door exists — Wi-Fi never goes out on an open route.
 *   no params      → { units: [{ id, name }] } (active units)
 *   ?unit=<id>     → { unitName, guide, prices }
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { repoMatch, type RepoRow } from '../../src/lib/unit-access.ts';
import { UNIT_TABLES } from '../../src/lib/repo-checks.ts';
import { emptyGuide, guideFrom, pricesFrom } from '../../src/lib/guest-portal.ts';
import type { CheckinStep } from '../../src/lib/checkin.ts';

export async function guestHouse(sql: SqlFn, unitId: string) {
  const [units, recs] = await Promise.all([
    sql`SELECT id::text AS id, name FROM units WHERE account_id = 1 AND id::text = ${unitId}` as Promise<{ id: string; name: string }[]>,
    sql`SELECT table_key AS "table", id, vals FROM repo_records
         WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) AND archived_at IS NULL` as Promise<RepoRow[]>,
  ]);
  const u = units[0];
  if (!u) return null;
  const rec = repoMatch(u.name, recs);
  // The builder's steps (107); a missing table must not take the guide down with it.
  const steps = await (sql`SELECT steps FROM checkin_guides WHERE account_id = 1 AND unit_id = ${unitId}` as Promise<{ steps: CheckinStep[] }[]>)
    .then(r => r[0]?.steps ?? [], () => [] as CheckinStep[]);
  const guide = guideFrom(rec?.vals);
  return { unitName: u.name, guide: guide || steps.length ? { ...(guide ?? emptyGuide()), steps } : null, prices: pricesFrom(rec?.vals) };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!identify(request, env)) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const unit = new URL(request.url).searchParams.get('unit');
  if (!unit) {
    const units = await sql`SELECT id, name FROM units WHERE account_id = 1 AND active ORDER BY name` as { id: string; name: string }[];
    return Response.json({ units: units.map(u => ({ id: String(u.id), name: u.name })) });
  }
  const house = await guestHouse(sql, unit);
  return house ? Response.json(house) : Response.json({ error: 'unknown_unit' }, { status: 404 });
};
