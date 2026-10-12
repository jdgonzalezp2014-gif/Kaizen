/**
 * /api/ops-settings — the roster, the rules, and the switch.
 *
 *   GET                                        everything below, as it is
 *   POST { roster: [...] }                     replace the roster
 *   POST { rules: {...} }                      thresholds (merged over defaults)
 *   POST { assignRule: 'tiers' | 'stars' }     which rule decides who cleans (§121)
 *   POST { crewCalendar: bool, crewCalendarDays }  cleaners see what is coming (§122)
 *   POST { action: 'crewLink', name, revoke? }  a cleaner's secret link: made (shown once) or revoked
 *   POST { action: 'previewAssign', roster, rules, rule? }   (rule: 'levels' by default, or 'stars')
 *                                              the board under these, by stars, against
 *                                              the board as it is — nothing saved
 *   POST { extraInspectors: [...] }
 *   POST { guestDocUnits: [listingId, …] }     units that ask guests for ID + agreement (§73)
 *   POST { action: 'import', commit }          one-time cutover from the daily file
 *   POST { mode: 'live' | 'shadow', confirmSheetOff }
 *   POST { hostawayTasks: 'off' | 'mirror' }  work ↔ Hostaway tasks (§93)
 *   POST { action: 'hostawayBackfill' }        send the open work that has no Hostaway task yet
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
import { pushWork } from '../_lib/hostaway-tasks.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { loadOps, opsConfig } from '../_lib/ops.ts';
import { newToken, sha256 } from '../_lib/crew.ts';
import {
  fetchPublishedCsv, isoDay, parseDailySettings, parseInspectionLog, parseNotesLog
} from '../_lib/daily.ts';
import {
  BEDROOM_SIZES, DEFAULT_RULES, LEVELS, buildBoard, summarize, withDefaults, zoneOf,
  type Cleaner, type OpsRules
} from '../../src/lib/operations.ts';
import { todayIn } from '../../src/lib/dates.ts';

const TIERS = new Set(['high', 'mid', 'low']);
/** A tier's stars, for a cleaner who arrives with only a tier (§121). */
const TIER_STARS: Record<string, number> = { high: 5, mid: 3, low: 2 };

/** The roster as sent from Setup, checked. Throws a message a person can act on. */
function parseRoster(raw: Record<string, any>[]): Cleaner[] {
  const seen = new Set<string>();
  const rows: Cleaner[] = [];
  for (const [i, c] of raw.entries()) {
    const name = String(c.name ?? '').trim();
    if (!name) continue;
    if (seen.has(name.toLowerCase())) throw new Error(`"${name}" is on the roster twice.`);
    seen.add(name.toLowerCase());
    if (!TIERS.has(c.tier)) throw new Error(`${name}: tier is high, mid or low.`);
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
    const stars = c.stars == null || c.stars === '' ? TIER_STARS[c.tier]! : Number(c.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error(`${name}: stars are 1 to 5.`);
    const max = c.maxPerDay == null || c.maxPerDay === '' ? null : Number(c.maxPerDay);
    if (max !== null && (!Number.isInteger(max) || max < 1)) throw new Error(`${name}: max cleans a day is a whole number, or blank for no limit.`);
    const zones = Array.isArray(c.zones) ? [...new Set((c.zones as unknown[]).map(z => String(z).trim()).filter(Boolean))] : [];
    const email = String(c.email ?? '').trim().toLowerCase() || null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error(`${name}: "${email}" is not an email address.`);
    if (email && rows.some(r => r.email === email)) throw new Error(`${email} is on the roster twice.`);
    const invoicePeriod = c.invoicePeriod === 'weekly' ? 'weekly' : 'monthly';
    const level = c.level == null || c.level === '' ? (stars >= 4 ? 'high' : stars <= 1 ? 'manual' : 'standard') : c.level;
    if (!LEVELS.includes(level)) throw new Error(`${name}: level is high, standard or manual.`);
    rows.push({ name, tier: c.tier, position: Number(c.position ?? i) || 0, rates: card(c.rates),
                deepRates: card(c.deepRates), active: c.active !== false, stars, level, zones, maxPerDay: max, email, invoicePeriod,
                lang: c.lang === 'es' ? 'es' : 'en' });
  }
  return rows;
}

/** Rules as sent from Setup: numbers only, blanks dropped (the default applies), checked for order. */
function parseRules(raw: Record<string, unknown>): Record<string, number> {
  const clean: Record<string, number> = {};
  for (const k of Object.keys(DEFAULT_RULES)) {
    const n = Number(raw[k]);
    if (raw[k] !== '' && raw[k] != null && Number.isFinite(n) && n >= 0) clean[k] = n;
  }
  if ((clean.inspectionSoonDays ?? 0) >= (clean.inspectionIntervalDays ?? Infinity)) {
    throw new Error('"Due soon" has to come before the inspection interval, or nothing is ever amber.');
  }
  const r = withDefaults(clean);
  if (!(r.starBand2From < r.starBand3From && r.starBand3From < r.starBand4From && r.starBand4From < r.starBand5From)) {
    throw new Error('The star price bands have to go up: ★2 < ★3 < ★4 < ★5.');
  }
  if (r.starStayPlus1Nights >= r.starStayPlus2Nights) throw new Error('The +1 stay length has to be shorter than the +2 one.');
  if (!Number.isInteger(r.starDefault) || r.starDefault < 1 || r.starDefault > 5) throw new Error('Stars with no price to go by are 1 to 5.');
  if (!(r.levelNextWithinDays >= 1)) throw new Error('The next check-in window is at least 1 day.');
  if (!(r.levelLongStayNights >= 1)) throw new Error('A long stay is at least 1 night.');
  return clean;
}

/**
 * The board under a proposed roster and rules, decided by stars, against
 * the board as it is now — how many cleans change cleaner, how many fall
 * below their stars, and what it costs (§121). Built from the same load,
 * so the only difference is the proposal. Nothing is saved.
 */
async function previewAssign(sql: SqlFn, env: Env, body: Record<string, any>): Promise<Response> {
  const roster = Array.isArray(body.roster) ? parseRoster(body.roster) : null;
  const rules: OpsRules | null = body.rules && typeof body.rules === 'object' ? withDefaults(parseRules(body.rules)) : null;
  const account = await getAccount(sql);
  const s = await loadOps(sql, await getCredentials(sql, env.ENCRYPTION_KEY), { cleaningsCsvUrl: account?.cleaningsCsvUrl });
  const proposed = { roster: roster ?? s.roster, rules: rules ?? s.rules };
  const rule = body.rule === 'stars' ? 'stars' : 'levels';
  const after = buildBoard({ ...s.boardInput, ...proposed, assignRule: rule });
  const before = new Map(s.rows.filter(r => r.kind === 'out').map(r => [r.resId, r]));
  const label = (r: { assignment: string; cleaner: string | null }) =>
    r.assignment === 'assigned' ? r.cleaner : r.assignment === 'not_needed' ? 'no clean needed' : 'unassigned';
  const changes = after.filter(r => r.kind === 'out').flatMap(r => {
    const b = before.get(r.resId);
    if (!b || (b.assignment === r.assignment && b.cleaner === r.cleaner)) return [];
    return [{ date: r.date, unit: r.unit, resId: r.resId,
              required: rule === 'levels' ? (r.levels?.required ?? (r.levels?.waiting ? 'waiting' : null)) : (r.stars?.required ?? null),
              now: label(b), then: label(r), priceNow: b.price, priceThen: r.price,
              below: rule === 'stars' && !!r.stars?.below, manual: r.manual.cleaner }];
  });
  const a = summarize(after), b = summarize(s.rows);
  return Response.json({ ok: true, preview: {
    from: s.today, to: s.end, rule: s.assignRule, proposedRule: rule, cleans: a.cleanings, changed: changes.length, changes,
    waiting: after.filter(r => r.kind === 'out' && r.levels?.waiting && !r.manual.cleaner && r.assignment === 'tbd').length,
    unassigned: { now: b.unassigned, then: a.unassigned },
    cost: { now: b.cleaningCost, then: a.cleaningCost },
    unpriced: { now: b.unpriced, then: a.unpriced }
  } });
}

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
  // The zones a cleaner can cover, from the units Kaizen knows (§121).
  const units = await sql`SELECT name FROM units WHERE account_id = 1 AND active ORDER BY name` as { name: string }[];
  const zones: Record<string, string[]> = {};
  for (const u of units) (zones[zoneOf(u.name)] ??= []).push(u.name);
  return Response.json({ ok: true, ...cfg, defaults: DEFAULT_RULES, counts, zones, hostawayTasks: await hostawayTasksState(sql) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => ({})) as Record<string, any>;

  try {
    if (body.action === 'previewAssign') return await previewAssign(sql, env, body);

    if (Array.isArray(body.roster)) {
      const rows = parseRoster(body.roster);
      // An address belongs to one person: a member keeps theirs, and a
      // cleaner given a member's address would be a member (accessOf).
      const emails = rows.map(r => r.email).filter((e): e is string => !!e);
      if (emails.length) {
        const taken = await sql`SELECT email FROM members WHERE account_id = 1 AND lower(email) = ANY(${emails})` as { email: string }[];
        if (taken.length) return bad(`${taken.map(t => t.email).join(', ')} is a member's address — a cleaner needs their own.`);
      }
      // The roster is replaced whole; a secret link (§122) is not something
      // the screen sends back, so it is carried over by name.
      const links = new Map((await sql`SELECT name, link_token_hash FROM cleaners WHERE account_id = 1 AND link_token_hash IS NOT NULL` as
        { name: string; link_token_hash: string }[]).map(r => [r.name, r.link_token_hash]));
      await sql`DELETE FROM cleaners WHERE account_id = 1`;
      for (const r of rows) {
        await sql`INSERT INTO cleaners (account_id, name, tier, position, rates, deep_rates, active, stars, level, zones, max_per_day,
                                        email, invoice_period, link_token_hash, lang)
                  VALUES (1, ${r.name}, ${r.tier}, ${r.position}, ${JSON.stringify(r.rates)}::jsonb,
                          ${JSON.stringify(r.deepRates)}::jsonb, ${r.active}, ${r.stars}, ${r.level ?? 'standard'}, ${r.zones}, ${r.maxPerDay},
                          ${r.email ?? null}, ${r.invoicePeriod ?? 'monthly'}, ${links.get(r.name) ?? null}, ${r.lang ?? 'en'})`;
      }
    }

    if (body.rules && typeof body.rules === 'object') {
      const clean = parseRules(body.rules);
      await sql`UPDATE accounts SET ops_rules = ${JSON.stringify(clean)}::jsonb WHERE id = 1`;
    }

    // §122: the schedule on the crew pages — off until the team has checked it makes sense.
    if (typeof body.crewCalendar === 'boolean') {
      const days = Math.round(Number(body.crewCalendarDays ?? 14));
      if (!(days >= 1 && days <= 30)) return bad('Show 1 to 30 days ahead.');
      const auto = Math.round(Number(body.crewAutoDays ?? 4));
      if (!(auto >= 0 && auto <= 14)) return bad('The rule\'s picks show 0 to 14 days ahead.');
      await sql`UPDATE accounts SET crew_calendar = ${body.crewCalendar}, crew_calendar_days = ${days}, crew_auto_days = ${auto} WHERE id = 1`;
    }

    // §122: the fallback link. Only its hash is kept, so it is shown once, here.
    if (body.action === 'crewLink') {
      const name = String(body.name ?? '');
      const token = body.revoke === true ? null : newToken();
      const done = await sql`UPDATE cleaners SET link_token_hash = ${token ? await sha256(token) : null}
                              WHERE account_id = 1 AND name = ${name} RETURNING name`;
      if (!done.length) return bad(`${name} is not on the roster.`);
      return Response.json({ ok: true, link: token ? `${new URL(request.url).origin}/crew#t=${token}` : null });
    }

    if (body.assignRule === 'tiers' || body.assignRule === 'stars' || body.assignRule === 'levels') {
      if (body.assignRule !== 'tiers' && !(await opsConfig(sql)).roster.some(c => c.active)) {
        return bad('The roster is empty — nobody could be assigned.');
      }
      await sql`UPDATE accounts SET assign_rule = ${body.assignRule} WHERE id = 1`;
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

    // §93 — the mirror's switch, and sending what was open before it was on.
    if (body.hostawayTasks === 'off' || body.hostawayTasks === 'mirror') {
      await sql`UPDATE accounts SET hostaway_tasks = ${body.hostawayTasks}, hostaway_tasks_pulled_at = NULL WHERE id = 1`;
      return Response.json({ ok: true, hostawayTasks: await hostawayTasksState(sql) });
    }
    if (body.action === 'hostawayBackfill') {
      const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
      const open = await sql`SELECT id::text FROM todos WHERE account_id = 1 AND deleted_at IS NULL AND parent_id IS NULL
                               AND hostaway_task_id IS NULL AND status NOT IN ('completed', 'cancelled') ORDER BY created_at LIMIT 200` as { id: string }[];
      const tally: Record<string, number> = { created: 0, failed: 0, skipped: 0, updated: 0 };
      for (const r of open) tally[await pushWork(sql, creds, r.id)]!++;
      return Response.json({ ok: true, sent: tally, hostawayTasks: await hostawayTasksState(sql) });
    }

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
      await sql`INSERT INTO cleaners (account_id, name, tier, position, rates, deep_rates, stars)
                VALUES (1, ${c.name}, ${tier}, ${i}, ${JSON.stringify(strip(c.rates))}::jsonb,
                        ${JSON.stringify(strip(c.deepRates))}::jsonb, ${TIER_STARS[tier] ?? 3})`;
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

/** The mirror as Setup shows it: on or off, what is linked, what failed, what is still to send. */
async function hostawayTasksState(sql: SqlFn) {
  const [r] = await sql`
    SELECT a.hostaway_tasks AS mode, a.hostaway_tasks_pulled_at AS pulled_at,
           (SELECT count(*)::int FROM todos WHERE account_id = 1 AND deleted_at IS NULL AND hostaway_task_id IS NOT NULL) AS linked,
           (SELECT count(*)::int FROM todos WHERE account_id = 1 AND deleted_at IS NULL AND hostaway_error IS NOT NULL) AS errors,
           (SELECT count(*)::int FROM todos WHERE account_id = 1 AND deleted_at IS NULL AND source = 'hostaway') AS imported,
           (SELECT count(*)::int FROM todos WHERE account_id = 1 AND deleted_at IS NULL AND parent_id IS NULL
               AND hostaway_task_id IS NULL AND status NOT IN ('completed', 'cancelled')) AS unsent
      FROM accounts a WHERE a.id = 1` as { mode: string; pulled_at: string | Date | null; linked: number; errors: number; imported: number; unsent: number }[];
  return { mode: r?.mode ?? 'off', pulledAt: r?.pulled_at ? new Date(r.pulled_at).toISOString() : null,
           linked: r?.linked ?? 0, errors: r?.errors ?? 0, imported: r?.imported ?? 0, unsent: r?.unsent ?? 0 };
}
