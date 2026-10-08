/**
 * POST /api/slack — everything Slack sends Kaizen (§99): the /kaizen
 * command, buttons and menus on messages, and submitted forms.
 *
 * Outside Cloudflare Access (listed in _middleware SELF_AUTHENTICATING):
 * every request must carry Slack's signature for this app's signing
 * secret, or nothing is read. The Slack user is then matched to a Kaizen
 * member by email — on the account's allow-list, with the member's own
 * permissions — and the action runs through the same handler the app
 * uses (/api/todos, /api/claims), as that member. So a task completed
 * from Slack writes the same timeline, follows the same Hostaway sync and
 * records the same repair cost as one completed in Kaizen.
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { mayAccess } from '../_lib/roles.ts';
import { rememberThread, slackApi, slackSetup, taskLite, claimLite, verifySlack, type SlackSetup } from '../_lib/slack.ts';
import { cleansFor, digestFacts } from '../_lib/slack-digest.ts';
import { taskCheckFacts } from '../_lib/slack-taskcheck.ts';
import * as todos from './todos.ts';
import * as claims from './claims.ts';
import * as expenses from './expenses.ts';
import {
  claimList, claimMessage, claimModal, cleanAssignModal, cleansModal, day, digestMessage, HELP, helpBlocks, helpUrlOf, hostawayUserOf, loadingModal,
  parseCommand, readClaimForm, readTaskForm, taskCard, taskList, taskMessage, taskModal, checkinsModal, claimsModal, tasksModal, commentFromMention,
  costModal, costFromWords, readCostForm, teamTz, localNow, parseMention, newButtons, mentionHelpBlocks, sectionButtons, claimCard, commentsBlocks, guessUnit, quickTitle, trackedReply,
  type ClaimLite, type Opt, type TaskCard, type TaskForm, type TaskLite
} from '../../src/lib/slack.ts';
import * as turnover from './turnover.ts';
import { opsConfig } from '../_lib/ops.ts';
import { nyParts } from '../../src/lib/todos.ts';
import { CLAIM_CATEGORIES, CLAIM_SOURCES } from '../../src/lib/claims.ts';
import { addDays, todayIn } from '../../src/lib/dates.ts';

type Ctx = Parameters<PagesFunction<Env>>[0];
const json = (b: unknown) => Response.json(b);
const ephemeral = (text: string, blocks?: unknown[]) => json({ response_type: 'ephemeral', text, ...(blocks ? { blocks } : {}) });
const ack = () => new Response('', { status: 200 });

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const raw = await request.text();
  const sql = db(env) as unknown as SqlFn;
  const s = await slackSetup(sql, env.ENCRYPTION_KEY);
  if (!s.secret || !s.token) return new Response('Slack is not set up in Kaizen.', { status: 503 });
  if (!(await verifySlack(s.secret, request.headers.get('X-Slack-Request-Timestamp'), raw, request.headers.get('X-Slack-Signature')))) {
    return new Response('Bad signature.', { status: 401 });
  }
  // §107: the Events API — a JSON body. Only app_mention is subscribed: Kaizen sees the messages that name it, nothing else.
  if (raw.trimStart().startsWith('{')) {
    const body = JSON.parse(raw) as { type?: string; challenge?: string; event?: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (body.type === 'url_verification') return json({ challenge: body.challenge });
    // Slack retries what was not answered in 3 seconds; the first delivery is already being handled.
    if (body.type === 'event_callback' && !request.headers.get('X-Slack-Retry-Num')) {
      const ev = body.event ?? {};
      if (ev.type === 'app_mention' && !ev.bot_id) ctx.waitUntil(mention(ctx, sql, s, ev).catch(() => {}));
    }
    return ack();
  }
  const form = new URLSearchParams(raw);
  const payload = form.get('payload') ? JSON.parse(form.get('payload')!) as Record<string, any> : null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const slackUser = String(payload?.user?.id ?? form.get('user_id') ?? '');
  const member = await memberOf(sql, s.token, slackUser);
  if (!member.ok) {
    return payload?.type === 'view_submission'
      ? json({ response_action: 'errors', errors: { title: member.why } })
      : ephemeral(member.why);
  }
  const k = new Kaizen(ctx, sql, s, member.email, member.permissions, slackUser);
  try {
    if (!payload) return await k.command(form.get('text') ?? '', form.get('trigger_id') ?? '', form.get('response_url') ?? '');
    if (payload.type === 'block_actions') return await k.action(payload);
    if (payload.type === 'shortcut') return await k.shortcut(payload);
    if (payload.type === 'message_action') return await k.fromMessage(payload);
    if (payload.type === 'view_submission') return await k.submit(payload);
    return ack();
  } catch (e) {
    return ephemeral(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/**
 * "@Kaizen …" (§107, §108). A mention cannot open a pop-up — Slack gives no
 * trigger for one — so Kaizen answers with buttons that do, seen only by
 * whoever wrote it; this works the same in the Slack phone app.
 *   @Kaizen new|repair|claim <title> → the button to that form, title filled in
 *   @Kaizen tasks / today / help     → the list, the day, what it does
 *   in a task's or claim's thread: @Kaizen comments → the comments so far;
 *   @Kaizen <anything else>          → saved as a comment (✅ on the message)
 *   anywhere else, other text        → offered as a new to-do
 */
async function mention(ctx: Ctx, sql: SqlFn, s: SlackSetup, ev: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const inThread = !!ev.thread_ts && ev.thread_ts !== ev.ts;
  // §115: private answers go in the thread of the asking message, so the channel loses nothing. Slack shows a private reply
  // only in a thread that exists — one line, "🔒 Answered privately", opens it first (once per mention).
  let threadTs: string | null = inThread ? String(ev.thread_ts) : null;
  const say = async (text: string, blocks?: unknown[]) => {
    if (!threadTs) {
      const stub = await slackApi<{ ts?: string }>(s.token!, 'chat.postMessage', { channel: ev.channel, thread_ts: ev.ts, text: `🔒 Answered <@${ev.user}> privately`,
        blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: `🔒 Answered <@${ev.user}> privately here` }] }] });
      threadTs = stub.ok ? String(ev.ts) : '';
    }
    return slackApi(s.token!, 'chat.postEphemeral', { channel: ev.channel, user: ev.user, text, ...(blocks ? { blocks } : {}), ...(threadTs ? { thread_ts: threadTs } : {}) });
  };
  const { verb, arg } = parseMention(String(ev.text ?? ''));
  const from = { channel: String(ev.channel), ts: String(inThread ? ev.thread_ts : ev.ts) };
  if (verb === 'help') { await say('What Kaizen does in Slack', mentionHelpBlocks()); return; }
  // §110: "@Kaizen new <what>" is made at once — the reply in its thread has ✎ Add details. No words: the form.
  if ((verb === 'new' || verb === 'repair') && arg) {
    const member = await memberOf(sql, s.token!, String(ev.user ?? ''));
    if (!member.ok) { await say(member.why); return; }
    const r = await new Kaizen(ctx, sql, s, member.email, member.permissions, String(ev.user))
      .quickCreate(verb === 'repair' ? 'work_order' : 'task', arg, from, String(ev.ts));
    if (!r.ok) await say(`Not saved: ${String(r.message ?? r.error ?? 'Kaizen said no.')}`);
    return;
  }
  if (verb === 'new' || verb === 'repair' || verb === 'claim' || verb === 'cost') {
    // §117: a cost is never made at once — the button opens the form, every field to confirm.
    const only = verb === 'new' ? 'task' : verb === 'repair' ? 'work_order' : verb === 'cost' ? 'cost' : 'claim';
    await say(arg ? `New: ${arg}` : 'Open the form', [
      { type: 'section', text: { type: 'mrkdwn', text: arg ? `Ready to save *${arg.replace(/[<>&]/g, '')}* — tap to open the form.` : 'Tap to open the form.' } },
      newButtons(arg, only, from)]);
    return;
  }
  const member = await memberOf(sql, s.token!, String(ev.user ?? ''));
  if (!member.ok) { await say(member.why); return; }
  const k = new Kaizen(ctx, sql, s, member.email, member.permissions, String(ev.user));
  if (verb === 'tasks' || verb === 'today' || verb === 'claims') { const m = await k.forMention(verb); await say(m.text, m.blocks); return; }
  // §114: "@Kaizen all" — the reminder now, for everyone, in the thread of the asking message (the channel stays short).
  if (verb === 'all') {
    const m = await k.forMention('all');
    const r = await slackApi(s.token!, 'chat.postMessage', { channel: ev.channel, thread_ts: inThread ? ev.thread_ts : ev.ts, text: m.text, blocks: m.blocks, unfurl_links: false });
    if (!r.ok) await say(m.text, m.blocks);
    return;
  }

  const [t] = inThread ? await sql`SELECT subject, subject_id FROM slack_threads WHERE account_id = 1 AND channel = ${ev.channel} AND ts = ${ev.thread_ts}` as
    { subject: 'task' | 'claim'; subject_id: string }[] : [];
  if (verb === 'comments') {
    if (!t) { await say('Ask for comments inside the thread of a Kaizen task or claim message.'); return; }
    const m = await k.comments(t.subject, t.subject_id);
    await say(m.text, m.blocks);
    return;
  }
  // Plain text: a comment where there is a subject; elsewhere, an offer to track it.
  if (!t) {
    await say(`Make it a to-do? ${arg}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `Kaizen can track *${arg.replace(/[<>&]/g, '').slice(0, 200)}* — pick what it is:` } },
      newButtons(arg, undefined, from),
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Type *@Kaizen help* for everything Kaizen does here.' }] }]);
    return;
  }
  const r = await k.comment(t.subject, t.subject_id, arg);
  if (!r.ok) { await say(`Not saved: ${String(r.message ?? r.error ?? 'Kaizen said no.')}`); return; }
  const re = await slackApi(s.token!, 'reactions.add', { channel: ev.channel, timestamp: ev.ts, name: 'white_check_mark' });
  if (!re.ok) await say('✓ Saved as a comment in Kaizen.');
}

/** The Slack user, as the Kaizen member with the same email — or why not. */
async function memberOf(sql: SqlFn, token: string, user: string):
  Promise<{ ok: true; email: string; permissions: string[] } | { ok: false; why: string }> {
  if (!user) return { ok: false, why: 'Who is asking? Slack did not say.' };
  const info = await slackApi<{ user?: { profile?: { email?: string } } }>(token, 'users.info', { user });
  const email = info.user?.profile?.email?.trim().toLowerCase();
  if (!email) return { ok: false, why: 'Kaizen could not read your Slack email (the app needs the users:read.email scope).' };
  const [acc] = await sql`SELECT allowed_emails FROM accounts WHERE id = 1` as { allowed_emails: string[] | null }[];
  const allowed = (acc?.allowed_emails ?? []).map(e => e.toLowerCase());
  if (allowed.length && !allowed.includes(email)) return { ok: false, why: `${email} is not a Kaizen member — an admin adds members in Settings.` };
  const access = await accessOf(sql, { email, local: false });
  return { ok: true, email, permissions: access.permissions };
}

class Kaizen {
  constructor(private ctx: Ctx, private sql: SqlFn, private s: SlackSetup, private email: string, private perms: string[], private slackUser: string) {}

  private may(path: string, method: string) { return mayAccess(this.perms, path, method); }
  private deny(what: string) { return ephemeral(`Your Kaizen role does not include ${what}.`); }

  /** The app's own handler, run as this member. */
  private async api(handler: PagesFunction<Env>, path: string, method: string, body?: unknown): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const request = new Request(new URL(path, this.ctx.request.url), {
      method, headers: { 'Content-Type': 'application/json', 'Cf-Access-Authenticated-User-Email': this.email },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const res = await handler({ ...this.ctx, request } as Ctx);
    return await res.json().catch(() => ({ ok: res.ok })) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  }
  private todo(body: Record<string, unknown>) { return this.api(todos.onRequestPost, '/api/todos', 'POST', body); }
  private claimSave(body: Record<string, unknown>) { return this.api(claims.onRequestPost, '/api/claims', 'POST', body); }

  private async reply(url: string, msg: Record<string, unknown>) {
    if (!url) return;
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
  }
  private async open(trigger: string, view: unknown) {
    const r = await slackApi(this.s.token!, 'views.open', { trigger_id: trigger, view });
    if (!r.ok) throw new Error(`Slack did not open the form (${r.error}).`);
  }

  private async units(): Promise<Opt[]> {
    const rows = await this.sql`SELECT id, name FROM units WHERE account_id = 1 AND active ORDER BY name` as { id: string; name: string }[];
    return rows.map(r => ({ value: String(r.id), label: r.name }));
  }
  private async people(): Promise<Opt[]> {
    const rows = await this.sql`SELECT id, name FROM hostaway_users WHERE account_id = 1 ORDER BY name` as { id: number; name: string }[];
    return rows.map(r => ({ value: String(r.id), label: r.name }));
  }

  private async openTasks(): Promise<TaskLite[]> {
    const rows = await this.sql`SELECT t.id::text FROM todos t WHERE t.account_id = 1 AND t.deleted_at IS NULL AND t.parent_id IS NULL
                                   AND t.status NOT IN ('completed', 'cancelled')
                                 ORDER BY (t.priority = 'urgent') DESC, t.due_on NULLS LAST, t.created_at` as { id: string }[];
    return (await Promise.all(rows.map(r => taskLite(this.sql, r.id)))).filter((t): t is TaskLite => !!t);
  }
  private async openClaims(): Promise<ClaimLite[]> {
    const rows = await this.sql`SELECT id::text FROM claims WHERE account_id = 1 AND deleted_at IS NULL AND status IN ('Open', 'In progress')
                                 ORDER BY (severity IN ('Critical', 'High')) DESC, occurred_on` as { id: string }[];
    return (await Promise.all(rows.map(r => claimLite(this.sql, r.id)))).filter((c): c is ClaimLite => !!c);
  }

  private async taskForm(id: string): Promise<TaskForm | null> {
    const [t] = await this.sql`SELECT id::text, title, description, kind, unit_ids[1] AS unit, status, priority, assignee_user_id,
                                      due_on::text AS due_on, scheduled_on::text AS scheduled_on, cost_actual
                                 FROM todos WHERE account_id = 1 AND id::text = ${id} AND deleted_at IS NULL` as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    return t ? { id: t.id, title: t.title, description: t.description, kind: t.kind, unitId: t.unit, status: t.status, priority: t.priority,
                 assigneeUserId: t.assignee_user_id, dueOn: t.due_on, scheduledOn: t.scheduled_on,
                 costActual: t.cost_actual == null ? null : Number(t.cost_actual) } : null;
  }
  private async claimRow(id: string) {
    const [c] = await this.sql`SELECT id::text, unit_id, occurred_on::text AS occurred_on, category, severity, status, source, description,
                                      refund, repair_cost, case_url
                                 FROM claims WHERE account_id = 1 AND id::text = ${id} AND deleted_at IS NULL` as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    return c;
  }
  /** A claim saved with every field as it is, but the ones changed — the claims route saves the whole case. */
  private async claimUpdate(id: string, change: Record<string, unknown>) {
    const c = await this.claimRow(id);
    if (!c) return { ok: false, error: 'That claim is gone.' };
    return this.claimSave({ id, unitId: c.unit_id, occurredOn: c.occurred_on, category: c.category, severity: c.severity, status: c.status,
      source: c.source, description: c.description, refund: Number(c.refund) || 0, repairCost: Number(c.repair_cost) || 0,
      caseUrl: c.case_url ?? '', ...change });
  }

  /** A comment on a task or a claim, as this member (§107). */
  async comment(subject: 'task' | 'claim', id: string, body: string): Promise<Record<string, unknown>> {
    // via: it came from the thread, so it is not posted back there.
    if (subject === 'task') return this.may('/api/todos', 'POST') ? this.todo({ action: 'note', id, body, via: 'slack-thread' }) : { ok: false, message: 'your role does not include the to-do list' };
    return this.may('/api/claims', 'POST') ? this.claimSave({ action: 'note', id, body, via: 'slack-thread' }) : { ok: false, message: 'your role does not include claims' };
  }

  /**
   * A request made at once (§110): the title from the words, the listing
   * named in them, the whole text and a link back as the description. The
   * reply in the request's thread says it is tracked, with ✎ Add details,
   * and that thread becomes the task's.
   */
  async quickCreate(kind: 'task' | 'work_order', words: string, thread: { channel: string; ts: string }, messageTs: string): Promise<Record<string, unknown>> {
    if (!this.may('/api/todos', 'POST')) return { ok: false, message: 'your role does not include the to-do list' };
    const units = await this.units();
    const unit = guessUnit(words, units);
    const { title, description } = quickTitle(words);
    const link = await slackApi<{ permalink?: string }>(this.s.token!, 'chat.getPermalink', { channel: thread.channel, message_ts: messageTs });
    const r = await this.todo({ action: 'create', kind, title, unitIds: unit ? [unit] : [], priority: 'none',
      description: [description, link.permalink ? `From Slack: ${link.permalink}` : ''].filter(Boolean).join('\n\n') || null });
    if (!r.ok || !r.id) return r;
    const m = trackedReply({ id: String(r.id), title, kind, unit: units.find(u => u.value === unit)?.label ?? null });
    const posted = await slackApi<{ ts?: string }>(this.s.token!, 'chat.postMessage', { channel: thread.channel, thread_ts: thread.ts, ...m, unfurl_links: false });
    if (posted.ok) await rememberThread(this.sql, { ok: true, ...thread }, 'task', String(r.id));
    return r;
  }

  /** "@Kaizen comments" in a thread (§108): what people wrote on it so far. */
  async comments(subject: 'task' | 'claim', id: string) {
    if (!this.may(subject === 'task' ? '/api/todos' : '/api/claims', 'GET')) return { text: 'Your Kaizen role does not include that.', blocks: [] };
    const [rows, head] = await Promise.all([
      this.sql`SELECT body, created_by, created_at FROM work_updates WHERE account_id = 1 AND subject = ${subject} AND subject_id = ${id} AND kind = 'note'
                ORDER BY created_at, id` as Promise<{ body: string; created_by: string | null; created_at: string }[]>,
      subject === 'task' ? taskLite(this.sql, id).then(t => t?.title ?? 'this task')
        : claimLite(this.sql, id).then(c => c ? `${c.unit ?? 'Portfolio'} · ${c.description ?? c.category ?? 'claim'}` : 'this claim')
    ]);
    const m = commentsBlocks(rows.map(r => ({ who: (r.created_by ?? '—').split('@')[0]!, when: nyParts(new Date(r.created_at).toISOString()).short, body: r.body })), head);
    const more = rows.length > 10 ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: `Showing the latest 10 of ${rows.length}.` }] }] : [];
    const open = subject === 'task' ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '📋 Open' }, action_id: 'task_open', value: id }] }] : [];
    return { text: m.text, blocks: [...m.blocks, ...more, ...open] };
  }

  /** "@Kaizen tasks" / "@Kaizen today" (§108): the same answers as /kaizen, for a message seen only by the writer. */
  async forMention(verb: 'tasks' | 'today' | 'claims' | 'all'): Promise<{ text: string; blocks: unknown[] }> {
    if (verb === 'claims') {
      if (!this.may('/api/claims', 'GET')) return { text: 'Your Kaizen role does not include claims.', blocks: [] };
      return { text: 'Open claims', blocks: claimList(await this.openClaims()) };
    }
    if (verb === 'tasks') {
      if (!this.may('/api/todos', 'GET')) return { text: 'Your Kaizen role does not include the to-do list.', blocks: [] };
      return { text: 'Open work', blocks: taskList(await this.openTasks(), this.s.config.appUrl) };
    }
    if (!this.may('/api/operations', 'GET')) return { text: 'Your Kaizen role does not include operations.', blocks: [] };
    const facts = await digestFacts(this.sql, await getCredentials(this.sql, this.ctx.env.ENCRYPTION_KEY), this.ctx.env.ENCRYPTION_KEY);
    const m = digestMessage(facts, 'morning', this.s.config.appUrl, helpUrlOf(this.s.config));
    if (verb !== 'all') return m;
    // "all" adds how the day is going: what closed and what opened since midnight, the team's time.
    const tz = teamTz(this.s.config);
    const day = await taskCheckFacts(this.sql, localNow(tz).day, tz);
    const line = { type: 'context', elements: [{ type: 'mrkdwn', text: `*Today so far* · ✓ ${day.closed.length} closed · ＋ ${day.opened.length} opened · ○ ${day.open.length} open` }] };
    return { text: m.text, blocks: [...m.blocks.slice(0, 1), line, ...m.blocks.slice(1)] };
  }

  /* ── the task card (§100) ── */
  private async card(id: string): Promise<TaskCard | null> {
    const [t] = await this.sql`SELECT t.id::text, t.title, t.kind, t.status, t.priority, t.assignee, t.supervisor, t.due_on::text AS due_on,
                                      t.scheduled_on::text AS scheduled_on, t.reservation_label, t.description, t.vendor, t.cost_actual,
                                      t.cost_estimate, t.resolution_note, u.name AS unit
                                 FROM todos t LEFT JOIN units u ON u.account_id = t.account_id AND u.id = t.unit_ids[1]
                                WHERE t.account_id = 1 AND t.id::text = ${id} AND t.deleted_at IS NULL` as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!t) return null;
    const [kids, ups] = await Promise.all([
      this.sql`SELECT title, status FROM todos WHERE account_id = 1 AND parent_id::text = ${id} AND deleted_at IS NULL ORDER BY created_at` as Promise<{ title: string; status: string }[]>,
      // The card shows what people wrote; the system's lines are Kaizen's activity log (§103).
      this.sql`SELECT body, created_by, created_at FROM work_updates WHERE account_id = 1 AND subject = 'task' AND subject_id = ${id} AND kind = 'note'
                ORDER BY created_at DESC, id DESC LIMIT 3` as Promise<{ body: string; created_by: string | null; created_at: string }[]>
    ]);
    return { id: t.id, title: t.title, kind: t.kind, status: t.status, priority: t.priority, assignee: t.assignee, supervisor: t.supervisor,
      dueOn: t.due_on, scheduledOn: t.scheduled_on, reservationLabel: t.reservation_label, description: t.description, vendor: t.vendor,
      costActual: t.cost_actual == null ? null : Number(t.cost_actual), costEstimate: t.cost_estimate == null ? null : Number(t.cost_estimate),
      resolutionNote: t.resolution_note, unit: t.unit, children: kids,
      updates: ups.reverse().map(u => ({ body: u.body, who: (u.created_by ?? '—').split('@')[0]!, when: nyParts(new Date(u.created_at).toISOString()).short })) };
  }
  /* ── the claim card (§113) ── */
  private async claimCardOf(id: string) {
    const [c, row, ups] = await Promise.all([
      claimLite(this.sql, id), this.claimRow(id),
      this.sql`SELECT body, created_by, created_at FROM work_updates WHERE account_id = 1 AND subject = 'claim' AND subject_id = ${id} AND kind = 'note'
                ORDER BY created_at, id` as Promise<{ body: string; created_by: string | null; created_at: string }[]>
    ]);
    if (!c || !row) return null;
    return { ...c, source: row.source, refund: Number(row.refund) || 0, repairCost: Number(row.repair_cost) || 0,
      updates: ups.map(u => ({ body: u.body, who: (u.created_by ?? '—').split('@')[0]!, when: nyParts(new Date(u.created_at).toISOString()).short })) };
  }
  private async openClaimCard(trigger: string, id: string, push = false) {
    const c = await this.claimCardOf(id);
    if (!c) return ephemeral('That claim is gone.');
    if (push) await slackApi(this.s.token!, 'views.push', { trigger_id: trigger, view: claimCard(c, undefined, 'claims', true) });
    else await this.open(trigger, claimCard(c, undefined, undefined, true));
    return ack();
  }

  /** The card, opened to comment (§111): the cursor in the comment box. */
  private async openCard(trigger: string, id: string, push = false) {
    const c = await this.card(id);
    if (!c) return ephemeral('That task is gone.');
    if (push) await slackApi(this.s.token!, 'views.push', { trigger_id: trigger, view: taskCard(c, undefined, 'tasks', true) });
    else await this.open(trigger, taskCard(c, undefined, undefined, true));
    return ack();
  }
  /** The card again, after an action — in place. */
  private async refreshCard(viewId: string, id: string, note?: string, root?: 'tasks') {
    const c = await this.card(id);
    if (c) await slackApi(this.s.token!, 'views.update', { view_id: viewId, view: taskCard(c, note, root) });
  }

  /* ── the reminder's sections, each in its pop-up (§102) ── */
  private async tasksFlagged() {
    const today = todayIn('America/New_York');
    return (await this.openTasks()).map(t => ({ ...t, overdue: !!t.dueOn && t.dueOn < today, dueToday: t.dueOn === today }));
  }
  private async refreshTasks(viewId: string, note?: string, undo?: { id: string; title: string }) {
    await slackApi(this.s.token!, 'views.update', { view_id: viewId, view: tasksModal(await this.tasksFlagged(), note, undo) });
  }
  private async refreshClaims(viewId: string, note?: string, undo?: { id: string; title: string }) {
    await slackApi(this.s.token!, 'views.update', { view_id: viewId, view: claimsModal(await this.openClaims(), note, undo) });
  }
  private async openCheckins(trigger: string, days: string[]): Promise<Response> {
    if (!this.may('/api/operations', 'GET')) return this.deny('operations');
    const r = await slackApi<{ view?: { id: string } }>(this.s.token!, 'views.open', { trigger_id: trigger, view: loadingModal('Check-ins') });
    if (!r.ok || !r.view) throw new Error(`Slack did not open the form (${r.error}).`);
    this.ctx.waitUntil(this.fillCheckins(r.view.id, days));
    return ack();
  }
  private async fillCheckins(viewId: string, days: string[], note?: string) {
    try {
      const facts = await digestFacts(this.sql, await getCredentials(this.sql, this.ctx.env.ENCRYPTION_KEY), this.ctx.env.ENCRYPTION_KEY);
      await slackApi(this.s.token!, 'views.update', { view_id: viewId, view: checkinsModal(facts, days, this.may('/api/turnover', 'POST'), note) });
    } catch (e) {
      await slackApi(this.s.token!, 'views.update', { view_id: viewId, view: { ...(loadingModal('Check-ins') as object),
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `⚠ Could not read the board: ${e instanceof Error ? e.message : String(e)}` } }] } });
    }
  }
  /** A form opened from inside a section's pop-up goes on top of it, and remembers which list to refresh. */
  private async pushForm(trigger: string, view: Record<string, unknown>, meta: Record<string, unknown>) {
    await slackApi(this.s.token!, 'views.push', { trigger_id: trigger, view: { ...view, private_metadata: JSON.stringify(meta) } });
  }

  /* ── a day's cleans (§101) ── */
  /** Open at once ("Reading the board…"), fill when the board is read. */
  private async openCleans(trigger: string, date: string): Promise<Response> {
    if (!this.may('/api/operations', 'GET')) return this.deny('operations');
    const r = await slackApi<{ view?: { id: string } }>(this.s.token!, 'views.open', { trigger_id: trigger, view: loadingModal('Cleans') });
    if (!r.ok || !r.view) throw new Error(`Slack did not open the form (${r.error}).`);
    this.ctx.waitUntil(this.fillCleans(r.view.id, date));
    return ack();
  }
  private async fillCleans(viewId: string, date: string, note?: string) {
    const today = todayIn('America/New_York');
    const label = date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : day(date);
    try {
      // Booking values only for roles that see them on the board (the `money` permission).
      const showMoney = this.perms.includes('*') || this.perms.includes('money');
      const rows = (await cleansFor(this.sql, await getCredentials(this.sql, this.ctx.env.ENCRYPTION_KEY), date))
        .map(r => showMoney ? r : { ...r, out: r.out && { ...r.out, total: null }, next: r.next && { ...r.next, total: null } });
      await slackApi(this.s.token!, 'views.update', { view_id: viewId, view: cleansModal(date, label, rows, this.may('/api/turnover', 'POST'), note,
                                                                                          { today, tomorrow: addDays(today, 1) }) });
    } catch (e) {
      await slackApi(this.s.token!, 'views.update', { view_id: viewId, view: { ...(loadingModal('Cleans') as object),
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `⚠ Could not read the board: ${e instanceof Error ? e.message : String(e)}` } }] } });
    }
  }

  /* ── shortcuts ⚡ and "Create task from message" (§100) ── */
  async shortcut(p: Record<string, any>): Promise<Response> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const cb = String(p.callback_id ?? '');
    if (cb === 'new_claim') {
      if (!this.may('/api/claims', 'POST')) return this.deny('claims');
      await this.open(p.trigger_id, claimModal({ occurredOn: todayIn('America/New_York') }, await this.units(), CLAIM_CATEGORIES, CLAIM_SOURCES));
      return ack();
    }
    if (!this.may('/api/todos', 'POST')) return this.deny('the to-do list');
    await this.open(p.trigger_id, taskModal({ kind: cb === 'new_repair' ? 'work_order' : 'task' }, await this.units(), await this.people()));
    return ack();
  }
  async fromMessage(p: Record<string, any>): Promise<Response> { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!this.may('/api/todos', 'POST')) return this.deny('the to-do list');
    const text = String(p.message?.text ?? '').trim();
    const channel = String(p.channel?.id ?? ''), ts = String(p.message?.ts ?? '');
    const root = String(p.message?.thread_ts ?? ts);
    const link = channel && ts ? await slackApi<{ permalink?: string }>(this.s.token!, 'chat.getPermalink', { channel, message_ts: ts }) : null;
    const first = text.split('\n')[0]!.replace(/<[^>]+>/g, '').trim();
    await this.open(p.trigger_id, taskModal({
      kind: 'task', title: first.slice(0, 120),
      description: [text, link?.permalink ? `From Slack: ${link.permalink}` : ''].filter(Boolean).join('\n\n').slice(0, 3800),
      ...(channel && ts ? { from: { channel, ts: root } } : {})
    }, await this.units(), await this.people()));
    return ack();
  }

  /* ── /kaizen ── */
  async command(text: string, trigger: string, responseUrl: string): Promise<Response> {
    const { verb, arg } = parseCommand(text);
    if (verb === 'help') {
      // §101: the SOP "Kaizen in Slack", right here — and the way to it in Kaizen.
      const [sop] = this.s.config.helpSopId ? await this.sql`SELECT title, purpose, steps FROM sops WHERE account_id = 1 AND id::text = ${this.s.config.helpSopId}
                                                              AND deleted_at IS NULL AND status = 'published'` as { title: string; purpose: string | null; steps: { text: string; detail?: string }[] }[] : [];
      return ephemeral('How to use Kaizen in Slack', [sectionButtons(), ...helpBlocks(sop ?? null, helpUrlOf(this.s.config)),
        { type: 'context', elements: [{ type: 'mrkdwn', text: HELP.split('\n').map(l => l.split(' — ')[0]).join(' · ') }] }]);
    }
    if (verb === 'cleans') {
      const today = todayIn('America/New_York');
      return await this.openCleans(trigger, /tomorrow|mañana/i.test(arg) ? addDays(today, 1) : /^\d{4}-\d{2}-\d{2}$/.test(arg.trim()) ? arg.trim() : today);
    }
    if (verb === 'tasks') {
      if (!this.may('/api/todos', 'GET')) return this.deny('the to-do list');
      return ephemeral('Open work', taskList(await this.openTasks(), this.s.config.appUrl));
    }
    if (verb === 'task' || verb === 'repair') {
      if (!this.may('/api/todos', 'POST')) return this.deny('the to-do list');
      await this.open(trigger, taskModal({ kind: verb === 'repair' ? 'work_order' : 'task', title: arg }, await this.units(), await this.people()));
      return ack();
    }
    if (verb === 'cost') {
      if (!this.may('/api/expenses', 'POST')) return this.deny('costs');
      const units = await this.units();
      await this.open(trigger, costModal(costFromWords(arg, units, todayIn('America/New_York')), units));
      return ack();
    }
    if (verb === 'claims') {
      if (!this.may('/api/claims', 'GET')) return this.deny('claims');
      return ephemeral('Open claims', claimList(await this.openClaims()));
    }
    if (verb === 'claim') {
      if (!this.may('/api/claims', 'POST')) return this.deny('claims');
      await this.open(trigger, claimModal({ description: arg, occurredOn: todayIn('America/New_York') }, await this.units(), CLAIM_CATEGORIES, CLAIM_SOURCES));
      return ack();
    }
    // today: reading the board takes longer than Slack waits — answer now, send it when ready.
    if (!this.may('/api/operations', 'GET')) return this.deny('operations');
    this.ctx.waitUntil((async () => {
      try {
        const facts = await digestFacts(this.sql, await getCredentials(this.sql, this.ctx.env.ENCRYPTION_KEY), this.ctx.env.ENCRYPTION_KEY);
        const m = digestMessage(facts, 'morning', this.s.config.appUrl, helpUrlOf(this.s.config));
        await this.reply(responseUrl, { response_type: 'ephemeral', text: m.text, blocks: m.blocks });
      } catch (e) {
        await this.reply(responseUrl, { response_type: 'ephemeral', text: `Could not read the board: ${e instanceof Error ? e.message : String(e)}` });
      }
    })());
    return ephemeral('Reading the board…');
  }

  /* ── buttons and menus ── */
  async action(p: Record<string, any>): Promise<Response> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const a = p.actions?.[0] ?? {};
    // Slack refuses two buttons with one action_id in a message, so "+ Repair" has its own — it is task_new for a repair.
    const id: string = a.action_id === 'task_new_repair' ? 'task_new' : a.action_id;
    const value: string = a.selected_option?.value ?? a.value ?? '';
    const url: string = p.response_url ?? '';
    const inChannel = p.container?.type === 'message' && !p.container?.is_ephemeral;
    if (id === 'open_kaizen' || id.startsWith('open_hostaway_')) return ack();
    const inView: string = p.container?.type === 'view' ? (p.view?.callback_id ?? '') : '';
    const viewId: string = p.view?.id ?? '';

    // §102: "Manage" on each section of the reminder.
    if (id.startsWith('sec_')) {
      // From a message's Manage: its days. From the help's buttons (§112): today and tomorrow.
      const today = todayIn('America/New_York');
      const days = (JSON.parse(value || '{}') as { days?: string[] }).days ?? [today, addDays(today, 1)];
      if (id === 'sec_checkins') return await this.openCheckins(p.trigger_id, days);
      if (id === 'sec_cleans') return await this.openCleans(p.trigger_id, days[0]!);
      if (id === 'sec_tasks') {
        if (!this.may('/api/todos', 'GET')) return this.deny('the to-do list');
        await this.open(p.trigger_id, tasksModal(await this.tasksFlagged()));
        return ack();
      }
      if (id === 'sec_claims') {
        if (!this.may('/api/claims', 'GET')) return this.deny('claims');
        await this.open(p.trigger_id, claimsModal(await this.openClaims()));
        return ack();
      }
    }
    // Today / Tomorrow inside the Cleans pop-up.
    if (id.startsWith('cleans_day_')) {
      await slackApi(this.s.token!, 'views.update', { view_id: viewId, view: loadingModal('Cleans') });
      this.ctx.waitUntil(this.fillCleans(viewId, value));
      return ack();
    }

    // §111: "💬 Comment on a task…" — in a message, the card; inside the Tasks pop-up, on top of it.
    if (id === 'task_pick') {
      if (!this.may('/api/todos', 'GET')) return this.deny('the to-do list');
      return await this.openCard(p.trigger_id, value, inView === 'sec_tasks');
    }

    // §113: a claim's 💬 Comment — its card; inside the Claims pop-up, on top of it.
    if (id === 'claim_open') {
      if (!this.may('/api/claims', 'GET')) return this.deny('claims');
      return await this.openClaimCard(p.trigger_id, value, inView === 'sec_claims');
    }

    // Inside the Tasks pop-up: everything refreshes the list in place; open and edit go on top of it.
    if (inView === 'sec_tasks' && id.startsWith('task_')) {
      const [verb, tid = ''] = id === 'task_menu' ? value.split(':') : [id.replace('task_', ''), value];
      if (verb === 'open') { if (!this.may('/api/todos', 'GET')) return this.deny('the to-do list'); return await this.openCard(p.trigger_id, tid, true); }
      if (!this.may('/api/todos', 'POST')) return this.deny('the to-do list');
      if (verb === 'new') { await this.pushForm(p.trigger_id, taskModal({ kind: value === 'work_order' ? 'work_order' : 'task' }, await this.units(), await this.people()) as Record<string, unknown>, { id: null, kind: value === 'work_order' ? 'work_order' : 'task', root: 'tasks' }); return ack(); }
      if (verb === 'edit') {
        const f = await this.taskForm(tid);
        if (f) await this.pushForm(p.trigger_id, taskModal(f, await this.units(), await this.people()) as Record<string, unknown>, { id: f.id, kind: f.kind, root: 'tasks' });
        return ack();
      }
      const t = await taskLite(this.sql, tid);
      const body = verb === 'complete' ? { action: 'done', id: tid, done: true } : verb === 'start' ? { action: 'update', id: tid, status: 'in_progress' }
        : verb === 'remove' ? { action: 'delete', id: tid } : verb === 'restore' ? { action: 'restore', id: tid } : null;
      if (!body) return ack();
      // A button on a message already in the tasks channel: that message is updated in place below, so the
      // channel must not also get a separate "completed / started / reopened" post — it showed twice (2026-10-07).
      const onTasksMessage = inChannel && p.container?.channel_id === this.s.config.channels?.tasks?.id;
      const r = await this.todo(onTasksMessage && body.action !== 'delete' && body.action !== 'restore' ? { ...body, via: 'slack-message' } : body);
      const word = verb === 'complete' ? 'Completed' : verb === 'start' ? 'Started' : verb === 'restore' ? 'Restored' : '';
      await this.refreshTasks(viewId, r.ok ? (word ? `✓ ${word}: ${t?.title ?? ''}` : undefined) : `⚠ ${r.message ?? 'Not saved.'}`,
                              r.ok && verb === 'remove' && t ? { id: tid, title: t.title } : undefined);
      return ack();
    }
    // Inside the Claims pop-up: the same.
    if (inView === 'sec_claims' && id.startsWith('claim_')) {
      // The status select carries 'Resolved|3'; buttons carry the id.
      const [verb, a1 = '', a2 = ''] = id === 'claim_menu' ? value.split(':') : id === 'claim_status' ? ['status', ...value.split('|')] : [id.replace('claim_', ''), value];
      const cid = verb === 'status' ? a2 : a1;
      if (!this.may('/api/claims', 'POST')) return this.deny('claims');
      if (verb === 'new') { await this.pushForm(p.trigger_id, claimModal({ occurredOn: todayIn('America/New_York') }, await this.units(), CLAIM_CATEGORIES, CLAIM_SOURCES) as Record<string, unknown>, { id: null, root: 'claims' }); return ack(); }
      if (verb === 'edit') {
        const c = await this.claimRow(cid);
        if (c) await this.pushForm(p.trigger_id, claimModal({ id: c.id, unitId: c.unit_id, occurredOn: c.occurred_on, category: c.category, severity: c.severity,
          status: c.status, source: c.source, description: c.description, refund: Number(c.refund) || 0, caseUrl: c.case_url }, await this.units(), CLAIM_CATEGORIES, CLAIM_SOURCES) as Record<string, unknown>, { id: c.id, root: 'claims' });
        return ack();
      }
      const before = await claimLite(this.sql, cid);
      let r: Record<string, unknown> = { ok: false };
      if (verb === 'status') r = await this.claimUpdate(cid, { status: a1 });
      if (verb === 'remove') r = await this.api(claims.onRequestDelete, `/api/claims?id=${encodeURIComponent(cid)}`, 'DELETE');
      if (verb === 'restore') r = await this.claimSave({ action: 'restore', id: cid });
      const title = before ? `${before.unit ?? 'Portfolio'} · ${before.description ?? before.category ?? 'Claim'}` : '';
      await this.refreshClaims(viewId, r.ok ? (verb === 'status' ? `✓ ${title} → ${a1}` : verb === 'restore' ? `✓ Restored: ${title}` : undefined) : `⚠ ${String(r.error ?? 'Not saved.')}`,
                               r.ok && verb === 'remove' ? { id: cid, title } : undefined);
      return ack();
    }

    // §100: the task card — opened from a message or a list, worked inside the pop-up.
    if (id === 'task_open' || (id === 'task_menu' && value.startsWith('open:'))) {
      if (!this.may('/api/todos', 'GET')) return this.deny('the to-do list');
      return await this.openCard(p.trigger_id, id === 'task_open' ? value : value.slice(5));
    }
    if (id.startsWith('card_')) {
      if (!this.may('/api/todos', 'POST')) return this.deny('the to-do list');
      if (id === 'card_edit') {
        const f = await this.taskForm(value);
        if (f) await slackApi(this.s.token!, 'views.push', { trigger_id: p.trigger_id, view: { ...(taskModal(f, await this.units(), await this.people()) as object),
          private_metadata: JSON.stringify({ id: f.id, kind: f.kind, card: true }) } });
        return ack();
      }
      let body: Record<string, unknown> | null = null, note = '';
      if (id === 'card_complete') { body = { action: 'done', id: value, done: true }; note = '✓ Completed'; }
      if (id === 'card_reopen') { body = { action: 'done', id: value, done: false }; note = '↺ Reopened'; }
      if (id === 'card_start') { body = { action: 'update', id: value, status: 'in_progress' }; note = '▶ Started'; }
      if (id === 'card_take') {
        const mine = hostawayUserOf(this.s.config, this.slackUser);
        if (!mine) { await this.refreshCard(viewId, value, '⚠ You are not linked to a Hostaway user yet (Settings → Slack → People), so Kaizen cannot make you the owner.'); return ack(); }
        body = { action: 'update', id: value, assigneeUserId: Number(mine) }; note = '🙋 Yours now';
      }
      if (!body) return ack();
      const r = await this.todo(body);
      const root = (JSON.parse(p.view?.private_metadata || '{}') as { root?: 'tasks' }).root;
      await this.refreshCard(viewId, value, r.ok ? note : `⚠ ${r.message ?? 'Not saved.'}`, root);
      // Opened from the Tasks pop-up: the list beneath follows.
      if (root === 'tasks' && p.view?.root_view_id && p.view.root_view_id !== viewId) await this.refreshTasks(p.view.root_view_id);
      return ack();
    }

    // §101: the reminder's "🧹 Cleans", and "Change" inside it (opened on top; saving returns to the refreshed list).
    if (id === 'cleans_open') return await this.openCleans(p.trigger_id, value);
    if (id === 'clean_change') {
      if (!this.may('/api/turnover', 'POST')) return this.deny('operations');
      const c = JSON.parse(value || '{}') as { resId: string; unit: string; date: string; from?: 'checkins'; days?: string[] };
      const cleaners = (await opsConfig(this.sql)).roster.filter(x => x.active).map(x => x.name);
      await slackApi(this.s.token!, 'views.push', { trigger_id: p.trigger_id, view: cleanAssignModal({ ...c, from: c.from ?? 'cleans' }, cleaners) });
      return ack();
    }
    // §100: the reminder's "Assign cleaner".
    if (id === 'clean_assign') {
      if (!this.may('/api/turnover', 'POST')) return this.deny('operations');
      const c = JSON.parse(value || '{}') as { resId: string; unit: string; date: string };
      const cleaners = (await opsConfig(this.sql)).roster.filter(x => x.active).map(x => x.name);
      await this.open(p.trigger_id, cleanAssignModal(c, cleaners));
      return ack();
    }

    // §108: the buttons an @Kaizen mention answers with — the forms, title filled in; saving says so in the mention's thread.
    if (id.startsWith('mention_new_')) {
      const v = JSON.parse(value || '{}') as { kind?: string; title?: string; from?: { channel: string; ts: string } };
      // A to-do or repair with words: made at once, like "@Kaizen new" (§110); the offer goes.
      if ((v.kind === 'task' || v.kind === 'work_order') && v.title && v.from) {
        const r = await this.quickCreate(v.kind === 'work_order' ? 'work_order' : 'task', v.title, v.from, v.from.ts);
        await this.reply(url, r.ok ? { delete_original: true } : { replace_original: true, response_type: 'ephemeral', text: `Not saved: ${String(r.message ?? 'Kaizen said no.')}` });
        return ack();
      }
      if (v.kind === 'cost') {
        if (!this.may('/api/expenses', 'POST')) return this.deny('costs');
        const units = await this.units();
        await this.open(p.trigger_id, costModal(costFromWords(v.title ?? '', units, todayIn('America/New_York')), units));
      } else if (v.kind === 'claim') {
        if (!this.may('/api/claims', 'POST')) return this.deny('claims');
        await this.open(p.trigger_id, claimModal({ description: v.title ?? '', occurredOn: todayIn('America/New_York') }, await this.units(), CLAIM_CATEGORIES, CLAIM_SOURCES));
      } else {
        if (!this.may('/api/todos', 'POST')) return this.deny('the to-do list');
        await this.open(p.trigger_id, taskModal({ kind: v.kind === 'work_order' ? 'work_order' : 'task', title: v.title ?? '', ...(v.from ? { from: v.from } : {}) },
          await this.units(), await this.people()));
      }
      // The offer has done its job.
      await this.reply(url, { delete_original: true });
      return ack();
    }

    // Tasks
    const taskVerb = id === 'task_menu' ? value.split(':')[0] : id.replace('task_', '');
    const taskId = id === 'task_menu' ? value.split(':')[1] ?? '' : value;
    if (id.startsWith('task_')) {
      if (!this.may('/api/todos', 'POST')) return this.deny('the to-do list');
      if (taskVerb === 'new') { await this.open(p.trigger_id, taskModal({ kind: value === 'work_order' ? 'work_order' : 'task' }, await this.units(), await this.people())); return ack(); }
      if (taskVerb === 'edit') {
        const f = await this.taskForm(taskId);
        if (!f) return ephemeral('That task is gone.');
        await this.open(p.trigger_id, taskModal(f, await this.units(), await this.people()));
        return ack();
      }
      const body = taskVerb === 'complete' ? { action: 'done', id: taskId, done: true }
        : taskVerb === 'reopen' ? { action: 'done', id: taskId, done: false }
        : taskVerb === 'start' ? { action: 'update', id: taskId, status: 'in_progress' }
        : taskVerb === 'remove' ? { action: 'delete', id: taskId }
        : taskVerb === 'restore' ? { action: 'restore', id: taskId } : null;
      if (!body) return ack();
      const r = await this.todo(body);
      if (!r.ok) { await this.reply(url, { response_type: 'ephemeral', replace_original: false, text: r.message ?? 'Not saved.' }); return ack(); }
      const t = await taskLite(this.sql, taskId);
      if (inChannel && t) {
        await this.reply(url, { replace_original: true, ...taskMessage(t, taskVerb === 'complete' ? 'completed' : taskVerb === 'start' ? 'started' : taskVerb === 'reopen' ? 'reopened' : 'updated', this.email.split('@')[0]!, this.s.config.appUrl) });
      } else {
        const note = taskVerb === 'remove' && t ? [{ type: 'section', text: { type: 'mrkdwn', text: `Removed *${t.title}*.` },
          accessory: { type: 'button', text: { type: 'plain_text', text: 'Undo' }, action_id: 'task_restore', value: taskId } }] : [];
        await this.reply(url, { replace_original: true, response_type: 'ephemeral', text: 'Open work', blocks: [...note, ...taskList(await this.openTasks(), this.s.config.appUrl)] });
      }
      return ack();
    }

    // Claims
    if (id.startsWith('claim_')) {
      if (!this.may('/api/claims', 'POST')) return this.deny('claims');
      if (id === 'claim_new') { await this.open(p.trigger_id, claimModal({ occurredOn: todayIn('America/New_York') }, await this.units(), CLAIM_CATEGORIES, CLAIM_SOURCES)); return ack(); }
      const [verb, a1, a2] = id === 'claim_menu' ? value.split(':') : id === 'claim_status' ? ['status', ...value.split('|')] : [id.replace('claim_', ''), value];
      // menu 'status:Resolved:3' / select 'Resolved|3' carry the claim second; everything else first.
      const claimId = (verb === 'status' ? a2 : a1) ?? '';
      if (verb === 'edit') {
        const c = await this.claimRow(claimId);
        if (!c) return ephemeral('That claim is gone.');
        await this.open(p.trigger_id, claimModal({ id: c.id, unitId: c.unit_id, occurredOn: c.occurred_on, category: c.category, severity: c.severity,
          status: c.status, source: c.source, description: c.description, refund: Number(c.refund) || 0, caseUrl: c.case_url }, await this.units(), CLAIM_CATEGORIES, CLAIM_SOURCES));
        return ack();
      }
      let r: Record<string, unknown>;
      if (verb === 'status') r = await this.claimUpdate(claimId, { status: a1 });
      else if (verb === 'remove') r = await this.api(claims.onRequestDelete, `/api/claims?id=${encodeURIComponent(claimId)}`, 'DELETE');
      else if (verb === 'restore') r = await this.claimSave({ action: 'restore', id: claimId });
      else return ack();
      if (!r.ok) { await this.reply(url, { response_type: 'ephemeral', replace_original: false, text: String(r.error ?? 'Not saved.') }); return ack(); }
      const c = await claimLite(this.sql, claimId);
      if (inChannel && c && verb === 'status') await this.reply(url, { replace_original: true, ...claimMessage(c, `→ ${c.status}`, this.email.split('@')[0]!) });
      else {
        const note = verb === 'remove' && c ? [{ type: 'section', text: { type: 'mrkdwn', text: `Removed the claim *${c.unit ?? ''} · ${c.description ?? c.category ?? ''}*.` },
          accessory: { type: 'button', text: { type: 'plain_text', text: 'Undo' }, action_id: 'claim_restore', value: claimId } }] : [];
        await this.reply(url, { replace_original: true, response_type: 'ephemeral', text: 'Open claims', blocks: [...note, ...claimList(await this.openClaims())] });
      }
      return ack();
    }
    return ack();
  }

  /* ── forms ── */
  async submit(p: Record<string, any>): Promise<Response> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const view = p.view ?? {};
    const meta = JSON.parse(view.private_metadata || '{}') as { id: string | null; kind?: string };
    const state = view.state?.values ?? {};
    if (view.callback_id === 'task_card') {
      // "Add comment": the box at the bottom of the card; the card stays open with it in.
      const body = String(state.update?.v?.value ?? '').trim();
      if (!body) return json({ response_action: 'errors', errors: { update: 'Write a comment first.' } });
      const r = await this.todo({ action: 'note', id: meta.id, body });
      if (!r.ok) return json({ response_action: 'errors', errors: { update: r.message ?? 'Not saved.' } });
      const c = await this.card(String(meta.id));
      return c ? json({ response_action: 'update', view: taskCard(c, '✓ Comment added') }) : json({ response_action: 'clear' });
    }
    if (view.callback_id === 'cost_save') {
      // §117: Costs → One-offs, as this member; the form stays open on an error, says what was saved on success.
      if (!this.may('/api/expenses', 'POST')) return json({ response_action: 'errors', errors: { what: 'Your role does not include costs.' } });
      const f = readCostForm(state);
      if ('error' in f) return json({ response_action: 'errors', errors: { [f.error.block]: f.error.message } });
      const r = await this.api(expenses.onRequestPost, '/api/expenses', 'POST', f.body);
      if (!r.ok) return json({ response_action: 'errors', errors: { amount: String(r.error ?? 'Not saved.') } });
      const unit = f.body.unitId ? (await this.units()).find(u => u.value === f.body.unitId)?.label : 'Shared';
      return json({ response_action: 'update', view: { type: 'modal', title: { type: 'plain_text', text: 'Cost logged' }, close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✓ *$${Number(f.body.amount).toFixed(2)}* · ${f.body.category} · ${unit} · ${f.body.date}\n${String(f.body.notes)}` } },
                 { type: 'context', elements: [{ type: 'mrkdwn', text: 'In Costs → One-offs. To change or remove it, open Costs in Kaizen.' }] }] } });
    }
    if (view.callback_id === 'claim_card') {
      // §113: "Add comment" on a claim; the card stays open with it in, and the Claims list beneath follows.
      const body = String(state.update?.v?.value ?? '').trim();
      if (!body) return json({ response_action: 'errors', errors: { update: 'Write a comment first.' } });
      if (!this.may('/api/claims', 'POST')) return json({ response_action: 'errors', errors: { update: 'Your role does not include claims.' } });
      const r = await this.claimSave({ action: 'note', id: meta.id, body });
      if (!r.ok) return json({ response_action: 'errors', errors: { update: String(r.error ?? 'Not saved.') } });
      const root = (meta as { root?: 'claims' }).root;
      const c = await this.claimCardOf(String(meta.id));
      return c ? json({ response_action: 'update', view: claimCard(c, '✓ Comment added', root) }) : json({ response_action: 'clear' });
    }
    if (view.callback_id === 'clean_assign_save') {
      if (!this.may('/api/turnover', 'POST')) return json({ response_action: 'errors', errors: { cleaner: 'Your role does not include operations.' } });
      const m = JSON.parse(view.private_metadata || '{}') as { resId: string; unit: string; date: string; from?: string; days?: string[] };
      const pick = String(state.cleaner?.v?.selected_option?.value ?? '');
      // "Let the rule decide" hands both back to the rule (the turnover API's null).
      const set = pick === '__not_needed' ? { assignment: 'not_needed' } : pick === '__rule' ? { assignment: null, cleaner: null } : { assignment: 'assigned', cleaner: pick };
      const r = await this.api(turnover.onRequestPost, '/api/turnover', 'POST', { resId: m.resId, set });
      if (!r.ok) return json({ response_action: 'errors', errors: { cleaner: String(r.message ?? r.error ?? 'Not saved.') } });
      // Opened from the Cleans list: back to it, refreshed (after the reply — reading the board takes longer than Slack waits).
      const said = pick === '__not_needed' ? 'no clean needed' : pick === '__rule' ? 'back to the rule' : pick;
      if (m.from === 'cleans' && view.root_view_id) { this.ctx.waitUntil(this.fillCleans(view.root_view_id, m.date, `✓ ${m.unit}: ${said}`)); return ack(); }
      if (m.from === 'checkins' && view.root_view_id) { this.ctx.waitUntil(this.fillCheckins(view.root_view_id, m.days ?? [m.date], `✓ ${m.unit}: ${said}`)); return ack(); }
      return json({ response_action: 'clear' });
    }
    if (view.callback_id === 'task_save') {
      if (!this.may('/api/todos', 'POST')) return json({ response_action: 'errors', errors: { title: 'Your role does not include the to-do list.' } });
      const m = meta as { id: string | null; kind?: string; card?: boolean; root?: string; from?: { channel: string; ts: string } };
      const body = readTaskForm(state, { id: m.id, kind: m.kind ?? 'task' });
      if (Number.isNaN(body.costActual)) return json({ response_action: 'errors', errors: { cost: 'A number, like 85 or 85.50.' } });
      const r = await this.todo(body);
      if (!r.ok) return json({ response_action: 'errors', errors: { title: r.message ?? 'Not saved.' } });
      // Made from a message: the thread says it is tracked now.
      if (m.from && r.id) {
        // …and becomes the task's thread (§108): "@Kaizen …" there comments on it.
        const from = m.from;
        this.ctx.waitUntil(slackApi(this.s.token!, 'chat.postMessage', { channel: from.channel, thread_ts: from.ts,
          text: `📋 Tracked in Kaizen as a ${m.kind === 'work_order' ? 'repair' : 'task'}: *${String(body.title)}* — reply here with @Kaizen to comment` })
          .then(() => rememberThread(this.sql, { ok: true, ...from }, 'task', String(r.id))).catch(() => {}));
      }
      // Edited on top of the card: back to the card, refreshed.
      if (m.card && m.id && view.root_view_id) { await this.refreshCard(view.root_view_id, m.id, '✎ Saved'); return ack(); }
      // Added or edited from the Tasks pop-up: back to the list, refreshed.
      if (m.root === 'tasks' && view.root_view_id) { await this.refreshTasks(view.root_view_id, `✓ Saved: ${String(body.title)}`); return ack(); }
      return json({ response_action: 'clear' });
    }
    if (view.callback_id === 'claim_save') {
      if (!this.may('/api/claims', 'POST')) return json({ response_action: 'errors', errors: { description: 'Your role does not include claims.' } });
      const body = readClaimForm(state);
      const r = meta.id ? await this.claimUpdate(meta.id, body) : await this.claimSave({ ...body, repairCost: 0 });
      if (!r.ok) return json({ response_action: 'errors', errors: { description: String(r.error ?? 'Not saved.') } });
      // From the Claims pop-up: back to the list, refreshed.
      if ((meta as { root?: string }).root === 'claims' && view.root_view_id) { await this.refreshClaims(view.root_view_id, '✓ Saved'); return ack(); }
      return json({ response_action: 'clear' });
    }
    return json({ response_action: 'clear' });
  }
}
