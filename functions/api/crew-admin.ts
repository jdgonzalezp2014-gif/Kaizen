/**
 * /api/crew-admin — the team's side of the crew pages (§122).
 *
 *   GET  [?cleaner=<name>&period=YYYY-MM-DD]     extras waiting on the team; with a
 *                                               cleaner, their page exactly as they see it
 *   POST { action: 'decideExtra', id, status: 'approved' | 'denied', note }
 *   POST { action: 'flag', key, note }          flag a clean; the cleaner sees the note
 *   POST { action: 'unflag', key }
 *   POST { action: 'confirmSchedule' }          the schedule as it stands is what cleaners'
 *                                               "changes since" are measured from
 *
 * GET needs `operations`, POST `operations.edit` (roles.ts). A denial must
 * say why — the cleaner reads it.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { attachFiles, confirmSchedule, loadCrewPage, refuse, scheduleState } from '../_lib/crew.ts';
import { scheduleMovements, type Movement } from '../../src/lib/crew.ts';
import { todayIn } from '../../src/lib/dates.ts';

const TZ = 'America/New_York';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const url = new URL(request.url);
  const name = url.searchParams.get('cleaner');
  // The schedule once, for the movements of every cleaner and the page shown.
  const [acc] = await sql`SELECT crew_calendar, crew_calendar_days FROM accounts WHERE id = 1` as { crew_calendar: boolean; crew_calendar_days: number }[];
  let schedule: { enabled: boolean; confirmed: { at: string; by: string; through: string } | null;
                  movements: (Movement & { cleaner: string })[]; problem: string | null } =
    { enabled: !!acc?.crew_calendar, confirmed: null, movements: [], problem: null };
  let st: Awaited<ReturnType<typeof scheduleState>> | undefined;
  try {
    st = await scheduleState(sql, env.ENCRYPTION_KEY, acc?.crew_calendar_days ?? 14);
    if (st.confirm) {
      const today = todayIn(TZ);
      const people = new Set([...st.confirm.snapshot, ...st.now].map(i => i.cleaner));
      schedule = { ...schedule, confirmed: { at: st.confirm.at, by: st.confirm.by, through: st.confirm.through },
        movements: [...people].flatMap(c => scheduleMovements(c, st!.confirm!.snapshot, st!.now, st!.confirm!.through, today, st!.fate(c))
          .map(m => ({ ...m, cleaner: c }))) };
    }
  } catch (e) {
    schedule.problem = `The schedule could not be read (${e instanceof Error ? e.message : String(e)}).`;
  }
  const [pending, page] = await Promise.all([
    sql`SELECT e.id::text, e.cleaner, e.cleaning_key AS key, e.amount::float AS amount, e.description,
               to_char(e.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS "createdAt",
               c.unit_name AS unit, c.checkout_on::text AS date, c.price::float AS price
          FROM cleaning_extras e
          JOIN cleanings c ON c.account_id = e.account_id AND c.key = e.cleaning_key
         WHERE e.account_id = 1 AND e.status = 'pending'
         ORDER BY e.created_at`,
    name ? loadCrewPage(sql, env.ENCRYPTION_KEY, name, url.searchParams.get('period'), st) : Promise.resolve(null)
  ]);
  if (name && !page) return refuse(404, 'not_on_roster', `${name} is not on the roster.`);
  await attachFiles(sql, pending as { id: string }[]);
  return Response.json({ ok: true, pending, page, schedule });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const note = String(body.note ?? '').trim().slice(0, 500);

  if (body.action === 'decideExtra') {
    const status = body.status;
    if (status !== 'approved' && status !== 'denied') return refuse(400, 'bad_request', 'Approve or deny.');
    if (status === 'denied' && !note) return refuse(400, 'bad_request', 'Say why it is denied — the cleaner reads the note.');
    // Only a pending extra: a decision is not silently overwritten.
    const done = await sql`UPDATE cleaning_extras SET status = ${status}, decision_note = ${note || null},
                                  decided_by = ${who.email}, decided_at = now()
                            WHERE account_id = 1 AND id = ${Number(body.id) || 0} AND status = 'pending' RETURNING id`;
    if (!done.length) return refuse(409, 'already_decided', 'That extra was already decided or withdrawn — reload.');
    return Response.json({ ok: true });
  }

  if (body.action === 'confirmSchedule') {
    return Response.json({ ok: true, ...(await confirmSchedule(sql, env.ENCRYPTION_KEY, who.email)) });
  }

  if (body.action === 'flag' || body.action === 'unflag') {
    const key = String(body.key ?? '');
    if (body.action === 'flag' && !note) return refuse(400, 'bad_request', 'A flag needs a note — it is what the cleaner reads.');
    const done = body.action === 'flag'
      ? await sql`UPDATE cleanings SET flag_note = ${note}, flagged_by = ${who.email}, flagged_at = now()
                   WHERE account_id = 1 AND key = ${key} RETURNING key`
      : await sql`UPDATE cleanings SET flag_note = NULL, flagged_by = NULL, flagged_at = NULL
                   WHERE account_id = 1 AND key = ${key} RETURNING key`;
    if (!done.length) return refuse(404, 'not_found', 'That clean is not in the record.');
    return Response.json({ ok: true });
  }

  return refuse(400, 'bad_request', 'Unknown action.');
};
