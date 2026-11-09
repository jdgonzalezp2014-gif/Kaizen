/**
 * /api/checkin-guide (2026-11-09) — Repository → Check-in builder. Per unit (checkin_guides, 107–109): its own steps and
 * house-manual items, and optionally the shared guide it `uses` (one per building, rows `shared:<slug>`, 109).
 *   GET                       → { units: [{ id, name, steps, uses }], shared: [{ id, title, steps, users }] }
 *   GET ?unit=<id>            → { unitName, steps, house, uses, sharedPart, record, recordRef, updatedAt, updatedBy }
 *   GET ?unit=shared:<slug>   → { unitName: title, steps, house, shared: true, users }
 *   POST { unit, steps, house, uses?, title?, copiedFrom? } → saves (a new shared guide: unit 'shared:' + title), audited
 * Read = permission `repository`, save = `repository.edit` (roles.ts).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { audit } from '../_lib/repo-store.ts';
import { repoMatch, type RepoRow } from '../../src/lib/unit-access.ts';
import { UNIT_TABLES } from '../../src/lib/repo-checks.ts';
import { guideFrom } from '../../src/lib/guest-portal.ts';
import { cleanHouse, cleanSteps, isShared, sharedId, SHARED, MAX_TITLE, type CheckinStep, type HouseItem } from '../../src/lib/checkin.ts';

const bad = (status: number, message: string) => Response.json({ ok: false, message }, { status });
type Row = { unit_id: string; steps: CheckinStep[]; house: HouseItem[]; title: string | null; uses: string | null; updated_by: string | null; updated_at: string };

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!identify(request, env)) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const unit = new URL(request.url).searchParams.get('unit');
  if (!unit) {
    const [units, shared] = await Promise.all([
      sql`SELECT u.id::text AS id, u.name, coalesce(jsonb_array_length(g.steps), 0)::int AS steps, g.uses
            FROM units u LEFT JOIN checkin_guides g ON g.account_id = u.account_id AND g.unit_id = u.id::text
           WHERE u.account_id = 1 AND u.active ORDER BY u.name` as Promise<{ id: string; name: string; steps: number; uses: string | null }[]>,
      sql`SELECT g.unit_id AS id, coalesce(g.title, g.unit_id) AS title, jsonb_array_length(g.steps)::int AS steps,
                 (SELECT count(*) FROM checkin_guides x WHERE x.account_id = 1 AND x.uses = g.unit_id)::int AS users
            FROM checkin_guides g WHERE g.account_id = 1 AND g.unit_id LIKE ${SHARED + '%'} ORDER BY 2` as Promise<{ id: string; title: string; steps: number; users: number }[]>,
    ]);
    return Response.json({ ok: true, units, shared });
  }
  if (isShared(unit)) {
    const [g] = await sql`SELECT * FROM checkin_guides WHERE account_id = 1 AND unit_id = ${unit}` as Row[];
    if (!g) return bad(404, 'No such shared guide.');
    const users = await sql`SELECT u.id::text AS id, u.name FROM checkin_guides g JOIN units u ON u.account_id = 1 AND u.id::text = g.unit_id
                             WHERE g.account_id = 1 AND g.uses = ${unit} ORDER BY u.name` as { id: string; name: string }[];
    return Response.json({ ok: true, shared: true, unitName: g.title ?? unit, steps: g.steps, house: g.house, users, uses: null, sharedPart: null,
      record: null, recordRef: null, updatedAt: g.updated_at, updatedBy: g.updated_by });
  }
  const [units, recs, guides] = await Promise.all([
    sql`SELECT id::text AS id, name FROM units WHERE account_id = 1 AND id::text = ${unit}` as Promise<{ id: string; name: string }[]>,
    sql`SELECT table_key AS "table", id, vals FROM repo_records
         WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) AND archived_at IS NULL` as Promise<RepoRow[]>,
    sql`SELECT * FROM checkin_guides WHERE account_id = 1 AND unit_id = ${unit}` as Promise<Row[]>,
  ]);
  const u = units[0];
  if (!u) return bad(404, 'Unknown unit.');
  const rec = repoMatch(u.name, recs);
  const g = guides[0];
  const [sp] = g?.uses ? await sql`SELECT unit_id AS id, title, steps, house FROM checkin_guides WHERE account_id = 1 AND unit_id = ${g.uses}` as
    { id: string; title: string | null; steps: CheckinStep[]; house: HouseItem[] }[] : [];
  return Response.json({ ok: true, unitName: u.name, steps: g?.steps ?? [], house: g?.house ?? [], uses: g?.uses ?? null,
    sharedPart: sp ? { id: sp.id, title: sp.title ?? sp.id, steps: sp.steps, house: sp.house } : null,
    record: guideFrom(rec?.vals), recordVals: rec ? { name: rec.vals.name ?? null, lockbox: rec.vals.lockbox ?? null, floor: rec.vals.floor ?? null, hw_address: rec.vals.hw_address ?? null, checkin_from: rec.vals.checkin_from ?? null } : null,
    recordRef: rec ? { table: rec.table, id: String(rec.id) } : null, updatedAt: g?.updated_at ?? null, updatedBy: g?.updated_by ?? null });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => null) as { unit?: unknown; steps?: unknown; house?: unknown; uses?: unknown; title?: unknown; copiedFrom?: unknown } | null;
  let unit = typeof body?.unit === 'string' ? body.unit : '';
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  let label: string;
  if (isShared(unit)) {
    if (!title || title.length > MAX_TITLE) return bad(400, 'A shared guide needs a name.');
    if (unit === SHARED) {   // new
      unit = sharedId(title);
      if (unit === SHARED) return bad(400, 'Pick another name.');
      const [taken] = await sql`SELECT 1 FROM checkin_guides WHERE account_id = 1 AND unit_id = ${unit}` as unknown[];
      if (taken) return bad(400, 'There is already a shared guide with that name.');
    }
    label = title;
  } else {
    const units = unit ? await sql`SELECT name FROM units WHERE account_id = 1 AND id::text = ${unit}` as { name: string }[] : [];
    if (!units[0]) return bad(400, 'Pick a unit.');
    label = units[0].name;
  }
  const c = cleanSteps(body?.steps);
  if (!c.ok) return bad(400, c.error);
  const h = cleanHouse(body?.house);
  if (!h.ok) return bad(400, h.error);
  const uses = !isShared(unit) && typeof body?.uses === 'string' && body.uses ? body.uses : null;
  if (uses) {
    const [ok] = await sql`SELECT 1 FROM checkin_guides WHERE account_id = 1 AND unit_id = ${uses} AND unit_id LIKE ${SHARED + '%'}` as unknown[];
    if (!ok) return bad(400, 'That shared guide does not exist.');
  }
  await sql`INSERT INTO checkin_guides (account_id, unit_id, steps, house, title, uses, updated_by, updated_at)
            VALUES (1, ${unit}, ${JSON.stringify(c.steps)}::jsonb, ${JSON.stringify(h.house)}::jsonb, ${isShared(unit) ? title : null}, ${uses}, ${who.email}, now())
            ON CONFLICT (account_id, unit_id) DO UPDATE SET steps = EXCLUDED.steps, house = EXCLUDED.house, title = EXCLUDED.title,
              uses = EXCLUDED.uses, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  const from = typeof body?.copiedFrom === 'string' && body.copiedFrom ? ` (copied from ${body.copiedFrom})` : '';
  await audit(sql, who.email, 'checkin.save', 'checkin_guides', unit,
    `${label}: ${c.steps.length} steps, ${h.house.length} house manual items${uses ? `, uses ${uses}` : ''}${from}`);
  return Response.json({ ok: true, unit, steps: c.steps, house: h.house, uses });
};
