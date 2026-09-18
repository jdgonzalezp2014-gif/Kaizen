/**
 * /api/claims — what guests complained about, and what it cost.
 *
 * Full CRUD, unlike the money tables, and the difference is deliberate.
 * An expense is a fact that happened once; a claim is a CASE that moves
 * — opened, investigated, refunded, closed — and a table that could only
 * be appended to would make "update the status" mean "file it again".
 *
 * What does not change is `occurred_on`: when the guest raised it, never
 * when someone got round to fixing it. Filing a July complaint in
 * September moves it into the wrong month and quietly flatters July.
 */
import { db, type Env } from '../_lib/db.ts';
import { identify, unauthorised } from '../_lib/auth.ts';

const SEVERITY = ['Low', 'Medium', 'High', 'Critical'];
const STATUS = ['Open', 'In progress', 'Resolved', 'Refunded', 'Dismissed'];

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env);
  const claims = await sql`
    SELECT c.id, c.unit_id, c.occurred_on, c.category, c.severity, c.status,
           c.source, c.description, c.refund, c.repair_cost, c.resolved_on,
           c.created_by, c.created_at, u.name AS unit_name
      FROM claims c
      LEFT JOIN units u ON u.account_id = c.account_id AND u.id = c.unit_id
     WHERE c.account_id = 1
     ORDER BY
       -- Open cases first regardless of age: a three-month-old open
       -- claim is the one that needs attention, and sorting purely by
       -- date buries it under yesterday's resolved ones.
       (c.status IN ('Open', 'In progress')) DESC, c.occurred_on DESC
     LIMIT 500`;
  return Response.json({ ok: true, claims });
};

interface Body {
  id?: string;
  unitId?: string | null;
  occurredOn?: string;
  category?: string;
  severity?: string;
  status?: string;
  source?: string;
  description?: string;
  refund?: number;
  repairCost?: number;
  resolvedOn?: string | null;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env);
  const b = await request.json().catch(() => ({})) as Body;

  const severity = SEVERITY.includes(String(b.severity)) ? b.severity : 'Medium';
  const status = STATUS.includes(String(b.status)) ? b.status : 'Open';
  const refund = Number(b.refund) || 0;
  const repair = Number(b.repairCost) || 0;
  if (refund < 0 || repair < 0) {
    return Response.json({ ok: false, error: 'Amounts cannot be negative.' }, { status: 400 });
  }

  // Closing a case without a date leaves a resolved claim that cannot be
  // aged, so the date is filled rather than left to whoever remembers.
  const closing = status === 'Resolved' || status === 'Refunded' || status === 'Dismissed';
  const resolvedOn = b.resolvedOn ?? (closing ? new Date().toISOString().slice(0, 10) : null);

  if (b.id) {
    const rows = await sql`
      UPDATE claims SET
        unit_id = ${b.unitId || null},
        occurred_on = COALESCE(${b.occurredOn ?? null}, occurred_on),
        category = ${b.category ?? null}, severity = ${severity}, status = ${status},
        source = ${b.source ?? null}, description = ${b.description ?? null},
        refund = ${refund}, repair_cost = ${repair},
        -- Cleared when a case is reopened, so a claim never carries a
        -- resolution date while it is open.
        resolved_on = ${closing ? resolvedOn : null}
      WHERE account_id = 1 AND id = ${b.id}
      RETURNING id`;
    return Response.json({ ok: rows.length > 0, id: rows[0]?.id });
  }

  const rows = await sql`
    INSERT INTO claims
      (account_id, unit_id, occurred_on, category, severity, status, source,
       description, refund, repair_cost, resolved_on, created_by)
    VALUES (1, ${b.unitId || null},
            ${b.occurredOn || new Date().toISOString().slice(0, 10)},
            ${b.category ?? null}, ${severity}, ${status}, ${b.source ?? null},
            ${b.description ?? null}, ${refund}, ${repair}, ${resolvedOn}, ${who.email})
    RETURNING id`;
  return Response.json({ ok: true, id: rows[0]?.id });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id is required.' }, { status: 400 });
  const sql = db(env);
  const rows = await sql`DELETE FROM claims WHERE account_id = 1 AND id = ${id} RETURNING id`;
  return Response.json({ ok: rows.length > 0 });
};
