/**
 * /api/inventory-items — the supplies catalog (§134).
 *
 *   POST { action: 'save', id?, name, category, measure, perClean?, reorderAt?, active? }
 *   POST { action: 'delete', id }        switched off, never erased: the moves name it
 *
 * `operations.setup` (roles.ts). Read with /api/inventory.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { invItems } from '../_lib/inventory.ts';
import { CATEGORIES } from '../../src/lib/inventory.ts';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, unknown>;
  const num = (v: unknown) => v === '' || v == null ? null : Number(v);
  if (b.action === 'save') {
    const name = String(b.name ?? '').trim().slice(0, 120);
    const category = String(b.category ?? 'other');
    const measure = String(b.measure ?? 'unit').trim().slice(0, 20) || 'unit';
    const perClean = num(b.perClean), reorderAt = num(b.reorderAt);
    if (!name) return bad('An item needs a name.');
    if (!(CATEGORIES as readonly string[]).includes(category)) return bad('Which category?');
    if ((perClean !== null && !(perClean >= 0)) || (reorderAt !== null && !(reorderAt >= 0))) return bad('Amounts are numbers, 0 or more.');
    try {
      if (b.id) await sql`UPDATE inventory_items SET name = ${name}, category = ${category}, measure = ${measure}, per_clean = ${perClean},
                                 reorder_at = ${reorderAt}, active = ${b.active !== false}, updated_at = now()
                           WHERE account_id = 1 AND id = ${Number(b.id)}`;
      else await sql`INSERT INTO inventory_items (account_id, name, category, measure, per_clean, reorder_at)
                     VALUES (1, ${name}, ${category}, ${measure}, ${perClean}, ${reorderAt})`;
    } catch { return bad(`There is already an item called "${name}".`); }
  } else if (b.action === 'delete') {
    await sql`UPDATE inventory_items SET active = false, updated_at = now() WHERE account_id = 1 AND id = ${Number(b.id)}`;
  } else return bad('Unknown action.');
  return Response.json({ ok: true, items: await invItems(sql) });
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
