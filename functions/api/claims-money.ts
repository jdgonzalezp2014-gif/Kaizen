/**
 * /api/claims-money — Claims & upselling as money (§162), Finance's view (permission `claims.money`).
 *
 *   GET  ?from&to   cases raised or paid in the range (all open ones too): requested, received (its day), repair work,
 *                   the part of it charged to the owner
 *   POST { id, requested?, received?, receivedOn?, collectedVia?, category? }   a correction — §167: the team enters the
 *                   money on the case (/api/claims action `money`); Finance can edit the same fields, through the same rules
 *
 * Received is income (Revenue counts it in net on `received_on` — /api/portfolio); requested is an estimate; repair
 * work is read from the case's work orders and purchase orders (`claim_work`), already in Costs on their own.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { saveCaseMoney, type MoneyChange } from '../_lib/claim-money.ts';

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
           c.requested::float8 AS requested, c.refund::float8 AS received, c.received_on::text AS received_on, c.collected_via,
           COALESCE(w.repair_work, 0)::float8 AS repair_work, COALESCE(w.owner_work, 0)::float8 AS owner_work
      FROM claims c LEFT JOIN units u ON u.account_id = c.account_id AND u.id = c.unit_id
      LEFT JOIN claim_work w ON w.account_id = c.account_id AND w.claim_id = c.id::text
     WHERE c.account_id = 1 AND c.deleted_at IS NULL
       AND (c.occurred_on BETWEEN ${from} AND ${to} OR c.received_on BETWEEN ${from} AND ${to} OR c.status IN ('Open', 'In progress'))
     ORDER BY c.occurred_on DESC, c.id DESC LIMIT 1000`;
  return Response.json({ ok: true, cases }, { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const b = await request.json().catch(() => ({})) as { id?: string } & Record<string, unknown>;
  if (!/^\d+$/.test(String(b.id ?? ''))) return bad('Which case?');
  const r = await saveCaseMoney(db(env) as unknown as SqlFn, String(b.id), b as MoneyChange, who.email);
  return r.ok ? Response.json({ ok: true }) : bad(r.error, r.status);
};
