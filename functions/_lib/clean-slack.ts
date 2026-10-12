/**
 * The cleans' daily thread in Slack (§134): one message per day of cleans
 * in the Reservations channel, and under it, as they happen, each clean's
 * photos (one line per stage that grows) and every ✅ done / ↩️ reopened.
 * Off until "Cleans: one thread a day" is switched on in Settings → Slack.
 * Runs after the response (waitUntil): a Slack hiccup never fails a report.
 */
import type { SqlFn } from './accounts.ts';
import type { HostawayCredentials } from './hostaway.ts';
import { slackApi, slackSetup, type SlackSetup } from './slack.ts';
import { cleanDayMessage, cleanEventMessage, cleanMarkMessage, eventsOf, type CleanEvent, type DayClean } from '../../src/lib/slack.ts';
import { cleanStates } from './clean-record.ts';
import { cleansFor } from './slack-digest.ts';

/** A day's cleans as the morning list keeps them. */
interface Listed { key: string; unit: string; cleaner: string | null; time: string }

/** The day's message drawn from its kept list and where each clean stands now. */
async function dayMessage(sql: SqlFn, day: string, list: Listed[] | null) {
  if (!list) return cleanDayMessage(dayText(day));
  const st = await cleanStates(sql, list.map(c => c.key));
  const cleans: DayClean[] = list.map(c => ({ unit: c.unit, cleaner: c.cleaner, time: c.time,
    before: st[c.key]?.before ?? 0, after: st[c.key]?.after ?? 0, done: !!st[c.key]?.done }));
  return cleanDayMessage(dayText(day), cleans);
}

/** Re-draw the day's message after something happened on one of its cleans (only once it has its list). */
async function redrawDay(sql: SqlFn, token: string, day: string) {
  const [row] = await sql`SELECT channel, ts, cleans FROM clean_slack_posts WHERE account_id = 1 AND key = ${`day:${day}`}` as
    { channel: string; ts: string | null; cleans: Listed[] | null }[];
  if (!row?.ts || !row.cleans) return;
  await slackApi(token, 'chat.update', { channel: row.channel, ts: row.ts, ...(await dayMessage(sql, day, row.cleans)) });
}

/**
 * The clock's morning post (§136): the day's message with every clean of the
 * day — from the board (checkout cleans) and the record (manual cleans) — or,
 * if a photo already opened the thread, that message filled in. Nothing on a
 * day without cleans. Returns how many cleans it listed.
 */
export async function postCleanDay(sql: SqlFn, s: SlackSetup, creds: HostawayCredentials, day: string): Promise<number> {
  const channel = s.config.channels?.reservations?.id;
  if (!s.token || !channel) return 0;
  const token = s.token;
  const board = (await cleansFor(sql, creds, day)).filter(c => c.state !== 'not_needed')
    .map(c => ({ key: c.resId, unit: c.unit, cleaner: c.state === 'assigned' ? c.cleaner : null, time: c.time }));
  const manual = await sql`SELECT key, unit_name AS unit, cleaner, coalesce(checkout_time, '') AS time FROM cleanings
                            WHERE account_id = 1 AND key LIKE 'MAN-%' AND void_reason IS NULL AND checkout_on = ${day}::date` as Listed[];
  const list = [...board, ...manual].sort((a, b) => a.unit.localeCompare(b.unit));
  if (!list.length) return 0;
  const msg = await dayMessage(sql, day, list);
  const r = await once(sql, `day:${day}`, channel, async () =>
    (await slackApi<{ ts?: string }>(token, 'chat.postMessage', { channel, unfurl_links: false, ...msg })).ts ?? null);
  if (!r.ts) throw new Error('Slack did not take the day’s message.');
  await sql`UPDATE clean_slack_posts SET cleans = ${JSON.stringify(list)}::jsonb WHERE account_id = 1 AND key = ${`day:${day}`}`;
  if (!r.made) await slackApi(token, 'chat.update', { channel, ts: r.ts, ...msg });
  return list.length;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayText = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${DOW[t.getUTCDay()]}, ${MON[t.getUTCMonth()]} ${t.getUTCDate()}`; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The message a key stands for: made once. The row is taken BEFORE posting
 * (ts NULL), so a second caller at the same moment waits for the first's
 * message instead of posting its own.
 */
export async function once(sql: SqlFn, key: string, channel: string, post: () => Promise<string | null>): Promise<{ ts: string | null; made: boolean }> {
  const took = await sql`INSERT INTO clean_slack_posts (account_id, key, channel) VALUES (1, ${key}, ${channel})
                         ON CONFLICT DO NOTHING RETURNING key`;
  if (took.length) {
    const ts = await post();
    if (ts) await sql`UPDATE clean_slack_posts SET ts = ${ts} WHERE account_id = 1 AND key = ${key}`;
    else await sql`DELETE FROM clean_slack_posts WHERE account_id = 1 AND key = ${key}`;   // let the next one try
    return { ts, made: true };
  }
  for (let i = 0; i < 10; i++) {
    const [r] = await sql`SELECT ts FROM clean_slack_posts WHERE account_id = 1 AND key = ${key}` as { ts: string | null }[];
    if (r?.ts) return { ts: r.ts, made: false };
    if (!r) return once(sql, key, channel, post);
    await sleep(500);
  }
  return { ts: null, made: false };
}

/** What to tell the day's thread about one clean. */
export type ThreadNews =
  | { kind: 'photos'; stage: 'before' | 'after'; by: string }
  | { kind: 'done' | 'reopened' }
  | { kind: 'event'; by: string; event: Exclude<CleanEvent, { kind: 'photos' }> };

/** A batch of photos: the same person and stage within 15 minutes is one reply that grows; later ones, a new reply. */
const BATCH_MS = 15 * 60e3;

/**
 * Tell the day's thread (§136): every thing done on a clean is a reply — the
 * thread is the day's whole record for Ops — and the day's message is re-drawn.
 * `fallback` places a clean that has no field record yet (a decline, an extra).
 */
export async function tellCleanThread(sql: SqlFn, encryptionKey: string, cleaningKey: string, what: ThreadNews,
                                      fallback?: { unit: string; date: string }) {
  try {
    const s = await slackSetup(sql, encryptionKey);
    const channel = s.config.channels?.reservations?.id;
    if (!s.token || !channel || !eventsOf(s.config).cleanThread) return;
    const token = s.token;
    const [r0] = await sql`SELECT unit_name, clean_date::text AS date FROM clean_records WHERE account_id = 1 AND cleaning_key = ${cleaningKey}` as
      { unit_name: string; date: string }[];
    const rec = r0 ?? (fallback ? { unit_name: fallback.unit, date: fallback.date } : null);
    if (!rec) return;
    const posted = async (body: Record<string, unknown>) =>
      (await slackApi<{ ts?: string }>(token, 'chat.postMessage', { channel, unfurl_links: false, ...body })).ts ?? null;

    const day = await once(sql, `day:${rec.date}`, channel, () => posted(cleanDayMessage(dayText(rec.date))));
    if (!day.ts) return;
    const now = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date());

    if (what.kind === 'photos') {
      const st = (await cleanStates(sql, [cleaningKey]))[cleaningKey];
      const bucket = Math.floor(Date.now() / BATCH_MS);
      const [cnt] = await sql`SELECT count(*)::int AS n FROM clean_photos WHERE account_id = 1 AND cleaning_key = ${cleaningKey}
                                 AND stage = ${what.stage} AND by_name = ${what.by}
                                 AND created_at >= to_timestamp(${bucket * BATCH_MS / 1000})` as { n: number }[];
      const msg = cleanEventMessage(rec.unit_name, what.by, now, { kind: 'photos', stage: what.stage, n: Math.max(1, cnt?.n ?? 1), folderUrl: st?.folderUrl ?? null });
      const line = await once(sql, `photos:${cleaningKey}:${what.stage}:${what.by}:${bucket}`, channel, () => posted({ ...msg, thread_ts: day.ts }));
      if (line.ts && !line.made) await slackApi(token, 'chat.update', { channel, ts: line.ts, ...msg });
    } else if (what.kind === 'event') {
      await posted({ ...cleanEventMessage(rec.unit_name, what.by, now, what.event), thread_ts: day.ts });
    } else {
      const st = (await cleanStates(sql, [cleaningKey]))[cleaningKey];
      const [m] = await sql`SELECT by_name, to_char(created_at AT TIME ZONE 'America/New_York', 'HH24:MI') AS at FROM clean_marks
                             WHERE account_id = 1 AND cleaning_key = ${cleaningKey} ORDER BY id DESC LIMIT 1` as { by_name: string; at: string }[];
      if (!m || !st) return;
      await posted({ ...cleanMarkMessage({ unit: rec.unit_name, kind: what.kind, by: m.by_name, time: m.at, before: st.before, after: st.after,
                                           folderUrl: st.folderUrl, taken: st.supplies }), thread_ts: day.ts });
    }
    // The day's message keeps its list up to date: 📷 counts and ✅.
    await redrawDay(sql, token, rec.date);
  } catch { /* the thread is a courtesy: the report itself is already saved */ }
}
