/**
 * Slack (§99): the calls, the signature check, and the notifications.
 *
 * Every request Slack sends is signed with the app's signing secret
 * (HMAC-SHA256 over "v0:timestamp:body"); one that does not verify, or is
 * more than five minutes old, is refused before anything is read.
 * Notifications go out after the response (waitUntil) and never fail the
 * action that caused them.
 */
import type { SqlFn } from './accounts.ts';
import { decrypt } from './crypto.ts';
import { claimMessage, eventsOf, taskMessage, type ClaimLite, type SlackConfig, type TaskLite, type Topic } from '../../src/lib/slack.ts';

export interface SlackSetup { config: SlackConfig; token: string | null; secret: string | null }

export async function slackSetup(sql: SqlFn, key: string): Promise<SlackSetup> {
  const [a] = await sql`SELECT slack_bot_token_enc, slack_signing_secret_enc, slack_config FROM accounts WHERE id = 1` as
    { slack_bot_token_enc: string | null; slack_signing_secret_enc: string | null; slack_config: SlackConfig | null }[];
  return {
    config: a?.slack_config ?? {},
    token: a?.slack_bot_token_enc ? await decrypt(a.slack_bot_token_enc, key) : null,
    secret: a?.slack_signing_secret_enc ? await decrypt(a.slack_signing_secret_enc, key) : null
  };
}

/**
 * One Slack Web API call. Slack answers 200 with `ok: false` on errors; that is returned, not thrown.
 *
 * Form-encoded, never JSON: every method takes a form, but the read
 * methods (users.info, users.lookupByEmail, conversations.list) refuse a
 * JSON body with `invalid_arguments`. Objects (blocks, view) go as JSON
 * strings inside the form, which is how Slack reads them there.
 */
export async function slackApi<T = Record<string, unknown>>(token: string, method: string, body: Record<string, unknown> = {}): Promise<T & { ok: boolean; error?: string }> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  return await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` })) as T & { ok: boolean; error?: string };
}

/** Slack's request signature, checked in constant time. */
export async function verifySlack(secret: string, timestamp: string | null, rawBody: string, signature: string | null, now = Date.now()): Promise<boolean> {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${rawBody}`)));
  const expected = 'v0=' + [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

/** Post to a topic's channel, when Slack is connected and the topic has one. */
export async function postTo(s: SlackSetup, topic: Topic, msg: { text: string; blocks: unknown[] }) {
  const ch = s.config.channels?.[topic]?.id;
  if (!s.token || !ch) return null;
  return slackApi(s.token, 'chat.postMessage', { channel: ch, text: msg.text, blocks: msg.blocks, unfurl_links: false });
}

const who = (email: string) => email.includes('@') ? email.split('@')[0]! : email;

export async function taskLite(sql: SqlFn, id: string): Promise<TaskLite | null> {
  const [t] = await sql`SELECT t.id::text, t.title, t.kind, t.status, t.priority, t.assignee, t.due_on::text AS due_on, t.reservation_label,
                               t.description, t.parent_id, u.name AS unit
                          FROM todos t LEFT JOIN units u ON u.account_id = t.account_id AND u.id = t.unit_ids[1]
                         WHERE t.account_id = 1 AND t.id::text = ${id}` as
    { id: string; title: string; kind: TaskLite['kind']; status: string; priority: string; assignee: string | null; due_on: string | null;
      reservation_label: string | null; description: string | null; parent_id: string | null; unit: string | null }[];
  return t ? { id: t.id, title: t.title, kind: t.kind, status: t.status, priority: t.priority, assignee: t.assignee, dueOn: t.due_on,
               reservationLabel: t.reservation_label, description: t.description, unit: t.unit } : null;
}

export type TaskEvent = 'created' | 'assigned' | 'completed' | 'cancelled' | 'reopened' | 'hostaway';

/** A task's news in its channel — only top-level work, and only the events switched on. */
export async function notifyTask(sql: SqlFn, key: string, id: string, event: TaskEvent, by: string, extra = ''): Promise<void> {
  const s = await slackSetup(sql, key);
  if (!s.token || !s.config.channels?.tasks) return;
  const ev = eventsOf(s.config);
  const on = event === 'created' ? ev.taskCreated : event === 'assigned' ? ev.taskAssigned
    : event === 'hostaway' ? ev.fromHostaway : ev.taskClosed;
  if (!on) return;
  const t = await taskLite(sql, id);
  if (!t) return;
  const [p] = await sql`SELECT parent_id FROM todos WHERE id::text = ${id}` as { parent_id: string | null }[];
  if (p?.parent_id) return;
  const word = event === 'assigned' ? `assigned to ${t.assignee ?? 'nobody'}` : event === 'hostaway' ? `changed in Hostaway${extra ? ` (${extra})` : ''}` : event;
  await postTo(s, 'tasks', taskMessage(t, word, who(by), s.config.appUrl));
}

export async function claimLite(sql: SqlFn, id: string): Promise<ClaimLite | null> {
  const [c] = await sql`SELECT c.id::text, u.name AS unit, c.category, c.severity, c.status, c.description, c.case_url,
                               (CURRENT_DATE - c.occurred_on)::int AS days
                          FROM claims c LEFT JOIN units u ON u.account_id = c.account_id AND u.id = c.unit_id
                         WHERE c.account_id = 1 AND c.id::text = ${id}` as
    { id: string; unit: string | null; category: string | null; severity: string; status: string; description: string | null; case_url: string | null; days: number }[];
  return c ? { id: c.id, unit: c.unit, category: c.category, severity: c.severity, status: c.status, description: c.description, caseUrl: c.case_url, days: c.days } : null;
}

export async function notifyClaim(sql: SqlFn, key: string, id: string, event: 'opened' | 'changed', by: string, word?: string): Promise<void> {
  const s = await slackSetup(sql, key);
  if (!s.token || !s.config.channels?.claims) return;
  const ev = eventsOf(s.config);
  if (event === 'opened' ? !ev.claimOpened : !ev.claimChanged) return;
  const c = await claimLite(sql, id);
  if (c) await postTo(s, 'claims', claimMessage(c, word ?? event, who(by)));
}
