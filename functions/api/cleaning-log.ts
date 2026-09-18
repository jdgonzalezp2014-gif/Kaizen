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
  let sheetUrl: string | null = null;

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
  // A closed window, for reconciling one month against one invoice.
  // Without an upper bound a month view silently includes everything
  // after it, which is the opposite of what a cross-check needs.
  const to = url.searchParams.get('to') || null;
  const unit = url.searchParams.get('unit') || null;
  // Several cleaners, not one. Comparing a filter against a LIST is the
  // same question as comparing it against a name, and a filter that can
  // only hold one value makes "Michelle and Veronica" impossible to ask.
  const cleaners = (url.searchParams.get('cleaners') || '')
    .split(',').map(c => c.trim()).filter(Boolean);

  // Rows with nobody on them are OUT unless asked for. "Unassigned" and
  // "no clean needed" are states, not people, and a view that mixes them
  // into the default answers "who cleaned what" with rows where the answer
  // is nobody. They stay one click away, never silently included.
  const include = (url.searchParams.get('include') || '')
    .split(',').map(c => c.trim())
    .filter(c => c === 'tbd' || c === 'not_needed');
  const raw = url.searchParams.get('scope');
  const scope = raw === 'scheduled' || raw === 'all' ? raw : 'done';

  const rowsQ = sql`
    SELECT key, unit_id, unit_name, checkout_on, cleaner, assignment, guest,
           price, deep, urgency, reservation_note,
           (checkout_on > ${now}) AS future
      FROM cleanings
     WHERE account_id = 1
       AND (${scope} = 'all'
            OR (${scope} = 'done' AND checkout_on <= ${now})
            OR (${scope} = 'scheduled' AND checkout_on > ${now}))
       AND (${from}::date IS NULL OR checkout_on >= ${from}::date)
       AND (${to}::date IS NULL OR checkout_on <= ${to}::date)
       AND (${unit}::text IS NULL OR unit_id = ${unit}::text)
       AND (
             (assignment = 'assigned'
              AND (${cleaners.length === 0} OR cleaner = ANY(${cleaners}::text[])))
             OR assignment = ANY(${include}::text[])
           )
     ORDER BY checkout_on DESC, unit_name
     LIMIT 1000`;

  // Independent of each other, so they go together. In series they were
  // four round trips a person waits through one after another; the
  // database does not care in which order it answers them.
  const countsQ = sql`
    SELECT
      COUNT(*) FILTER (WHERE checkout_on <= ${now})::int AS done,
      COUNT(*) FILTER (WHERE checkout_on >  ${now})::int AS scheduled
    FROM cleanings WHERE account_id = 1`;

  // Real cleaners only, for the filter. "Not needed" and "TBD" are not
  // people and must not appear in a list of who to filter by.
  const crewQ = sql`
    SELECT cleaner, COUNT(*)::int AS n FROM cleanings
     WHERE account_id = 1 AND assignment = 'assigned' AND cleaner IS NOT NULL
     GROUP BY cleaner ORDER BY n DESC`;

  // Counted over the whole table, not the current selection, so a chip
  // that is switched off can still say how much it is holding back.
  const statesQ = sql`
    SELECT assignment, COUNT(*)::int AS n FROM cleanings
     WHERE account_id = 1 AND assignment <> 'assigned'
     GROUP BY assignment`;

  const [rows, counts, crew, states] = await Promise.all([rowsQ, countsQ, crewQ, statesQ]) as [
    Record<string, unknown>[],
    { done: number; scheduled: number }[],
    { cleaner: string; n: number }[],
    { assignment: string; n: number }[]
  ];

  return Response.json({
    ok: true, today: now, scope, sheetUrl, selected: cleaners, cleaners: crew,
    states: Object.fromEntries(states.map(r => [r.assignment, r.n])),
    cleanings: rows,
    doneCount: counts[0]?.done ?? 0,
    scheduledAhead: counts[0]?.scheduled ?? 0
  });
};
