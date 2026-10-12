/**
 * /api/inspection-items — the inspection checklist template (§133).
 *
 *   GET                                           every item, active or not
 *   POST { action: 'save', id?, area, label, defaultOutcome, unitId?, active? }
 *   POST { action: 'move', id, dir: -1 | 1 }      up or down within its area
 *   POST { action: 'delete', id }                 gone if never used; else switched off
 *
 * GET with `operations`; POST with `operations.setup` (roles.ts). An item
 * already answered in an inspection is never deleted — the report keeps its
 * words — it is switched off and stops appearing in new inspections.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { templateItems } from '../_lib/inspection-run.ts';
import { AREA_KEYS } from '../../src/lib/inspection.ts';

const OUT = new Set(['repair', 'purchase', 'clean']);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  return Response.json({ ok: true, items: await templateItems(sql) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, unknown>;
  const id = Number(b.id) || 0;

  if (b.action === 'save') {
    const area = String(b.area ?? ''), label = String(b.label ?? '').trim().slice(0, 200);
    const outcome = String(b.defaultOutcome ?? 'repair');
    const unitId = b.unitId ? String(b.unitId) : null;
    if (!AREA_KEYS.has(area)) return bad('Which area?');
    if (!label) return bad('Say what to check.');
    if (!OUT.has(outcome)) return bad('A failure usually becomes a repair, a purchase or a clean.');
    if (unitId && !(await sql`SELECT 1 FROM units WHERE account_id = 1 AND id = ${unitId}`).length) return bad('Unknown unit.');
    if (id) {
      await sql`UPDATE inspection_items SET area = ${area}, label = ${label}, default_outcome = ${outcome}, unit_id = ${unitId},
                       active = ${b.active !== false}, updated_at = now() WHERE account_id = 1 AND id = ${id}`;
    } else {
      await sql`INSERT INTO inspection_items (account_id, area, label, default_outcome, unit_id, position, created_by)
                VALUES (1, ${area}, ${label}, ${outcome}, ${unitId},
                        (SELECT COALESCE(max(position), 0) + 1 FROM inspection_items WHERE account_id = 1 AND area = ${area}), ${who.email})`;
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
    return Response.json({ ok: true, switchedOff: used, items: await templateItems(sql) });
  } else {
    return bad('Unknown action.');
  }
  return Response.json({ ok: true, items: await templateItems(sql) });
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
