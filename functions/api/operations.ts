/**
 * GET /api/operations?days=10[&refresh=1]
 *
 * The operations board: every arrival and departure in the next N days,
 * who cleans each one and why, what it pays, what needs inspecting — the
 * work the daily file used to do, decided here (functions/_lib/ops.ts).
 *
 * In shadow mode the sheet's own decisions ride along on every row, so
 * the two can be compared before Kaizen takes over. In live mode the
 * cleanings record is written on the way out, so the cost screens see
 * the same decisions the board shows.
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, getAccount, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { can } from '../_lib/roles.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { loadOps, recordCleanings, trimForOps, OPS_TZ } from '../_lib/ops.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;
  const account = await getAccount(sql);
  if (!account?.hasHostawayKey) {
    return Response.json({ ok: false, error: 'not_configured',
      message: 'Hostaway is not connected yet — an admin sets it up in Settings.' }, { status: 409 });
  }
  const access = await accessOf(sql, who);
  const showMoney = can(access.permissions, 'money');
  const url = new URL(request.url);

  let s;
  try {
    s = await loadOps(sql, await getCredentials(sql, env.ENCRYPTION_KEY), {
      days: Number(url.searchParams.get('days')) || 10,
      cleaningsCsvUrl: account.cleaningsCsvUrl,
      refreshSheet: url.searchParams.get('refresh') === '1'
    });
  } catch (e) {
    return Response.json({ ok: false, error: 'hostaway',
      message: `Could not build the board: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }

  let recorded: number | null = null;
  if (s.mode === 'live') {
    try { recorded = await recordCleanings(sql, s); } catch { /* the board still reads */ }
  }

  // Newest first, bounded: a log is read from the top.
  const [noteLog, pushes] = await Promise.all([
    sql`SELECT n.reservation_id AS "resId", n.kind, n.unit_name AS unit, n.guest,
               n.check_in::text AS "checkIn", n.notes, n.source, n.created_by AS "by",
               to_char(n.created_at AT TIME ZONE ${OPS_TZ}, 'YYYY-MM-DD HH24:MI') AS "loggedAt"
          FROM stay_notes n WHERE n.account_id = 1 ORDER BY n.id DESC LIMIT 400`,
    sql`SELECT reservation_id AS "resId", outcome, detail,
               to_char(at AT TIME ZONE ${OPS_TZ}, 'YYYY-MM-DD HH24:MI') AS at
          FROM host_note_pushes WHERE account_id = 1 ORDER BY id DESC LIMIT 60`
  ]);

  // Booking values are what the portfolio earns (§49): only for roles that hold `money`.
  if (!showMoney) trimForOps(s);

  return Response.json({
    ok: true, role: access.role, permissions: access.permissions, mode: s.mode, today: s.today, end: s.end, days: s.days, timeZone: OPS_TZ,
    lookaheadTo: s.lookaheadTo,
    sheetUrl: account.cleaningsSheetUrl, showMoney,
    rows: s.rows, summary: s.summary, panel: s.panel,
    inspectionLog: { done: s.inspections.done.slice(0, 200), scheduled: s.inspections.scheduled },
    noteLog, pushes,
    rules: s.rules, extraInspectors: s.extraInspectors, guestDocUnits: s.guestDocUnits,
    // Pay per size is cost data ops already record; names and tiers are
    // what the edit menus need.
    roster: s.roster,
    sheet: s.sheet, recorded,
    tookMs: s.timings.total, timings: s.timings
  });
};
