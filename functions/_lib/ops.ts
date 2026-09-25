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
import { fetchListings, fetchReservationsTouching, fetchHostNote, writeHostNote,
         type HostawayCredentials } from './hostaway.ts';
import { importCleanings } from './cleanings-import.ts';
import type { SqlFn } from './accounts.ts';
import { addDays, todayIn } from '../../src/lib/dates.ts';
import {
  blockForReservation, buildBoard, inspectionPanel, mergeHostNote, summarize, withDefaults,
  type BoardRow, type Cleaner, type OpsCleaning, type OpsInspection, type OpsRules, type Override
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
}> {
  const [acc, roster] = await Promise.all([
    sql`SELECT ops_mode, ops_rules, extra_inspectors FROM accounts WHERE id = 1`,
    sql`SELECT name, tier, position, rates, deep_rates, active FROM cleaners
         WHERE account_id = 1 ORDER BY tier, position, name`
  ]) as [{ ops_mode: OpsMode; ops_rules: Record<string, unknown>; extra_inspectors: string[] }[],
         { name: string; tier: Cleaner['tier']; position: number; rates: Record<string, number | null>;
           deep_rates: Record<string, number | null>; active: boolean }[]];
  return {
    mode: acc[0]?.ops_mode === 'live' ? 'live' : 'shadow',
    rules: withDefaults(acc[0]?.ops_rules),
    extraInspectors: acc[0]?.extra_inspectors ?? [],
    roster: roster.map(c => ({ name: c.name, tier: c.tier, position: c.position,
      rates: c.rates ?? {}, deepRates: c.deep_rates ?? {}, active: c.active }))
  };
}

export async function inspectionLog(sql: SqlFn): Promise<{
  done: (OpsInspection & { id: string; reservationId: string | null })[];
  scheduled: (OpsInspection & { id: string; reservationId: string | null })[];
}> {
  const rows = await sql`
    SELECT id, unit_name, inspected_on::text AS date, inspector, result, notes, reservation_id
      FROM inspections WHERE account_id = 1 ORDER BY inspected_on DESC, id DESC LIMIT 2000` as
    { id: string; unit_name: string; date: string; inspector: string | null; result: string | null;
      notes: string | null; reservation_id: string | null }[];
  const map = (r: typeof rows[number]) => ({ id: String(r.id), date: r.date, unit: r.unit_name,
    by: r.inspector ?? '', result: r.result ?? '', notes: r.notes ?? '', reservationId: r.reservation_id });
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
  rows: BoardRow[];
  summary: ReturnType<typeof summarize>;
  panel: ReturnType<typeof inspectionPanel>;
  inspections: Awaited<ReturnType<typeof inspectionLog>>;
  reservations: Awaited<ReturnType<typeof fetchReservationsTouching>>;
  /** The last day the next booking was looked for. */
  lookaheadTo: string;
  sheet: { ok: boolean; problem: string | null; warning: string | null } | null;
  timings: Record<string, number>;
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

  const [listings, reservations, inspections, overrideRows, noteRows] = await Promise.all([
    timed('listings', fetchListings(creds)),
    // One live question: every stay still in the building today or
    // arriving before the look-ahead ends. Stays that began months ago but
    // check out this week are included by construction.
    timed('reservations', fetchReservationsTouching(creds, today, addDays(end, NEXT_STAY_LOOKAHEAD))),
    inspectionLog(sql),
    sql`SELECT reservation_id, assignment, cleaner, deep, checkout_time, checkin_time
          FROM turnover_overrides WHERE account_id = 1`,
    // The current note per stay and end: the latest row, including a
    // blank one — a cleared note is the current note.
    sql`SELECT DISTINCT ON (reservation_id, kind) reservation_id, kind, notes
          FROM stay_notes WHERE account_id = 1
         ORDER BY reservation_id, kind, id DESC`
  ]) as [Awaited<ReturnType<typeof fetchListings>>, Awaited<ReturnType<typeof fetchReservationsTouching>>,
         Awaited<ReturnType<typeof inspectionLog>>,
         { reservation_id: string; assignment: Override['assignment']; cleaner: string | null;
           deep: boolean | null; checkout_time: string | null; checkin_time: string | null }[],
         { reservation_id: string; kind: string; notes: string }[]];

  const overrides = new Map<string, Override>(overrideRows.map(o => [o.reservation_id, {
    assignment: o.assignment, cleaner: o.cleaner, deep: o.deep,
    checkoutTime: o.checkout_time, checkinTime: o.checkin_time }]));
  const notes = new Map(noteRows.map(n => [`${n.reservation_id}|${n.kind}`, n.notes]));

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

  const opsListings = listings.map(l => ({ id: l.listingId, name: l.name, bedrooms: l.bedrooms, active: l.active }));
  const panel = inspectionPanel(opsListings, reservations, inspections.done, inspections.scheduled, today, cfg.rules);
  const rows = buildBoard({
    today, windowDays: days, listings: opsListings, reservations, roster: cfg.roster, rules: cfg.rules,
    overrides, notes, inspections: panel, sheet: sheetMap,
    // With no inspection ever recorded here, "never inspected" would be a
    // claim about every unit made from no evidence (§63).
    inspectionLogRead: inspections.done.length + inspections.scheduled.length > 0
  });
  timings.total = Date.now() - started;

  return { mode: cfg.mode, today, end, days, rules: cfg.rules, roster: cfg.roster,
           extraInspectors: cfg.extraInspectors, rows, summary: summarize(rows), panel,
           inspections, reservations, sheet, timings, lookaheadTo: addDays(end, NEXT_STAY_LOOKAHEAD) };
}

/* ── live mode: the record and the push ───────────────────────────── */

const URGENCY_LABEL: Record<string, string> = { turnover: '⚡', same_guest: '🔁', no_next: '⏳' };

/**
 * The cleanings record for every checkout on the board — what the
 * Cleanings Log was. Upserted on the reservation, so a changed cleaner
 * corrects the row rather than adding one. A stay that has vanished from
 * the future window (cancelled) is removed, but only rows Kaizen wrote
 * and only ahead of today: the past is a record, not a forecast.
 */
export async function recordCleanings(sql: SqlFn, s: OpsState): Promise<number> {
  const outs = s.rows.filter(r => r.kind === 'out');
  if (outs.length) {
    await sql`
      INSERT INTO cleanings (account_id, key, unit_id, unit_name, checkout_on, cleaner, assignment,
                             guest, price, deep, urgency, checkout_time, beds, source)
      SELECT 1, k, u, n, d, c, a, g, p, dp, ug, tm, bd, 'kaizen'
        FROM unnest(${outs.map(r => r.resId)}::text[], ${outs.map(r => r.unitId)}::text[],
                    ${outs.map(r => r.unit)}::text[], ${outs.map(r => r.date)}::date[],
                    ${outs.map(r => r.cleaner)}::text[], ${outs.map(r => r.assignment === 'unknown' ? 'tbd' : r.assignment)}::text[],
                    ${outs.map(r => r.guest || null)}::text[], ${outs.map(r => r.price)}::numeric[],
                    ${outs.map(r => r.deep)}::boolean[], ${outs.map(r => (r.urgency && URGENCY_LABEL[r.urgency]) || null)}::text[],
                    ${outs.map(r => r.time)}::text[], ${outs.map(r => r.beds)}::smallint[])
             AS t(k, u, n, d, c, a, g, p, dp, ug, tm, bd)
      ON CONFLICT (account_id, key) DO UPDATE SET
        unit_id = EXCLUDED.unit_id, unit_name = EXCLUDED.unit_name, checkout_on = EXCLUDED.checkout_on,
        cleaner = EXCLUDED.cleaner, assignment = EXCLUDED.assignment, guest = EXCLUDED.guest,
        price = EXCLUDED.price, deep = EXCLUDED.deep, urgency = EXCLUDED.urgency,
        checkout_time = EXCLUDED.checkout_time, beds = EXCLUDED.beds, source = 'kaizen',
        imported_at = now()`;
  }
  await refreshCleaningRates(sql);
  await sql`
    DELETE FROM cleanings WHERE account_id = 1 AND source = 'kaizen'
       AND checkout_on > ${s.today}::date AND checkout_on <= ${s.end}::date
       AND NOT (key = ANY(${outs.map(r => r.resId)}::text[]))`;
  return outs.length;
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
       WHERE account_id = 1 AND unit_id IS NOT NULL AND assignment = 'assigned'
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
  const ids = [...new Set(s.rows.map(r => r.resId))].filter(id => !only || only.includes(id));
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
    if (r.next) r.next.total = null;
    if (r.inspection.key === 'req') {
      r.inspection.reason = 'The next booking is a high-value stay. Inspect at this turnover, before that guest arrives.';
    }
    r.auto.reason = r.auto.reason.replace(/\$\d[\d,]*/g, '$…');
  }
  for (const p of s.panel) if (p.nextBig) p.nextBig.total = 0;
  s.summary.arriving = 0;
  s.summary.pipeline = 0;
}
