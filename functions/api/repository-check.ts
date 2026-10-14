/**
 * /api/repository-check (§149, §155) — Repository → Units against the live Hostaway listings, by section.
 *
 *   GET                                                  every active unit × every check in CHECKS
 *   POST { unitId, checks: [...], to: 'repository' }     copy Hostaway's values into the unit's record
 *   POST { unitId, checks: [...], to: 'hostaway' }       send the record's values to the listing, read back
 *   POST { unitId, op: 'draft-adds' }                    word the empty house-rules Adds from the record's fees
 *
 * Several checks at once = "everything in this section". GET is `repository`, POST is `repository.edit`
 * (roles.ts). Both directions are confirmed on screen, before → after; a Hostaway write changes what guests
 * see and every one is kept in listing_text_changes, before and after.
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { audit } from '../_lib/repo-store.ts';
import { fetchListingsRaw, updateListingFields } from '../_lib/hostaway.ts';
import { repoMatch, type RepoRow } from '../../src/lib/unit-access.ts';
import { CHECKS, SECTIONS, UNIT_TABLES, runCheck, writePlan, draftAdds, hostawayValue, type CheckResult } from '../../src/lib/repo-checks.ts';

interface UnitCheck { unitId: string; unit: string; table: string | null; recordId: string | null; record: string | null; checks: CheckResult[] }
type Listing = Record<string, unknown>;

async function load(sql: SqlFn, env: Env, onlyUnit?: string) {
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
  const [listings, units, recs, cols] = await Promise.all([
    fetchListingsRaw(creds),
    sql`SELECT id, name FROM units WHERE account_id = 1 AND active ORDER BY name` as Promise<{ id: string; name: string }[]>,
    sql`SELECT table_key AS "table", id, vals FROM repo_records
         WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) AND archived_at IS NULL` as Promise<RepoRow[]>,
    // Column order decides the order of a text's footer parts.
    sql`SELECT table_key, key FROM repo_columns WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) ORDER BY position` as Promise<{ table_key: string; key: string }[]>,
  ]);
  const orderOf = (t: string | undefined) => cols.filter(c => c.table_key === t).map(c => c.key);
  const byId = new Map(listings.map(l => [String(l.id), l]));
  const rows: (UnitCheck & { listing: Listing | null; vals: Record<string, unknown>; order: string[] })[] = [];
  for (const u of units) {
    if (onlyUnit && String(u.id) !== onlyUnit) continue;
    const rec = repoMatch(u.name, recs);
    const listing = byId.get(String(u.id)) ?? null;
    const vals = rec?.vals ?? {}, order = orderOf(rec?.table);
    rows.push({
      unitId: String(u.id), unit: u.name, table: rec?.table ?? null, recordId: rec?.id ?? null,
      record: rec ? String(rec.vals.name ?? '') : null, listing, vals, order,
      checks: CHECKS.map(c => runCheck(c, vals, listing ?? {}, order)),
    });
  }
  return { creds, rows };
}

const strip = ({ listing: _l, vals: _v, order: _o, ...r }: UnitCheck & { listing: unknown; vals: unknown; order: unknown }) => r;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!identify(request, env)) return unauthorised();
  try {
    const { rows } = await load(db(env) as unknown as SqlFn, env);
    return Response.json({
      ok: true, sections: SECTIONS,
      checks: CHECKS.map(({ key, label, section, note, send, fields }) => ({ key, label, section, note, send, fields: fields.map(f => f.label), long: fields.some(f => f.kind === 'longtext' || f.kind === 'composed') })),
      units: rows.map(strip),
    });
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : String(e));
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as { unitId?: string; checks?: string[]; check?: string; to?: string; op?: string };
  if (!b.unitId) return fail(400, 'Which unit?');
  try {
    const { creds, rows } = await load(sql, env, String(b.unitId));
    const row = rows[0];
    if (!row) return fail(404, 'No such active unit.');
    const save = async (plan: Record<string, unknown>, what: string) => {
      await sql`UPDATE repo_records SET vals = vals || ${JSON.stringify(plan)}::jsonb, updated_at = now(), updated_by = ${who.email}
                 WHERE account_id = 1 AND table_key = ${row.table} AND id = ${row.recordId}`;
      // Field names only: these are passwords and money, and the audit is read by anyone with the Repository.
      await audit(sql, who.email, 'records.update', row.table!, row.recordId!, `${what}: ${Object.keys(plan).join(', ')}`);
    };
    const done = async () => Response.json({ ok: true, unit: strip((await load(sql, env, row.unitId)).rows[0]!) });

    if (b.op === 'draft-adds') {
      if (!row.table || !row.recordId) return fail(400, `${row.unit} has no record in Repository → Units.`);
      const plan = draftAdds(row.vals);
      if (!Object.keys(plan).length) return fail(400, 'Nothing to draft: every Add with a fee behind it is already written.');
      await save(plan, 'House rules Adds drafted from the fees (§155)');
      return await done();
    }

    const keys = b.checks ?? (b.check ? [b.check] : []);
    const defs = keys.map(k => CHECKS.find(c => c.key === k));
    if (!defs.length || defs.some(d => !d) || (b.to !== 'repository' && b.to !== 'hostaway')) return fail(400, 'Which checks, and which way?');
    const to = b.to;
    const plan: Record<string, string | number | boolean> = {};
    for (const def of defs as typeof CHECKS) {
      const p = writePlan(def, row.checks.find(c => c.key === def.key)!, to, row.vals, row.order);
      if (typeof p === 'string') return fail(400, p);
      Object.assign(plan, p);
    }

    if (to === 'repository') {
      if (!row.table || !row.recordId) return fail(400, `${row.unit} has no record in Repository → Units.`);
      await save(plan, `Copied from Hostaway (${defs.map(d => d!.label).join(', ')})`);
      return await done();
    }

    const before = row.listing ?? {};
    const w = await updateListingFields(creds, row.unitId, plan as Record<string, string | number>);
    const after = w.ok ? (await fetchListingsRaw(creds)).find(l => String(l.id) === row.unitId) ?? null : null;
    const fields = (defs as typeof CHECKS).flatMap(d => d.fields);
    const kept = (d: (typeof CHECKS)[number]) => after && runCheck(d, row.vals, after, row.order).status === 'match';
    const took = !!after && (defs as typeof CHECKS).every(kept);
    for (const f of fields) {
      await sql`INSERT INTO listing_text_changes (account_id, listing_id, field, before, after, outcome, detail, changed_by)
                VALUES (1, ${row.unitId}, ${f.hostaway}, ${String(hostawayValue(before, f.hostaway) ?? '')}, ${String(after ? hostawayValue(after, f.hostaway) ?? '' : '')},
                        ${took ? 'changed' : 'failed'}, ${took ? 'from Repository (§155)' : w.detail || 'not confirmed on read-back'}, ${who.email})`;
    }
    if (!took) return fail(502, w.detail || 'Hostaway did not keep every new value — check the listing; before and after are logged.');
    // The units row is what cleaners read between syncs; keep it in step.
    if (keys.includes('wifi')) await sql`UPDATE units SET wifi_name = ${String(after!.wifiUsername ?? '')}, wifi_password = ${String(after!.wifiPassword ?? '')} WHERE account_id = 1 AND id = ${row.unitId}`;
    return await done();
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : String(e));
  }
};

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, error: 'repository-check', message }, { status });
}
