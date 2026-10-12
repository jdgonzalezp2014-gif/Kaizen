/**
 * /api/crew-admin — the team's side of the crew pages (§122).
 *
 *   GET  [?cleaner=<name>&period=YYYY-MM-DD]     extras waiting on the team; with a
 *                                               cleaner, their page for the team
 *   GET  ?view=cleaner&cleaner=<name>[&period]  that cleaner's page through the SAME code that
 *                                               answers the cleaner (crewGet) — nothing of the team's
 *   POST { action: 'decideExtra', id, status: 'approved' | 'denied', note }   an approved extra goes to Costs (§137)
 *   POST { action: 'decideField', id, status: 'approved' | 'denied', note }   a purchase paid in the field → Costs (§137)
 *   POST { action: 'flag', key, note, price? }  flag a clean; the cleaner sees the note — and, for a clean
 *                                               today or before, optionally correct what it pays (§128)
 *   POST { action: 'unflag', key }
 *   POST { action: 'confirmClean', key, cleaner | null, date?, deep? }
 *                                               settle a clean held after a cancellation (§123):
 *                                               who cleaned it, or null = no clean was needed
 *   POST { action: 'editClean', key, deep, price?, note }
 *                                               correct a clean already done — a "deep" that was
 *                                               not done as one, a wrong price (§123)
 *
 * GET needs `operations`, POST `operations.edit` (roles.ts). A denial must
 * say why — the cleaner reads it.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { attachFiles, crewGet, crewVisibility, loadCrewPage, refuse, scheduleState } from '../_lib/crew.ts';
import { scheduleMovements, type Movement } from '../../src/lib/crew.ts';
import { todayIn } from '../../src/lib/dates.ts';
import { rateFor } from '../../src/lib/operations.ts';
import { opsConfig } from '../_lib/ops.ts';
import { decideFieldExpense, pendingFieldExpenses, syncCleaningCosts } from '../_lib/field-costs.ts';

const TZ = 'America/New_York';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const url = new URL(request.url);
  const name = url.searchParams.get('cleaner');
  // "View as cleaner": exactly what the cleaner's own request returns, by the same function.
  if (url.searchParams.get('view') === 'cleaner' && name) return crewGet(request, env, sql, { name, by: who.email });
  // The schedule once, for the movements of every cleaner and the page shown.
  const vis = await crewVisibility(sql);
  let schedule: { enabled: boolean; autoDays: number; confirmed: { at: string; by: string; through: string } | null;
                  movements: (Movement & { cleaner: string })[]; problem: string | null } =
    { enabled: vis.published, autoDays: vis.autoDays, confirmed: null, movements: [], problem: null };
  let st: Awaited<ReturnType<typeof scheduleState>> | undefined;
  try {
    st = await scheduleState(sql, env.ENCRYPTION_KEY, vis.days);
    const c = st.confirm;
    if (c) {
      const today = todayIn(TZ);
      const people = new Set([...c.snapshot, ...st.now].map(i => i.cleaner));
      schedule = { ...schedule, confirmed: { at: c.at, by: c.by, through: c.through },
        movements: [...people].flatMap(p => scheduleMovements(p, { items: c.snapshot, day: c.day, through: c.through, vis: c.vis },
          st!.now, today, vis, st!.fate(p)).map(m => ({ ...m, cleaner: p }))) };
    }
  } catch (e) {
    schedule.problem = `The schedule could not be read (${e instanceof Error ? e.message : String(e)}).`;
  }
  const [pending, page, toConfirm] = await Promise.all([
    sql`SELECT e.id::text, e.cleaner, e.cleaning_key AS key, e.amount::float AS amount, e.description,
               to_char(e.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS "createdAt",
               c.unit_name AS unit, c.checkout_on::text AS date, c.price::float AS price
          FROM cleaning_extras e
          JOIN cleanings c ON c.account_id = e.account_id AND c.key = e.cleaning_key
         WHERE e.account_id = 1 AND e.status = 'pending'
         ORDER BY e.created_at`,
    name ? loadCrewPage(sql, env.ENCRYPTION_KEY, name, url.searchParams.get('period'), st) : Promise.resolve(null),
    // Cleans held after a cancellation, waiting for a person (§123).
    sql`SELECT key, unit_name AS unit, checkout_on::text AS date, beds, deep, guest, needs_confirm AS note
          FROM cleanings WHERE account_id = 1 AND needs_confirm IS NOT NULL AND void_reason IS NULL
         ORDER BY checkout_on`
  ]);
  if (name && !page) return refuse(404, 'not_on_roster', `${name} is not on the roster.`);
  await attachFiles(sql, pending as { id: string }[]);
  // §137: purchases paid in the field, waiting for approval before they reach Costs.
  const fieldPending = await pendingFieldExpenses(sql);
  return Response.json({ ok: true, pending, fieldPending, page, schedule, toConfirm });
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
    // §137: approved, it is part of what the clean cost — in Costs at once.
    if (status === 'approved') await syncCleaningCosts(sql, who.email);
    return Response.json({ ok: true });
  }

  if (body.action === 'decideField') {
    const status = body.status;
    if (status !== 'approved' && status !== 'denied') return refuse(400, 'bad_request', 'Approve or deny.');
    if (status === 'denied' && !note) return refuse(400, 'bad_request', 'Say why it is denied — whoever paid reads the note.');
    try { await decideFieldExpense(sql, String(body.id ?? ''), status, note || null, who.email); }
    catch (e) { return refuse(409, 'already_decided', e instanceof Error ? e.message : String(e)); }
    return Response.json({ ok: true });
  }

  if (body.action === 'confirmClean' || body.action === 'editClean') {
    const key = String(body.key ?? '');
    const today = todayIn(TZ);
    // Older rows (the sheet's import) carry no bedroom count: the unit's own is the size the rate card is read at.
    const [row] = await sql`
      SELECT c.checkout_on::text AS date, c.deep, c.needs_confirm, c.price::float AS price,
             COALESCE(c.beds, (SELECT u.bedrooms FROM units u WHERE u.account_id = 1 AND (u.id = c.unit_id
                 OR lower(regexp_replace(u.name, '[^a-zA-Z0-9]', '', 'g')) = lower(regexp_replace(c.unit_name, '[^a-zA-Z0-9]', '', 'g')))
               LIMIT 1)) AS beds
        FROM cleanings c WHERE c.account_id = 1 AND c.key = ${key}` as
      { date: string; beds: number | null; deep: boolean; needs_confirm: string | null; price: number | null }[];
    if (!row) return refuse(404, 'not_found', 'That clean is not in the record.');
    const { roster } = await opsConfig(sql);
    const deep = typeof body.deep === 'boolean' ? body.deep : row.deep;

    if (body.action === 'confirmClean') {
      if (!row.needs_confirm) return refuse(409, 'already_settled', 'That clean was already settled — reload.');
      const cleaner = body.cleaner ? String(body.cleaner) : null;
      if (cleaner && !roster.some(c => c.name === cleaner)) return refuse(400, 'bad_request', `"${cleaner}" is not on the roster.`);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date ?? '')) ? String(body.date) : row.date;
      const price = cleaner ? rateFor(roster, cleaner, row.beds, deep) : null;
      await sql`UPDATE cleanings SET assignment = ${cleaner ? 'assigned' : 'not_needed'}, cleaner = ${cleaner}, price = ${price},
                       deep = ${deep}, beds = COALESCE(beds, ${row.beds}), checkout_on = ${date}, needs_confirm = NULL, confirmed_by = ${who.email}, confirmed_at = now(),
                       decided_by = ${`confirmed by ${who.email} (cancelled after arrival)`}, void_reason = NULL
                 WHERE account_id = 1 AND key = ${key}`;
      // Still ahead: the board keeps the same answer, as a person's choice.
      if (date >= today && !key.startsWith('MAN-')) {
        await sql`INSERT INTO turnover_overrides (account_id, reservation_id, assignment, cleaner, deep, updated_by)
                  VALUES (1, ${key}, ${cleaner ? 'assigned' : 'not_needed'}, ${cleaner}, ${deep}, ${who.email})
                  ON CONFLICT (account_id, reservation_id) DO UPDATE SET assignment = EXCLUDED.assignment, cleaner = EXCLUDED.cleaner,
                    deep = EXCLUDED.deep, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      }
      return Response.json({ ok: true, price });
    }

    // editClean: only the past — what is ahead is changed on the board, which owns it.
    if (row.date >= today) return refuse(400, 'bad_request', 'This clean is today or ahead — change it on the board (Movements).');
    if (!note) return refuse(400, 'bad_request', 'Say why it is corrected — the cleaner reads the note.');
    const [cur] = await sql`SELECT cleaner, assignment FROM cleanings WHERE account_id = 1 AND key = ${key}` as { cleaner: string | null; assignment: string }[];
    const typed = body.price === '' || body.price == null ? null : Number(body.price);
    if (typed !== null && !(typed >= 0)) return refuse(400, 'bad_request', 'The price is a number, or blank for the rate card.');
    const price = typed ?? (cur?.assignment === 'assigned' ? rateFor(roster, cur.cleaner, row.beds, deep) : null);
    // A correction never silently unpays a clean: no rate for the size means a typed price.
    if (price === null && cur?.assignment === 'assigned') {
      return refuse(400, 'bad_request', `There is no ${deep ? 'deep ' : ''}rate on ${cur.cleaner}'s card for this unit's size — type the price.`);
    }
    await sql`UPDATE cleanings SET deep = ${deep}, price = ${price}, edited_by = ${who.email}, edited_at = now(), edit_note = ${note}
               WHERE account_id = 1 AND key = ${key}`;
    return Response.json({ ok: true, price });
  }

  if (body.action === 'flag' || body.action === 'unflag') {
    const key = String(body.key ?? '');
    if (body.action === 'flag' && !note) return refuse(400, 'bad_request', 'A flag needs a note — it is what the cleaner reads.');
    // §128: the flag can correct the pay at the same time — only for a clean already due, and
    // kept as a correction (edited_*), which the board's record never overwrites.
    const fix = body.action === 'flag' && body.price !== undefined && body.price !== null && body.price !== '';
    if (fix) {
      const price = Number(body.price);
      if (!(price >= 0)) return refuse(400, 'bad_request', 'The pay is a number (0 or more).');
      const [row] = await sql`SELECT checkout_on::text AS date, assignment FROM cleanings WHERE account_id = 1 AND key = ${key}` as
        { date: string; assignment: string }[];
      if (!row) return refuse(404, 'not_found', 'That clean is not in the record.');
      if (row.date > todayIn(TZ)) return refuse(400, 'bad_request', 'The pay is corrected once the clean is due — today or after.');
      if (row.assignment !== 'assigned') return refuse(400, 'bad_request', 'Only a clean someone was assigned to has a pay to correct.');
      await sql`UPDATE cleanings SET price = ${price}, edited_by = ${who.email}, edited_at = now(), edit_note = ${note}
                 WHERE account_id = 1 AND key = ${key}`;
    }
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
