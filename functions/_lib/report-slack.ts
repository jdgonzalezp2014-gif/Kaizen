/**
 * Reports in Slack (owner, 2026-10-15): each new report is a card in the reports
 * channel (topic `reports`), and that card's thread is the report's conversation —
 * a status change or a comment in Kaizen is a reply there; a reply there is a
 * comment (slack_threads subject 'report'). Done / won't do is told to whoever
 * reported it, by DM (DM mode respected). A Slack error never fails the report.
 */
import type { SqlFn } from './accounts.ts';
import { slackApi, slackSetup, rememberThread } from './slack.ts';
import { esc } from '../../src/lib/slack.ts';
import { REPORT_STATUS, reportMessage, reportTitle, type ReportRow, type ReportStatus } from '../../src/lib/reports.ts';

export async function reportLite(sql: SqlFn, id: string): Promise<(ReportRow & { slackUser: string | null }) | null> {
  const [r] = await sql`SELECT id::text, kind, body, urgency, status, where_from, device, source, reporter, slack_user,
                               photo IS NOT NULL AS has_photo, created_at, updated_at
                          FROM reports WHERE account_id = 1 AND id::text = ${id}` as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!r) return null;
  return { id: r.id, kind: r.kind, body: r.body, urgency: r.urgency, status: r.status, whereFrom: r.where_from, device: r.device,
           source: r.source, reporter: r.reporter, slackUser: r.slack_user, hasPhoto: r.has_photo,
           createdAt: String(r.created_at), updatedAt: String(r.updated_at) };
}

async function threadOf(sql: SqlFn, id: string) {
  const [t] = await sql`SELECT channel, ts FROM slack_threads WHERE account_id = 1 AND subject = 'report' AND subject_id = ${id}
                         ORDER BY created_at DESC LIMIT 1` as { channel: string; ts: string }[];
  return t ?? null;
}

const short = (email: string) => email.includes('@') ? email.split('@')[0]! : email;

/** A new report: its card in the reports channel. */
export async function postReport(sql: SqlFn, key: string, id: string, thread?: { channel: string; ts: string }): Promise<void> {
  const s = await slackSetup(sql, key);
  const ch = s.config.channels?.reports?.id;
  const r = await reportLite(sql, id);
  if (!s.token || !ch || !r) return;
  const m = reportMessage(r, s.config.appUrl, r.slackUser);
  const posted = await slackApi<{ ts?: string; channel?: string }>(s.token, 'chat.postMessage', { channel: ch, text: m.text, blocks: m.blocks, unfurl_links: false });
  await rememberThread(sql, posted, 'report', id);
  // Sent from a Slack conversation: a link back there, so the asker's thread says where it went.
  if (posted.ok && thread && thread.channel !== ch) {
    const link = await slackApi<{ permalink?: string }>(s.token, 'chat.getPermalink', { channel: ch, message_ts: posted.ts });
    await slackApi(s.token, 'chat.postMessage', { channel: thread.channel, thread_ts: thread.ts, unfurl_links: false,
      text: `✓ Sent as ${r.kind} #${r.id}${link.permalink ? ` — <${link.permalink}|follow it here>` : ''}` });
  }
}

/** Status changed: the card redrawn, a line in its thread, and the reporter told when it closes. */
export async function reportStatusToSlack(sql: SqlFn, key: string, id: string, status: ReportStatus, by: string): Promise<void> {
  const s = await slackSetup(sql, key);
  const r = await reportLite(sql, id);
  const t = await threadOf(sql, id);
  if (!s.token || !r) return;
  if (t) {
    const m = reportMessage(r, s.config.appUrl, r.slackUser);
    await slackApi(s.token, 'chat.update', { channel: t.channel, ts: t.ts, text: m.text, blocks: m.blocks });
    await slackApi(s.token, 'chat.postMessage', { channel: t.channel, thread_ts: t.ts, text: `→ ${REPORT_STATUS[status]} · ${short(by)}` });
  }
  await reportDm(sql, key, id, status);
}

/** Closed (done / won't do): whoever reported it hears it by DM — the DM mode is respected (test → the tester). */
export async function reportDm(sql: SqlFn, key: string, id: string, status: ReportStatus): Promise<void> {
  if (status !== 'done' && status !== 'wontfix') return;
  const s = await slackSetup(sql, key);
  const r = await reportLite(sql, id);
  if (!s.token || !r) return;
  const mode = s.config.dm?.mode ?? 'test';
  if (mode === 'off') return;
  let to = r.slackUser;
  if (!to) {
    const u = await slackApi<{ user?: { id?: string } }>(s.token, 'users.lookupByEmail', { email: r.reporter });
    to = u.user?.id ?? null;
  }
  const target = mode === 'test' ? s.config.dm?.testUser ?? null : to;
  if (!target) return;
  const lead = status === 'done' ? '✅ Done' : "✕ Won't be done";
  const standIn = mode === 'test' && target !== to ? `🧪 Test — would go to *${esc(short(r.reporter))}*\n` : '';
  await slackApi(s.token, 'chat.postMessage', { channel: target, unfurl_links: false, text: `${lead}: your ${r.kind} #${r.id}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${standIn}${lead} — your ${r.kind} *#${r.id}*: ${esc(reportTitle(r.body))}` } }] });
}


/** A comment written in Kaizen, in the card's thread too. */
export async function reportCommentToSlack(sql: SqlFn, key: string, id: string, body: string, by: string): Promise<void> {
  const t = await threadOf(sql, id);
  if (!t) return;
  const s = await slackSetup(sql, key);
  if (!s.token) return;
  await slackApi(s.token, 'chat.postMessage', { channel: t.channel, thread_ts: t.ts, unfurl_links: false, text: `💬 ${short(by)}: ${body}`.slice(0, 3000),
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `💬 *${esc(short(by))}* · in Kaizen\n${esc(body).slice(0, 2900)}` } }] });
}
