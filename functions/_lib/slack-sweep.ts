/**
 * The night's sweep of the team channel (owner, 2026-11-23: "Kaizen's messages are drafts — clean it; keep the days'
 * summaries"). Late each night (team time) Kaizen takes down ITS OWN messages of the day, after posting one summary of
 * the day (`daySummary`, the list in its thread). Kept: work still open (its message is its thread — comments land
 * there), any message someone of the team replied to (people's words stay; a deleted parent would leave "This message
 * was deleted"), the day's cleans thread (the cleaners' record), and the summaries. People's own messages are never
 * touched — the bot cannot, and they are comments Kaizen already has.
 *
 * Workers Free allows 50 subrequests a request: a pass deletes what fits and the clock comes back on its next quiet tick;
 * `sweepdone:<day>` is set once a pass finds nothing left.
 */
import type { SqlFn } from './accounts.ts';
import { slackApi, type SlackSetup } from './slack.ts';
import { dayRange, daySummary, sweepKind } from '../../src/lib/slack.ts';

type Msg = { ts: string; text?: string; bot_id?: string; user?: string; reply_count?: number; reply_users?: string[] };

export async function sweepDay(sql: SqlFn, s: SlackSetup, day: string, tz: string, budget = 38): Promise<{ deleted: number; kept: number; left: number; summary: boolean }> {
  const out = { deleted: 0, kept: 0, left: 0, summary: false };
  const token = s.token;
  const channels = [...new Set(['tasks', 'claims', 'reservations', 'escalations'].map(k => s.config.channels?.[k as 'tasks']?.id).filter((x): x is string => !!x))];
  if (!token || !channels.length) return out;
  const [from, to] = dayRange(day, tz).map(x => String(Date.parse(x) / 1000));
  let calls = 0;
  const bot = s.config.botUserId;
  // What must stay, whatever its text.
  const [threads, openT, openC, cleans, sums] = await Promise.all([
    sql`SELECT channel, ts, subject, subject_id FROM slack_threads WHERE account_id = 1 AND channel = ANY(${channels})` as Promise<{ channel: string; ts: string; subject: string; subject_id: string }[]>,
    sql`SELECT id::text AS id FROM todos WHERE account_id = 1 AND deleted_at IS NULL AND status NOT IN ('completed', 'cancelled')` as Promise<{ id: string }[]>,
    sql`SELECT id::text AS id FROM claims WHERE account_id = 1 AND deleted_at IS NULL AND status IN ('Open', 'In progress')` as Promise<{ id: string }[]>,
    sql`SELECT ts FROM clean_slack_posts WHERE account_id = 1 AND key LIKE 'day:%' AND ts IS NOT NULL` as Promise<{ ts: string }[]>,
    sql`SELECT key FROM slack_sent WHERE account_id = 1 AND key LIKE 'daysum:%'` as Promise<{ key: string }[]>
  ]);
  calls += 5;
  const open = new Set([...openT.map(r => `task:${r.id}`), ...openC.map(r => `claim:${r.id}`)]);
  const item = new Map(threads.map(t => [`${t.channel}:${t.ts}`, `${t.subject}:${t.subject_id}`]));
  const keepTs = new Set([...cleans.map(r => r.ts), ...sums.map(r => r.key.split(':').pop()!)]);
  const summaryKey = `daysum:${day}:`;
  const summarised = sums.some(r => r.key.startsWith(summaryKey));

  for (const ch of channels) {
    const h = await slackApi<{ messages?: Msg[] }>(token, 'conversations.history', { channel: ch, oldest: from, latest: to, limit: 200 });
    calls++;
    if (!h.ok) continue;
    const mine = (h.messages ?? []).filter(m => m.bot_id && (!bot || !m.user || m.user === bot));
    const people = (m: Msg) => (m.reply_users ?? []).some(u => u !== bot && u !== m.user);
    const sticky = (m: Msg) => {
      const it = item.get(`${ch}:${m.ts}`);
      return keepTs.has(m.ts) || people(m) || (it ? open.has(it) || it.startsWith('report:') : false);
    };
    const go = mine.filter(m => !sticky(m));
    out.kept += mine.length - go.length;
    // The day's summary first, once, from everything Kaizen said that day (in the first channel that had any).
    if (!summarised && !out.summary && mine.length) {
      const m = daySummary(day, mine.map(x => x.text ?? '').map(sweepKind).filter((x): x is NonNullable<ReturnType<typeof sweepKind>> => !!x));
      if (m) {
        const p = await slackApi<{ ts?: string }>(token, 'chat.postMessage', { channel: ch, text: m.text, blocks: m.blocks, unfurl_links: false });
        calls++;
        if (p.ok && p.ts) {
          await sql`INSERT INTO slack_sent (account_id, key) VALUES (1, ${`${summaryKey}${p.ts}`}) ON CONFLICT DO NOTHING`;
          await slackApi(token, 'chat.postMessage', { channel: ch, thread_ts: p.ts, ...m.details, unfurl_links: false });
          calls += 2;
          out.summary = true;
        }
      }
    }
    const gone: string[] = [];
    for (const m of go) {
      // Its replies are Kaizen's own (a reply from a person keeps it, above): they go first, or the parent leaves a stub.
      const need = 1 + (m.reply_count ? 1 + m.reply_count : 0);
      if (calls + need > budget) { out.left++; continue; }
      if (m.reply_count) {
        const r = await slackApi<{ messages?: Msg[] }>(token, 'conversations.replies', { channel: ch, ts: m.ts, limit: 100 });
        calls++;
        for (const x of (r.messages ?? []).slice(1)) { await slackApi(token, 'chat.delete', { channel: ch, ts: x.ts }); calls++; }
      }
      const d = await slackApi(token, 'chat.delete', { channel: ch, ts: m.ts });
      calls++;
      if (d.ok || d.error === 'message_not_found') { out.deleted++; gone.push(m.ts); }
    }
    if (gone.length) await sql`DELETE FROM slack_threads WHERE account_id = 1 AND channel = ${ch} AND ts = ANY(${gone})`.catch(() => {});
  }
  return out;
}
