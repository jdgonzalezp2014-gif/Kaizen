/**
 * /api/inspection-items — the inspection checklist template (§133).
 *
 *   GET                                           every item and area, active or not; the units with house/apartment
 *   POST { action: 'save', id?, area, label, defaultOutcome, appliesTo, unitIds?, active?, supplyId? }
 *   POST { action: 'move', id, dir: -1 | 1 }      up or down within its area
 *   POST { action: 'delete', id }                 gone if never used; else switched off
 *   POST { action: 'areaSave', key?, label }      a new area (§138), or a rename
 *   POST { action: 'areaMove', key, dir }         earlier or later in the walk
 *   POST { action: 'areaActive', key, active }    off: its items leave new inspections
 *   POST { action: 'areaDelete', key }            only an area with no items
 *
 * GET with `operations`; POST with `operations.setup` (roles.ts). An item
 * already answered in an inspection is never deleted — the report keeps its
 * words — it is switched off and stops appearing in new inspections.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { inspectionAreas, templateItems } from '../_lib/inspection-run.ts';
import { unitTypes } from '../_lib/unit-access.ts';
import { invItems } from '../_lib/inventory.ts';
import { APPLIES, areaKey, type AppliesTo } from '../../src/lib/inspection.ts';

const OUT = new Set(['repair', 'purchase', 'clean']);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  return Response.json(await everything(sql));
};

/** What the setup shows: items, areas, and every active unit with what the Repository says it is. */
async function everything(sql: SqlFn, extra: Record<string, unknown> = {}) {
  const [items, areas, types, inv] = await Promise.all([templateItems(sql), inspectionAreas(sql), unitTypes(sql), invItems(sql)]);
  const units = [...types].filter(([, u]) => u.active).map(([id, u]) => ({ id, name: u.name, type: u.type }));
  // §150: the supplies a "purchase" item can preset.
  const supplies = inv.filter(i => i.active).map(i => ({ id: i.id, name: i.name, measure: i.measure }));
  return { ok: true, items, areas, units, supplies, ...extra };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, unknown>;
  const id = Number(b.id) || 0;

  if (b.action === 'save') {
    const area = String(b.area ?? ''), label = String(b.label ?? '').trim().slice(0, 200);
    const outcome = String(b.defaultOutcome ?? 'repair');
    const appliesTo = String(b.appliesTo ?? 'all') as AppliesTo;
    const unitIds = appliesTo === 'units' && Array.isArray(b.unitIds) ? [...new Set(b.unitIds.map(String))] : [];
    if (!(await sql`SELECT 1 FROM inspection_areas WHERE account_id = 1 AND key = ${area}`).length) return bad('Which area?');
    if (!label) return bad('Say what to check.');
    if (!OUT.has(outcome)) return bad('A failure usually becomes a repair, a purchase or a clean.');
    if (!APPLIES.includes(appliesTo)) return bad('Where does it apply?');
    if (appliesTo === 'units' && !unitIds.length) return bad('Pick at least one unit.');
    // §150: only a "purchase" item presets a supply.
    const supplyId = outcome === 'purchase' && b.supplyId ? Number(b.supplyId) : null;
    if (supplyId && !(await sql`SELECT 1 FROM inventory_items WHERE account_id = 1 AND id = ${supplyId} AND active`).length) return bad('Which supply?');
    if (unitIds.length && (await sql`SELECT count(*)::int AS n FROM units WHERE account_id = 1 AND id = ANY(${unitIds})` as { n: number }[])[0]!.n !== unitIds.length) return bad('Unknown unit.');
    if (id) {
      await sql`UPDATE inspection_items SET area = ${area}, label = ${label}, default_outcome = ${outcome}, applies_to = ${appliesTo},
                       unit_ids = ${unitIds}, active = ${b.active !== false}, supply_id = ${supplyId}, updated_at = now() WHERE account_id = 1 AND id = ${id}`;
    } else {
      await sql`INSERT INTO inspection_items (account_id, area, label, default_outcome, applies_to, unit_ids, position, created_by, supply_id)
                VALUES (1, ${area}, ${label}, ${outcome}, ${appliesTo}, ${unitIds},
                        (SELECT COALESCE(max(position), 0) + 1 FROM inspection_items WHERE account_id = 1 AND area = ${area}), ${who.email}, ${supplyId})`;
    }
  } else if (b.action === 'move') {
    const [it] = await sql`SELECT area, position FROM inspection_items WHERE account_id = 1 AND id = ${id}` as { area: string; position: number }[];
    if (!it) return bad('That item is gone.');
    const up = Number(b.dir) < 0;
    const [other] = await sql`SELECT id, position FROM inspection_items WHERE account_id = 1 AND area = ${it.area} AND id <> ${id}
                                AND (CASE WHEN ${up} THEN position <= ${it.position} ELSE position >= ${it.position} END)
                              ORDER BY CASE WHEN ${up} THEN -position ELSE position END, id LIMIT 1` as { id: number; position: number }[];
    if (other) {
      // Swap — and keep them apart if they shared a number.
      const mine = other.position === it.position ? (up ? it.position - 1 : it.position + 1) : other.position;
      await sql`UPDATE inspection_items SET position = ${it.position}, updated_at = now() WHERE account_id = 1 AND id = ${other.id}`;
      await sql`UPDATE inspection_items SET position = ${mine}, updated_at = now() WHERE account_id = 1 AND id = ${id}`;
    }
  } else if (b.action === 'delete') {
    const used = (await sql`SELECT 1 FROM inspection_checks WHERE account_id = 1 AND item_id = ${id} LIMIT 1`).length > 0;
    if (used) await sql`UPDATE inspection_items SET active = false, updated_at = now() WHERE account_id = 1 AND id = ${id}`;
    else await sql`DELETE FROM inspection_items WHERE account_id = 1 AND id = ${id}`;
    return Response.json(await everything(sql, { switchedOff: used }));
  } else if (b.action === 'areaSave') {
    const label = String(b.label ?? '').trim().slice(0, 60);
    if (!label) return bad('Name the area.');
    if (b.key) {
      await sql`UPDATE inspection_areas SET label = ${label} WHERE account_id = 1 AND key = ${String(b.key)}`;
    } else {
      const key = areaKey(label);
      if (!key) return bad('Name the area with letters or numbers.');
      if ((await sql`SELECT 1 FROM inspection_areas WHERE account_id = 1 AND (key = ${key} OR lower(label) = lower(${label}))`).length) return bad('There is an area with that name already.');
      await sql`INSERT INTO inspection_areas (account_id, key, label, position, created_by)
                VALUES (1, ${key}, ${label}, (SELECT COALESCE(max(position), 0) + 1 FROM inspection_areas WHERE account_id = 1), ${who.email})`;
    }
  } else if (b.action === 'areaMove') {
    const areas = await inspectionAreas(sql);
    const i = areas.findIndex(a => a.key === String(b.key)), j = i + (Number(b.dir) < 0 ? -1 : 1);
    if (i < 0) return bad('That area is gone.');
    if (j >= 0 && j < areas.length) {
      [areas[i], areas[j]] = [areas[j]!, areas[i]!];
      // Renumber the whole walk: positions stay 1…n with no ties.
      await sql`UPDATE inspection_areas a SET position = v.pos FROM unnest(${areas.map(a => a.key)}::text[]) WITH ORDINALITY AS v(key, pos)
                 WHERE a.account_id = 1 AND a.key = v.key`;
    }
  } else if (b.action === 'areaActive') {
    await sql`UPDATE inspection_areas SET active = ${b.active !== false} WHERE account_id = 1 AND key = ${String(b.key)}`;
  } else if (b.action === 'areaDelete') {
    const key = String(b.key);
    if ((await sql`SELECT 1 FROM inspection_items WHERE account_id = 1 AND area = ${key} LIMIT 1`).length) return bad('It still has items — move or remove them first, or switch the area off.');
    if ((await sql`SELECT 1 FROM inspection_checks WHERE account_id = 1 AND area = ${key} LIMIT 1`).length) return bad('Old inspections have findings there — switch it off instead.');
    await sql`DELETE FROM inspection_areas WHERE account_id = 1 AND key = ${key}`;
  } else {
    return bad('Unknown action.');
  }
  return Response.json(await everything(sql));
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
