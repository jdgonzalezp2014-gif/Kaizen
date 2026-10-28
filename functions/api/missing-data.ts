/**
 * GET /api/missing-data (§170) — every active unit audited for missing data: its Repository record
 * (codes, insurance, AT&T account, POC, …) and the important fields of its live Hostaway listing.
 * Read-only: nothing here writes, to the Repository or to Hostaway. Permission `repository` (roles.ts).
 *
 * Hostaway down does not hide the Repository's gaps: the answer says Hostaway was not read.
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { fetchListingsRaw } from '../_lib/hostaway.ts';
import { repoMatch, type RepoRow } from '../../src/lib/unit-access.ts';
import { UNIT_TABLES, CHECKS } from '../../src/lib/repo-checks.ts';
import { auditUnit, worstFirst, countBy, REPO_RULES, HOSTAWAY_RULES } from '../../src/lib/missing-data.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!identify(request, env)) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  try {
    const [units, recs, stored, cols] = await Promise.all([
      sql`SELECT id, name FROM units WHERE account_id = 1 AND active ORDER BY name` as Promise<{ id: string; name: string }[]>,
      sql`SELECT table_key AS "table", id, vals FROM repo_records
           WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) AND archived_at IS NULL` as Promise<RepoRow[]>,
      // Secrets and documents live apart from vals; only whether there is one is read — never the value.
      sql`SELECT table_key, record_id, column_key FROM repo_secrets WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES})
          UNION SELECT table_key, record_id, column_key FROM repo_files WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) AND removed_at IS NULL` as
        Promise<{ table_key: string; record_id: string; column_key: string }[]>,
      sql`SELECT table_key, key FROM repo_columns WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) ORDER BY position` as Promise<{ table_key: string; key: string }[]>,
    ]);
    let listings: Record<string, unknown>[] = [], hostawayError = '';
    try { listings = await fetchListingsRaw(await getCredentials(sql, env.ENCRYPTION_KEY)); }
    catch (e) { hostawayError = e instanceof Error ? e.message : String(e); }
    const byId = new Map(listings.map(l => [String(l.id), l]));
    const list = worstFirst(units.map(u => {
      const rec = repoMatch(u.name, recs);
      const has = new Set(rec ? stored.filter(s => s.table_key === rec.table && s.record_id === rec.id).map(s => s.column_key) : []);
      return auditUnit(String(u.id), u.name, {
        rec, records: recs, stored: has, listing: byId.get(String(u.id)) ?? null,
        order: rec ? cols.filter(c => c.table_key === rec.table).map(c => c.key) : undefined,
      });
    }));
    return Response.json({
      ok: true, units: list, counts: countBy(list), hostawayError: hostawayError || null,
      rules: [...REPO_RULES.map(r => ({ key: r.key, label: r.label, severity: r.severity, why: r.why, where: 'repository' })),
              ...HOSTAWAY_RULES.map(h => ({ key: `hw:${h.check}`, label: CHECKS.find(c => c.key === h.check)?.label ?? h.check, severity: h.severity, why: h.why, where: 'hostaway' }))],
      at: new Date().toISOString(),
    });
  } catch (e) {
    return Response.json({ ok: false, error: 'missing-data', message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
};
