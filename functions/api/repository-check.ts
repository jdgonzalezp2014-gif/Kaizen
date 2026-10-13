/**
 * /api/repository-check (§149) — Repository → Units against the live Hostaway listings.
 *
 *   GET                                          every active unit × every check in CHECKS
 *   POST { unitId, check, to: 'repository' }     copy Hostaway's values into the unit's record
 *   POST { unitId, check, to: 'hostaway' }       send the record's values to the listing, read back
 *
 * GET is `repository`, POST is `repository.edit` (roles.ts). A Hostaway write changes what guests
 * see, so the screen asks first; every one is kept in listing_text_changes, before and after.
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { audit } from '../_lib/repo-store.ts';
import { fetchListings, updateListingFields, type HostawayListing } from '../_lib/hostaway.ts';
import { repoMatch, type RepoRow } from '../../src/lib/unit-access.ts';
import { CHECKS, runCheck, writePlan, type CheckResult } from '../../src/lib/repo-checks.ts';

const UNIT_TABLES = ['cortland_legacy', 'houses', 'the_links'];

interface UnitCheck { unitId: string; unit: string; table: string | null; recordId: string | null; record: string | null; checks: CheckResult[] }

async function load(sql: SqlFn, env: Env, onlyUnit?: string) {
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
  const [listings, units, recs] = await Promise.all([
    fetchListings(creds),
    sql`SELECT id, name FROM units WHERE account_id = 1 AND active ORDER BY name` as Promise<{ id: string; name: string }[]>,
    sql`SELECT table_key AS "table", id, vals FROM repo_records
         WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) AND archived_at IS NULL` as Promise<RepoRow[]>,
  ]);
  const byId = new Map(listings.map(l => [l.listingId, l]));
  const rows: (UnitCheck & { listing: HostawayListing | null })[] = [];
  for (const u of units) {
    if (onlyUnit && String(u.id) !== onlyUnit) continue;
    const rec = repoMatch(u.name, recs);
    const listing = byId.get(String(u.id)) ?? null;
    rows.push({
      unitId: String(u.id), unit: u.name, table: rec?.table ?? null, recordId: rec?.id ?? null,
      record: rec ? String(rec.vals.name ?? '') : null, listing,
      checks: CHECKS.map(c => runCheck(c, rec?.vals ?? {}, listing ?? {})),
    });
  }
  return { creds, rows, recs };
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!identify(request, env)) return unauthorised();
  try {
    const { rows } = await load(db(env) as unknown as SqlFn, env);
    return Response.json({ ok: true, checks: CHECKS.map(({ key, label, note, fields }) => ({ key, label, note, fields: fields.map(f => f.label) })),
                           units: rows.map(({ listing: _l, ...r }) => r) });
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : String(e));
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as { unitId?: string; check?: string; to?: string };
  const def = CHECKS.find(c => c.key === b.check);
  if (!def || !b.unitId || (b.to !== 'repository' && b.to !== 'hostaway')) return fail(400, 'Which unit, which check, and which way?');
  try {
    const { creds, rows } = await load(sql, env, String(b.unitId));
    const row = rows[0];
    if (!row) return fail(404, 'No such active unit.');
    const result = row.checks.find(c => c.key === def.key)!;
    const plan = writePlan(def, result, b.to);
    if (typeof plan === 'string') return fail(400, plan);

    if (b.to === 'repository') {
      if (!row.table || !row.recordId) return fail(400, `${row.unit} has no record in Repository → Units.`);
      await sql`UPDATE repo_records SET vals = vals || ${JSON.stringify(plan)}::jsonb, updated_at = now(), updated_by = ${who.email}
                 WHERE account_id = 1 AND table_key = ${row.table} AND id = ${row.recordId}`;
      // Field names only: these are passwords and money, and the audit is read by anyone with the Repository.
      await audit(sql, who.email, 'records.update', row.table, row.recordId, `${def.label} copied from Hostaway: ${Object.keys(plan).join(', ')}`);
    } else {
      const before = row.listing;
      const w = await updateListingFields(creds, row.unitId, plan);
      const after = w.after;
      const check = after ? runCheck(def, Object.fromEntries(def.fields.map((f, i) => [f.repo, result.fields[i]!.repo])), after) : null;
      const took = w.ok && check?.status === 'match';
      for (const f of def.fields) {
        await sql`INSERT INTO listing_text_changes (account_id, listing_id, field, before, after, outcome, detail, changed_by)
                  VALUES (1, ${row.unitId}, ${f.hostaway}, ${String(before?.[f.hostaway] ?? '')}, ${String(after?.[f.hostaway] ?? '')},
                          ${took ? 'changed' : 'failed'}, ${took ? 'from Repository (§149)' : w.detail || 'not confirmed on read-back'}, ${who.email})`;
      }
      if (!took) return fail(502, w.detail || 'Hostaway did not keep the new value — nothing confirmed.');
      // The units row is what cleaners read between syncs; keep it in step.
      if (def.key === 'wifi') await sql`UPDATE units SET wifi_name = ${after!.wifiName}, wifi_password = ${after!.wifiPassword} WHERE account_id = 1 AND id = ${row.unitId}`;
    }
    const fresh = (await load(sql, env, row.unitId)).rows[0]!;
    const { listing: _l, ...out } = fresh;
    return Response.json({ ok: true, unit: out });
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : String(e));
  }
};

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, error: 'repository-check', message }, { status });
}
