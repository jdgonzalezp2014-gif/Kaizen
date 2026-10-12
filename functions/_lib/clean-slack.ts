/**
 * The cleans' daily thread in Slack (§134): one message per day of cleans
 * in the Reservations channel, and under it, as they happen, each clean's
 * photos (one line per stage that grows) and every ✅ done / ↩️ reopened.
 * Off until "Cleans: one thread a day" is switched on in Settings → Slack.
 * Runs after the response (waitUntil): a Slack hiccup never fails a report.
 */
import type { SqlFn } from './accounts.ts';
import { slackApi, slackSetup } from './slack.ts';
import { cleanDayMessage, cleanMarkMessage, cleanPhotosMessage, eventsOf } from '../../src/lib/slack.ts';
import { cleanStates } from './clean-record.ts';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayText = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${DOW[t.getUTCDay()]}, ${MON[t.getUTCMonth()]} ${t.getUTCDate()}`; };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * The message a key stands for: made once. The row is taken BEFORE posting
 * (ts NULL), so a second caller at the same moment waits for the first's
 * message instead of posting its own.
 */
async function once(sql: SqlFn, key: string, channel: string, post: () => Promise<string | null>): Promise<{ ts: string | null; made: boolean }> {
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

export async function tellCleanThread(sql: SqlFn, encryptionKey: string, cleaningKey: string,
                                      what: { kind: 'photos'; stage: 'before' | 'after' } | { kind: 'done' | 'reopened' }) {
  try {
    const s = await slackSetup(sql, encryptionKey);
    const channel = s.config.channels?.reservations?.id;
    if (!s.token || !channel || !eventsOf(s.config).cleanThread) return;
    const token = s.token;
    const [rec] = await sql`SELECT unit_name, clean_date::text AS date FROM clean_records WHERE account_id = 1 AND cleaning_key = ${cleaningKey}` as
      { unit_name: string; date: string }[];
    if (!rec) return;
    const posted = async (body: Record<string, unknown>) =>
      (await slackApi<{ ts?: string }>(token, 'chat.postMessage', { channel, unfurl_links: false, ...body })).ts ?? null;

    const day = await once(sql, `day:${rec.date}`, channel, () => posted(cleanDayMessage(dayText(rec.date))));
    if (!day.ts) return;
    const st = (await cleanStates(sql, [cleaningKey]))[cleaningKey];
    if (!st) return;

    if (what.kind === 'photos') {
      const by = (await sql`SELECT by_name FROM clean_photos WHERE account_id = 1 AND cleaning_key = ${cleaningKey} AND stage = ${what.stage}
                             GROUP BY by_name ORDER BY min(id)` as { by_name: string }[]).map(r => r.by_name);
      const msg = cleanPhotosMessage({ unit: rec.unit_name, stage: what.stage, n: st[what.stage], by, folderUrl: st.folderUrl });
      const line = await once(sql, `photos:${cleaningKey}:${what.stage}`, channel, () => posted({ ...msg, thread_ts: day.ts }));
      if (line.ts && !line.made) await slackApi(token, 'chat.update', { channel, ts: line.ts, ...msg });
    } else {
      const [m] = await sql`SELECT by_name, to_char(created_at AT TIME ZONE 'America/New_York', 'HH24:MI') AS at FROM clean_marks
                             WHERE account_id = 1 AND cleaning_key = ${cleaningKey} ORDER BY id DESC LIMIT 1` as { by_name: string; at: string }[];
      if (!m) return;
      await posted({ ...cleanMarkMessage({ unit: rec.unit_name, kind: what.kind, by: m.by_name, time: m.at, before: st.before, after: st.after,
                                           folderUrl: st.folderUrl, taken: st.supplies }), thread_ts: day.ts });
    }
  } catch { /* the thread is a courtesy: the report itself is already saved */ }
}
