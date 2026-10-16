/**
 * /api/inventory-items — the supplies catalog (§134).
 *
 *   POST { action: 'save', id?, name, size?, category, measure, perClean?, reorderAt?, active?, kind?, buyOptions? }
 *        kind 'supply' | 'furniture' (§150); buyOptions [{ label, url, pack? }] — where to buy it; pack = how many of
 *        its measure come in one (a Walmart/Amazon product's, learned from receipts — store-order.ts)
 *   POST { action: 'delete', id }        switched off, never erased: the moves name it
 *   POST { action: 'lowStock', on }      §150: a "Low stock at <place>" to-do on its own, or not
 *   POST { action: 'assign', unitId, to } §150: where a unit draws supplies — a place key, 'self' (its own
 *                                         closet) or '' (not assigned): written to the Repository's
 *                                         `storage` column, the one source, audited by field name
 *                                         (a unit that has a closet: what REFILLS it; 'self' = nothing)
 *   POST { action: 'closet', unitId, on } "Has closet" (owner, 2026-10-15), written to the Repository
 *
 * `operations.setup` (roles.ts). Read with /api/inventory.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { invItems } from '../_lib/inventory.ts';
import { supplyPlaces } from '../_lib/unit-access.ts';
import { repoMatch, type RepoRow } from '../../src/lib/unit-access.ts';
import { CATEGORIES, itemLabel, sameItem } from '../../src/lib/inventory.ts';
import { storeProduct } from '../../src/lib/store-order.ts';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, unknown>;
  const num = (v: unknown) => v === '' || v == null ? null : Number(v);
  if (b.action === 'save') {
    const name = String(b.name ?? '').trim().slice(0, 120);
    // Owner, 2026-10-14: King and Queen are two items of one name — the size tells them apart.
    const size = String(b.size ?? '').trim().slice(0, 30) || null;
    const category = String(b.category ?? 'other');
    const measure = String(b.measure ?? 'unit').trim().slice(0, 20) || 'unit';
    const perClean = num(b.perClean), reorderAt = num(b.reorderAt);
    if (!name) return bad('An item needs a name.');
    if (!(CATEGORIES as readonly string[]).includes(category)) return bad('Which category?');
    if ((perClean !== null && !(perClean >= 0)) || (reorderAt !== null && !(reorderAt >= 0))) return bad('Amounts are numbers, 0 or more.');
    const kind = b.kind === 'furniture' ? 'furniture' : 'supply';
    const raw = Array.isArray(b.buyOptions) ? b.buyOptions as { label?: unknown; url?: unknown; pack?: unknown }[] : [];
    const buy = raw.map(o => ({ label: String(o.label ?? '').trim().slice(0, 60), url: String(o.url ?? '').trim().slice(0, 500), pack: Number(o.pack) > 0 ? Math.round(Number(o.pack) * 100) / 100 : null }))
      .filter(o => o.label || o.url);
    if (buy.some(o => !/^https?:\/\/\S+$/i.test(o.url))) return bad('Each buying option needs a link that starts with https://');
    // Owner, 2026-10-15: one Walmart or Amazon product per item for now — the one its receipts match and its order's cart uses.
    if (buy.filter(o => storeProduct(o.url)).length > 1) return bad('One Walmart or Amazon link per item — keep the one you buy.');
    const buyJson = JSON.stringify(buy.map(o => ({ label: o.label || new URL(o.url).hostname.replace(/^www\./, ''), url: o.url, ...(o.pack ? { pack: o.pack } : {}) })));
    // Owner, 2026-10-15: one item per thing — "Mattress protector" is refused beside "Mattress protectors" of the same size.
    const all = await sql`SELECT id::text, name, size FROM inventory_items WHERE account_id = 1 AND active` as { id: string; name: string; size: string | null }[];
    const twin = sameItem(all, name, size, b.id ? String(b.id) : undefined);
    if (twin) return bad(`There is already "${itemLabel(twin.name, twin.size)}" — edit that one instead.`);
    try {
      if (b.id) await sql`UPDATE inventory_items SET name = ${name}, size = ${size}, category = ${category}, measure = ${measure}, per_clean = ${perClean},
                                 kind = ${kind}, buy_options = ${buyJson}::jsonb,
                                 reorder_at = ${reorderAt}, active = ${b.active !== false}, updated_at = now()
                           WHERE account_id = 1 AND id = ${Number(b.id)}`;
      else await sql`INSERT INTO inventory_items (account_id, name, size, category, measure, per_clean, reorder_at, kind, buy_options)
                     VALUES (1, ${name}, ${size}, ${category}, ${measure}, ${perClean}, ${reorderAt}, ${kind}, ${buyJson}::jsonb)`;
    } catch { return bad(`There is already an item called "${size ? `${name} — ${size}` : name}".`); }
  } else if (b.action === 'delete') {
    await sql`UPDATE inventory_items SET active = false, updated_at = now() WHERE account_id = 1 AND id = ${Number(b.id)}`;
  } else if (b.action === 'assign') {
    const [u] = await sql`SELECT name FROM units WHERE account_id = 1 AND id = ${String(b.unitId ?? '')}` as { name: string }[];
    if (!u) return bad('Which unit?');
    const recs = await sql`SELECT r.id, r.table_key AS "table", r.vals FROM repo_records r
                             JOIN repo_tables t ON t.account_id = r.account_id AND t.key = r.table_key
                            WHERE r.account_id = 1 AND t.section_key = 'units' AND t.archived_at IS NULL AND r.archived_at IS NULL` as RepoRow[];
    const rec = repoMatch(u.name, recs);
    if (!rec) return bad(`${u.name} has no record in Repository → Units — add it there first.`);
    const to = String(b.to ?? '');
    let value = '';
    if (to === 'self') value = String(rec.vals.name ?? '').trim();
    else if (to) {
      const p = (await supplyPlaces(sql)).places.find(x => x.key === to);
      if (!p) return bad('Which place?');
      value = p.name;
    }
    await sql`UPDATE repo_records SET vals = jsonb_set(vals, '{storage}', to_jsonb(${value}::text)), updated_at = now(), updated_by = ${who.email}
               WHERE account_id = 1 AND table_key = ${rec.table} AND id = ${rec.id}`;
    // Audited by field name, as every Repository edit (§72): who, which record, which field.
    await sql`INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
              VALUES (1, ${who.email}, 'records.update', ${rec.table}, ${rec.id}, 'storage (supplies place, from Setup → Inventory, §150)')`;
    return Response.json({ ok: true, items: await invItems(sql) });
  } else if (b.action === 'closet') {
    // Owner, 2026-10-15: "Has closet" lives in the Repository — switched here, written there.
    const [u] = await sql`SELECT name FROM units WHERE account_id = 1 AND id = ${String(b.unitId ?? '')}` as { name: string }[];
    if (!u) return bad('Which unit?');
    const recs = await sql`SELECT r.id, r.table_key AS "table", r.vals FROM repo_records r
                             JOIN repo_tables t ON t.account_id = r.account_id AND t.key = r.table_key
                            WHERE r.account_id = 1 AND t.section_key = 'units' AND t.archived_at IS NULL AND r.archived_at IS NULL` as RepoRow[];
    const rec = repoMatch(u.name, recs);
    if (!rec) return bad(`${u.name} has no record in Repository → Units — add it there first.`);
    await sql`UPDATE repo_records SET vals = jsonb_set(vals, '{has_closet}', to_jsonb(${b.on === true}::boolean)), updated_at = now(), updated_by = ${who.email}
               WHERE account_id = 1 AND table_key = ${rec.table} AND id = ${rec.id}`;
    await sql`INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
              VALUES (1, ${who.email}, 'records.update', ${rec.table}, ${rec.id}, 'has_closet (from Setup → Inventory)')`;
  } else if (b.action === 'lowStock') {
    await sql`UPDATE accounts SET inventory_low_stock_tasks = ${b.on === true} WHERE id = 1`;
  } else return bad('Unknown action.');
  return Response.json({ ok: true, items: await invItems(sql) });
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
