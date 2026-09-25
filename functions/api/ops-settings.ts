/**
 * /api/ops-settings — the roster, the rules, and the switch.
 *
 *   GET                                        everything below, as it is
 *   POST { roster: [...] }                     replace the roster
 *   POST { rules: {...} }                      thresholds (merged over defaults)
 *   POST { extraInspectors: [...] }
 *   POST { guestDocUnits: [listingId, …] }     units that ask guests for ID + agreement (§73)
 *   POST { action: 'import', commit }          one-time cutover from the daily file
 *   POST { mode: 'live' | 'shadow', confirmSheetOff }
 *
 * Admin only (roles.ts). These change who gets paid what, for everyone.
 *
 * Going live is the one step with an outside effect: from then on Kaizen
 * writes the Host Note in Hostaway. The sheet must have stopped doing so
 * first — two writers on one field is the state this whole cutover
 * exists to avoid — so the switch refuses without an explicit
 * confirmation that it has.
 */
import { db, type Env } from '../_lib/db.ts';
import { getAccount, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { loadOps, opsConfig } from '../_lib/ops.ts';
import {
  fetchPublishedCsv, isoDay, parseDailySettings, parseInspectionLog, parseNotesLog
} from '../_lib/daily.ts';
import { BEDROOM_SIZES, DEFAULT_RULES } from '../../src/lib/operations.ts';
import { todayIn } from '../../src/lib/dates.ts';

const TIERS = new Set(['high', 'mid', 'low']);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const cfg = await opsConfig(sql);
  const [counts] = await sql`
    SELECT (SELECT COUNT(*)::int FROM inspections WHERE account_id = 1) AS inspections,
           (SELECT COUNT(*)::int FROM stay_notes WHERE account_id = 1) AS notes,
           (SELECT COUNT(*)::int FROM turnover_overrides WHERE account_id = 1) AS overrides` as
    { inspections: number; notes: number; overrides: number }[];
  return Response.json({ ok: true, ...cfg, defaults: DEFAULT_RULES, counts });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => ({})) as Record<string, any>;

  try {
    if (Array.isArray(body.roster)) {
      const seen = new Set<string>();
      const rows = [];
      for (const [i, c] of (body.roster as Record<string, any>[]).entries()) {
        const name = String(c.name ?? '').trim();
        if (!name) continue;
        if (seen.has(name.toLowerCase())) return bad(`"${name}" is on the roster twice.`);
        seen.add(name.toLowerCase());
        if (!TIERS.has(c.tier)) return bad(`${name}: tier is high, mid or low.`);
        const card = (raw: unknown) => {
          const out: Record<string, number> = {};
          for (const b of BEDROOM_SIZES) {
            const v = (raw as Record<string, unknown> | null)?.[b];
            if (v === '' || v === null || v === undefined) continue;   // blank is "no rate"
            const n = Number(v);
            if (!Number.isFinite(n) || n < 0) throw new Error(`${name}: the ${b}-bedroom rate is not a number.`);
            out[b] = n;
          }
          return out;
        };
        rows.push({ name, tier: c.tier, position: Number(c.position ?? i) || 0,
                    rates: card(c.rates), deep: card(c.deepRates), active: c.active !== false });
      }
      await sql`DELETE FROM cleaners WHERE account_id = 1`;
      for (const r of rows) {
        await sql`INSERT INTO cleaners (account_id, name, tier, position, rates, deep_rates, active)
                  VALUES (1, ${r.name}, ${r.tier}, ${r.position}, ${JSON.stringify(r.rates)}::jsonb,
                          ${JSON.stringify(r.deep)}::jsonb, ${r.active})`;
      }
    }

    if (body.rules && typeof body.rules === 'object') {
      const clean: Record<string, number> = {};
      for (const k of Object.keys(DEFAULT_RULES)) {
        const n = Number(body.rules[k]);
        if (body.rules[k] !== '' && body.rules[k] != null && Number.isFinite(n) && n >= 0) clean[k] = n;
      }
      if ((clean.inspectionSoonDays ?? 0) >= (clean.inspectionIntervalDays ?? Infinity)) {
        return bad('"Due soon" has to come before the inspection interval, or nothing is ever amber.');
      }
      await sql`UPDATE accounts SET ops_rules = ${JSON.stringify(clean)}::jsonb WHERE id = 1`;
    }

    // Which units ask for guest documents (§73) — only units Kaizen knows.
    if (Array.isArray(body.guestDocUnits)) {
      const asked = [...new Set((body.guestDocUnits as unknown[]).map(String))];
      const known = new Set((await sql`SELECT id FROM units WHERE id = ANY(${asked})`).map((r: any) => String(r.id)));
      const unknown = asked.filter(id => !known.has(id));
      if (unknown.length) return bad(`Unknown unit(s): ${unknown.join(', ')}.`);
      await sql`UPDATE accounts SET guest_docs_units = ${asked} WHERE id = 1`;
    }

    if (Array.isArray(body.extraInspectors)) {
      const list = [...new Set((body.extraInspectors as unknown[]).map(v => String(v).trim()).filter(Boolean))];
      await sql`UPDATE accounts SET extra_inspectors = ${list} WHERE id = 1`;
    }

    if (body.action === 'import') return await cutoverImport(sql, body.commit === true);

    if (body.mode === 'live' || body.mode === 'shadow') {
      if (body.mode === 'live') {
        if (body.confirmSheetOff !== true) {
          return bad('Turn off the daily file\'s Hostaway push first (🏠 Kaizen → 🚫 Disable automatic ' +
                     'Hostaway push, and stop running 📅 Next 10 Days), then confirm here.');
        }
        const cfg = await opsConfig(sql);
        if (!cfg.roster.some(c => c.active)) return bad('The roster is empty — nobody could be assigned.');
        const adopted = await adoptSheetDecisions(sql, env, who.email);
        await sql`UPDATE accounts SET ops_mode = 'live' WHERE id = 1`;
        return Response.json({ ok: true, mode: 'live', adopted });
      }
      await sql`UPDATE accounts SET ops_mode = 'shadow' WHERE id = 1`;
      return Response.json({ ok: true, mode: 'shadow' });
    }

    return Response.json({ ok: true, ...(await opsConfig(sql)) });
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }
};

/**
 * Brings the daily file's roster, rules, Inspection Log and Notes Log in,
 * once. Previewed first — an import is the one operation where being
 * wrong is both easy and invisible (§5).
 *
 * Replaces what an EARLIER import brought (source = 'sheet') rather than
 * adding to it, so running it again before cutover refreshes instead of
 * duplicating. Rows written in Kaizen are never touched.
 */
async function cutoverImport(sql: SqlFn, commit: boolean): Promise<Response> {
  const account = await getAccount(sql);
  const today = todayIn('America/New_York');
  const read = async (url: string | null | undefined) => url ? fetchPublishedCsv(url) : null;
  const [settingsCsv, inspCsv, notesCsv] = await Promise.all([
    read(account?.dailySettingsCsvUrl), read(account?.dailyInspectionsCsvUrl), read(account?.dailyNotesCsvUrl)
  ]);
  const settings = settingsCsv?.ok ? parseDailySettings(settingsCsv.text) : null;
  const insp = inspCsv?.ok ? parseInspectionLog(inspCsv.text, today) : null;
  const notes = notesCsv?.ok ? parseNotesLog(notesCsv.text) : null;
  const problem = (r: Awaited<ReturnType<typeof read>>, parsed: unknown, name: string) =>
    !r ? `${name}: not linked (Settings → Daily file).`
      : !r.ok ? `${name}: ${r.problem}`
      : parsed === null ? `${name}: read, but not the expected columns.` : null;

  const preview = {
    roster: settings?.cleaners.map(c => ({ name: c.name, tier: c.tier })) ?? [],
    rules: settings ? Object.fromEntries(Object.keys(DEFAULT_RULES).map(k => [k, (settings as any)[k]])) : null,
    inspectors: settings?.inspectors ?? [],
    inspections: { done: insp?.done.length ?? 0, scheduled: insp?.scheduled.length ?? 0 },
    notes: notes?.length ?? 0,
    problems: [problem(settingsCsv, settings, 'Settings tab'), problem(inspCsv, insp, 'Inspection Log'),
               problem(notesCsv, notes, 'Notes Log')].filter(Boolean)
  };
  if (!commit) return Response.json({ ok: true, dryRun: true, preview });

  if (settings) {
    await sql`DELETE FROM cleaners WHERE account_id = 1`;
    for (const [i, c] of settings.cleaners.entries()) {
      const tier = TIERS.has(c.tier) ? c.tier : 'mid';
      const strip = (card: Record<string, number | null>) =>
        Object.fromEntries(Object.entries(card).filter(([, v]) => v !== null));
      await sql`INSERT INTO cleaners (account_id, name, tier, position, rates, deep_rates)
                VALUES (1, ${c.name}, ${tier}, ${i}, ${JSON.stringify(strip(c.rates))}::jsonb,
                        ${JSON.stringify(strip(c.deepRates))}::jsonb)`;
    }
    await sql`UPDATE accounts SET ops_rules = ${JSON.stringify(preview.rules)}::jsonb,
                     extra_inspectors = ${settings.inspectors} WHERE id = 1`;
  }
  if (insp) {
    await sql`DELETE FROM inspections WHERE account_id = 1 AND source = 'sheet'`;
    for (const e of [...insp.done, ...insp.scheduled]) {
      // The result exactly as written. The parser already decided done vs
      // scheduled the sheet's way (a result AND a date not in the future).
      const done = !!e.result && e.date <= today;
      await sql`INSERT INTO inspections (account_id, unit_name, inspected_on, inspector, result, notes,
                                         source, created_by)
                VALUES (1, ${e.unit}, ${e.date}, ${e.by || null}, ${done ? e.result : null},
                        ${e.notes || null}, 'sheet', 'daily file')
                ON CONFLICT DO NOTHING`;
    }
  }
  if (notes) {
    await sql`DELETE FROM stay_notes WHERE account_id = 1 AND source = 'sheet'`;
    const rows = notes.filter(n => n.resId && (n.kind === 'checkin' || n.kind === 'checkout'));
    if (rows.length) {
      // One statement, not one per note (§62). Order is kept by inserting
      // oldest first — the log's own order — so "latest" stays latest.
      await sql`
        INSERT INTO stay_notes (account_id, reservation_id, kind, unit_name, guest, check_in, notes,
                                source, created_by, created_at)
        SELECT 1, r, k, u, g, ci, n, 'sheet', 'daily file', COALESCE(at, now())
          FROM unnest(${rows.map(n => n.resId)}::text[], ${rows.map(n => n.kind)}::text[],
                      ${rows.map(n => n.unit)}::text[], ${rows.map(n => n.guest)}::text[],
                      ${rows.map(n => n.checkIn || null)}::date[], ${rows.map(n => n.notes)}::text[],
                      ${rows.map(n => isoDay(n.loggedAt) ? n.loggedAt : null)}::timestamptz[])
               WITH ORDINALITY AS t(r, k, u, g, ci, n, at, ord)
         ORDER BY ord`;
    }
  }
  return Response.json({ ok: true, dryRun: false, preview });
}

/**
 * On the day Kaizen takes over, the board must not change under anyone.
 * Wherever the sheet decided something different from what Kaizen's rule
 * would — a cleaner swapped by hand, a deep clean switched off — that
 * decision becomes an override here, marked as coming from the sheet.
 * Existing overrides are left alone: a person's choice in Kaizen wins.
 */
async function adoptSheetDecisions(sql: SqlFn, env: Env, _actor: string): Promise<number> {
  const account = await getAccount(sql);
  const s = await loadOps(sql, await getCredentials(sql, env.ENCRYPTION_KEY),
                          { cleaningsCsvUrl: account?.cleaningsCsvUrl, refreshSheet: true });
  let adopted = 0;
  for (const r of s.rows) {
    if (r.kind !== 'out' || !r.sheet || r.manual.cleaner || r.manual.deep || r.manual.time) continue;
    const sh = r.sheet;
    const cleanerDiffers = r.differs.includes('cleaner');
    const deepDiffers = r.differs.includes('deep');
    const timeDiffers = !!sh.checkoutTime && sh.checkoutTime !== r.time;
    if (!cleanerDiffers && !deepDiffers && !timeDiffers) continue;
    const onRoster = sh.assignment !== 'assigned' || s.roster.some(c => c.name === sh.cleaner);
    await sql`
      INSERT INTO turnover_overrides (account_id, reservation_id, assignment, cleaner, deep,
                                      checkout_time, updated_by)
      VALUES (1, ${r.resId},
              ${cleanerDiffers && onRoster ? sh.assignment : null},
              ${cleanerDiffers && onRoster && sh.assignment === 'assigned' ? sh.cleaner : null},
              ${deepDiffers ? sh.deep : null}, ${timeDiffers ? sh.checkoutTime : null},
              'daily file (cutover)')
      ON CONFLICT (account_id, reservation_id) DO NOTHING`;
    adopted++;
  }
  return adopted;
}

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
