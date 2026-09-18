/**
 * GET /api/cleaning-log — the cleanings that have happened.
 *
 * Three scopes, because two different questions are being asked of the
 * same table:
 *
 *   done       past and today. What cleaning COST. The default, because
 *              it is the only one that is a fact.
 *   scheduled  ahead of today. Work committed but not done, which is
 *              what a projection needs.
 *   all        both, for a full picture of the commitment.
 *
 * They are never blended silently. A total that mixes money paid with
 * money promised answers neither question, and "what did this month
 * cost" including work nobody has done is simply wrong.
 *
 * The cut is made HERE rather than trimmed in the browser, so the
 * figures on the page and the rows under them come from one query and
 * cannot disagree.
 */
import { db, type Env } from '../_lib/db.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { today } from '../../src/lib/dates.ts';
import { importCleanings } from '../_lib/cleanings-import.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env);
  const url = new URL(request.url);
  const now = today();

  // Refreshed on the way in, not by a button. The sheet is edited daily
  // by the people doing the work, so anything older than a few hours is
  // behind — and asking someone to remember to press Pull is how a
  // screen ends up quietly showing last week.
  //
  // Guarded by age so opening the tab twice costs one fetch, and wrapped
  // because a sheet that is down must cost the refresh, never the view.
  try {
    const acc = (await sql`SELECT cleanings_csv_url FROM accounts WHERE id = 1`) as
      { cleanings_csv_url: string | null }[];
    const feedUrl = acc[0]?.cleanings_csv_url;
    if (feedUrl) {
      const fresh = (await sql`
        SELECT 1 FROM cleanings
         WHERE account_id = 1 AND imported_at > now() - INTERVAL '3 hours' LIMIT 1`) as unknown[];
      if (!fresh.length) await importCleanings(sql as never, feedUrl);
    }
  } catch { /* the log is not the sheet's hostage */ }
  // NULL, not ''. `checkout_on >= $1` makes Postgres coerce the
  // parameter to DATE, and it does that before the OR can short-circuit
  // — so an empty string failed the whole query with
  // "invalid input syntax for type date". A filter meaning "no filter"
  // has to be absent, not blank.
  const from = url.searchParams.get('from') || null;
  const unit = url.searchParams.get('unit') || null;
  const raw = url.searchParams.get('scope');
  const scope = raw === 'scheduled' || raw === 'all' ? raw : 'done';

  const rows = await sql`
    SELECT key, unit_id, unit_name, checkout_on, cleaner, guest,
           price, deep, urgency, notes,
           (checkout_on > ${now}) AS future
      FROM cleanings
     WHERE account_id = 1
       AND (${scope} = 'all'
            OR (${scope} = 'done' AND checkout_on <= ${now})
            OR (${scope} = 'scheduled' AND checkout_on > ${now}))
       AND (${from}::date IS NULL OR checkout_on >= ${from}::date)
       AND (${unit}::text IS NULL OR unit_id = ${unit}::text)
     ORDER BY checkout_on DESC, unit_name
     LIMIT 1000`;

  // Both counts always, whatever the scope: the tab needs to say what it
  // is NOT showing, or a filtered view reads as an empty table.
  const counts = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE checkout_on <= ${now})::int AS done,
      COUNT(*) FILTER (WHERE checkout_on >  ${now})::int AS scheduled
    FROM cleanings WHERE account_id = 1`) as { done: number; scheduled: number }[];

  return Response.json({
    ok: true, today: now, scope, cleanings: rows,
    doneCount: counts[0]?.done ?? 0,
    scheduledAhead: counts[0]?.scheduled ?? 0
  });
};
