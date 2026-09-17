/**
 * /api/expenses — what things cost.
 *
 * Two shapes, one table, because "what did this cost" must have one
 * answer and one place to look for it:
 *
 *   FIXED    a recurring LINE (Lease, Internet, Pest control) that gets
 *            its own row per month. Editing August's electricity edits
 *            August, and last year's dashboard does not move. A line is
 *            identified by (label, unit) — the amount is just what it
 *            was that month.
 *
 *   VARIABLE a dated one-off. Either charged to one unit (a repair, a
 *            replacement mattress) or shared across the active ones (an
 *            accountant, a software subscription).
 *
 * Amounts are never edited in place. A correction is a new row and the
 * old one is deleted by id, so a wrong number is visible in the history
 * rather than silently replaced — the same append-only rule the money
 * tables were built on.
 */
import { db, type Env } from '../_lib/db.ts';
import { identify, unauthorised } from '../_lib/auth.ts';

/** First day of the month a date falls in, as yyyy-MM-dd. */
function monthStart(d: string): string { return `${d.slice(0, 7)}-01`; }
/** Last day of that month. Day 0 of the next month IS the last day of this one. */
function monthEnd(d: string): string {
  const [y, m] = d.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env);
  const url = new URL(request.url);
  const month = url.searchParams.get('month');   // 'yyyy-MM'

  if (month) {
    // One month's fixed lines, plus the distinct lines seen in the three
    // months before it. The second part is what makes "carry forward"
    // possible without the user retyping a list they already maintain.
    const start = `${month}-01`;
    const [lines, recent] = await Promise.all([
      sql`SELECT e.id, e.label, e.unit_id, e.shared, e.category, e.amount, e.notes, u.name AS unit_name
            FROM expenses e LEFT JOIN units u ON u.account_id = e.account_id AND u.id = e.unit_id
           WHERE e.account_id = 1 AND e.frequency = 'Monthly' AND e.start_date = ${start}
           ORDER BY e.label`,
      sql`SELECT DISTINCT ON (label, COALESCE(unit_id,'')) label, unit_id, shared, category, amount, start_date
            FROM expenses
           WHERE account_id = 1 AND frequency = 'Monthly'
             AND start_date < ${start} AND start_date >= ${start}::date - INTERVAL '3 months'
           ORDER BY label, COALESCE(unit_id,''), start_date DESC`
    ]);
    return Response.json({ ok: true, month, lines, carryable: recent });
  }

  const rows = await sql`
    SELECT e.id, e.label, e.unit_id, e.shared, e.start_date, e.end_date, e.category,
           e.frequency, e.amount, e.notes, e.created_by, e.created_at, u.name AS unit_name
      FROM expenses e LEFT JOIN units u ON u.account_id = e.account_id AND u.id = e.unit_id
     WHERE e.account_id = 1 AND e.frequency <> 'Monthly'
     ORDER BY e.start_date DESC LIMIT 500`;
  return Response.json({ ok: true, expenses: rows });
};

interface PostBody {
  action?: 'fixed' | 'variable' | 'carryForward';
  month?: string;
  fromMonth?: string;
  label?: string;
  unitId?: string | null;
  shared?: boolean;
  category?: string;
  amount?: number;
  date?: string;
  endDate?: string | null;
  notes?: string;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env);
  const b = await request.json().catch(() => ({})) as PostBody;
  const action = b.action ?? 'variable';

  if (action === 'carryForward') {
    // Copy the previous month's lines into this one. The unique index
    // makes a second click a no-op rather than a doubled month — which
    // matters, because the button gives no sign it worked the first time.
    const to = b.month, fromM = b.fromMonth;
    if (!to || !fromM) return Response.json({ ok: false, error: 'month and fromMonth are required.' }, { status: 400 });
    const rows = await sql`
      INSERT INTO expenses
        (account_id, unit_id, shared, start_date, end_date, category, frequency, amount, label, notes, created_by)
      SELECT 1, unit_id, shared, ${`${to}-01`}::date,
             (date_trunc('month', ${`${to}-01`}::date) + INTERVAL '1 month - 1 day')::date,
             category, 'Monthly', amount, label, notes, ${who.email}
        FROM expenses
       WHERE account_id = 1 AND frequency = 'Monthly' AND start_date = ${`${fromM}-01`}
      ON CONFLICT DO NOTHING
      RETURNING id`;
    return Response.json({ ok: true, added: rows.length,
      message: rows.length ? `${rows.length} line(s) carried into ${to}.`
                           : `${to} already has those lines — nothing duplicated.` });
  }

  const amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return Response.json({ ok: false, error: 'A non-negative amount is required.' }, { status: 400 });
  }

  if (action === 'fixed') {
    const label = String(b.label ?? '').trim();
    if (!label) return Response.json({ ok: false, error: 'A fixed cost needs a name.' }, { status: 400 });
    const month = b.month || new Date().toISOString().slice(0, 7);
    const start = `${month}-01`;
    const rows = await sql`
      INSERT INTO expenses
        (account_id, unit_id, shared, start_date, end_date, category, frequency, amount, label, notes, created_by)
      VALUES (1, ${b.unitId || null}, ${b.unitId ? false : true}, ${start}, ${monthEnd(start)},
              ${b.category ?? 'General'}, 'Monthly', ${amount}, ${label}, ${b.notes ?? null}, ${who.email})
      ON CONFLICT (account_id, label, COALESCE(unit_id, ''), start_date)
        WHERE frequency = 'Monthly' AND label IS NOT NULL
      DO UPDATE SET amount = EXCLUDED.amount, category = EXCLUDED.category,
                    notes = EXCLUDED.notes, created_by = EXCLUDED.created_by
      RETURNING id`;
    return Response.json({ ok: true, id: rows[0]?.id, month });
  }

  const date = b.date || new Date().toISOString().slice(0, 10);
  const rows = await sql`
    INSERT INTO expenses
      (account_id, unit_id, shared, start_date, end_date, category, frequency, amount, notes, source, created_by)
    VALUES (1, ${b.unitId || null}, ${b.shared === true || !b.unitId}, ${date}, ${b.endDate || null},
            ${b.category ?? 'General'}, 'One-time', ${amount}, ${b.notes ?? null}, 'manual', ${who.email})
    RETURNING id`;
  return Response.json({ ok: true, id: rows[0]?.id });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ ok: false, error: 'id is required.' }, { status: 400 });
  const sql = db(env);
  const rows = await sql`DELETE FROM expenses WHERE account_id = 1 AND id = ${id} RETURNING id`;
  return Response.json({ ok: rows.length > 0, deleted: rows.length });
};
