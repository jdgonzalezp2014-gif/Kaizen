/**
 * GET /api/operations?days=10[&refresh=1]
 *
 * The daily file's working surface — every arrival and departure in the
 * next N days, who cleans each one, what it pays, what needs inspecting —
 * without opening the sheet.
 *
 * Two sources, each for what it owns:
 *
 *   Hostaway       the stays themselves: dates, guest, value, the next
 *                  booking after each checkout. Live, like everywhere
 *                  else in this app.
 *   the daily file its DECISIONS: the cleaner, the price, deep or not,
 *                  the checkout time, the notes, the inspection log. Read
 *                  from its published logs, never re-derived — the tier
 *                  rule lives in the sheet and a second copy here would be
 *                  a second answer.
 *
 * Every source reports its own state. A tab that is not published and a
 * tab with nothing in it must not look the same on the board.
 */
import { fetchListings, fetchReservationsArriving } from '../_lib/hostaway.ts';
import { db, type Env } from '../_lib/db.ts';
import { getAccount, getCredentials, roleOf, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { importCleanings } from '../_lib/cleanings-import.ts';
import {
  DAILY_DEFAULTS, fetchPublishedCsv, latestNotes, parseDailySettings,
  parseInspectionLog, parseNotesLog,
  type DailySettings, type InspectionEntry, type NoteEntry
} from '../_lib/daily.ts';
import { addDays, todayIn } from '../../src/lib/dates.ts';
import {
  buildBoard, inspectionPanel, summarize, type OpsCleaning
} from '../../src/lib/operations.ts';

/** The daily file's own zone (its manifest), so "today" is the same day in both. */
const OPS_TZ = 'America/New_York';
/** How far past the window to look for each checkout's next booking. */
const NEXT_STAY_HORIZON = 120;
/** How far back an arrival can be and still check out inside the window. */
const STAY_LOOKBACK = 120;
/**
 * The Cleanings Log changes through the day — a cleaner swapped, a price
 * filled in — so the board re-reads it far sooner than the cost screen's
 * three hours. Google's own publish cache is about five minutes; going
 * below that would only re-read the same copy.
 */
const CLEANINGS_FRESH_MINUTES = 30;

interface SourceState {
  ok: boolean; configured: boolean; problem: string | null; rows?: number;
  /** Read fine, but the sheet itself needs a person's attention. */
  warning?: string | null;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const started = Date.now();
  const sql = db(env) as unknown as SqlFn;
  const account = await getAccount(sql);
  if (!account?.hasHostawayKey) {
    return Response.json({ ok: false, error: 'not_configured',
      message: 'Hostaway is not connected yet — an admin sets it up in Settings.' }, { status: 409 });
  }
  const role = await roleOf(sql, who);

  const url = new URL(request.url);
  const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days')) || 10));
  const today = todayIn(OPS_TZ);
  const end = addDays(today, days);

  // ── the Cleanings Log, refreshed first so the board reads today's copy
  const cleaningsSrc: SourceState = { ok: false, configured: !!account.cleaningsCsvUrl, problem: null };
  if (account.cleaningsCsvUrl) {
    try {
      const fresh = url.searchParams.get('refresh') === '1' ? [] : (await sql`
        SELECT 1 FROM cleanings WHERE account_id = 1
           AND imported_at > now() - make_interval(mins => ${CLEANINGS_FRESH_MINUTES}) LIMIT 1`);
      if (!fresh.length) {
        const r = await importCleanings(sql as never, account.cleaningsCsvUrl);
        cleaningsSrc.problem = r.problem;
        cleaningsSrc.warning = r.warning ?? null;
      }
      cleaningsSrc.ok = !cleaningsSrc.problem;
    } catch (e) {
      // The board is not the sheet's hostage: the last import still reads.
      cleaningsSrc.problem = e instanceof Error ? e.message : String(e);
    }
  } else {
    cleaningsSrc.problem = 'Cleanings Log not linked — Settings → Cleaning cost.';
  }

  // Where the wait goes, returned with the answer. A board that takes
  // twenty seconds should say which of its sources is the slow one.
  const timings: Record<string, number> = { sheetImport: Date.now() - started };
  const timed = <T,>(name: string, p: Promise<T>) => {
    const t0 = Date.now();
    return p.finally(() => { timings[name] = Date.now() - t0; });
  };
  const csv = (u: string | null) => u ? fetchPublishedCsv(u) : Promise.resolve(null);
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);

  let listings, reservations, notesCsv, inspCsv, settingsCsv;
  try {
    [listings, reservations, notesCsv, inspCsv, settingsCsv] = await Promise.all([
      timed('listings', fetchListings(creds)),
      // Arrivals from well before today, so a long stay that checks out
      // this week is still on the board; the daily file looks back the
      // same 120 days.
      timed('reservations', fetchReservationsArriving(creds, addDays(today, -STAY_LOOKBACK),
                                                        addDays(end, NEXT_STAY_HORIZON))),
      timed('notesLog', csv(account.dailyNotesCsvUrl)),
      timed('inspectionLog', csv(account.dailyInspectionsCsvUrl)),
      timed('settingsTab', csv(account.dailySettingsCsvUrl))
    ]);
  } catch (e) {
    return Response.json({ ok: false, error: 'hostaway',
      message: `Hostaway did not answer: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }

  // ── each log, with its own verdict
  const state = (read: Awaited<ReturnType<typeof csv>>, parsed: unknown[] | null, missing: string): SourceState =>
    !read ? { ok: false, configured: false, problem: missing }
      : !read.ok ? { ok: false, configured: true, problem: read.problem }
      : parsed === null ? { ok: false, configured: true,
          problem: 'Read, but the expected columns were not found — is this the right tab?' }
      : { ok: true, configured: true, problem: null, rows: parsed.length };

  const notes: NoteEntry[] | null = notesCsv?.ok ? parseNotesLog(notesCsv.text) : null;
  const insp = inspCsv?.ok ? parseInspectionLog(inspCsv.text, today) : null;
  const parsedSettings = settingsCsv?.ok ? parseDailySettings(settingsCsv.text) : null;
  const settings: DailySettings = parsedSettings ?? DAILY_DEFAULTS;

  const sources = {
    cleanings: cleaningsSrc,
    notes: state(notesCsv, notes, 'Notes Log not linked — Settings → Daily file.'),
    inspections: state(inspCsv, insp ? [...insp.done, ...insp.scheduled] : null,
                       'Inspection Log not linked — Settings → Daily file.'),
    settings: state(settingsCsv, parsedSettings ? [parsedSettings] : null,
                    'Settings tab not linked — using the sheet\'s built-in defaults.')
  };

  // ── the decisions the sheet made, for the checkouts on the board
  const outKeys = reservations
    .filter(r => r.departure >= today && r.departure <= end)
    .map(r => r.reservationId);
  const logRows = outKeys.length ? await sql`
    SELECT key, cleaner, assignment, price, deep, urgency, checkout_time, beds
      FROM cleanings WHERE account_id = 1 AND key = ANY(${outKeys}::text[])` : [];
  const cleanings = new Map<string, OpsCleaning>(
    (logRows as Record<string, any>[]).map(r => [String(r.key), {
      cleaner: r.cleaner, assignment: r.assignment,
      price: r.price == null ? null : Number(r.price), deep: !!r.deep,
      urgency: r.urgency, checkoutTime: r.checkout_time, beds: r.beds
    }]));

  const opsListings = listings.map(l => ({
    id: l.listingId, name: l.name, bedrooms: l.bedrooms, active: l.active
  }));
  // No log, no panel: every unit would read "never inspected", which is
  // a claim about the units made from no evidence at all.
  const panel = insp
    ? inspectionPanel(opsListings, reservations, insp.done, insp.scheduled, today, settings)
    : [];
  const rows = buildBoard({
    today, windowDays: days, listings: opsListings, reservations, cleanings,
    notes: latestNotes(notes ?? []), inspections: panel, rules: settings,
    inspectionLogRead: !!insp
  });
  const summary = summarize(rows);

  // ── what an ops member may see
  //
  // Booking values are what the portfolio EARNS, which the ops role
  // exists not to show (§49). What a clean pays stays: it is cost data
  // they already record. The inspection still fires on a big booking —
  // it just says so without the figure.
  if (role === 'ops') {
    for (const r of rows) {
      r.total = 0;
      if (r.next) r.next.total = null;
      if (r.inspection.key === 'req') {
        r.inspection.reason = 'The next booking is a high-value stay. Inspect at this turnover, before that guest arrives.';
      }
    }
    for (const p of panel) if (p.nextBig) p.nextBig.total = 0;
    summary.arriving = 0;
    summary.pipeline = 0;
  }

  // Newest first, bounded: a log is read from the top.
  const noteLog = (notes ?? []).slice(-400).reverse();
  const inspectionLog: { done: InspectionEntry[]; scheduled: InspectionEntry[] } =
    { done: (insp?.done ?? []).slice(0, 200), scheduled: insp?.scheduled ?? [] };

  return Response.json({
    ok: true, role, today, end, days, timeZone: OPS_TZ,
    sheetUrl: account.cleaningsSheetUrl,
    showMoney: role === 'admin',
    rows, summary, panel, noteLog, inspectionLog,
    settings, sources,
    tookMs: Date.now() - started, timings
  });
};
