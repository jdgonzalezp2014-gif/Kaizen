/**
 * /api/inspections — the Inspection Log, kept here.
 *
 *   POST { action: 'log', unit, date, inspector, result, notes, reservationId?, id? }
 *   POST { action: 'schedule' }            book every due unit at its next checkout
 *   DELETE ?id=…                           cancel a SCHEDULED one
 *
 * A row without a result is a plan. Plans can be cancelled; a done
 * inspection is an audit record and cannot be deleted from here — the
 * same reason the sheet's log was "never overwritten".
 *
 * The inspector is never the person who cleaned that turnover. An
 * inspection audits the clean, and an audit by its own author is not
 * one; the sheet said so in a comment, this refuses it.
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { loadOps } from '../_lib/ops.ts';
import { proposeInspections } from '../../src/lib/operations.ts';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => ({})) as Record<string, any>;

  if (body.action === 'schedule') {
    const s = await loadOps(sql, await getCredentials(sql, env.ENCRYPTION_KEY));
    const proposals = proposeInspections(s.panel, s.reservations, s.today, s.rules);
    let added = 0;
    for (const p of proposals) {
      // Manager by default, as the sheet did: independent of every cleaner.
      const r = await sql`
        INSERT INTO inspections (account_id, unit_id, unit_name, inspected_on, inspector, result,
                                 notes, reservation_id, source, created_by)
        VALUES (1, ${p.unitId}, ${p.unit}, ${p.date}, 'Manager', NULL,
                ${`⏳ Auto-scheduled · ${p.reason}`}, ${p.reservationId}, 'auto', ${who.email})
        ON CONFLICT DO NOTHING RETURNING id`;
      added += r.length;
    }
    return Response.json({ ok: true, proposed: proposals.length, added });
  }

  if (body.action !== 'log') return bad('Unknown action.');

  const unit = String(body.unit ?? '').trim();
  const date = String(body.date ?? '');
  const inspector = String(body.inspector ?? '').trim() || null;
  const result = body.result ? String(body.result) : null;
  const notes = String(body.notes ?? '').slice(0, 2000).trim() || null;
  const reservationId = body.reservationId ? String(body.reservationId) : null;
  if (!unit || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad('A unit and a date, please.');
  // The four standard results are what the form offers; anything else is
  // accepted as written, as the sheet's dropdown did, rather than refused.
  if (result !== null && !result.trim()) return bad('A result cannot be blank — leave it out to schedule.');

  if (inspector && reservationId) {
    const c = (await sql`SELECT cleaner FROM cleanings WHERE account_id = 1 AND key = ${reservationId}
                         UNION ALL
                         SELECT cleaner FROM turnover_overrides WHERE account_id = 1 AND reservation_id = ${reservationId}`) as
      { cleaner: string | null }[];
    if (c.some(x => x.cleaner && x.cleaner === inspector)) {
      return bad(`${inspector} cleaned this turnover, so cannot inspect it — an inspection audits the clean.`);
    }
  }

  const unitId = (await sql`SELECT id FROM units WHERE account_id = 1
                              AND lower(regexp_replace(name, '[^a-zA-Z0-9]', '', 'g')) =
                                  lower(regexp_replace(${unit}, '[^a-zA-Z0-9]', '', 'g')) LIMIT 1`)[0]?.id ?? null;

  if (body.id) {
    await sql`UPDATE inspections SET inspected_on = ${date}, inspector = ${inspector}, result = ${result},
                     notes = ${notes}, updated_at = now()
               WHERE account_id = 1 AND id = ${String(body.id)}`;
  } else {
    // One per unit per day: logging the day a plan was for completes the plan.
    await sql`
      INSERT INTO inspections (account_id, unit_id, unit_name, inspected_on, inspector, result, notes,
                               reservation_id, created_by)
      VALUES (1, ${unitId}, ${unit}, ${date}, ${inspector}, ${result}, ${notes}, ${reservationId}, ${who.email})
      ON CONFLICT (account_id, lower(unit_name), inspected_on) DO UPDATE SET
        inspector = EXCLUDED.inspector, result = EXCLUDED.result,
        notes = COALESCE(EXCLUDED.notes, inspections.notes), updated_at = now()`;
  }
  return Response.json({ ok: true });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^\d+$/.test(id)) return bad('Which inspection?');
  const r = await sql`DELETE FROM inspections WHERE account_id = 1 AND id = ${id} AND result IS NULL RETURNING id`;
  if (!r.length) return bad('Only a scheduled inspection can be cancelled — a done one is part of the audit trail.');
  return Response.json({ ok: true });
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
