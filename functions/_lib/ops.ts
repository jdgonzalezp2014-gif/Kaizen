/**
 * Operations, server side: load everything the board needs, build it,
 * and — once Kaizen is the one deciding — record and push the result.
 *
 * One implementation for the screen, the edit routes and the scheduled
 * pass. Three copies of "what does the board say" would be three answers
 * the first time one of them was changed.
 *
 * Two modes (`accounts.ops_mode`):
 *
 *   shadow  the daily file still decides and still writes to Hostaway.
 *           Kaizen computes its own decisions and shows them beside the
 *           sheet's; it writes nothing outside its own tables.
 *   live    Kaizen decides, writes the cleanings record, and pushes the
 *           Host Note. The sheet's import is no longer read, so the two
 *           never write the same key.
 */
import { fetchCancelledTouching, fetchListings, fetchReservationDetail, fetchReservationsTouching, fetchHostNote, writeHostNote,
         reservationCounts,
         type HostawayCredentials } from './hostaway.ts';
import { importCleanings } from './cleanings-import.ts';
import type { SqlFn } from './accounts.ts';
import { addDays, todayIn } from '../../src/lib/dates.ts';
import {
  blockForReservation, buildBoard, cancelledClean, inspectionPanel, mergeHostNote, rebookedAs, summarize, utcToLocal, withDefaults,
  type AssignRule, type BoardRow, type Cleaner, type OpsCleaning, type OpsInspection, type OpsRules, type Override
} from '../../src/lib/operations.ts';

/** The daily file's own zone (its manifest), so "today" is the same day in both. */
export const OPS_TZ = 'America/New_York';
/**
 * How far past the board the next booking is looked for. Every rule that
 * reads the next stay fits inside it — the value horizon (10 days), a long
 * vacancy (7), a big booking forcing an inspection (45) — and a unit with
 * nothing inside it says "nothing booked through <date>", never a flat
 * "nothing booked" it has not checked.
 */
export const NEXT_STAY_LOOKAHEAD = 45;
const SHEET_FRESH_MINUTES = 30;

export type OpsMode = 'shadow' | 'live';

export async function opsConfig(sql: SqlFn): Promise<{
  mode: OpsMode; rules: OpsRules; extraInspectors: string[]; roster: Cleaner[];
  /** Units whose guests must have an ID and agreement on file (§73), by listing ID. */
  guestDocUnits: string[];
  /** Which rule decides who cleans (§121). */
  assignRule: AssignRule;
  /** Cleaners see what is coming on their page (§122), this many days ahead. */
  crewCalendar: boolean; crewCalendarDays: number;
  /** Unpublished, the rule's picks show on a cleaner's page this many days ahead (§127). */
  crewAutoDays: number;
}> {
  const [acc, roster] = await Promise.all([
    sql`SELECT ops_mode, ops_rules, extra_inspectors, guest_docs_units, assign_rule, crew_calendar, crew_calendar_days, crew_auto_days
          FROM accounts WHERE id = 1`,
    sql`SELECT name, tier, position, rates, deep_rates, active, stars, level, zones, max_per_day, email, invoice_period, lang,
               link_token_hash IS NOT NULL AS has_link FROM cleaners
         WHERE account_id = 1 ORDER BY tier, position, name`
  ]) as [{ ops_mode: OpsMode; ops_rules: Record<string, unknown>; extra_inspectors: string[]; guest_docs_units: string[];
           assign_rule: string; crew_calendar: boolean; crew_calendar_days: number; crew_auto_days: number }[],
         { name: string; tier: Cleaner['tier']; position: number; rates: Record<string, number | null>;
           deep_rates: Record<string, number | null>; active: boolean; stars: number; level: Cleaner['level']; zones: string[];
           max_per_day: number | null; email: string | null; invoice_period: 'weekly' | 'monthly'; has_link: boolean; lang: 'en' | 'es' }[]];
  return {
    mode: acc[0]?.ops_mode === 'live' ? 'live' : 'shadow',
    rules: withDefaults(acc[0]?.ops_rules),
    extraInspectors: acc[0]?.extra_inspectors ?? [],
    guestDocUnits: acc[0]?.guest_docs_units ?? [],
    assignRule: acc[0]?.assign_rule === 'levels' ? 'levels' : acc[0]?.assign_rule === 'stars' ? 'stars' : 'tiers',
    crewCalendar: !!acc[0]?.crew_calendar, crewCalendarDays: Number(acc[0]?.crew_calendar_days) || 14,
    crewAutoDays: Number(acc[0]?.crew_auto_days ?? 4),
    roster: roster.map(c => ({ name: c.name, tier: c.tier, position: c.position,
      rates: c.rates ?? {}, deepRates: c.deep_rates ?? {}, active: c.active,
      stars: Number(c.stars) || 1, level: c.level ?? 'standard', zones: c.zones ?? [], maxPerDay: c.max_per_day == null ? null : Number(c.max_per_day),
      email: c.email, invoicePeriod: c.invoice_period, hasLink: c.has_link, lang: c.lang ?? 'en' }))
  };
}

export async function inspectionLog(sql: SqlFn): Promise<{
  done: (OpsInspection & { id: string; reservationId: string | null; started: boolean; checklist: boolean; sentBy: string | null })[];
  scheduled: (OpsInspection & { id: string; reservationId: string | null; started: boolean; checklist: boolean; sentBy: string | null })[];
}> {
  const rows = await sql`
    SELECT i.id, i.unit_name, i.inspected_on::text AS date, i.inspector, i.result, i.notes, i.reservation_id,
           i.started_at IS NOT NULL AS started, CASE WHEN i.sent_at IS NOT NULL THEN i.sent_by END AS sent_by,
           EXISTS (SELECT 1 FROM inspection_checks c WHERE c.account_id = 1 AND c.inspection_id = i.id) AS checklist
      FROM inspections i WHERE i.account_id = 1 ORDER BY i.inspected_on DESC, i.id DESC LIMIT 2000` as
    { id: string; unit_name: string; date: string; inspector: string | null; result: string | null;
      notes: string | null; reservation_id: string | null; started: boolean; checklist: boolean; sent_by: string | null }[];
  // `sentBy`: sent from the inspector's link, waiting for the team's review (§135).
  // `started`: walked as a checklist and not finished (§133); `checklist`: has a checklist report to open.
  const map = (r: typeof rows[number]) => ({ id: String(r.id), date: r.date, unit: r.unit_name,
    by: r.inspector ?? '', result: r.result ?? '', notes: r.notes ?? '', reservationId: r.reservation_id,
    started: !!r.started, checklist: !!r.checklist, sentBy: r.sent_by });
  return {
    done: rows.filter(r => r.result).map(map),
    // A row with no result is a plan, and a plan must never reset the
    // "days since" clock.
    scheduled: rows.filter(r => !r.result).map(map).reverse()
  };
}

export interface OpsState {
  mode: OpsMode;
  today: string; end: string; days: number;
  rules: OpsRules; roster: Cleaner[]; extraInspectors: string[];
  guestDocUnits: string[];
  assignRule: AssignRule;
  rows: BoardRow[];
  /** What the board was built from — so Setup can rebuild it under a proposed roster and rules. */
  boardInput: Parameters<typeof buildBoard>[0];
  summary: ReturnType<typeof summarize>;
  panel: ReturnType<typeof inspectionPanel>;
  inspections: Awaited<ReturnType<typeof inspectionLog>>;
  reservations: Awaited<ReturnType<typeof fetchReservationsTouching>>;
  /** The last day the next booking was looked for. */
  lookaheadTo: string;
  /** Who made each override, for the record's `decided_by`. */
  overrideBy: Map<string, string>;
  sheet: { ok: boolean; problem: string | null; warning: string | null } | null;
  timings: Record<string, number>;
  /** One reservation as Hostaway has it now — for a recorded clean that left the board's window (recordCleanings). */
  lookup?: (reservationId: string) => Promise<Record<string, unknown> | null>;
}

export async function loadOps(sql: SqlFn, creds: HostawayCredentials, opts: {
  days?: number; cleaningsCsvUrl?: string | null; refreshSheet?: boolean;
} = {}): Promise<OpsState> {
  const started = Date.now();
  const timings: Record<string, number> = {};
  const timed = <T,>(name: string, p: Promise<T>) => {
    const t0 = Date.now();
    return p.finally(() => { timings[name] = Date.now() - t0; });
  };

  const days = Math.max(1, Math.min(30, opts.days ?? 10));
  const today = todayIn(OPS_TZ);
  const end = addDays(today, days);
  const cfg = await opsConfig(sql);

  // Shadow only: the sheet's decisions, freshly read, to compare against.
  let sheet: OpsState['sheet'] = null;
  if (cfg.mode === 'shadow' && opts.cleaningsCsvUrl) {
    sheet = { ok: true, problem: null, warning: null };
    try {
      const fresh = opts.refreshSheet ? [] : await sql`
        SELECT 1 FROM cleanings WHERE account_id = 1 AND source = 'sheet'
           AND imported_at > now() - make_interval(mins => ${SHEET_FRESH_MINUTES}) LIMIT 1`;
      if (!fresh.length) {
        const r = await timed('sheetImport', importCleanings(sql as never, opts.cleaningsCsvUrl));
        sheet = { ok: r.ok, problem: r.problem, warning: r.warning ?? null };
      }
    } catch (e) {
      sheet = { ok: false, problem: e instanceof Error ? e.message : String(e), warning: null };
    }
  }

  const [listings, reservations, inspections, overrideRows, noteRows, declineRows, cancelledRaw, midRows, carryRows] = await Promise.all([
    timed('listings', fetchListings(creds)),
    // One live question: every stay still in the building today or
    // arriving before the look-ahead ends. Stays that began months ago but
    // check out this week are included by construction.
    timed('reservations', fetchReservationsTouching(creds, today, addDays(end, NEXT_STAY_LOOKAHEAD))),
    inspectionLog(sql),
    sql`SELECT reservation_id, assignment, cleaner, deep, checkout_time, checkin_time, updated_by
          FROM turnover_overrides WHERE account_id = 1`,
    // The current note per stay and end: the latest row, including a
    // blank one — a cleared note is the current note.
    sql`SELECT DISTINCT ON (reservation_id, kind) reservation_id, kind, notes
          FROM stay_notes WHERE account_id = 1
         ORDER BY reservation_id, kind, id DESC`,
    // Cleans a cleaner turned down on their page (§122), still ahead.
    sql`SELECT cleaning_key, cleaner, reason FROM crew_declines
         WHERE account_id = 1 AND clean_on >= ${today}::date ORDER BY id`,
    // Bookings cancelled while the guest may have been in (§123): their clean waits for a person.
    timed('cancelled', fetchCancelledTouching(creds, today, end)),
    // Mid-stay cleans (§79), which lighten a long stay's checkout under the levels rule (§125).
    sql`SELECT unit_id, checkout_on::text AS day FROM cleanings
         WHERE account_id = 1 AND kind = 'mid_stay' AND assignment = 'assigned' AND void_reason IS NULL
           AND unit_id IS NOT NULL AND checkout_on >= ${today}::date - 60 AND checkout_on <= ${end}::date`,
    // §131: who the rule gave the clean before each coming guest — kept if a booking lands in between.
    sql`SELECT key, cleaner, prepares_for FROM cleanings
         WHERE account_id = 1 AND prepares_for IS NOT NULL AND assignment = 'assigned' AND cleaner IS NOT NULL
           AND void_reason IS NULL AND decided_by LIKE 'rule%' AND checkout_on >= ${today}::date`
  ]) as [Awaited<ReturnType<typeof fetchListings>>, Awaited<ReturnType<typeof fetchReservationsTouching>>,
         Awaited<ReturnType<typeof inspectionLog>>,
         { reservation_id: string; assignment: Override['assignment']; cleaner: string | null;
           deep: boolean | null; checkout_time: string | null; checkin_time: string | null; updated_by: string }[],
         { reservation_id: string; kind: string; notes: string }[],
         { cleaning_key: string; cleaner: string; reason: string | null }[],
         Awaited<ReturnType<typeof fetchCancelledTouching>>,
         { unit_id: string; day: string }[],
         { key: string; cleaner: string; prepares_for: string }[]];

  const overrides = new Map<string, Override>(overrideRows.map(o => [o.reservation_id, {
    assignment: o.assignment, cleaner: o.cleaner, deep: o.deep,
    checkoutTime: o.checkout_time, checkinTime: o.checkin_time }]));
  const notes = new Map(noteRows.map(n => [`${n.reservation_id}|${n.kind}`, n.notes]));
  const overrideBy = new Map(overrideRows.map(o => [o.reservation_id, o.updated_by]));
  const midStays = new Map<string, string[]>();
  for (const m of midRows) midStays.set(m.unit_id, [...(midStays.get(m.unit_id) ?? []), m.day]);
  const declines = new Map<string, { cleaner: string; reason: string | null }[]>();
  for (const d of declineRows) declines.set(d.cleaning_key, [...(declines.get(d.cleaning_key) ?? []), { cleaner: d.cleaner, reason: d.reason }]);

  let sheetMap: Map<string, OpsCleaning> | null = null;
  if (cfg.mode === 'shadow') {
    const keys = reservations.filter(r => r.departure >= today && r.departure <= end).map(r => r.reservationId);
    const rows = keys.length ? await sql`
      SELECT key, cleaner, assignment, price, deep, urgency, checkout_time, beds
        FROM cleanings WHERE account_id = 1 AND source = 'sheet' AND key = ANY(${keys}::text[])` : [];
    sheetMap = new Map((rows as Record<string, any>[]).map(r => [String(r.key), {
      cleaner: r.cleaner, assignment: r.assignment, price: r.price == null ? null : Number(r.price),
      deep: !!r.deep, urgency: r.urgency, checkoutTime: r.checkout_time, beds: r.beds }]));
  }

  const opsListings = listings.map(l => ({ id: l.listingId, name: l.name, bedrooms: l.bedrooms, active: l.active,
                                            checkInHour: l.checkInHour, checkOutHour: l.checkOutHour }));
  const panel = inspectionPanel(opsListings, reservations, inspections.done, inspections.scheduled, today, cfg.rules);
  const boardInput: Parameters<typeof buildBoard>[0] = {
    today, windowDays: days, listings: opsListings, reservations, roster: cfg.roster, rules: cfg.rules,
    overrides, notes, inspections: panel, sheet: sheetMap, assignRule: cfg.assignRule, declines,
    cancelled: cancelledRaw.map(r => ({ ...r, cancelledAt: utcToLocal(r.cancellationDate, OPS_TZ) })), midStays,
    carry: new Map(carryRows.map(c => [c.prepares_for, { cleaner: c.cleaner, from: c.key }])),
    // With no inspection ever recorded here, "never inspected" would be a
    // claim about every unit made from no evidence (§63).
    inspectionLogRead: inspections.done.length + inspections.scheduled.length > 0
  };
  const rows = buildBoard(boardInput);
  // A pay corrected by a person on a clean already due (§128) is what it pays — on the board too,
  // while the same cleaner holds it (recordCleanings keeps it on the same terms).
  const fixes = await sql`SELECT key, cleaner, price::float AS price, deep FROM cleanings
                           WHERE account_id = 1 AND edited_by IS NOT NULL AND checkout_on >= ${today}::date AND checkout_on <= ${end}::date` as
    { key: string; cleaner: string | null; price: number | null; deep: boolean }[];
  for (const f of fixes) {
    const r = rows.find(x => x.kind === 'out' && x.resId === f.key);
    if (r && r.assignment === 'assigned' && r.cleaner === f.cleaner) { r.price = f.price; r.deep = f.deep; }
  }
  // Owner, 2026-10-17: the cleaner confirmed it on their page — the same cleaner, the same day.
  const accepts = await sql`SELECT cleaning_key AS key, cleaner, clean_on::text AS day, created_at AS at FROM crew_accepts
                             WHERE account_id = 1 AND clean_on >= ${today}::date` as { key: string; cleaner: string; day: string; at: string }[];
  for (const a of accepts) {
    const r = rows.find(x => x.kind === 'out' && x.resId === a.key);
    if (r && r.assignment === 'assigned' && r.cleaner === a.cleaner && r.date === a.day) r.confirmed = a.at;
  }
  timings.total = Date.now() - started;

  return { mode: cfg.mode, today, end, days, rules: cfg.rules, roster: cfg.roster, assignRule: cfg.assignRule, boardInput,
           extraInspectors: cfg.extraInspectors, guestDocUnits: cfg.guestDocUnits, rows, summary: summarize(rows), panel,
           inspections, reservations, sheet, timings, lookaheadTo: addDays(end, NEXT_STAY_LOOKAHEAD), overrideBy,
           lookup: id => fetchReservationDetail(creds, id) };
}

/* ── live mode: the record and the push ───────────────────────────── */

const URGENCY_LABEL: Record<string, string> = { turnover: '⚡', same_guest: '🔁', no_next: '⏳' };

/**
 * The cleanings record for every checkout on the board — what the
 * Cleanings Log was, and what cleaners are paid from (§70). Four rules:
 *
 *   · One row per reservation, upserted: a changed cleaner corrects the
 *     row rather than adding one.
 *   · THE PAST IS FROZEN. A row whose checkout has passed is never
 *     rewritten here — a rate changed today must not reprice a clean done
 *     last week.
 *   · Nothing is deleted. A stay that no longer checks out in the window
 *     is either MOVED (its new date is recorded) or gone from Hostaway —
 *     then it is excluded (`void_reason`), still visible, never paid, and
 *     counted again if the booking comes back.
 *   · Every row says who decided it: the rule, a person, or the sheet.
 */
export async function recordCleanings(sql: SqlFn, s: OpsState): Promise<number> {
  const outs = s.rows.filter(r => r.kind === 'out');
  const decidedBy = (r: BoardRow) => r.manual.cleaner ? `override:${s.overrideBy.get(r.resId) ?? 'someone'}`
    : r.cancelled ? 'cancelled after arrival — to confirm'
    : r.carried ? `rule:carried from ${r.carried.from} — a booking came in between`
    : r.sameDayOf ? `rule: one clean per unit per day (${r.sameDayOf})` : s.assignRule === 'levels' ? 'rule:levels' : s.assignRule === 'stars' ? 'rule:stars' : 'rule';
  // §123: a stay cancelled after arrival is unpaid until a person settles it; a person's choice on the board settles it.
  const toConfirm = (r: BoardRow) => r.cancelled && !r.manual.cleaner
    ? `Cancelled ${r.cancelled} (New York), on or after the arrival — was the unit used, and who cleaned it?` : null;
  const settledBy = (r: BoardRow) => r.cancelled && r.manual.cleaner ? (s.overrideBy.get(r.resId) ?? 'someone') : null;
  if (outs.length) {
    await sql`
      INSERT INTO cleanings (account_id, key, unit_id, unit_name, checkout_on, cleaner, assignment,
                             guest, price, deep, urgency, checkout_time, beds, source, decided_by, needs_confirm, confirmed_by, prepares_for)
      SELECT 1, k, u, n, d, c, a, g, p, dp, ug, tm, bd, 'kaizen', db, nc, cb, pf
        FROM unnest(${outs.map(r => r.resId)}::text[], ${outs.map(r => r.unitId)}::text[],
                    ${outs.map(r => r.unit)}::text[], ${outs.map(r => r.date)}::date[],
                    ${outs.map(r => r.cleaner)}::text[], ${outs.map(r => r.assignment === 'unknown' ? 'tbd' : r.assignment)}::text[],
                    ${outs.map(r => r.guest || null)}::text[], ${outs.map(r => r.price)}::numeric[],
                    ${outs.map(r => r.deep)}::boolean[], ${outs.map(r => (r.urgency && URGENCY_LABEL[r.urgency]) || null)}::text[],
                    ${outs.map(r => r.time)}::text[], ${outs.map(r => r.beds)}::smallint[], ${outs.map(decidedBy)}::text[],
                    ${outs.map(toConfirm)}::text[], ${outs.map(settledBy)}::text[], ${outs.map(r => r.next?.resId ?? null)}::text[])
             AS t(k, u, n, d, c, a, g, p, dp, ug, tm, bd, db, nc, cb, pf)
      ON CONFLICT (account_id, key) DO UPDATE SET
        unit_id = EXCLUDED.unit_id, unit_name = EXCLUDED.unit_name, checkout_on = EXCLUDED.checkout_on,
        cleaner = EXCLUDED.cleaner, assignment = EXCLUDED.assignment, guest = EXCLUDED.guest,
        -- A pay corrected by a person (§128) stands while the same cleaner holds the clean.
        price = CASE WHEN cleanings.edited_by IS NOT NULL AND cleanings.cleaner IS NOT DISTINCT FROM EXCLUDED.cleaner
                     THEN cleanings.price ELSE EXCLUDED.price END,
        deep = CASE WHEN cleanings.edited_by IS NOT NULL AND cleanings.cleaner IS NOT DISTINCT FROM EXCLUDED.cleaner
                    THEN cleanings.deep ELSE EXCLUDED.deep END,
        urgency = EXCLUDED.urgency,
        checkout_time = EXCLUDED.checkout_time, beds = EXCLUDED.beds, source = 'kaizen',
        decided_by = EXCLUDED.decided_by, void_reason = NULL, imported_at = now(),
        needs_confirm = EXCLUDED.needs_confirm, prepares_for = EXCLUDED.prepares_for,
        confirmed_by = COALESCE(EXCLUDED.confirmed_by, cleanings.confirmed_by),
        confirmed_at = CASE WHEN EXCLUDED.confirmed_by IS NOT NULL AND cleanings.confirmed_by IS NULL THEN now() ELSE cleanings.confirmed_at END
      WHERE cleanings.checkout_on >= ${s.today}::date`;
  }

  // Rows in the window whose reservation is not checking out in it.
  const onBoard = outs.map(r => r.resId);
  const stale = await sql`
    SELECT key FROM cleanings WHERE account_id = 1 AND key ~ '^[0-9]+$' AND void_reason IS NULL
       AND checkout_on >= ${s.today}::date AND checkout_on <= ${s.end}::date
       AND NOT (key = ANY(${onBoard}::text[]))` as { key: string }[];
  const known = new Map(s.reservations.map(r => [r.reservationId, r]));
  const cancelled = new Map((s.boardInput.cancelled ?? []).map(r => [r.reservationId, r]));
  for (const { key } of stale) {
    const moved = known.get(key);
    // Cancelled mid-stay, its clean proposed before today: held for a person, not voided (§123) —
    // unless the guest booked again, which is a change (§126).
    const fate = !moved ? cancelledFate(cancelled.get(key) as never, s.reservations) : null;
    if (fate && 'rebooked' in fate) {
      await releaseRebooked(sql, key, fate.rebooked);
    } else if (fate) {
      await holdForConfirm(sql, key, fate.date, fate.at);
    } else if (moved) {
      // Extended or shortened: the clean moves with the checkout.
      await sql`UPDATE cleanings SET checkout_on = ${moved.departure}, imported_at = now()
                 WHERE account_id = 1 AND key = ${key}`;
    } else {
      await settleGone(sql, key, s.lookup);
    }
  }
  await refreshCleaningRates(sql);
  return outs.length;
}

/**
 * A recorded clean whose booking was cancelled on or after its arrival
 * (§123): unpaid and unassigned until a person confirms it, moved to the
 * proposed day, and saying whose it was. Never touches a row a person has
 * already settled, and does nothing to a row already waiting.
 */
async function holdForConfirm(sql: SqlFn, key: string, date: string, cancelledLocal: string): Promise<boolean> {
  const done = await sql`
    UPDATE cleanings SET
      needs_confirm = ${`Cancelled ${cancelledLocal} (New York), on or after the arrival — was the unit used, and who cleaned it?`}
                      -- whose it was: the cleaner on it, or the one a void before arrival noted (§130)
                      || COALESCE(' It was ' || cleaner || '''s clean.',
                                  ' It was ' || substring(decided_by from ' — it was (.+)''s$') || '''s clean.', ''),
      assignment = 'tbd', cleaner = NULL, price = NULL, void_reason = NULL, checkout_on = ${date},
      decided_by = 'cancelled after arrival — to confirm', imported_at = now()
     WHERE account_id = 1 AND key = ${key} AND confirmed_by IS NULL AND needs_confirm IS NULL
    RETURNING key`;
  return done.length > 0;
}

/**
 * What a cancelled booking means for its clean: booked again by the same
 * guest (a change, §126) — the live booking owns the clean; cancelled on
 * or after arrival — held for a person, with its day; otherwise nothing.
 */
type CancelledStay = Awaited<ReturnType<typeof fetchCancelledTouching>>[number];
function cancelledFate(c: CancelledStay | undefined, active: Awaited<ReturnType<typeof fetchReservationsTouching>>):
  { rebooked: string } | { date: string; at: string } | null {
  if (!c) return null;
  const as = rebookedAs(c, active);
  if (as) return { rebooked: as };
  const at = utcToLocal(c.cancellationDate, OPS_TZ);
  const date = cancelledClean(c.arrival, c.departure, at);
  return date && at ? { date, at } : null;
}

/**
 * A recorded clean whose stay is neither on the board nor in its cancelled
 * list — the board only sees from today on, so "gone" may be a stay SHORTENED
 * into the past, or CANCELLED after arrival with its checkout already behind
 * us. Both used to be voided as "cancelled before arrival" (owner, 2026-10-16:
 * a cancellation after check-in must never be lost). Hostaway is asked what
 * the reservation is now: a confirmed stay moves its clean; a cancelled one
 * follows §123 on its own dates; a request never confirmed (Vrbo's request
 * to book, an inquiry) had no stay. No answer at all: voided, as before.
 */
async function settleGone(sql: SqlFn, key: string, lookup: OpsState['lookup']): Promise<void> {
  const d = lookup ? await lookup(key).catch(() => null) : null;
  const status = String(d?.status ?? '');
  const arrival = String(d?.arrivalDate ?? '').slice(0, 10), departure = String(d?.departureDate ?? '').slice(0, 10);
  if (!d || !arrival || !departure) return voidCancelled(sql, key);
  if (reservationCounts(status)) {
    await sql`UPDATE cleanings SET checkout_on = ${departure}, imported_at = now() WHERE account_id = 1 AND key = ${key}`;
  } else if (status.toLowerCase() === 'cancelled') {
    const at = utcToLocal(d.cancellationDate ? String(d.cancellationDate) : null, OPS_TZ);
    const date = cancelledClean(arrival, departure, at);
    if (date && at) await holdForConfirm(sql, key, date, at);
    else await voidCancelled(sql, key);
  } else {
    await voidCancelled(sql, key, `booking request not confirmed in Hostaway (${status})`);
  }
}

/**
 * A booking cancelled before its guest arrived (§130): no clean, and nobody
 * on it — a cleaner's name on a cancelled stay reads as work still to do.
 * Who had it stays in decided_by; the reason in void_reason.
 */
async function voidCancelled(sql: SqlFn, key: string, reason = 'booking cancelled in Hostaway'): Promise<void> {
  const before = reason === 'booking cancelled in Hostaway' ? 'cancelled before arrival' : 'never confirmed';
  await sql`UPDATE cleanings SET void_reason = ${reason}, assignment = 'not_needed',
                   decided_by = ${before} || COALESCE(' — it was ' || cleaner || '''s', ''),
                   cleaner = NULL, price = NULL, imported_at = now()
             WHERE account_id = 1 AND key = ${key}`;
}

/** A clean held (or recorded) for a booking that was in fact changed, not cancelled: released, never paid twice. */
async function releaseRebooked(sql: SqlFn, key: string, as: string): Promise<boolean> {
  const done = await sql`
    UPDATE cleanings SET needs_confirm = NULL, assignment = 'not_needed', cleaner = NULL, price = NULL,
           void_reason = ${`booking changed — the guest booked again as reservation ${as}, which carries the clean`},
           decided_by = 'rebooked, not cancelled', imported_at = now()
     WHERE account_id = 1 AND key = ${key} AND confirmed_by IS NULL
       AND (void_reason IS DISTINCT FROM ${`booking changed — the guest booked again as reservation ${as}, which carries the clean`})
    RETURNING key`;
  return done.length > 0;
}

/**
 * The recent past, checked against Hostaway: rows already recorded for
 * the last `days` days whose booking was cancelled, whose checkout moved,
 * or which share their unit and day with another row. Run by the daily
 * pass — the board only ever looks forward from today, so without this a
 * booking cancelled the day before its checkout stays "paid" forever.
 */
export async function reconcileRecent(sql: SqlFn, creds: HostawayCredentials, today: string, days = 45) {
  const from = addDays(today, -days);
  const [rows, stays, cancelledStays] = await Promise.all([
    sql`SELECT key, unit_id, checkout_on::text AS day, void_reason, confirmed_by, needs_confirm FROM cleanings
         WHERE account_id = 1 AND key ~ '^[0-9]+$' AND checkout_on >= ${from}::date AND checkout_on < ${today}::date` as
      Promise<{ key: string; unit_id: string | null; day: string; void_reason: string | null;
                confirmed_by: string | null; needs_confirm: string | null }[]>,
    fetchReservationsTouching(creds, from, today),
    fetchCancelledTouching(creds, from, today)
  ]);
  const byId = new Map(stays.map(r => [r.reservationId, r]));
  const cancelledById = new Map(cancelledStays.map(r => [r.reservationId, r]));
  const out = { cancelled: 0, moved: 0, restored: 0, sameDay: 0, toConfirm: 0, rebooked: 0 };

  for (const r of rows) {
    const stay = byId.get(r.key);
    if (!stay) {
      // A person already settled it (§123): their word stands.
      if (r.confirmed_by) continue;
      const fate = cancelledFate(cancelledById.get(r.key), stays);
      // The guest booked again (§126): a change, not a cancellation — released even if it was held.
      if (fate && 'rebooked' in fate) {
        if (await releaseRebooked(sql, r.key, fate.rebooked)) out.rebooked++;
        continue;
      }
      if (r.needs_confirm) continue;
      // Cancelled on or after arrival: maybe used — held for a person, not voided.
      if (fate) {
        if (await holdForConfirm(sql, r.key, fate.date, fate.at)) out.toConfirm++;
        continue;
      }
      if (!r.void_reason) {
        await voidCancelled(sql, r.key);
        out.cancelled++;
      }
    } else {
      if (r.void_reason === 'booking cancelled in Hostaway' || r.void_reason?.startsWith('booking request not confirmed')) {
        // The booking came back — or was only shortened, which the board once took for a cancellation:
        // a clean again, back to whoever had it (the void kept the name in decided_by, owner 2026-10-16);
        // nobody noted → unassigned. Unpriced either way: a person sets the pay (§128).
        await sql`UPDATE cleanings SET void_reason = NULL,
                         cleaner = COALESCE(cleaner, substring(decided_by from ' — it was (.+)''s$')),
                         assignment = CASE WHEN COALESCE(cleaner, substring(decided_by from ' — it was (.+)''s$')) IS NULL
                                           THEN 'tbd' ELSE 'assigned' END,
                         decided_by = 'restored — the booking is live in Hostaway'
                   WHERE account_id = 1 AND key = ${r.key}`;
        out.restored++;
      }
      if (stay.departure !== r.day) {
        await sql`UPDATE cleanings SET checkout_on = ${stay.departure} WHERE account_id = 1 AND key = ${r.key}`;
        r.day = stay.departure;
        out.moved++;
      }
    }
  }

  // One unit, one day, one clean — the same rule as the board, applied to
  // what was already recorded. The owner is the real guest stay: not an
  // iCal block, then the higher value.
  const live = rows.filter(r => byId.has(r.key));
  const groups = new Map<string, typeof live>();
  for (const r of live) if (r.unit_id) groups.set(`${r.unit_id}|${r.day}`, [...(groups.get(`${r.unit_id}|${r.day}`) ?? []), r]);
  for (const g of groups.values()) {
    const counted = g.filter(r => !r.void_reason || r.void_reason.startsWith('same unit and day'));
    if (counted.length < 2) continue;
    const weight = (key: string) => { const s = byId.get(key)!; return (/ical|block/i.test(s.channel) || s.totalPaid <= 0 ? 0 : 1e9) + s.totalPaid; };
    const owner = [...counted].sort((a, b) => weight(b.key) - weight(a.key))[0]!;
    for (const r of counted) {
      if (r === owner) continue;
      await sql`UPDATE cleanings SET void_reason = ${`same unit and day as reservation ${owner.key} — one clean`}
                 WHERE account_id = 1 AND key = ${r.key}`;
      out.sameDay++;
    }
  }
  await refreshCleaningRates(sql);
  return out;
}

/**
 * Each unit's recurring cleaning cost — the median of its standard
 * (non-deep) priced cleans — from the record itself, now that the sheet's
 * import no longer computes it. Same rule as the import (§18a): the
 * median, because one unit is legitimately cleaned at two prices, and a
 * blank price or a stay needing no clean is not a data point. Deep cleans
 * only when a unit has nothing else. Past cleans only: a plan is not what
 * cleaning costs.
 */
export async function refreshCleaningRates(sql: SqlFn): Promise<void> {
  await sql`
    WITH per_unit AS (
      SELECT unit_id,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY price) FILTER (WHERE NOT deep) AS std,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY price) AS any_clean
        FROM cleanings
       WHERE account_id = 1 AND unit_id IS NOT NULL AND assignment = 'assigned' AND void_reason IS NULL
         AND price IS NOT NULL AND price > 0
         AND checkout_on <= CURRENT_DATE AND checkout_on > CURRENT_DATE - 180
       GROUP BY unit_id)
    UPDATE units u SET cleaning_fee = round(COALESCE(p.std, p.any_clean)::numeric, 2),
                       cleaning_fee_source = 'kaizen', cleaning_fee_at = now()
      FROM per_unit p WHERE u.account_id = 1 AND u.id = p.unit_id`;
}

/**
 * The Host Note for each reservation on the board, pushed only when OUR
 * block changed since the last push. Hostaway is not asked about a
 * reservation whose lines are already what we would write — at twenty
 * reservations a pass, that is the difference between three calls and
 * sixty.
 *
 * Every attempt leaves a row, including failures (§17).
 */
export async function pushHostNotes(
  sql: SqlFn, creds: HostawayCredentials, s: OpsState, only?: string[]
): Promise<{ pushed: number; unchanged: number; failed: number; skipped: number }> {
  // Hostaway refuses every write to an archived listing ("You can't
  // perform this action for an archived listing", 403). Asking anyway
  // fails on every pass forever; the note stays in Kaizen, and the editor
  // says so.
  const archived = new Set(s.rows.filter(r => !r.listed || r.cancelled).map(r => r.resId));
  const ids = [...new Set(s.rows.map(r => r.resId))]
    .filter(id => (!only || only.includes(id)) && !archived.has(id));
  const last = ids.length ? await sql`
    SELECT DISTINCT ON (reservation_id) reservation_id, block, outcome FROM host_note_pushes
     WHERE account_id = 1 AND reservation_id = ANY(${ids}::text[])
     ORDER BY reservation_id, at DESC` as { reservation_id: string; block: string; outcome: string }[] : [];
  const prev = new Map(last.map(l => [l.reservation_id, l]));
  const out = { pushed: 0, unchanged: 0, failed: 0, skipped: 0 };

  const todo = ids.map(id => ({ id, block: blockForReservation(s.rows, id) }))
    .filter(t => {
      const p = prev.get(t.id);
      const same = p && p.block === t.block && (p.outcome === 'pushed' || p.outcome === 'unchanged');
      if (same) out.skipped++;
      return !same;
    });

  // A few at a time: Hostaway rate-limits, and a pass is not urgent.
  for (let i = 0; i < todo.length; i += 4) {
    await Promise.all(todo.slice(i, i + 4).map(async t => {
      let outcome: 'pushed' | 'unchanged' | 'failed' = 'failed';
      let detail = '';
      try {
        const existing = await fetchHostNote(creds, t.id);
        if (existing === null) { detail = 'Could not read the current note.'; }
        else {
          const merged = mergeHostNote(existing, t.block);
          if (merged === existing.trim()) { outcome = 'unchanged'; }
          else {
            const w = await writeHostNote(creds, t.id, merged);
            outcome = w.ok ? 'pushed' : 'failed';
            detail = w.detail;
          }
        }
      } catch (e) { detail = e instanceof Error ? e.message : String(e); }
      out[outcome]++;
      await sql`INSERT INTO host_note_pushes (account_id, reservation_id, block, outcome, detail)
                VALUES (1, ${t.id}, ${t.block}, ${outcome}, ${detail || null})`;
    }));
  }
  return out;
}

/** Ops members see the day's work without what the portfolio earns (§49). */
export function trimForOps(s: OpsState): void {
  for (const r of s.rows) {
    r.total = 0;
    if (r.next) { r.next.total = null; r.next.nightly = null; }
    if (r.stars) { r.stars.why = r.stars.why.replace(/\$\d[\d,]*/g, '$…'); r.stars.reason = r.stars.reason.replace(/\$\d[\d,]*/g, '$…'); }
    if (r.inspection.key === 'req') {
      r.inspection.reason = 'The next booking is a high-value stay. Inspect at this turnover, before that guest arrives.';
    }
    r.auto.reason = r.auto.reason.replace(/\$\d[\d,]*/g, '$…');
  }
  for (const p of s.panel) if (p.nextBig) p.nextBig.total = 0;
  s.summary.arriving = 0;
  s.summary.pipeline = 0;
}
