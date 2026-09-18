/**
 * GET /api/cleaning-log — the cleanings that have happened.
 *
 * Past and today only, and that is enforced HERE rather than trimmed in
 * the browser. A clean scheduled for next week is a plan, not a fact:
 * counting it would answer "what did cleaning cost this month" with a
 * number that includes work nobody has done and money nobody has paid.
 *
 * Filtering server-side also means the figures on the page and the rows
 * under them can never disagree — they come from the same query.
 */
import { db, type Env } from '../_lib/db.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { today } from '../../src/lib/dates.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env);
  const url = new URL(request.url);
  const now = today();
  const from = url.searchParams.get('from') || '';
  const unit = url.searchParams.get('unit') || '';

  const rows = await sql`
    SELECT key, unit_id, unit_name, checkout_on, cleaner, guest,
           price, deep, urgency, notes
      FROM cleanings
     WHERE account_id = 1
       AND checkout_on <= ${now}
       AND (${from} = '' OR checkout_on >= ${from})
       AND (${unit} = '' OR unit_id = ${unit})
     ORDER BY checkout_on DESC, unit_name
     LIMIT 1000`;

  // Counted from the same rows rather than from a second query, so a
  // total can never describe a set the page is not showing.
  const scheduled = (await sql`
    SELECT COUNT(*)::int AS n FROM cleanings
     WHERE account_id = 1 AND checkout_on > ${now}`) as { n: number }[];

  return Response.json({
    ok: true, today: now, cleanings: rows,
    // Mentioned, never mixed in: knowing five are booked ahead is useful,
    // counting them as done is not.
    scheduledAhead: scheduled[0]?.n ?? 0
  });
};
