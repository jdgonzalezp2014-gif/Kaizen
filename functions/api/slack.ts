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
import { slackApi, slackSetup, taskLite, claimLite, verifySlack, type SlackSetup } from '../_lib/slack.ts';
import { digestFacts } from '../_lib/slack-digest.ts';
import * as todos from './todos.ts';
import * as claims from './claims.ts';
import {
  claimList, claimMessage, claimModal, digestMessage, HELP, parseCommand, readClaimForm, readTaskForm, taskList, taskMessage, taskModal,
  type ClaimLite, type Opt, type TaskForm, type TaskLite
} from '../../src/lib/slack.ts';
import { CLAIM_CATEGORIES, CLAIM_SOURCES } from '../../src/lib/claims.ts';
import { todayIn } from '../../src/lib/dates.ts';

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
  const form = new URLSearchParams(raw);
  const payload = form.get('payload') ? JSON.parse(form.get('payload')!) as Record<string, any> : null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const slackUser = String(payload?.user?.id ?? form.get('user_id') ?? '');
  const member = await memberOf(sql, s.token, slackUser);
  if (!member.ok) {
    return payload?.type === 'view_submission'
      ? json({ response_action: 'errors', errors: { title: member.why } })
      : ephemeral(member.why);
  }
  const k = new Kaizen(ctx, sql, s, member.email, member.permissions);
  try {
    if (!payload) return await k.command(form.get('text') ?? '', form.get('trigger_id') ?? '', form.get('response_url') ?? '');
    if (payload.type === 'block_actions') return await k.action(payload);
    if (payload.type === 'view_submission') return await k.submit(payload);
    return ack();
  } catch (e) {
    return ephemeral(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
  }
};

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
  constructor(private ctx: Ctx, private sql: SqlFn, private s: SlackSetup, private email: string, private perms: string[]) {}

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

  /* ── /kaizen ── */
  async command(text: string, trigger: string, responseUrl: string): Promise<Response> {
    const { verb, arg } = parseCommand(text);
    if (verb === 'help') return ephemeral('Kaizen from Slack', [{ type: 'section', text: { type: 'mrkdwn', text: HELP } }]);
    if (verb === 'tasks') {
      if (!this.may('/api/todos', 'GET')) return this.deny('the to-do list');
      return ephemeral('Open work', taskList(await this.openTasks(), this.s.config.appUrl));
    }
    if (verb === 'task' || verb === 'repair') {
      if (!this.may('/api/todos', 'POST')) return this.deny('the to-do list');
      await this.open(trigger, taskModal({ kind: verb === 'repair' ? 'work_order' : 'task', title: arg }, await this.units(), await this.people()));
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
        const m = digestMessage(facts, 'morning', this.s.config.appUrl);
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
    const id: string = a.action_id;
    const value: string = a.selected_option?.value ?? a.value ?? '';
    const url: string = p.response_url ?? '';
    const inChannel = p.container?.type === 'message' && !p.container?.is_ephemeral;
    if (id === 'open_kaizen') return ack();

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
    if (view.callback_id === 'task_save') {
      if (!this.may('/api/todos', 'POST')) return json({ response_action: 'errors', errors: { title: 'Your role does not include the to-do list.' } });
      const body = readTaskForm(state, { id: meta.id, kind: meta.kind ?? 'task' });
      if (Number.isNaN(body.costActual)) return json({ response_action: 'errors', errors: { cost: 'A number, like 85 or 85.50.' } });
      const r = await this.todo(body);
      return r.ok ? json({ response_action: 'clear' }) : json({ response_action: 'errors', errors: { title: r.message ?? 'Not saved.' } });
    }
    if (view.callback_id === 'claim_save') {
      if (!this.may('/api/claims', 'POST')) return json({ response_action: 'errors', errors: { description: 'Your role does not include claims.' } });
      const body = readClaimForm(state);
      const r = meta.id ? await this.claimUpdate(meta.id, body) : await this.claimSave({ ...body, repairCost: 0 });
      return r.ok ? json({ response_action: 'clear' }) : json({ response_action: 'errors', errors: { description: String(r.error ?? 'Not saved.') } });
    }
    return json({ response_action: 'clear' });
  }
}
