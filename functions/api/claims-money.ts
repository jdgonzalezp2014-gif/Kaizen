/**
 * /api/claims-money — Claims & upselling as money (§162, owner 2026-10-15), for Finance only
 * (permission `claims.money`; the team follows cases in Operations without the figures).
 *
 *   GET  ?from&to   cases raised in the range (all open ones too): requested, received, repair work
 *   POST { id, requested?, received?, category? }   the figures Finance keeps
 *
 * Received is income (Revenue counts it in net — /api/portfolio); requested is not money; repair work is read
 * from the case's work orders and purchase orders, which already reached Costs on their own — shown, never added.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { CLAIM_CATEGORIES } from '../../src/lib/claims.ts';

const bad = (message: string, status = 400) => Response.json({ ok: false, message }, { status });
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const q = new URL(request.url).searchParams;
  const from = q.get('from') ?? '', to = q.get('to') ?? '';
  if (!DAY.test(from) || !DAY.test(to)) return bad('Which dates?');
  const sql = db(env) as unknown as SqlFn;
  const cases = await sql`
    SELECT c.id::text, c.unit_id, u.name AS unit_name, c.occurred_on::text AS occurred_on, c.resolved_on::text AS resolved_on,
           c.category, c.status, c.source, c.description, c.reservation_label, c.case_url,
           c.requested::float8 AS requested, c.refund::float8 AS received,
           (SELECT COALESCE(sum(COALESCE(t.cost_actual, CASE WHEN t.kind = 'work_order' THEN t.cost_estimate END, 0)
                                + (SELECT COALESCE(sum(p.total), 0) FROM inventory_purchases p WHERE p.account_id = 1 AND p.todo_id = t.id)), 0)::float8
              FROM todos t WHERE t.account_id = 1 AND t.claim_id = c.id::text AND t.deleted_at IS NULL AND t.status <> 'cancelled') AS repair_work
      FROM claims c LEFT JOIN units u ON u.account_id = c.account_id AND u.id = c.unit_id
     WHERE c.account_id = 1 AND c.deleted_at IS NULL
       AND (c.occurred_on BETWEEN ${from} AND ${to} OR c.status IN ('Open', 'In progress'))
     ORDER BY c.occurred_on DESC, c.id DESC LIMIT 1000`;
  return Response.json({ ok: true, cases }, { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const b = await request.json().catch(() => ({})) as { id?: string; requested?: unknown; received?: unknown; category?: unknown };
  if (!/^\d+$/.test(String(b.id ?? ''))) return bad('Which case?');
  const amount = (v: unknown) => v === undefined ? undefined : Math.round((Number(v) || 0) * 100) / 100;
  const requested = amount(b.requested), received = amount(b.received);
  if ((requested ?? 0) < 0 || (received ?? 0) < 0) return bad('Amounts cannot be negative.');
  const category = b.category === undefined ? undefined : b.category === null || b.category === '' ? null : String(b.category);
  if (category && !CLAIM_CATEGORIES.includes(category)) return bad('Unknown kind.');
  const sql = db(env) as unknown as SqlFn;
  const rows = await sql`
    UPDATE claims SET
      requested = CASE WHEN ${requested !== undefined} THEN ${requested ?? 0}::numeric ELSE requested END,
      refund    = CASE WHEN ${received !== undefined} THEN ${received ?? 0}::numeric ELSE refund END,
      category  = CASE WHEN ${category !== undefined} THEN ${category ?? null} ELSE category END
    WHERE account_id = 1 AND id = ${Number(b.id)} AND deleted_at IS NULL RETURNING id`;
  if (!rows.length) return bad('That case is gone.', 404);
  // The case's activity log is read by the whole team — it says that the figures moved, not what they are.
  if (requested !== undefined || received !== undefined) {
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${String(b.id)}, 'change', 'Finance updated the figures', ${who.email})`;
  }
  return Response.json({ ok: true });
};
