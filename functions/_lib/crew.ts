/**
 * The crew page (§122), server side: one cleaner's record, extras,
 * invoice and — when the team has turned it on — what is coming.
 *
 * One loader for both doors: the cleaner's own (/api/crew) and the team's
 * preview of it (/api/crew-admin), so what the team checks is exactly what
 * the cleaner sees.
 */
import type { SqlFn } from './accounts.ts';
import { getCredentials } from './accounts.ts';
import type { Env } from './db.ts';
import { loadOps, pushHostNotes, recordCleanings } from './ops.ts';
import { DriveError, createFolder, driveToken, uploadFile } from './gdrive.ts';
import { addDays, todayIn, type DateStr } from '../../src/lib/dates.ts';
import { starsOf } from '../../src/lib/operations.ts';
import {
  buildInvoice, periodOf, recentPeriods, scheduleMovements, EXTRA_MAX_AGE_DAYS, EXTRA_MAX_AMOUNT,
  type CrewClean, type CrewExtra, type Fate, type InvoicePeriod, type Movement, type Period, type ScheduleItem
} from '../../src/lib/crew.ts';

const TZ = 'America/New_York';
const PERIODS_SHOWN = 6;

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
}

export interface CrewPage {
  /** `stars` only for the team: a cleaner is never shown their own rating. */
  cleaner: { name: string; stars?: number; invoicePeriod: InvoicePeriod; active: boolean };
  today: DateStr;
  periods: Period[];
  period: Period;
  /** The selected period's cleans, and every clean an extra can still be asked on. */
  cleans: CrewClean[];
  extras: CrewExtra[];
  invoice: ReturnType<typeof buildInvoice>;
  /** Cleans an extra can be added to: done, theirs, not excluded, recent. */
  extraFrom: DateStr;
  upcoming: {
    enabled: boolean; days: number; through: DateStr | null; rows: CrewUpcoming[]; problem: string | null;
    /** The team's last confirmation of the schedule — when, and how far it reached. */
    confirmed: { at: string; through: DateStr } | null;
    /** What moved for this cleaner since then. */
    movements: Movement[];
  };
}

/* ── the schedule: what it is now, what was confirmed, what moved ─── */

type Ops = Awaited<ReturnType<typeof loadOps>>;

/** Every assigned clean from today through the board's end — checkouts and manual cleans. */
async function scheduleNow(sql: SqlFn, s: Ops): Promise<ScheduleItem[]> {
  const items: ScheduleItem[] = s.rows
    .filter(r => r.kind === 'out' && r.assignment === 'assigned' && r.cleaner && r.date >= s.today)
    .map(r => ({ key: r.resId, cleaner: r.cleaner!, date: r.date, unit: r.unit, time: r.time }));
  const manual = await sql`
    SELECT key, cleaner, checkout_on::text AS date, unit_name, coalesce(checkout_time, '') AS time FROM cleanings
     WHERE account_id = 1 AND key LIKE 'MAN-%' AND assignment = 'assigned' AND cleaner IS NOT NULL AND void_reason IS NULL
       AND checkout_on >= ${s.today}::date AND checkout_on <= ${s.end}::date` as
    { key: string; cleaner: string; date: string; unit_name: string; time: string }[];
  return [...items, ...manual.map(m => ({ key: m.key, cleaner: m.cleaner, date: m.date, unit: m.unit_name, time: m.time }))];
}

export interface ScheduleState {
  s: Ops; now: ScheduleItem[];
  confirm: { at: string; by: string; through: DateStr; snapshot: ScheduleItem[] } | null;
  /** What happened to a confirmed clean that left this cleaner's schedule. */
  fate: (cleaner: string) => (key: string) => Fate;
}

export async function scheduleState(sql: SqlFn, encryptionKey: string, days: number): Promise<ScheduleState> {
  const s = await loadOps(sql, await getCredentials(sql, encryptionKey), { days });
  const [now, confirms] = await Promise.all([
    scheduleNow(sql, s),
    sql`SELECT to_char(confirmed_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS at, confirmed_by AS by,
               through::text AS through, snapshot
          FROM crew_schedule_confirms WHERE account_id = 1 ORDER BY id DESC LIMIT 1`
  ]) as [ScheduleItem[], { at: string; by: string; through: string; snapshot: ScheduleItem[] }[]];
  const confirm = confirms[0] ?? null;
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

/** The team confirms the schedule as it stands: what cleaners' "changes since" are measured from. */
export async function confirmSchedule(sql: SqlFn, encryptionKey: string, by: string) {
  const [acc] = await sql`SELECT crew_calendar_days FROM accounts WHERE id = 1` as { crew_calendar_days: number }[];
  const s = await loadOps(sql, await getCredentials(sql, encryptionKey), { days: acc?.crew_calendar_days ?? 14 });
  const items = await scheduleNow(sql, s);
  await sql`INSERT INTO crew_schedule_confirms (account_id, through, snapshot, confirmed_by)
            VALUES (1, ${s.end}, ${JSON.stringify(items)}::jsonb, ${by})`;
  return { through: s.end, cleans: items.length };
}

export async function findCleaner(sql: SqlFn, name: string) {
  const [c] = await sql`SELECT name, stars, invoice_period, active FROM cleaners WHERE account_id = 1 AND name = ${name}` as
    { name: string; stars: number; invoice_period: InvoicePeriod; active: boolean }[];
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
                                   asked?: string | null, preloaded?: ScheduleState): Promise<CrewPage | null> {
  const c = await findCleaner(sql, name);
  if (!c) return null;
  const today = todayIn(TZ);
  const periods = recentPeriods(today, c.invoice_period, PERIODS_SHOWN);
  const period = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) && asked <= today ? periodOf(asked, c.invoice_period) : periods[0]!;
  const extraFrom = addDays(today, -EXTRA_MAX_AGE_DAYS);
  const from = period.from < extraFrom ? period.from : extraFrom;
  const to = period.to > today ? period.to : today;

  const [rows, acc] = await Promise.all([
    sql`SELECT key, unit_name, checkout_on::text AS date, beds, deep, kind, price::float AS price, assignment,
               void_reason, flag_note
          FROM cleanings WHERE account_id = 1 AND cleaner = ${c.name}
           AND checkout_on >= ${from}::date AND checkout_on <= ${to}::date
         ORDER BY checkout_on, unit_name`,
    sql`SELECT crew_calendar, crew_calendar_days FROM accounts WHERE id = 1`
  ]) as [{ key: string; unit_name: string; date: string; beds: number | null; deep: boolean; kind: string | null;
           price: number | null; assignment: string; void_reason: string | null; flag_note: string | null }[],
         { crew_calendar: boolean; crew_calendar_days: number }[]];
  const cleans: CrewClean[] = rows.map(r => ({
    key: r.key, unit: r.unit_name, date: r.date, beds: r.beds, deep: !!r.deep, kind: r.kind ?? 'checkout',
    price: r.price, assignment: r.assignment, voidReason: r.void_reason, flagNote: r.flag_note
  }));
  const keys = cleans.map(x => x.key);
  const extras = keys.length ? (await sql`
    SELECT id::text, cleaning_key AS key, amount::float AS amount, description, status, decision_note AS "decisionNote",
           decided_by AS "decidedBy", to_char(created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS "createdAt"
      FROM cleaning_extras WHERE account_id = 1 AND cleaner = ${c.name} AND cleaning_key = ANY(${keys}::text[])
     ORDER BY created_at` as CrewExtra[]) : [];
  await attachFiles(sql, extras);

  const enabled = !!acc[0]?.crew_calendar;
  const days = acc[0]?.crew_calendar_days ?? 14;
  const upcoming: CrewPage['upcoming'] = { enabled, days, through: null, rows: [], problem: null, confirmed: null, movements: [] };
  if (enabled) {
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
      upcoming.rows = st.now.filter(i => i.cleaner === c.name).map(i => {
        const r = outs.get(i.key), m = man.get(i.key);
        return r
          ? { key: i.key, date: i.date, unit: i.unit, beds: r.beds, time: r.time, deep: r.deep, sameDay: r.urgency === 'turnover',
              checkIn: checkIn.get(`${r.unitId}|${r.date}`) ?? null, price: r.price, manual: null }
          : { key: i.key, date: i.date, unit: i.unit, beds: m?.beds ?? null, time: i.time, deep: !!m?.deep, sameDay: false,
              checkIn: null, price: m?.price ?? null, manual: m?.kind ?? 'extra' };
      }).sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.unit.localeCompare(b.unit));
      if (st.confirm) {
        upcoming.confirmed = { at: st.confirm.at, through: st.confirm.through };
        upcoming.movements = scheduleMovements(c.name, st.confirm.snapshot, st.now, st.confirm.through, today, st.fate(c.name));
      }
    } catch (e) {
      upcoming.problem = `The schedule could not be read just now (${e instanceof Error ? e.message : String(e)}). Try again in a minute.`;
    }
  }

  return {
    cleaner: { name: c.name, stars: starsOf({ stars: c.stars } as never), invoicePeriod: c.invoice_period, active: c.active },
    today, periods, period, cleans, extras, extraFrom,
    invoice: buildInvoice(c.name, period, cleans, extras, today),
    upcoming
  };
}

/* ── the two doors' shared handlers ───────────────────────────────── */

/** Who the page is for — never taken from the request body or query. */
export interface CrewCaller { name: string; by: string }

/** GET for whichever door identified the cleaner. */
export async function crewGet(request: Request, env: Env, sql: SqlFn, me: CrewCaller): Promise<Response> {
  const page = await loadCrewPage(sql, env.ENCRYPTION_KEY, me.name, new URL(request.url).searchParams.get('period'));
  if (!page) return refuse(404, 'not_on_roster', 'You are not on the roster any more.');
  // Their rating is the team's business — not sent, not just not drawn.
  delete page.cleaner.stars;
  return Response.json({ ok: true, ...page });
}

/** Each extra's evidence files, in place. */
export async function attachFiles(sql: SqlFn, extras: { id: string; files?: CrewExtra['files'] }[]): Promise<void> {
  if (!extras.length) return;
  const files = await sql`SELECT id::text, extra_id::text AS extra, name, url FROM cleaning_extra_files
                           WHERE account_id = 1 AND extra_id = ANY(${extras.map(e => Number(e.id))}::bigint[]) ORDER BY id` as
    { id: string; extra: string; name: string; url: string }[];
  for (const e of extras) e.files = files.filter(f => f.extra === e.id).map(f => ({ id: f.id, name: f.name, url: f.url }));
}

/** Evidence limits: a few photos or PDFs per request, each small enough to pass through the Worker. */
const MAX_FILES = 5;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Files to Drive, into the account's crew-extras folder (made on first use). Nothing is written if one fails. */
async function uploadEvidence(sql: SqlFn, encryptionKey: string, files: File[], label: string) {
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) throw new DriveError(`${f.name} is over 15 MB — send a smaller photo or a PDF.`);
    if (!/^(image\/|application\/pdf$)/.test(f.type || '')) throw new DriveError(`${f.name}: a photo or a PDF, please.`);
  }
  const token = await driveToken(sql, encryptionKey);
  const [acc] = await sql`SELECT crew_extras_folder FROM accounts WHERE id = 1` as { crew_extras_folder: string | null }[];
  let folder = acc?.crew_extras_folder ?? null;
  if (!folder) {
    folder = (await createFolder(token, null, 'Kaizen — crew extras')).id;
    await sql`UPDATE accounts SET crew_extras_folder = ${folder} WHERE id = 1`;
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

/** POST for whichever door identified the cleaner. JSON, or multipart when files come along. */
export async function crewPost(request: Request, env: Env, sql: SqlFn, me: CrewCaller,
                               waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  let body: Record<string, unknown> = {};
  let files: File[] = [];
  if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
    const form = await request.formData().catch(() => null);
    if (!form) return refuse(400, 'bad_request', 'Could not read the upload.');
    for (const [k, v] of form.entries()) {
      if (k === 'file') { if (typeof v !== 'string') files.push(v); } else body[k] = v;
    }
  } else {
    body = await request.json().catch(() => ({})) as Record<string, unknown>;
  }
  if (files.length > MAX_FILES) return refuse(400, 'bad_request', `At most ${MAX_FILES} files at a time.`);
  const today = todayIn(TZ);

  if (body.action === 'addExtra') {
    const key = String(body.key ?? '');
    const amount = Math.round(Number(body.amount) * 100) / 100;
    const description = String(body.description ?? '').trim().slice(0, 300);
    if (!(amount > 0) || amount > EXTRA_MAX_AMOUNT) return refuse(400, 'bad_request', `An extra is more than $0 and at most $${EXTRA_MAX_AMOUNT}.`);
    if (!description) return refuse(400, 'bad_request', 'Say what the extra is for.');
    // Only on their own clean, done, paid, and recent.
    const [c] = await sql`SELECT checkout_on::text AS date, unit_name FROM cleanings
                           WHERE account_id = 1 AND key = ${key} AND cleaner = ${me.name} AND assignment = 'assigned'
                             AND void_reason IS NULL` as { date: string; unit_name: string }[];
    if (!c) return refuse(400, 'bad_request', 'That clean is not one of yours.');
    if (c.date > today) return refuse(400, 'bad_request', 'Add extras once the clean is done.');
    if (c.date < addDays(today, -EXTRA_MAX_AGE_DAYS)) return refuse(400, 'bad_request', `Extras go in within ${EXTRA_MAX_AGE_DAYS} days of the clean.`);
    // The evidence first: an extra is not saved with half its receipts.
    let up: Awaited<ReturnType<typeof uploadEvidence>> = [];
    try { up = await uploadEvidence(sql, env.ENCRYPTION_KEY, files, `${c.date} ${c.unit_name} — ${me.name}`); }
    catch (e) { return refuse(502, 'upload', `The file could not be saved, so the extra was not sent: ${e instanceof Error ? e.message : String(e)}`); }
    const [row] = await sql`INSERT INTO cleaning_extras (account_id, cleaning_key, cleaner, amount, description, created_by)
                            VALUES (1, ${key}, ${me.name}, ${amount}, ${description}, ${me.by}) RETURNING id` as { id: number }[];
    await saveFiles(sql, Number(row!.id), me.by, up);
    return Response.json({ ok: true });
  }

  // More evidence on an extra still waiting for the team.
  if (body.action === 'attachFile') {
    if (!files.length) return refuse(400, 'bad_request', 'No file.');
    const [e] = await sql`SELECT e.id, c.checkout_on::text AS date, c.unit_name FROM cleaning_extras e
                           JOIN cleanings c ON c.account_id = e.account_id AND c.key = e.cleaning_key
                          WHERE e.account_id = 1 AND e.id = ${Number(body.id) || 0} AND e.cleaner = ${me.name} AND e.status = 'pending'` as
      { id: number; date: string; unit_name: string }[];
    if (!e) return refuse(400, 'bad_request', 'Files go on an extra of yours still waiting for the team.');
    let up: Awaited<ReturnType<typeof uploadEvidence>> = [];
    try { up = await uploadEvidence(sql, env.ENCRYPTION_KEY, files, `${e.date} ${e.unit_name} — ${me.name}`); }
    catch (err) { return refuse(502, 'upload', `The file could not be saved: ${err instanceof Error ? err.message : String(err)}`); }
    await saveFiles(sql, Number(e.id), me.by, up);
    return Response.json({ ok: true });
  }

  // Turning down a clean on their schedule: it becomes unassigned (TBD)
  // for the team, and the rule will not hand it back to them.
  if (body.action === 'decline') {
    const key = String(body.key ?? '');
    const reason = String(body.reason ?? '').trim().slice(0, 300) || null;
    const [acc] = await sql`SELECT crew_calendar, crew_calendar_days FROM accounts WHERE id = 1` as { crew_calendar: boolean; crew_calendar_days: number }[];
    if (!acc?.crew_calendar) return refuse(400, 'bad_request', 'The schedule is not shared yet, so there is nothing to decline.');
    if (key.startsWith('MAN-')) {
      const [m] = await sql`UPDATE cleanings SET assignment = 'tbd', cleaner = NULL, price = NULL, decided_by = ${`declined by ${me.name}`}
                             WHERE account_id = 1 AND key = ${key} AND cleaner = ${me.name} AND assignment = 'assigned'
                               AND void_reason IS NULL AND checkout_on >= ${today}::date
                            RETURNING checkout_on::text AS date, unit_name` as { date: string; unit_name: string }[];
      if (!m) return refuse(400, 'bad_request', 'That clean is not on your schedule any more.');
      await sql`INSERT INTO crew_declines (account_id, cleaning_key, cleaner, clean_on, unit_name, reason, created_by)
                VALUES (1, ${key}, ${me.name}, ${m.date}, ${m.unit_name}, ${reason}, ${me.by})`;
      return Response.json({ ok: true });
    }
    // A checkout: only one the board gives them right now.
    const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
    const s = await loadOps(sql, creds, { days: acc.crew_calendar_days });
    const row = s.rows.find(r => r.kind === 'out' && r.resId === key);
    if (!row || row.assignment !== 'assigned' || row.cleaner !== me.name || row.date < today) {
      return refuse(400, 'bad_request', 'That clean is not on your schedule any more.');
    }
    await sql`INSERT INTO turnover_overrides (account_id, reservation_id, assignment, cleaner, updated_by)
              VALUES (1, ${key}, 'tbd', NULL, ${`declined by ${me.name}`})
              ON CONFLICT (account_id, reservation_id) DO UPDATE SET assignment = 'tbd', cleaner = NULL,
                updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await sql`INSERT INTO crew_declines (account_id, cleaning_key, cleaner, clean_on, unit_name, reason, created_by)
              VALUES (1, ${key}, ${me.name}, ${row.date}, ${row.unit}, ${reason}, ${me.by})`;
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

  if (body.action === 'cancelExtra') {
    const done = await sql`UPDATE cleaning_extras SET status = 'cancelled', decided_by = ${me.by}, decided_at = now()
                            WHERE account_id = 1 AND id = ${Number(body.id) || 0} AND cleaner = ${me.name} AND status = 'pending'
                            RETURNING id`;
    if (!done.length) return refuse(400, 'bad_request', 'Only an extra still waiting for the team can be withdrawn.');
    return Response.json({ ok: true });
  }

  return refuse(400, 'bad_request', 'Unknown action.');
}

export function refuse(status: number, error: string, message: string): Response {
  return Response.json({ ok: false, error, message }, { status });
}
