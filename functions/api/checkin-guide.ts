/**
 * /api/checkin-guide (2026-11-09) — Repository → Check-in builder. A unit's arrival steps (checkin_guides, 107)
 * plus what its Units record already says (guideFrom: address, Wi-Fi, parking…), which the guest sees after the steps.
 *   GET                → { units: [{ id, name, steps }] }  active units, how many steps each
 *   GET ?unit=<id>     → { unitName, steps, record, recordRef, updatedAt, updatedBy }
 *   POST { unit, steps, copiedFrom? } → saves (cleanSteps), audited in repo_audit
 * Read = permission `repository`, save = `repository.edit` (roles.ts).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { audit } from '../_lib/repo-store.ts';
import { repoMatch, type RepoRow } from '../../src/lib/unit-access.ts';
import { UNIT_TABLES } from '../../src/lib/repo-checks.ts';
import { guideFrom } from '../../src/lib/guest-portal.ts';
import { cleanSteps, type CheckinStep } from '../../src/lib/checkin.ts';

const bad = (status: number, message: string) => Response.json({ ok: false, message }, { status });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!identify(request, env)) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const unit = new URL(request.url).searchParams.get('unit');
  if (!unit) {
    const rows = await sql`SELECT u.id::text AS id, u.name, coalesce(jsonb_array_length(g.steps), 0)::int AS steps
                             FROM units u LEFT JOIN checkin_guides g ON g.account_id = u.account_id AND g.unit_id = u.id::text
                            WHERE u.account_id = 1 AND u.active ORDER BY u.name` as { id: string; name: string; steps: number }[];
    return Response.json({ ok: true, units: rows });
  }
  const [units, recs, guides] = await Promise.all([
    sql`SELECT id::text AS id, name FROM units WHERE account_id = 1 AND id::text = ${unit}` as Promise<{ id: string; name: string }[]>,
    sql`SELECT table_key AS "table", id, vals FROM repo_records
         WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) AND archived_at IS NULL` as Promise<RepoRow[]>,
    sql`SELECT steps, updated_by, updated_at FROM checkin_guides WHERE account_id = 1 AND unit_id = ${unit}` as
      Promise<{ steps: CheckinStep[]; updated_by: string | null; updated_at: string }[]>,
  ]);
  const u = units[0];
  if (!u) return bad(404, 'Unknown unit.');
  const rec = repoMatch(u.name, recs);
  const g = guides[0];
  return Response.json({ ok: true, unitName: u.name, steps: g?.steps ?? [], record: guideFrom(rec?.vals),
    recordRef: rec ? { table: rec.table, id: String(rec.id) } : null, updatedAt: g?.updated_at ?? null, updatedBy: g?.updated_by ?? null });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => null) as { unit?: unknown; steps?: unknown; copiedFrom?: unknown } | null;
  const unit = typeof body?.unit === 'string' ? body.unit : '';
  const units = unit ? await sql`SELECT name FROM units WHERE account_id = 1 AND id::text = ${unit}` as { name: string }[] : [];
  if (!units[0]) return bad(400, 'Pick a unit.');
  const c = cleanSteps(body?.steps);
  if (!c.ok) return bad(400, c.error);
  await sql`INSERT INTO checkin_guides (account_id, unit_id, steps, updated_by, updated_at)
            VALUES (1, ${unit}, ${JSON.stringify(c.steps)}::jsonb, ${who.email}, now())
            ON CONFLICT (account_id, unit_id) DO UPDATE SET steps = EXCLUDED.steps, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  const from = typeof body?.copiedFrom === 'string' && body.copiedFrom ? ` (copied from ${body.copiedFrom})` : '';
  await audit(sql, who.email, 'checkin.save', 'checkin_guides', unit, `${units[0].name}: ${c.steps.length} step${c.steps.length === 1 ? '' : 's'}${from}`);
  return Response.json({ ok: true, steps: c.steps });
};
