/**
 * The cleaners' own Slack channels (§134): their cleans of the day at 9 AM
 * and of tomorrow at 6 PM, and — as it happens — what their helpers report
 * through a clean's link. In the cleaner's language; only to a cleaner who
 * has a channel (Settings → Slack → Cleaners' channels); off until switched on.
 * Notices run after the response: a Slack hiccup never fails a report.
 */
import type { SqlFn } from './accounts.ts';
import type { HostawayCredentials } from './hostaway.ts';
import { rememberThread, slackApi, slackSetup, type SlackSetup } from './slack.ts';
import { once } from './clean-slack.ts';
import { cleanerSchedule } from './slack-digest.ts';
import { crewChannelsOf, crewDayMessage, crewHelperMessage, type HelperEvent } from '../../src/lib/crew-slack.ts';

const langOf = async (sql: SqlFn, name: string) =>
  ((await sql`SELECT lang FROM cleaners WHERE account_id = 1 AND name = ${name}` as { lang: 'en' | 'es' }[])[0]?.lang) ?? 'en';

/**
 * A report — the cleaner's own or a helper's — in the cleaner's channel. Photos are one line
 * per clean and stage that grows as they arrive (`photosKey`), not a message per photo.
 * With a to-do behind it, the message is that to-do's thread: the team's reply there is a
 * comment on it (§153) — followed up and answered in the channel, managed in Kaizen.
 */
export async function tellCleaner(sql: SqlFn, encryptionKey: string, cleaner: string, e: HelperEvent, photosKey?: string, todoId?: string | null) {
  try {
    const s = await slackSetup(sql, encryptionKey);
    const channel = s.config.cleaners?.[cleaner]?.channelId;
    if (!s.token || !channel || !crewChannelsOf(s.config.crewChannels).helperNotices) return;
    // Photos: the clean's Drive folder with them (photosKey ends in "<key>:<stage>").
    if (e.kind === 'photos' && photosKey && e.folderUrl === undefined) {
      const key = photosKey.split(':').slice(-2, -1)[0] ?? '';
      const [f] = await sql`SELECT drive_folder FROM clean_records WHERE account_id = 1 AND cleaning_key = ${key}` as { drive_folder: string | null }[];
      e = { ...e, folderUrl: f?.drive_folder ? `https://drive.google.com/drive/folders/${f.drive_folder}` : null };
    }
    const msg = crewHelperMessage(await langOf(sql, cleaner), e, !!todoId);
    const token = s.token;
    if (photosKey) {
      const r = await once(sql, `cl:${cleaner}:${photosKey}`, channel,
        async () => (await slackApi<{ ts?: string }>(token, 'chat.postMessage', { channel, ...msg })).ts ?? null);
      if (r.ts && !r.made) await slackApi(token, 'chat.update', { channel, ts: r.ts, ...msg });
    } else {
      const r = await slackApi<{ ts?: string; channel?: string }>(token, 'chat.postMessage', { channel, unfurl_links: false, ...msg });
      if (todoId) await rememberThread(sql, r, 'task', todoId);
    }
  } catch { /* a courtesy: the report itself is saved */ }
}

/**
 * The day's (or tomorrow's) cleans to every cleaner with a channel — from the
 * board, read once for all of them. Nothing is sent to a cleaner with no
 * cleans that day. `claim` makes each cleaner's message go once.
 */
export async function remindCleaners(sql: SqlFn, s: SlackSetup, creds: HostawayCredentials, kind: 'today' | 'tomorrow', day: string,
                                     claim: (key: string) => Promise<boolean>, release: (key: string) => Promise<void>): Promise<{ sent: string[]; failed: number }> {
  const chans = Object.entries(s.config.cleaners ?? {}).filter(([, c]) => c.channelId);
  if (!s.token || !chans.length) return { sent: [], failed: 0 };
  const all = await cleanerSchedule(sql, creds, null, 3);
  const manual = (await sql`SELECT unit_name AS unit, cleaner, coalesce(checkout_time, '') AS time, deep, kind FROM cleanings
                             WHERE account_id = 1 AND key LIKE 'MAN-%' AND void_reason IS NULL AND assignment = 'assigned'
                               AND cleaner IS NOT NULL AND checkout_on = ${day}::date` as
                  { unit: string; cleaner: string; time: string; deep: boolean | null; kind: string }[])
    .map(m => ({ unit: m.unit, cleaner: m.cleaner, time: m.time, deep: !!m.deep, midStay: m.kind === 'mid_stay' }));
  const sent: string[] = [];
  let failed = 0;
  for (const [name, ch] of chans) {
    // The board only has checkouts; manual cleans (MAN-, e.g. mid-stay) are in the record (owner, 2026-10-14: Irene's was missed).
    const mine = [...all.filter(c => c.cleaner.toLowerCase() === name.toLowerCase() && c.date === day),
                  ...manual.filter(c => c.cleaner.toLowerCase() === name.toLowerCase())];
    if (!mine.length) continue;
    const key = `crew:${kind}:${day}:${name}`;
    if (!(await claim(key))) continue;
    const m = crewDayMessage(await langOf(sql, name), kind, day, mine, s.config.appUrl);
    const r = await slackApi(s.token, 'chat.postMessage', { channel: ch.channelId, unfurl_links: false, ...m });
    if (r.ok) sent.push(`${kind} ${name}`); else { failed++; await release(key); }
  }
  return { sent, failed };
}
