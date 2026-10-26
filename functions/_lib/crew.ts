/**
 * The crew page (§122), server side: one cleaner's record, extras,
 * invoice and — when the team has turned it on — what is coming.
 *
 * One loader for both doors: the cleaner's own (/api/crew) and the team's
 * preview of it (/api/crew-admin), so what the team checks is exactly what
 * the cleaner sees.
 */
import { shareRoot } from './clean-access.ts';
import type { SqlFn } from './accounts.ts';
import { getCredentials } from './accounts.ts';
import type { Env } from './db.ts';
import { loadOps, pushHostNotes, recordCleanings } from './ops.ts';
import { DriveError, createFolder, driveToken, uploadFile } from './gdrive.ts';
import { decrypt, encrypt } from './crypto.ts';
import { tellCleanThread } from './clean-slack.ts';
import { tellCleaner } from './crew-slack.ts';
import type { HelperEvent } from '../../src/lib/crew-slack.ts';
import { accessByUnit } from './unit-access.ts';
import type { UnitAccess } from '../../src/lib/unit-access.ts';
import { addPhotos, cleanStates, ensureRecord, markClean, type CleanState, type Stage } from './clean-record.ts';
import { activeUnits, esMessage, fieldPhotos, fieldPurchase, fieldTodo, invItems, lowStock, ranOut, mirrorTodos, nothingTaken, recordMove, recordUses } from './inventory.ts';
import { addDays, todayIn, type DateStr } from '../../src/lib/dates.ts';
import type { Level } from '../../src/lib/operations.ts';
import {
  buildInvoice, customPeriod, periodOf, recentPeriods, scheduleMovements, visibleAhead, EXTRA_MAX_AGE_DAYS, EXTRA_MAX_AMOUNT,
  type CrewClean, type CrewExtra, type Fate, type InvoicePeriod, type Movement, type Period, type ScheduleItem, type Visibility
} from '../../src/lib/crew.ts';

const TZ = 'America/New_York';
const PERIODS_SHOWN = 6;
/** A span the team picks: up to ~3 months (one query on the record), up to the board's 30 days ahead. */
export const CUSTOM_MAX_DAYS = 92, CUSTOM_AHEAD = 30;

export interface CrewUpcoming {
  /** The reservation (a checkout) or MAN-<n> (a manual clean) — what a decline names. */
  key: string;
  date: DateStr; unit: string; beds: number | null; time: string; deep: boolean;
  /** The next guest arrives the same day — no slack. */
  sameDay: boolean;
  /** That guest's check-in time, when it is the same day. */
  checkIn: string | null;
  price: number | null;
  /** A manual clean (§79) rather than a checkout. */
  manual: string | null;
  /** §133: what an inspection asked this clean to do. */
  tasks?: string[];
  /** When the cleaner confirmed it on their page (owner, 2026-10-17); null = not yet. */
  accepted?: string | null;
}

export interface CrewPage {
  /** `level` only for the team: a cleaner is never shown their own rating. */
  cleaner: { name: string; level?: Level; invoicePeriod: InvoicePeriod; active: boolean; lang: 'en' | 'es' };
  today: DateStr;
  periods: Period[];
  period: Period;
  /** The selected period's cleans, and every clean an extra can still be asked on. */
  cleans: CrewClean[];
  extras: CrewExtra[];
  invoice: ReturnType<typeof buildInvoice>;
  /** Cleans an extra can be added to: done, theirs, not excluded, recent. */
  extraFrom: DateStr;
  /** Published SOPs for the cleaner's page (feature `crew.page`), shown as "How this page works". */
  help?: { title: string; purpose: string | null; steps: { text: string; detail?: string }[]; body: string | null; lang: 'en' | 'es' }[];
  /** §134: each recent or coming clean's photos before/after and done — by key. */
  field?: Record<string, CleanState>;
  /** §136: how to get in (address, lock, code, Wi-Fi) — only for the cleaner's cleans of TODAY, by key. */
  access?: Record<string, UnitAccess>;
  places?: Record<string, NonNullable<UnitAccess['supplies']>>;
  /** §136: the address of each coming clean (no codes ahead of the day), by key. */
  addresses?: Record<string, string>;
  /** §134: the photos themselves (ids to ask for), by clean — shown on the cleaner's past cleans. */
  fieldPhotos?: Record<string, { id: string; stage: Stage }[]>;
  /** §134: what they can report — the supplies and the units. */
  supplies?: { items: { id: string; name: string; measure: string; category: string }[]; units: { id: string; name: string }[] };
  upcoming: {
    enabled: boolean; days: number; through: DateStr | null; rows: CrewUpcoming[]; problem: string | null;
    /** Unpublished, the rule's picks show this many days ahead (§127). */
    autoDays: number;
    /** The last snapshot of the schedule (daily, or by the team) — when, and how far it reached. */
    confirmed: { at: string; through: DateStr } | null;
    /** What moved for this cleaner since then. */
    movements: Movement[];
    /** Owner, 2026-10-25: a fast answer without the schedule (Hostaway) — the full one follows. */
    loading?: boolean;
  };
}

/* ── the schedule: what it is now, what was confirmed, what moved ─── */

type Ops = Awaited<ReturnType<typeof loadOps>>;

/** Every assigned clean from today through the board's end — checkouts and manual cleans. */
async function scheduleNow(sql: SqlFn, s: Ops): Promise<ScheduleItem[]> {
  const items: ScheduleItem[] = s.rows
    .filter(r => r.kind === 'out' && r.assignment === 'assigned' && r.cleaner && r.date >= s.today)
    .map(r => ({ key: r.resId, cleaner: r.cleaner!, date: r.date, unit: r.unit, time: r.time, byHand: r.manual.cleaner }));
  const manual = await sql`
    SELECT key, cleaner, checkout_on::text AS date, unit_name, coalesce(checkout_time, '') AS time FROM cleanings
     WHERE account_id = 1 AND key LIKE 'MAN-%' AND assignment = 'assigned' AND cleaner IS NOT NULL AND void_reason IS NULL
       AND checkout_on >= ${s.today}::date AND checkout_on <= ${s.end}::date` as
    { key: string; cleaner: string; date: string; unit_name: string; time: string }[];
  // A manual clean is a person's decision by construction.
  return [...items, ...manual.map(m => ({ key: m.key, cleaner: m.cleaner, date: m.date, unit: m.unit_name, time: m.time, byHand: true }))];
}

export interface ScheduleState {
  s: Ops; now: ScheduleItem[];
  confirm: { at: string; by: string; through: DateStr; snapshot: ScheduleItem[]; day: DateStr; vis: Visibility } | null;
  /** What happened to a confirmed clean that left this cleaner's schedule. */
  fate: (cleaner: string) => (key: string) => Fate;
}

export async function scheduleState(sql: SqlFn, encryptionKey: string, days: number): Promise<ScheduleState> {
  const s = await loadOps(sql, await getCredentials(sql, encryptionKey), { days });
  const [now, confirms] = await Promise.all([
    scheduleNow(sql, s),
    sql`SELECT to_char(confirmed_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS at, confirmed_by AS by,
               through::text AS through, snapshot, day::text AS day, published, auto_days
          FROM crew_schedule_confirms WHERE account_id = 1 ORDER BY id DESC LIMIT 1`
  ]) as [ScheduleItem[], { at: string; by: string; through: string; snapshot: ScheduleItem[]; day: string; published: boolean; auto_days: number }[]];
  const c0 = confirms[0];
  const confirm = c0 ? { at: c0.at, by: c0.by, through: c0.through, snapshot: c0.snapshot, day: c0.day,
                         vis: { published: c0.published, autoDays: Number(c0.auto_days) || 0 } } : null;
  const manualKeys = (confirm?.snapshot ?? []).map(i => i.key).filter(k => k.startsWith('MAN-'));
  const manual = new Map((manualKeys.length ? await sql`
    SELECT key, cleaner, assignment, void_reason, decided_by, checkout_on::text AS date FROM cleanings
     WHERE account_id = 1 AND key = ANY(${manualKeys}::text[])` as
    { key: string; cleaner: string | null; assignment: string; void_reason: string | null; decided_by: string | null; date: string }[] : [])
    .map(m => [m.key, m]));
  const fate = (cleaner: string) => (key: string): Fate => {
    const m = manual.get(key);
    if (key.startsWith('MAN-')) {
      if (!m || m.void_reason) return { status: 'cancelled' };
      if (m.decided_by === `declined by ${cleaner}`) return { status: 'declined' };
      if (m.assignment !== 'assigned') return { status: 'unassigned' };
      return m.cleaner === cleaner ? { status: 'moved', to: m.date } : { status: 'reassigned' };
    }
    const r = s.rows.find(o => o.kind === 'out' && o.resId === key);
    if (r) {
      if (r.declined.some(d => d.cleaner === cleaner) && r.cleaner !== cleaner) return { status: 'declined' };
      if (r.assignment === 'not_needed') return { status: 'not_needed' };
      if (r.assignment !== 'assigned') return { status: 'unassigned' };
      return { status: 'reassigned' };
    }
    const res = s.reservations.find(x => x.reservationId === key);
    return res ? { status: 'moved', to: res.departure } : { status: 'cancelled' };
  };
  return { s, now, confirm, fate };
}

/**
 * A snapshot of the schedule as it stands — by the daily pass ("daily
 * update"), or by a person — and what was in view then: what cleaners'
 * "changes since" are measured from.
 */
export async function confirmSchedule(sql: SqlFn, encryptionKey: string, by: string) {
  const [acc] = await sql`SELECT crew_calendar, crew_calendar_days, crew_auto_days FROM accounts WHERE id = 1` as
    { crew_calendar: boolean; crew_calendar_days: number; crew_auto_days: number }[];
  const s = await loadOps(sql, await getCredentials(sql, encryptionKey), { days: acc?.crew_calendar_days ?? 14 });
  const items = await scheduleNow(sql, s);
  await sql`INSERT INTO crew_schedule_confirms (account_id, through, snapshot, confirmed_by, published, auto_days, day)
            VALUES (1, ${s.end}, ${JSON.stringify(items)}::jsonb, ${by}, ${!!acc?.crew_calendar}, ${acc?.crew_auto_days ?? 4}, ${s.today})`;
  return { through: s.end, cleans: items.length };
}

/** What cleaners can see ahead, as the account is set now (§127). */
export async function crewVisibility(sql: SqlFn): Promise<Visibility & { days: number }> {
  const [acc] = await sql`SELECT crew_calendar, crew_calendar_days, crew_auto_days FROM accounts WHERE id = 1` as
    { crew_calendar: boolean; crew_calendar_days: number; crew_auto_days: number }[];
  return { published: !!acc?.crew_calendar, autoDays: Number(acc?.crew_auto_days ?? 4), days: acc?.crew_calendar_days ?? 14 };
}

export async function findCleaner(sql: SqlFn, name: string) {
  const [c] = await sql`SELECT name, level, invoice_period, active, lang FROM cleaners WHERE account_id = 1 AND name = ${name}` as
    { name: string; level: Level; invoice_period: InvoicePeriod; active: boolean; lang: 'en' | 'es' }[];
  return c ?? null;
}

/** The cleaner a secret link belongs to — matched by the token's SHA-256, never the token. */
export async function cleanerByToken(sql: SqlFn, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const [c] = await sql`SELECT name FROM cleaners WHERE account_id = 1 AND link_token_hash = ${await sha256(token)}` as { name: string }[];
  return c?.name ?? null;
}

export async function sha256(text: string): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** A new secret for a link: 24 random bytes, URL-safe. */
export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function loadCrewPage(sql: SqlFn, encryptionKey: string, name: string,
                                   asked?: string | null, preloaded?: ScheduleState,
                                   /** The team's own span's last day (Operations → Cleaners); `asked` is its first. */
                                   askedTo?: string | null,
                                   /** The team's fast first answer: no schedule (3 Hostaway calls); the full one follows. */
                                   skipSchedule = false): Promise<CrewPage | null> {
  const c = await findCleaner(sql, name);
  if (!c) return null;
  const today = todayIn(TZ);
  const periods = recentPeriods(today, c.invoice_period, PERIODS_SHOWN);
  const isDay = (d?: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const custom = isDay(asked) && isDay(askedTo) && asked <= askedTo && askedTo <= addDays(today, CUSTOM_AHEAD) &&
    askedTo <= addDays(asked, CUSTOM_MAX_DAYS);
  const period = custom ? customPeriod(asked, askedTo)
    : isDay(asked) && asked <= today ? periodOf(asked, c.invoice_period) : periods[0]!;
  const extraFrom = addDays(today, -EXTRA_MAX_AGE_DAYS);
  const from = period.from < extraFrom ? period.from : extraFrom;
  const to = period.to > today ? period.to : today;

  const [rows, acc] = await Promise.all([
    sql`SELECT key, unit_name, checkout_on::text AS date, beds, deep, kind, price::float AS price, assignment,
               void_reason, flag_note, edit_note
          FROM cleanings WHERE account_id = 1 AND cleaner = ${c.name}
           AND checkout_on >= ${from}::date AND checkout_on <= ${to}::date
         ORDER BY checkout_on, unit_name`,
    sql`SELECT crew_calendar, crew_calendar_days, crew_auto_days FROM accounts WHERE id = 1`
  ]) as [{ key: string; unit_name: string; date: string; beds: number | null; deep: boolean; kind: string | null;
           price: number | null; assignment: string; void_reason: string | null; flag_note: string | null; edit_note: string | null }[],
         { crew_calendar: boolean; crew_calendar_days: number; crew_auto_days: number }[]];
  const cleans: CrewClean[] = rows.map(r => ({
    key: r.key, unit: r.unit_name, date: r.date, beds: r.beds, deep: !!r.deep, kind: r.kind ?? 'checkout',
    price: r.price, assignment: r.assignment, voidReason: r.void_reason, flagNote: r.flag_note, editNote: r.edit_note
  }));
  const keys = cleans.map(x => x.key);
  const extras = keys.length ? (await sql`
    SELECT id::text, cleaning_key AS key, amount::float AS amount, description, status, decision_note AS "decisionNote",
           decided_by AS "decidedBy", to_char(created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS "createdAt",
           field_expense_id::text AS "fromPurchase"
      FROM cleaning_extras WHERE account_id = 1 AND cleaner = ${c.name} AND cleaning_key = ANY(${keys}::text[])
     ORDER BY created_at` as (CrewExtra & { fromPurchase?: string | null })[]) : [];
  await attachFiles(sql, extras);
  // A purchase paid back (098): its receipts are the purchase's.
  const bought = extras.filter(e => e.fromPurchase);
  if (bought.length) {
    const fe = await sql`SELECT id::text, photos FROM field_expenses WHERE account_id = 1 AND id = ANY(${bought.map(e => Number(e.fromPurchase))}::bigint[])` as
      { id: string; photos: { name: string; url: string }[] | null }[];
    for (const e of bought) {
      const ph = fe.find(f => f.id === e.fromPurchase)?.photos ?? [];
      e.files = [...(e.files ?? []), ...ph.map((p, i) => ({ id: `fe${e.fromPurchase}-${i}`, name: p.name, url: p.url }))];
    }
  }
  for (const e of extras) delete e.fromPurchase;

  const enabled = !!acc[0]?.crew_calendar;
  const days = acc[0]?.crew_calendar_days ?? 14;
  const vis: Visibility = { published: enabled, autoDays: Number(acc[0]?.crew_auto_days ?? 4) };
  const upcoming: CrewPage['upcoming'] = { enabled, days, autoDays: vis.autoDays, through: null, rows: [], problem: null, confirmed: null, movements: [] };
  // What a person assigned is shown even while the whole schedule is not (§123): it was checked by someone.
  if (skipSchedule) upcoming.loading = true;
  else {
    try {
      const st = preloaded ?? await scheduleState(sql, encryptionKey, days);
      const s = st.s;
      upcoming.through = s.end;
      const checkIn = new Map(s.rows.filter(r => r.kind === 'in').map(r => [`${r.unitId}|${r.date}`, r.time]));
      const outs = new Map(s.rows.filter(r => r.kind === 'out').map(r => [r.resId, r]));
      const manual = await sql`
        SELECT key, beds, deep, kind, price::float AS price FROM cleanings
         WHERE account_id = 1 AND key LIKE 'MAN-%' AND cleaner = ${c.name} AND checkout_on >= ${today}::date` as
        { key: string; beds: number | null; deep: boolean; kind: string; price: number | null }[];
      const man = new Map(manual.map(m => [m.key, m]));
      upcoming.rows = st.now.filter(i => i.cleaner === c.name && visibleAhead(i, today, vis)).map(i => {
        const r = outs.get(i.key), m = man.get(i.key);
        return r
          ? { key: i.key, date: i.date, unit: i.unit, beds: r.beds, time: r.time, deep: r.deep, sameDay: r.urgency === 'turnover',
              checkIn: checkIn.get(`${r.unitId}|${r.date}`) ?? null, price: r.price, manual: null }
          : { key: i.key, date: i.date, unit: i.unit, beds: m?.beds ?? null, time: i.time, deep: !!m?.deep, sameDay: false,
              checkIn: null, price: m?.price ?? null, manual: m?.kind ?? 'extra' };
      }).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.unit.localeCompare(b.unit));
      // §133: what the inspection asked these cleans to do.
      const keys = upcoming.rows.map(r => r.key);
      if (keys.length) {
        const ts = await sql`SELECT cleaning_key AS key, text FROM clean_tasks WHERE account_id = 1 AND cleaning_key = ANY(${keys}::text[]) ORDER BY id` as
          { key: string; text: string }[];
        for (const r of upcoming.rows) r.tasks = ts.filter(t => t.key === r.key).map(t => t.text);
        // A confirm counts for the day it was given: moved to another day, it is asked again.
        const ok = await sql`SELECT cleaning_key AS key, clean_on::text AS day, created_at AS at FROM crew_accepts
                              WHERE account_id = 1 AND cleaner = ${c.name} AND cleaning_key = ANY(${keys}::text[])` as
          { key: string; day: string; at: string }[];
        for (const r of upcoming.rows) r.accepted = ok.find(a => a.key === r.key && a.day === r.date)?.at ?? null;
      }
      if (st.confirm) {
        upcoming.confirmed = { at: st.confirm.at, through: st.confirm.through };
        upcoming.movements = scheduleMovements(c.name, { items: st.confirm.snapshot, day: st.confirm.day, through: st.confirm.through,
          vis: st.confirm.vis }, st.now, today, vis, st.fate(c.name));
      }
    } catch (e) {
      upcoming.problem = c.lang === 'es'
        ? `No se pudo leer la agenda en este momento (${e instanceof Error ? e.message : String(e)}). Intenta de nuevo en un minuto.`
        : `The schedule could not be read just now (${e instanceof Error ? e.message : String(e)}). Try again in a minute.`;
    }
  }

  // One rule for what is ahead, everywhere on the page: a clean after today
  // reaches the cleaner only if "Coming up" shows it — the whole schedule
  // once published, else what a person assigned. The record holds the rule's
  // picks for the coming days too; unpublished, they are not the cleaner's yet.
  const ahead = new Set(upcoming.rows.map(r => r.key));
  const shown = cleans.filter(x => x.date <= today || ahead.has(x.key));
  return {
    cleaner: { name: c.name, level: c.level, invoicePeriod: c.invoice_period, active: c.active, lang: c.lang ?? 'en' },
    today, periods, period, cleans: shown, extras: extras.filter(e => shown.some(x => x.key === e.key)), extraFrom,
    invoice: buildInvoice(c.name, period, shown, extras, today),
    upcoming,
    ...await (async () => {
      const keys = [...new Set([...shown.filter(x => x.date >= addDays(today, -LINK_PAST_DAYS)).map(x => x.key), ...ahead])];
      const photos = keys.length ? await sql`SELECT id::text, cleaning_key AS key, stage FROM clean_photos
                                              WHERE account_id = 1 AND cleaning_key = ANY(${keys}::text[]) ORDER BY id` as { id: string; key: string; stage: Stage }[] : [];
      const fieldPhotos: Record<string, { id: string; stage: Stage }[]> = {};
      for (const p of photos) (fieldPhotos[p.key] ??= []).push({ id: p.id, stage: p.stage });
      return { field: await cleanStates(sql, keys), fieldPhotos };
    })()
  };
}

/* ── the two doors' shared handlers ───────────────────────────────── */

/** Who the page is for — never taken from the request body or query. */
export interface CrewCaller { name: string; by: string }

/** GET for whichever door identified the cleaner. */
export async function crewGet(request: Request, env: Env, sql: SqlFn, me: CrewCaller): Promise<Response> {
  // §134: one photo of one of THEIR cleans, from the team's Drive (they have no access to it) — never another's.
  const photoId = new URL(request.url).searchParams.get('photo');
  if (photoId) {
    const [ph] = await sql`SELECT p.drive_id FROM clean_photos p JOIN clean_records r ON r.account_id = p.account_id AND r.cleaning_key = p.cleaning_key
                            WHERE p.account_id = 1 AND p.id = ${Number(photoId) || 0} AND r.cleaner = ${me.name}` as { drive_id: string }[];
    if (!ph) return refuse(404, 'not_found', 'No such photo.');
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(ph.drive_id)}?alt=media`,
      { headers: { Authorization: `Bearer ${await driveToken(sql, env.ENCRYPTION_KEY)}` } });
    if (!res.ok) return refuse(502, 'drive', `Drive said ${res.status}.`);
    return new Response(res.body, { headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
  }
  const page = await loadCrewPage(sql, env.ENCRYPTION_KEY, me.name, new URL(request.url).searchParams.get('period'));
  if (!page) return refuse(404, 'not_on_roster', 'You are not on the roster any more.');
  // Their rating is the team's business — not sent, not just not drawn.
  delete page.cleaner.level;
  // How the page works, as the team wrote it — published SOPs only.
  // §129: one for each language — `crew.page` English, `crew.page.es` Spanish; the page shows the cleaner's.
  page.help = (await sql`SELECT title, purpose, steps, body, 'crew.page.es' = ANY(features) AS es FROM sops
                          WHERE account_id = 1 AND status = 'published' AND ('crew.page' = ANY(features) OR 'crew.page.es' = ANY(features))
                          ORDER BY title` as { title: string; purpose: string | null; steps: { text: string; detail?: string }[]; body: string | null; es: boolean }[])
    .map(h => ({ title: h.title, purpose: h.purpose, steps: h.steps, body: h.body, lang: h.es ? 'es' : 'en' }));
  const [items, units] = await Promise.all([invItems(sql), activeUnits(sql)]);
  // §150: cleaners take supplies — never the house's furniture (linens, dishes…), which is only counted.
  page.supplies = { items: items.filter(i => i.active && i.kind !== 'furniture').map(i => ({ id: i.id, name: i.name, measure: i.measure, category: i.category })), units };
  // §136: the codes for today's cleans only; ahead, just where to go.
  const acc = await accessByUnit(sql);
  const todays = [...page.upcoming.rows.filter(r => r.date === page.today), ...page.cleans.filter(c => c.date === page.today && !c.voidReason)];
  page.access = Object.fromEntries(todays.flatMap(c => { const a = acc.get(c.unit); return a ? [[c.key, strip(a)]] : []; }));
  // §150: where each clean's supplies come from (no code: that is for today's, in `access`).
  page.places = Object.fromEntries([...page.upcoming.rows, ...page.cleans]
    .flatMap(c => { const s = acc.get(c.unit)?.supplies; return s ? [[c.key, { ...s, code: null }]] : []; }));
  page.addresses = Object.fromEntries(page.upcoming.rows.filter(r => r.date > page.today)
    .flatMap(r => { const a = acc.get(r.unit)?.address; return a ? [[r.key, a]] : []; }));
  return Response.json({ ok: true, ...page });
}

/** What a cleaner is sent of a unit's access: never the team's bookkeeping (record ids, the unit id). */
export const strip = (a: UnitAccess & { unitId?: string; recordId?: string | null }): UnitAccess => {
  const { unitId: _u, recordId: _r, ...rest } = a;
  return rest;
};

/** "What I took" lines with the supplies' names, for the day's thread. */
export async function namedLines(sql: SqlFn, raw: unknown): Promise<{ name: string; qty: number }[]> {
  const list = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
  const items = await invItems(sql);
  return (Array.isArray(list) ? list : []).filter((x: { qty?: unknown }) => Number(x.qty) > 0)
    .map((x: { itemId?: unknown; qty?: unknown }) => ({ name: items.find(i => i.id === String(x.itemId))?.name ?? '?', qty: Number(x.qty) }));
}

/** Each extra's evidence files, in place. */
export async function attachFiles(sql: SqlFn, extras: { id: string; files?: CrewExtra['files'] }[]): Promise<void> {
  if (!extras.length) return;
  const files = await sql`SELECT id::text, extra_id::text AS extra, name, url FROM cleaning_extra_files
                           WHERE account_id = 1 AND extra_id = ANY(${extras.map(e => Number(e.id))}::bigint[]) ORDER BY id` as
    { id: string; extra: string; name: string; url: string }[];
  for (const e of extras) e.files = files.filter(f => f.extra === e.id).map(f => ({ id: f.id, name: f.name, url: f.url }));
}

/** A helper's link (§134): for a clean ahead or done in the last LINK_PAST_DAYS, good until LINK_AFTER_DAYS after it. */
const LINK_PAST_DAYS = 3, LINK_AFTER_DAYS = 2;

/** Evidence limits: a few photos or PDFs per request, each small enough to pass through the Worker. */
const MAX_FILES = 5;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Files to Drive, into the account's crew-extras folder (made on first use). Nothing is written if one fails. */
async function uploadEvidence(sql: SqlFn, encryptionKey: string, files: File[], label: string, say: Say = (en) => en) {
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) throw new DriveError(say(`${f.name} is over 15 MB — send a smaller photo or a PDF.`, `${f.name} pesa más de 15 MB — envía una foto más pequeña o un PDF.`));
    if (!/^(image\/|application\/pdf$)/.test(f.type || '')) throw new DriveError(say(`${f.name}: a photo or a PDF, please.`, `${f.name}: una foto o un PDF, por favor.`));
  }
  const token = await driveToken(sql, encryptionKey);
  const [acc] = await sql`SELECT crew_extras_folder FROM accounts WHERE id = 1` as { crew_extras_folder: string | null }[];
  let folder = acc?.crew_extras_folder ?? null;
  if (!folder) {
    folder = (await createFolder(token, null, 'Kaizen — crew extras')).id;
    await sql`UPDATE accounts SET crew_extras_folder = ${folder} WHERE id = 1`;
    // Owner, 2026-10-14: the whole team opens what Kaizen keeps in Drive.
    await shareRoot(sql, token, folder).catch(() => []);
  }
  const out = [];
  for (const f of files) {
    const up = await uploadFile(token, folder, `${label} — ${f.name}`.slice(0, 200), f.type || 'application/octet-stream', await f.arrayBuffer());
    out.push({ name: f.name.slice(0, 200), mime: f.type || null, size: f.size, driveId: up.id, url: up.webViewLink ?? `https://drive.google.com/file/d/${up.id}/view` });
  }
  return out;
}

async function saveFiles(sql: SqlFn, extraId: number, by: string, files: Awaited<ReturnType<typeof uploadEvidence>>) {
  if (!files.length) return;
  await sql`INSERT INTO cleaning_extra_files (account_id, extra_id, name, mime_type, size, drive_id, url, uploaded_by)
            SELECT 1, ${extraId}, n, m, s, d, u, ${by}
              FROM unnest(${files.map(f => f.name)}::text[], ${files.map(f => f.mime)}::text[], ${files.map(f => f.size)}::bigint[],
                          ${files.map(f => f.driveId)}::text[], ${files.map(f => f.url)}::text[]) AS t(n, m, s, d, u)`;
}

/** A message in the cleaner's language (§129). */
type Say = (en: string, es: string) => string;

/** POST for whichever door identified the cleaner. JSON, or multipart when files come along. */
export async function crewPost(request: Request, env: Env, sql: SqlFn, me: CrewCaller,
                               waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  let body: Record<string, unknown> = {};
  let files: File[] = [];
  if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
    const form = await request.formData().catch(() => null);
    if (!form) return refuse(400, 'bad_request', 'Could not read the upload. / No se pudo leer el archivo.');
    for (const [k, v] of form.entries()) {
      if (k === 'file') { if (typeof v !== 'string') files.push(v); } else body[k] = v;
    }
  } else {
    body = await request.json().catch(() => ({})) as Record<string, unknown>;
  }
  const [who] = await sql`SELECT lang FROM cleaners WHERE account_id = 1 AND name = ${me.name}` as { lang: 'en' | 'es' }[];
  const say: Say = (en, es) => who?.lang === 'es' ? es : en;
  // Owner, 2026-10-14: what they do or ask for shows in their own channel too (helpers' already did), to follow up there.
  const tellMine = (e: HelperEvent, photosKey?: string, todoId?: string | null) =>
    waitUntil(tellCleaner(sql, env.ENCRYPTION_KEY, me.name, e, photosKey, todoId));
  const unitOf = async (key: string) =>
    ((await sql`SELECT unit_name FROM cleanings WHERE account_id = 1 AND key = ${key}` as { unit_name: string | null }[])[0]?.unit_name) ?? null;
  if (files.length > MAX_FILES) return refuse(400, 'bad_request', say(`At most ${MAX_FILES} files at a time.`, `Máximo ${MAX_FILES} archivos a la vez.`));
  const today = todayIn(TZ);

  // §129: the page's language, remembered for every device they sign in from.
  if (body.action === 'setLang') {
    const lang = body.lang === 'es' ? 'es' : body.lang === 'en' ? 'en' : null;
    if (!lang) return refuse(400, 'bad_request', 'en or es.');
    await sql`UPDATE cleaners SET lang = ${lang} WHERE account_id = 1 AND name = ${me.name}`;
    return Response.json({ ok: true });
  }

  if (body.action === 'addExtra') {
    const key = String(body.key ?? '');
    const amount = Math.round(Number(body.amount) * 100) / 100;
    const description = String(body.description ?? '').trim().slice(0, 300);
    if (!(amount > 0) || amount > EXTRA_MAX_AMOUNT) return refuse(400, 'bad_request', say(`An extra is more than $0 and at most $${EXTRA_MAX_AMOUNT}.`, `Un extra es de más de $0 y como máximo $${EXTRA_MAX_AMOUNT}.`));
    if (!description) return refuse(400, 'bad_request', say('Say what the extra is for.', 'Di para qué es el extra.'));
    // Only on their own clean, done, paid, and recent.
    const [c] = await sql`SELECT checkout_on::text AS date, unit_name FROM cleanings
                           WHERE account_id = 1 AND key = ${key} AND cleaner = ${me.name} AND assignment = 'assigned'
                             AND void_reason IS NULL` as { date: string; unit_name: string }[];
    if (!c) return refuse(400, 'bad_request', say('That clean is not one of yours.', 'Esa limpieza no es tuya.'));
    if (c.date > today) return refuse(400, 'bad_request', say('Add extras once the clean is done.', 'Agrega extras cuando la limpieza esté hecha.'));
    if (c.date < addDays(today, -EXTRA_MAX_AGE_DAYS)) return refuse(400, 'bad_request', say(`Extras go in within ${EXTRA_MAX_AGE_DAYS} days of the clean.`, `Los extras se agregan dentro de los ${EXTRA_MAX_AGE_DAYS} días de la limpieza.`));
    // The evidence first: an extra is not saved with half its receipts.
    let up: Awaited<ReturnType<typeof uploadEvidence>> = [];
    try { up = await uploadEvidence(sql, env.ENCRYPTION_KEY, files, `${c.date} ${c.unit_name} — ${me.name}`, say); }
    catch (e) { return refuse(502, 'upload', say(`The file could not be saved, so the extra was not sent: ${e instanceof Error ? e.message : String(e)}`, `No se pudo guardar el archivo, así que el extra no se envió: ${e instanceof Error ? e.message : String(e)}`)); }
    const [row] = await sql`INSERT INTO cleaning_extras (account_id, cleaning_key, cleaner, amount, description, created_by)
                            VALUES (1, ${key}, ${me.name}, ${amount}, ${description}, ${me.by}) RETURNING id` as { id: number }[];
    await saveFiles(sql, Number(row!.id), me.by, up);
    waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, key, { kind: 'event', by: me.name, event: { kind: 'extra', amount, description } },
                              { unit: c.unit_name, date: c.date }));
    tellMine({ by: me.name, unit: c.unit_name, kind: 'extra', amount, description });
    return Response.json({ ok: true });
  }

  // More evidence on an extra still waiting for the team.
  if (body.action === 'attachFile') {
    if (!files.length) return refuse(400, 'bad_request', say('No file.', 'No hay archivo.'));
    const [e] = await sql`SELECT e.id, c.checkout_on::text AS date, c.unit_name FROM cleaning_extras e
                           JOIN cleanings c ON c.account_id = e.account_id AND c.key = e.cleaning_key
                          WHERE e.account_id = 1 AND e.id = ${Number(body.id) || 0} AND e.cleaner = ${me.name} AND e.status = 'pending'` as
      { id: number; date: string; unit_name: string }[];
    if (!e) return refuse(400, 'bad_request', say('Files go on an extra of yours still waiting for the team.', 'Los archivos van en un extra tuyo que todavía espera al equipo.'));
    let up: Awaited<ReturnType<typeof uploadEvidence>> = [];
    try { up = await uploadEvidence(sql, env.ENCRYPTION_KEY, files, `${e.date} ${e.unit_name} — ${me.name}`, say); }
    catch (err) { return refuse(502, 'upload', say(`The file could not be saved: ${err instanceof Error ? err.message : String(err)}`, `No se pudo guardar el archivo: ${err instanceof Error ? err.message : String(err)}`)); }
    await saveFiles(sql, Number(e.id), me.by, up);
    return Response.json({ ok: true });
  }

  // Turning down a clean on their schedule: it becomes unassigned (TBD)
  // for the team, and the rule will not hand it back to them.
  if (body.action === 'decline') {
    const key = String(body.key ?? '');
    const reason = String(body.reason ?? '').trim().slice(0, 300) || null;
    const acc = await crewVisibility(sql);
    // Turned down after confirming: the ✓ goes (it is gone from their schedule either way).
    const dropAccept = () => sql`DELETE FROM crew_accepts WHERE account_id = 1 AND cleaning_key = ${key} AND cleaner = ${me.name}`;
    if (key.startsWith('MAN-')) {
      const [m] = await sql`UPDATE cleanings SET assignment = 'tbd', cleaner = NULL, price = NULL, decided_by = ${`declined by ${me.name}`}
                             WHERE account_id = 1 AND key = ${key} AND cleaner = ${me.name} AND assignment = 'assigned'
                               AND void_reason IS NULL AND checkout_on >= ${today}::date
                            RETURNING checkout_on::text AS date, unit_name` as { date: string; unit_name: string }[];
      if (!m) return refuse(400, 'bad_request', say('That clean is not on your schedule any more.', 'Esa limpieza ya no está en tu agenda.'));
      await sql`INSERT INTO crew_declines (account_id, cleaning_key, cleaner, clean_on, unit_name, reason, created_by)
                VALUES (1, ${key}, ${me.name}, ${m.date}, ${m.unit_name}, ${reason}, ${me.by})`;
      await dropAccept();
      waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, key, { kind: 'event', by: me.name, event: { kind: 'declined', reason } },
                                { unit: m.unit_name, date: m.date }));
      tellMine({ by: me.name, unit: m.unit_name, kind: 'declined', reason: reason ?? '' });
      return Response.json({ ok: true });
    }
    // A checkout: only one the board gives them right now.
    const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
    const s = await loadOps(sql, creds, { days: acc.days });
    const row = s.rows.find(r => r.kind === 'out' && r.resId === key);
    // Only what their page shows them: the whole schedule once shared, else what a person assigned (§123).
    if (!row || row.assignment !== 'assigned' || row.cleaner !== me.name || row.date < today ||
        !visibleAhead({ date: row.date, byHand: row.manual.cleaner }, today, acc)) {
      return refuse(400, 'bad_request', say('That clean is not on your schedule any more.', 'Esa limpieza ya no está en tu agenda.'));
    }
    await sql`INSERT INTO turnover_overrides (account_id, reservation_id, assignment, cleaner, updated_by)
              VALUES (1, ${key}, 'tbd', NULL, ${`declined by ${me.name}`})
              ON CONFLICT (account_id, reservation_id) DO UPDATE SET assignment = 'tbd', cleaner = NULL,
                updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await sql`INSERT INTO crew_declines (account_id, cleaning_key, cleaner, clean_on, unit_name, reason, created_by)
              VALUES (1, ${key}, ${me.name}, ${row.date}, ${row.unit}, ${reason}, ${me.by})`;
    await dropAccept();
    waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, key, { kind: 'event', by: me.name, event: { kind: 'declined', reason } },
                              { unit: row.unit, date: row.date }));
    tellMine({ by: me.name, unit: row.unit, kind: 'declined', reason: reason ?? '' });
    // Live: the record and the Host Note follow at once, as for any reassignment.
    if (s.mode === 'live') {
      waitUntil((async () => {
        try {
          const s2 = await loadOps(sql, creds);
          await recordCleanings(sql, s2);
          await pushHostNotes(sql, creds, s2, [key]);
        } catch { /* the scheduled pass retries whatever did not land */ }
      })());
    }
    return Response.json({ ok: true });
  }

  // Owner, 2026-10-17: "I'll do it" on a clean ahead — the team sees a ✓ on the board. It does not
  // lock anything: the cleaner can still turn it down, and a clean moved to another day is asked again.
  if (body.action === 'accept') {
    const key = String(body.key ?? '');
    let mine: { date: string; unit: string } | null = null;
    if (key.startsWith('MAN-')) {
      const [m] = await sql`SELECT checkout_on::text AS date, unit_name AS unit FROM cleanings
                             WHERE account_id = 1 AND key = ${key} AND cleaner = ${me.name} AND assignment = 'assigned'
                               AND void_reason IS NULL AND checkout_on >= ${today}::date` as { date: string; unit: string }[];
      mine = m ?? null;
    } else {
      const acc = await crewVisibility(sql);
      const s = await loadOps(sql, await getCredentials(sql, env.ENCRYPTION_KEY), { days: acc.days });
      const row = s.rows.find(r => r.kind === 'out' && r.resId === key);
      if (row && row.assignment === 'assigned' && row.cleaner === me.name && row.date >= today &&
          visibleAhead({ date: row.date, byHand: row.manual.cleaner }, today, acc)) mine = { date: row.date, unit: row.unit };
    }
    if (!mine) return refuse(400, 'bad_request', say('That clean is not on your schedule any more.', 'Esa limpieza ya no está en tu agenda.'));
    await sql`INSERT INTO crew_accepts (account_id, cleaning_key, cleaner, clean_on, unit_name, created_by)
              VALUES (1, ${key}, ${me.name}, ${mine.date}, ${mine.unit}, ${me.by})
              ON CONFLICT (account_id, cleaning_key, cleaner) DO UPDATE SET clean_on = EXCLUDED.clean_on,
                unit_name = EXCLUDED.unit_name, created_by = EXCLUDED.created_by, created_at = now()`;
    return Response.json({ ok: true });
  }

  // §134: supplies taken, bought or missing; a problem or a request — each from the field, each to the team.
  if (body.action === 'supply' || body.action === 'problem' || body.action === 'request') {
    const who2 = { name: me.name, source: 'cleaner' as const };
    try {
      const photos = await fieldPhotos(sql, env.ENCRYPTION_KEY, files, `${me.name} ${String(body.kind ?? body.action)}`);
      const what = String(body.action === 'supply' ? body.kind : body.action);
      let r: string | null = null, fresh = true, text = String(body.text ?? '').trim().slice(0, 300);
      if (body.action !== 'supply') ({ todoId: r, fresh } = await fieldTodo(sql, who2, { ...body, kind: body.action }, photos));
      else if (body.kind === 'used') {
        const used = await recordUses(sql, who2, body);
        waitUntil(lowStock(sql, [used.place]).then(ids => mirrorTodos(sql, env.ENCRYPTION_KEY, ids, 'Kaizen')).catch(() => {}));
      }
      // §150: what they bought, in their own words — the team records it in Inventory when approving it.
      else if (body.kind === 'purchase') ({ todoId: r, fresh } = await fieldPurchase(sql, who2, body, photos));
      else {
        const m = await recordMove(sql, who2, body, photos);
        r = m.todoId; fresh = m.fresh; text = `${m.item} (found ${Number(body.qty) || 0})`;
      }
      waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [r], me.name, fresh));
      // §136: Ops sees it in the day's thread too, on that clean.
      const ck = String(body.cleaningKey ?? '');
      if (ck && what !== 'used' && ['problem', 'request', 'missing', 'purchase'].includes(what)) {
        waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, ck, { kind: 'event', by: me.name, event: {
          kind: 'report', what: what as 'problem', text, priority: String(body.priority ?? '') || null, todoId: r } }));
      }
      if (what !== 'used') tellMine({ by: me.name, unit: ck ? await unitOf(ck) : null, kind: 'report', what, text,
                                      priority: String(body.priority ?? '') || null }, undefined, r);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      return refuse(400, 'bad_request', who?.lang === 'es' ? esMessage(m) : m);
    }
    return Response.json({ ok: true });
  }

  // §134: a clean the cleaner reports on must be one their page shows — coming, or done in the last
  // days. Checked against the page the first time (it reads the schedule), then by its field record.
  const myClean = async (key: string) => {
    const [r] = await sql`SELECT unit_name, clean_date::text AS date FROM clean_records
                           WHERE account_id = 1 AND cleaning_key = ${key} AND cleaner = ${me.name}` as { unit_name: string; date: string }[];
    if (r && r.date >= addDays(today, -LINK_PAST_DAYS)) return { unit: r.unit_name, date: r.date };
    const page = await loadCrewPage(sql, env.ENCRYPTION_KEY, me.name);
    const recent = page?.cleans.find(c => c.key === key && !c.voidReason && c.date <= today && c.date >= addDays(today, -LINK_PAST_DAYS));
    const ahead = page?.upcoming.rows.find(x => x.key === key);
    const clean = ahead ? { unit: ahead.unit, date: ahead.date } : recent ? { unit: recent.unit, date: recent.date } : null;
    if (!clean) return null;
    const [u] = await sql`SELECT id FROM units WHERE account_id = 1 AND name = ${clean.unit}` as { id: string }[];
    await ensureRecord(sql, { key, cleaner: me.name, unitId: u?.id ?? null, unitName: clean.unit, date: clean.date });
    return clean;
  };
  const notMine = () => refuse(400, 'bad_request', say('That clean is not on your page any more.', 'Esa limpieza ya no está en tu página.'));
  const inLang = (e: unknown) => { const m = e instanceof Error ? e.message : String(e); return who?.lang === 'es' ? esMessage(m) : m; };

  // §134: a link for the person helping on ONE clean — no account; it only reports, for that clean.
  // The same link is given again while it lasts (kept encrypted for that); it ends two days after the clean.
  if (body.action === 'cleanLink') {
    const key = String(body.key ?? '');
    const clean = await myClean(key);
    if (!clean) return notMine();
    const expires = addDays(clean.date, LINK_AFTER_DAYS);
    const [had] = await sql`SELECT token_enc FROM clean_links WHERE account_id = 1 AND cleaner = ${me.name} AND cleaning_key = ${key}
                               AND expires_on >= ${today}::date` as { token_enc: string }[];
    let token = had ? await decrypt(had.token_enc, env.ENCRYPTION_KEY).catch(() => null) : null;
    if (!token) {
      token = newToken();
      const [u] = await sql`SELECT id FROM units WHERE account_id = 1 AND name = ${clean.unit}` as { id: string }[];
      await sql`INSERT INTO clean_links (account_id, cleaner, cleaning_key, unit_id, unit_name, clean_date, expires_on, token_enc, token_hash)
                VALUES (1, ${me.name}, ${key}, ${u?.id ?? null}, ${clean.unit}, ${clean.date}, ${expires},
                        ${await encrypt(token, env.ENCRYPTION_KEY)}, ${await sha256(token)})
                ON CONFLICT (account_id, cleaner, cleaning_key) DO UPDATE
                  SET token_enc = EXCLUDED.token_enc, token_hash = EXCLUDED.token_hash, unit_id = EXCLUDED.unit_id,
                      unit_name = EXCLUDED.unit_name, clean_date = EXCLUDED.clean_date, expires_on = EXCLUDED.expires_on, created_at = now()`;
    }
    return Response.json({ ok: true, link: `${new URL(request.url).origin}/report#t=${token}`, unit: clean.unit, date: clean.date, expires });
  }

  // §134: a clean's steps — photos before / after to the team's Drive, what was taken from the
  // storage (or nothing), and done / reopened.
  if (body.action === 'cleanPhoto' || body.action === 'cleanMark' || body.action === 'cleanTaken' || body.action === 'cleanNothing') {
    const key = String(body.key ?? '');
    if (!(await myClean(key))) return notMine();
    const by = { name: me.name, source: 'cleaner' as const };
    try {
      if (body.action === 'cleanTaken' || body.action === 'cleanNothing') {
        const [u] = await sql`SELECT unit_id FROM clean_records WHERE account_id = 1 AND cleaning_key = ${key}` as { unit_id: string | null }[];
        const inv = { name: me.name, source: 'cleaner' as const };
        // §150: "none left" of something — marked ⚠ at the place and requested at once.
        const out = await ranOut(sql, inv, key, u?.unit_id ?? null, body.out);
        if (out) waitUntil(mirrorTodos(sql, env.ENCRYPTION_KEY, [out.todoId], me.name, out.fresh));
        if (body.action === 'cleanTaken') {
          const used = await recordUses(sql, inv, { lines: body.lines, cleaningKey: key, unitId: u?.unit_id ?? null });
          // §150: below the minimum → a "Low stock" to-do, when Setup has it on.
          waitUntil(lowStock(sql, [used.place]).then(ids => mirrorTodos(sql, env.ENCRYPTION_KEY, ids, 'Kaizen')).catch(() => {}));
          const lines = await namedLines(sql, body.lines);
          waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, key, { kind: 'event', by: me.name, event: { kind: 'taken', lines } }));
          tellMine({ by: me.name, unit: await unitOf(key), kind: 'taken', lines });
        } else {
          await nothingTaken(sql, inv, key);
          waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, key, { kind: 'event', by: me.name, event: { kind: 'nothing' } }));
          tellMine({ by: me.name, unit: await unitOf(key), kind: 'nothing' });
        }
      } else if (body.action === 'cleanPhoto') {
        const stage = String(body.stage) as Stage;
        await addPhotos(sql, env.ENCRYPTION_KEY, key, stage, files, by);
        waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, key, { kind: 'photos', stage, by: me.name }));
        // One growing line per clean and stage for their own photos (the helpers' have theirs).
        const [n] = await sql`SELECT count(*)::int AS n FROM clean_photos WHERE account_id = 1 AND cleaning_key = ${key} AND stage = ${stage}
                                AND source = 'cleaner'` as { n: number }[];
        tellMine({ by: me.name, unit: await unitOf(key), kind: 'photos', stage, n: n?.n ?? files.length }, `own:${key}:${stage}`);
      } else {
        const kind = String(body.kind) as 'done' | 'reopened';
        if (await markClean(sql, key, kind, by)) {
          waitUntil(tellCleanThread(sql, env.ENCRYPTION_KEY, key, { kind }));
          tellMine({ by: me.name, unit: await unitOf(key), kind });
        }
      }
    } catch (e) { return refuse(400, 'bad_request', inLang(e)); }
    return Response.json({ ok: true, state: (await cleanStates(sql, [key]))[key] });
  }

  if (body.action === 'cancelExtra') {
    const done = await sql`UPDATE cleaning_extras SET status = 'cancelled', decided_by = ${me.by}, decided_at = now()
                            WHERE account_id = 1 AND id = ${Number(body.id) || 0} AND cleaner = ${me.name} AND status = 'pending'
                            RETURNING id`;
    if (!done.length) return refuse(400, 'bad_request', say('Only an extra still waiting for the team can be withdrawn.', 'Solo se puede retirar un extra que todavía espera al equipo.'));
    return Response.json({ ok: true });
  }

  return refuse(400, 'bad_request', 'Unknown action.');
}

export function refuse(status: number, error: string, message: string): Response {
  return Response.json({ ok: false, error, message }, { status });
}
