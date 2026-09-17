/**
 * GET /api/units — the local unit mirror, for pickers.
 *
 * Reads the `units` table rather than Hostaway: an expense is attached
 * by foreign key, so the only ids worth offering are the ones that will
 * actually accept one.
 */
import { db, type Env } from '../_lib/db.ts';
import { identify, unauthorised } from '../_lib/auth.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env);
  const rows = await sql`
    SELECT id, name, active, parked, cleaning_fee, cleaning_fee_source, parked_checked_at
      FROM units WHERE account_id = 1 ORDER BY active DESC, parked, name` as {
        id: string; name: string; active: boolean; parked: boolean;
        cleaning_fee: string | null; cleaning_fee_source: string | null;
      }[];
  // `active` here means listed AND taking bookings, which is the sense
  // every caller wants. The two inputs stay separate alongside it so a
  // parked unit can be labelled as parked rather than as delisted.
  const units = rows.map(r => ({
    ...r, listed: r.active, active: r.active && !r.parked
  }));
  return Response.json({ ok: true, units });
};

/** POST /api/units — set what a cleaner is PAID for a unit. */
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const b = await request.json().catch(() => ({})) as { id?: string; cleaningFee?: number | null };
  if (!b.id) return Response.json({ ok: false, error: 'id is required.' }, { status: 400 });
  const fee = b.cleaningFee == null ? null : Number(b.cleaningFee);
  const sql = db(env);
  const rows = await sql`
    UPDATE units SET cleaning_fee = ${fee}, cleaning_fee_source = 'manual', cleaning_fee_at = now()
     WHERE account_id = 1 AND id = ${b.id} RETURNING id, cleaning_fee`;
  return Response.json({ ok: rows.length > 0, unit: rows[0] });
};
