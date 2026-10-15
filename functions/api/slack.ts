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
import { attachTodoFiles, commentFileLines, slackFiles, slackMessageFiles } from '../_lib/todo-files.ts';
import { commentToThread, notifyTask, rememberThread, slackApi, slackSetup, taskLite, claimLite, verifySlack, type SlackSetup } from '../_lib/slack.ts';
import { cleansFor, digestFacts } from '../_lib/slack-digest.ts';
import { taskCheckFacts } from '../_lib/slack-taskcheck.ts';
import * as todos from './todos.ts';
import * as claims from './claims.ts';
import * as expenses from './expenses.ts';
import { invItems, saveTodoOrder } from '../_lib/inventory.ts';
import * as sopsApi from './sops.ts';
import { askJson } from '../_lib/ai-chain.ts';
import { gapsInThread, standardFrom, draftFromAi, draftFromThread, helpAnswerBlocks, helpFromAi, helpMissingBlocks, helpPrompt, rankSops, type SopDoc, partialSopForm, readSopForm, reviewFromAi, reviewNote, sopBody, sopListModal, sopModal, sopPrompt, sopsBlocks, sopViewModal, slackText,
         type SopSectionLite, type SopSource } from '../../src/lib/slack-sops.ts';
import { addToBlocks, sourceOf, suggestTarget, type AddSource, type AddTarget } from '../../src/lib/slack-addto.ts';
import { supplyPlaces } from '../_lib/unit-access.ts';
import {
  claimList, claimMessage, claimModal, cleanAssignModal, cleansModal, day, digestMessage, HELP, helpBlocks, helpUrlOf, hostawayUserOf, loadingModal,
  parseCommand, readClaimForm, readTaskForm, taskCard, taskList, taskMessage, taskModal, unboughtModal, checkinsModal, claimsModal, tasksModal, commentFromMention,
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
  // §107/§153: the Events API — a JSON body. app_mention is "@Kaizen …"; message.channels/message.groups
  // (§153) is every other message, used only for a plain reply inside a task/claim's own thread.
  if (raw.trimStart().startsWith('{')) {
    const body = JSON.parse(raw) as { type?: string; challenge?: string; event?: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (body.type === 'url_verification') return json({ challenge: body.challenge });
    // Slack retries what was not answered in 3 seconds; the first delivery is already being handled.
    if (body.type === 'event_callback' && !request.headers.get('X-Slack-Retry-Num')) {
      const ev = body.event ?? {};
      if (ev.type === 'app_mention' && !ev.bot_id) ctx.waitUntil(mention(ctx, sql, s, ev).catch(() => {}));
      // Owner, 2026-10-14: 📎 on a message saves it — to its thread's task or claim, else the "Add to…" question.
      else if (ev.type === 'reaction_added' && ev.reaction === 'paperclip' && ev.item?.type === 'message') ctx.waitUntil(clipped(ctx, sql, s, ev).catch(() => {}));
      // Owner, 2026-10-14: a DM to Kaizen takes the same commands as "@Kaizen …", no @ needed.
      else if (ev.type === 'message' && ev.channel_type === 'im' && !ev.bot_id && (!ev.subtype || ev.subtype === 'file_share')) ctx.waitUntil(dmMessage(ctx, sql, s, ev).catch(() => {}));
      // A threaded reply, not the thread's own first message, and not itself an @-mention (app_mention above owns that one).
      else if (ev.type === 'message' && !ev.bot_id && (!ev.subtype || ev.subtype === 'file_share')) {
        if (ev.thread_ts && ev.thread_ts !== ev.ts) ctx.waitUntil(threadReply(ctx, sql, s, ev).catch(() => {}));
        // Owner, 2026-10-14: in a listened channel, a message no thread of Kaizen's already takes gets "Add to…".
        ctx.waitUntil(offerAddTo(ctx, sql, s, ev).catch(() => {}));
      }
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
    // Owner, 2026-10-14: ⋯ → "Make SOP from this" — the form, filled from the message's thread.
    if (payload.type === 'message_action' && payload.callback_id === 'sop_from_message') {
      const m = payload.message ?? {};
      return await k.openSopForm(payload.trigger_id, '', { channel: String(payload.channel?.id ?? ''), ts: String(m.ts ?? ''),
                                                          root: String(m.thread_ts ?? m.ts ?? ''), text: String(m.text ?? '') });
    }
    if (payload.type === 'message_action') return await k.fromMessage(payload);
    if (payload.type === 'view_submission') return await k.submit(payload);
    return ack();
  } catch (e) {
    return ephemeral(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/**
 * "@Kaizen …" (§107, §108, §152). A mention cannot open a pop-up — Slack gives no
 * trigger for one — so Kaizen answers with buttons that do; posted in the thread
 * of the asking message, visible to everyone (§152 — the team manages and comments
 * on what's there), except *help* and "you're not a member" which stay private
 * (nothing there for the team to act on).
 *   @Kaizen new|repair|claim <title> → the button to that form, title filled in
 *   @Kaizen tasks / today / help     → the list, the day, what it does
 *   in a task's or claim's thread: @Kaizen comments → the comments so far;
 *   @Kaizen <anything else>          → saved as a comment (✅ on the message)
 *   anywhere else, other text        → offered as a new to-do
 */
/** A DM to the bot: a reply in a thread Kaizen knows is a comment there; anything else is a command, as after "@Kaizen". */
async function dmMessage(ctx: Ctx, sql: SqlFn, s: SlackSetup, ev: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (ev.thread_ts && ev.thread_ts !== ev.ts) {
    const [known] = await sql`SELECT 1 FROM slack_threads WHERE account_id = 1 AND channel = ${ev.channel} AND ts = ${ev.thread_ts}`;
    if (known) return threadReply(ctx, sql, s, ev);
  }
  return mention(ctx, sql, s, ev, true);
}

async function mention(ctx: Ctx, sql: SqlFn, s: SlackSetup, ev: Record<string, any>, dm = false) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const inThread = !!ev.thread_ts && ev.thread_ts !== ev.ts;
  const threadTsOf = String(inThread ? ev.thread_ts : ev.ts);
  // In a DM the answer is the next message (a thread per question would hide it); in a channel, the asker's thread.
  const say = async (text: string, blocks?: unknown[]) =>
    slackApi(s.token!, 'chat.postMessage', { channel: ev.channel, ...(dm && !inThread ? {} : { thread_ts: threadTsOf }), text, ...(blocks ? { blocks } : {}), unfurl_links: false });
  // §115/§152: only help and access errors stay private — nothing there for the team to manage or comment on.
  // Slack shows a private reply only in a thread that exists — one line, "🔒 Answered privately", opens it first.
  let privateTs: string | null = inThread ? String(ev.thread_ts) : null;
  const sayPrivate = async (text: string, blocks?: unknown[]) => {
    if (dm) return say(text, blocks); // a DM is already private
    if (!privateTs) {
      const stub = await slackApi<{ ts?: string }>(s.token!, 'chat.postMessage', { channel: ev.channel, thread_ts: ev.ts, text: `🔒 Answered <@${ev.user}> privately`,
        blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: `🔒 Answered <@${ev.user}> privately here` }] }] });
      privateTs = stub.ok ? String(ev.ts) : '';
    }
    return slackApi(s.token!, 'chat.postEphemeral', { channel: ev.channel, user: ev.user, text, ...(blocks ? { blocks } : {}), ...(privateTs ? { thread_ts: privateTs } : {}) });
  };
  const { verb, arg } = parseMention(String(ev.text ?? ''));
  const from = { channel: String(ev.channel), ts: String(inThread ? ev.thread_ts : ev.ts) };
  // "@Kaizen help" alone: what Kaizen does. "@Kaizen help <question>": the SOPs answer it (owner, 2026-10-14).
  if (verb === 'help' && !arg.trim()) { await sayPrivate('What Kaizen does in Slack', mentionHelpBlocks()); return; }
  if (verb === 'help') {
    const member = await memberOf(sql, s.token!, String(ev.user ?? ''));
    if (!member.ok) { await sayPrivate(member.why); return; }
    const k = new Kaizen(ctx, sql, s, member.email, member.permissions, String(ev.user));
    const wait = await say('🔎 Looking in the SOPs…');
    const m = await k.helpFromSops(arg, { channel: String(ev.channel), root: threadTsOf });
    const ts = (wait as { ts?: string }).ts;
    if (ts) await slackApi(s.token!, 'chat.update', { channel: ev.channel, ts, text: m.text, blocks: m.blocks });
    else await say(m.text, m.blocks);
    return;
  }
  // Owner, 2026-10-14: a mention cannot open a pop-up — the button does.
  if (verb === 'newsop') {
    // In a thread, the form is that thread's: its words, and ✨ reads it (2026-10-14).
    await say('New SOP', [{ type: 'section', text: { type: 'mrkdwn', text: `📝 New SOP${arg ? `: *${arg.replace(/[<>&*]/g, '')}*` : inThread ? ' from this thread' : ''} — tap to open the form.` },
      accessory: { type: 'button', action_id: 'mention_new_sop', text: { type: 'plain_text', text: 'Open the form' }, style: 'primary',
                   value: JSON.stringify({ title: arg.slice(0, 120), ...(inThread ? { from: { channel: String(ev.channel), root: String(ev.thread_ts) } } : {}) }) } }]);
    return;
  }
  // §110: "@Kaizen new <what>" is made at once — the reply in its thread has ✎ Add details. No words: the form.
  // §162: "@Kaizen order <what is needed>" — a purchase order, made the same way.
  if ((verb === 'new' || verb === 'repair' || verb === 'order') && arg) {
    const member = await memberOf(sql, s.token!, String(ev.user ?? ''));
    if (!member.ok) { await sayPrivate(member.why); return; }
    const r = await new Kaizen(ctx, sql, s, member.email, member.permissions, String(ev.user))
      .quickCreate(verb === 'repair' ? 'work_order' : verb === 'order' ? 'order' : 'task', arg, from, String(ev.ts), ev.files);
    if (!r.ok) await say(`Not saved: ${String(r.message ?? r.error ?? 'Kaizen said no.')}`);
    return;
  }
  if (verb === 'order') { await say('Write what is needed: *@Kaizen order* _2 boxes of trash bags for Napa_.'); return; }
  if (verb === 'new' || verb === 'repair' || verb === 'claim' || verb === 'cost') {
    // §117: a cost is never made at once — the button opens the form, every field to confirm.
    const only = verb === 'new' ? 'task' : verb === 'repair' ? 'work_order' : verb === 'cost' ? 'cost' : 'claim';
    await say(arg ? `New: ${arg}` : 'Open the form', [
      { type: 'section', text: { type: 'mrkdwn', text: arg ? `Ready to save *${arg.replace(/[<>&]/g, '')}* — tap to open the form.` : 'Tap to open the form.' } },
      newButtons(arg, only, from)]);
    return;
  }
  const member = await memberOf(sql, s.token!, String(ev.user ?? ''));
  if (!member.ok) { await sayPrivate(member.why); return; }
  const k = new Kaizen(ctx, sql, s, member.email, member.permissions, String(ev.user));
  if (verb === 'tasks' || verb === 'today' || verb === 'claims') { const m = await k.forMention(verb); await say(m.text, m.blocks); return; }
  if (verb === 'sops') { const m = await k.sopsMessage(); await say(m.text, m.blocks); return; }
  // §114: "@Kaizen all" — the reminder now, for everyone, in the thread of the asking message (the channel stays short).
  if (verb === 'all') { const m = await k.forMention('all'); await say(m.text, m.blocks); return; }

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
  // §162: a reply's photos stay in its comment — not the to-do's Files.
  const r = await k.commentWithFiles(t.subject, t.subject_id, arg, ev.files, { channel: String(ev.channel), thread: String(ev.thread_ts) });
  if (!r.ok) { await say(`Not saved: ${String(r.message ?? r.error ?? 'Kaizen said no.')}`); return; }
  const re = await slackApi(s.token!, 'reactions.add', { channel: ev.channel, timestamp: ev.ts, name: 'white_check_mark' });
  if (!re.ok) await say('✓ Saved as a comment in Kaizen.');
}

/**
 * "Add to…" (owner, 2026-10-14): in a listened channel (Settings → Slack), each new message from a member gets a
 * private, silent reply — add it as a comment to a task, or to an order, a work order or a claim. Not in a thread
 * Kaizen already knows (those are saved by themselves), not an @Kaizen (the mention answers). No model reads it.
 */
/** A DM's channel id starts with D. */
const dmChannel = (channel: string) => channel.startsWith('D');

async function offerAddTo(ctx: Ctx, sql: SqlFn, s: SlackSetup, ev: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!(s.config.addTo?.channels ?? []).some(c => c.id === ev.channel)) return;
  const botId = await botUserIdOf(sql, s);
  if (botId && String(ev.text ?? '').includes(`<@${botId}>`)) return;
  if (ev.thread_ts) {
    const [known] = await sql`SELECT 1 FROM slack_threads WHERE account_id = 1 AND channel = ${ev.channel} AND ts = ${ev.thread_ts}`;
    if (known) return;
  }
  const member = await memberOf(sql, s.token!, String(ev.user ?? ''));
  if (!member.ok) return;
  const k = new Kaizen(ctx, sql, s, member.email, member.permissions, String(ev.user));
  const targets = await k.addTargets();
  if (!targets.length) return;
  const source: AddSource = { channel: String(ev.channel), ts: String(ev.ts), thread: ev.thread_ts ? String(ev.thread_ts) : null };
  // What this channel last added to, in the last hour (owner, 2026-10-14).
  const [last] = await sql`SELECT key FROM slack_sent WHERE account_id = 1 AND key LIKE ${`addto:${ev.channel}:%`}
                             AND sent_at > now() - interval '1 hour' ORDER BY sent_at DESC LIMIT 1` as { key: string }[];
  const lastTarget = last ? last.key.split(':').slice(2).join(':') : null;
  // Slack shows a private reply that comes too fast ABOVE the message it answers (owner, 2026-10-14: confusing) —
  // a moment's wait lets the message land first.
  await new Promise(r => setTimeout(r, 1500));
  await slackApi(s.token!, 'chat.postEphemeral', { channel: ev.channel, user: ev.user, text: 'Add this to Kaizen?',
    blocks: addToBlocks(targets, source, suggestTarget(String(ev.text ?? ''), targets, lastTarget)), ...(ev.thread_ts ? { thread_ts: ev.thread_ts } : {}) });
}

/**
 * 📎 on a message (owner, 2026-10-14): in a thread Kaizen knows, the message is saved there (✅ on it); elsewhere the
 * reactor gets the private "Add to…" question for it. Only a Kaizen member's 📎 counts.
 */
async function clipped(ctx: Ctx, sql: SqlFn, s: SlackSetup, ev: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const channel = String(ev.item.channel), ts = String(ev.item.ts);
  const member = await memberOf(sql, s.token!, String(ev.user ?? ''));
  if (!member.ok) return;
  const k = new Kaizen(ctx, sql, s, member.email, member.permissions, String(ev.user));
  // Where the message sits: a reply carries its thread's ts.
  const r = await slackApi<{ messages?: { ts: string; thread_ts?: string; text?: string }[] }>(s.token!, 'conversations.replies', { channel, ts, limit: 1, inclusive: true });
  const m = (r.messages ?? []).find(x => x.ts === ts) ?? r.messages?.[0];
  const root = m?.thread_ts ?? ts;
  const [t] = await sql`SELECT subject, subject_id FROM slack_threads WHERE account_id = 1 AND channel = ${channel} AND ts = ${root}` as { subject: string; subject_id: string }[];
  if (t) {
    const a = await k.addMessageTo(`${t.subject}:${t.subject_id}`, { channel, ts, thread: root !== ts ? root : null });
    if (a.ok) await slackApi(s.token!, 'reactions.add', { channel, timestamp: ts, name: 'white_check_mark' });
    else await slackApi(s.token!, 'chat.postEphemeral', { channel, user: ev.user, text: `📎 Not saved: ${a.message}`, ...(root !== ts ? { thread_ts: root } : {}) });
    return;
  }
  const targets = await k.addTargets();
  if (!targets.length) return;
  await slackApi(s.token!, 'chat.postEphemeral', { channel, user: ev.user, text: 'Add this to Kaizen?',
    blocks: addToBlocks(targets, { channel, ts, thread: root !== ts ? root : null }, suggestTarget(String(m?.text ?? ''), targets)), ...(root !== ts ? { thread_ts: root } : {}) });
}

/** The bot's own Slack user id, cached in slack_config — fetched once (auth.test) and saved if missing. */
async function botUserIdOf(sql: SqlFn, s: SlackSetup): Promise<string | null> {
  if (s.config.botUserId) return s.config.botUserId;
  const r = await slackApi<{ user_id?: string }>(s.token!, 'auth.test');
  if (!r.ok || !r.user_id) return null;
  await sql`UPDATE accounts SET slack_config = slack_config || ${JSON.stringify({ botUserId: r.user_id })}::jsonb WHERE id = 1`;
  s.config.botUserId = r.user_id;
  return r.user_id;
}

/**
 * A reply inside a task's or claim's own thread that does not mention @Kaizen (§153) — the same
 * comment "@Kaizen …" already saves, without asking everyone to remember the mention. Only a
 * thread Kaizen already knows (`slack_threads`) is touched; ordinary conversation is left alone.
 * The @-mention case is still the app_mention event's — skipped here so it is not saved twice.
 */
async function threadReply(ctx: Ctx, sql: SqlFn, s: SlackSetup, ev: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const text = String(ev.text ?? '');
  const botId = await botUserIdOf(sql, s);
  if (botId && text.includes(`<@${botId}>`)) return;
  const [t] = await sql`SELECT subject, subject_id, via FROM slack_threads WHERE account_id = 1 AND channel = ${ev.channel} AND ts = ${ev.thread_ts}` as
    { subject: 'task' | 'claim'; subject_id: string; via: string }[];
  // A conversation linked by "Add to…": its replies are not all saved (owner, 2026-10-14: volume) — 📎 on one saves it.
  if (!t || t.via === 'addto') return;
  const body = commentFromMention(text);
  if (!body && !ev.files?.length) return;
  const member = await memberOf(sql, s.token!, String(ev.user ?? ''));
  if (!member.ok) return;
  const k = new Kaizen(ctx, sql, s, member.email, member.permissions, String(ev.user));
  // §162 (owner, 2026-10-15): files posted in the thread stay in that comment (a photo shows there), not in Files.
  const r = await k.commentWithFiles(t.subject, t.subject_id, body, ev.files, { channel: String(ev.channel), thread: String(ev.thread_ts) });
  if (r.ok) await slackApi(s.token!, 'reactions.add', { channel: ev.channel, timestamp: ev.ts, name: 'white_check_mark' });
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
  // A task made in Slack is already in front of the person who made it (and @Kaizen new answers in its thread):
  // no "To-do created" notice in the channel for it (§119). Other changes keep their own `via`.
  private todo(body: Record<string, unknown>) {
    return this.api(todos.onRequestPost, '/api/todos', 'POST', body.action === 'create' && !body.via ? { ...body, via: 'slack' } : body);
  }
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
                                      case_url
                                 FROM claims WHERE account_id = 1 AND id::text = ${id} AND deleted_at IS NULL` as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    return c;
  }
  /** A claim saved with every field as it is, but the ones changed — the claims route saves the whole case. */
  private async claimUpdate(id: string, change: Record<string, unknown>) {
    const c = await this.claimRow(id);
    if (!c) return { ok: false, error: 'That claim is gone.' };
    return this.claimSave({ id, unitId: c.unit_id, occurredOn: c.occurred_on, category: c.category, severity: c.severity, status: c.status,
      source: c.source, description: c.description,
      caseUrl: c.case_url ?? '', ...change });
  }

  /** A comment on a task or a claim, as this member (§107). */
  /**
   * Owner, Oct 2026: a Slack message's files go onto the to-do — after the answer (Slack wants one in 3 s), and a line
   * in the thread says so. `files` as the event carried them, or read back from the message (channel + ts).
   */
  attachFromSlack(todoId: string, from: { channel: string; ts: string; thread?: string }, files?: unknown[]) {
    if (!this.may('/api/todo-files', 'POST')) return;
    this.ctx.waitUntil((async () => {
      const raw = files?.length ? files : await slackMessageFiles(this.s.token!, from.channel, from.ts);
      if (!raw.length) return;
      const got = await slackFiles(this.s.token!, raw);
      const names = await attachTodoFiles(this.sql, this.ctx.env.ENCRYPTION_KEY, todoId, got, this.email, 'slack');
      const missed = raw.length - names.length;
      if (names.length || missed) await slackApi(this.s.token!, 'chat.postMessage', { channel: from.channel, thread_ts: from.thread ?? from.ts,
        text: `📎 ${names.length ? `${names.length} file${names.length === 1 ? '' : 's'} added to the to-do: ${names.join(', ')}` : ''}${missed ? `${names.length ? ' · ' : ''}${missed} could not be read (over 15 MB, or the app needs the files:read permission — reinstall it)` : ''}` });
    })().catch(() => {}));
  }

  /**
   * Files from a card's 📎 box (owner, 2026-10-14). After the answer: Slack waits 3 s, the download and Drive do not.
   * A to-do lists them (its activity says so); a claim keeps none of its own, so a comment links them.
   */
  attachFiles(subject: 'task' | 'claim', id: string, files: unknown[], from?: { channel: string; thread: string }) {
    this.ctx.waitUntil((async () => {
      const got = await slackFiles(this.s.token!, files);
      // A file Kaizen could not keep is said where it was posted, not dropped quietly (2026-10-14).
      const missed = files.length - got.length;
      if (missed && from) await slackApi(this.s.token!, 'chat.postMessage', { channel: from.channel, thread_ts: from.thread,
        text: `⚠ ${missed} file${missed === 1 ? '' : 's'} not added to Kaizen — over 15 MB and not a photo. Add ${missed === 1 ? 'it' : 'them'} in Kaizen, or share a smaller copy.` });
      if (!got.length) return;
      if (subject === 'task') { await attachTodoFiles(this.sql, this.ctx.env.ENCRYPTION_KEY, id, got, this.email, 'slack'); return; }
      const lines = await commentFileLines(this.sql, this.ctx.env.ENCRYPTION_KEY, `claim #${id}`, got);
      await this.claimSave({ action: 'note', id, body: lines.join('\n') });
    })().catch(() => {}));
  }

  /**
   * A comment and the files posted with it (§162): kept in Drive and written into the comment — a photo shows in it.
   * Before `footer` ("— From Slack: …"), which must stay last. A file Kaizen cannot keep is said in the thread.
   */
  async commentWithFiles(subject: 'task' | 'claim', id: string, words: string, files: unknown[] | undefined,
                         from: { channel: string; thread: string }, footer = ''): Promise<Record<string, unknown>> {
    const raw = files ?? [];
    const got = raw.length ? await slackFiles(this.s.token!, raw) : [];
    const missed = raw.length - got.length;
    if (missed) await slackApi(this.s.token!, 'chat.postMessage', { channel: from.channel, thread_ts: from.thread,
      text: `⚠ ${missed} file${missed === 1 ? '' : 's'} not added to Kaizen — over 15 MB and not a photo, or the app needs the files:read permission.` });
    const lines = await commentFileLines(this.sql, this.ctx.env.ENCRYPTION_KEY, `${subject === 'task' ? 'to-do' : 'claim'} #${id} comment`, got)
      .catch(() => [] as string[]);
    const text = [words.trim(), ...lines].filter(Boolean).join('\n');
    if (!text) return { ok: false, message: 'Nothing to save.' };
    return this.comment(subject, id, `${text}${footer}`);
  }

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
  async quickCreate(kind: 'task' | 'work_order' | 'order', words: string, thread: { channel: string; ts: string }, messageTs: string, files?: unknown[]): Promise<Record<string, unknown>> {
    if (!this.may('/api/todos', 'POST')) return { ok: false, message: 'your role does not include the to-do list' };
    const units = await this.units();
    const quick = quickTitle(words);
    // §162: a purchase order is a to-do made as an order (listed with the orders; ✨ builds its cart in Kaizen).
    const title = kind === 'order' ? `Purchase order: ${quick.title}`.slice(0, 120) : quick.title;
    const description = kind === 'order' ? [quick.title, quick.description].filter(Boolean).join('\n') || null : quick.description;
    // Owner, Oct 2026: made inside a task's thread → its sub-task; inside a claim's → work on that claim. Either way it
    // lives in that thread (no new one): its news and comments go there (threadFor).
    const [home] = await this.sql`SELECT subject, subject_id FROM slack_threads WHERE account_id = 1 AND channel = ${thread.channel} AND ts = ${thread.ts}` as
      { subject: 'task' | 'claim'; subject_id: string }[];
    const parent = home?.subject === 'task' ? (await this.sql`SELECT id::text, unit_ids FROM todos WHERE account_id = 1 AND id::text = ${home.subject_id}
                                                                AND parent_id IS NULL AND deleted_at IS NULL` as { id: string; unit_ids: string[] }[])[0] : undefined;
    const claim = home?.subject === 'claim' ? await this.claimRow(home.subject_id) : undefined;
    const unit = guessUnit(words, units) ?? parent?.unit_ids?.[0] ?? claim?.unit_id ?? null;
    const link = await slackApi<{ permalink?: string }>(this.s.token!, 'chat.getPermalink', { channel: thread.channel, message_ts: messageTs });
    const r = await this.todo({ action: 'create', kind: kind === 'order' ? 'task' : kind, ...(kind === 'order' && !parent ? { asOrder: true } : {}),
      title, unitIds: unit ? [unit] : [], priority: 'none', via: home ? 'slack-thread' : dmChannel(thread.channel) ? 'slack-dm' : 'slack',
      ...(parent ? { parentId: parent.id } : {}), ...(claim ? { claimId: String(claim.id) } : {}),
      description: [description, link.permalink ? `From Slack: ${link.permalink.split('?')[0]}` : ''].filter(Boolean).join('\n\n') || null });
    if (!r.ok || !r.id) return r;
    const m = trackedReply({ id: String(r.id), title, kind, unit: units.find(u => u.value === unit)?.label ?? null }, parent ? 'sub-task' : claim ? 'claim' : undefined);
    const posted = await slackApi<{ ts?: string }>(this.s.token!, 'chat.postMessage', { channel: thread.channel, thread_ts: thread.ts, ...m, unfurl_links: false });
    // From a DM the task's thread is its notice in the tasks channel (via 'slack-dm'), where the team talks — not the DM.
    if (posted.ok && !home && !dmChannel(thread.channel)) await rememberThread(this.sql, { ok: true, ...thread }, 'task', String(r.id));
    // §162: something new is announced once where the team works — made in another channel, it is also posted in the
    // tasks channel (and that becomes its thread). Made right there, the mention already is the announcement.
    if (!home && !dmChannel(thread.channel) && this.s.config.channels?.tasks?.id && thread.channel !== this.s.config.channels.tasks.id) {
      this.ctx.waitUntil(notifyTask(this.sql, this.ctx.env.ENCRYPTION_KEY, String(r.id), 'created', this.email).catch(() => {}));
    }
    this.attachFromSlack(String(r.id), { channel: thread.channel, ts: messageTs, thread: thread.ts }, files);
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
                                      t.cost_estimate, t.resolution_note, u.name AS unit, t.parent_id::text AS parent_id,
                                      (SELECT concat_ws(' · ', cu.name, coalesce(nullif(c.description, ''), c.category))
                                         FROM claims c LEFT JOIN units cu ON cu.account_id = c.account_id AND cu.id = c.unit_id
                                        WHERE c.account_id = 1 AND c.id::text = t.claim_id::text) AS claim
                                 FROM todos t LEFT JOIN units u ON u.account_id = t.account_id AND u.id = t.unit_ids[1]
                                WHERE t.account_id = 1 AND t.id::text = ${id} AND t.deleted_at IS NULL` as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!t) return null;
    // Alongside the reads below: Slack gives the card 3 s to open.
    const form = this.orderForm({ parent_id: t.parent_id ?? null, status: String(t.status) });
    const [kids, ups, acts, order] = await Promise.all([
      this.sql`SELECT id::text, title, status FROM todos WHERE account_id = 1 AND parent_id::text = ${id} AND deleted_at IS NULL ORDER BY created_at` as Promise<{ id: string; title: string; status: string }[]>,
      // The card shows what people wrote; the system's lines are Kaizen's activity log (§103).
      this.sql`SELECT body, created_by, created_at FROM work_updates WHERE account_id = 1 AND subject = 'task' AND subject_id = ${id} AND kind = 'note'
                ORDER BY created_at DESC, id DESC LIMIT 3` as Promise<{ body: string; created_by: string | null; created_at: string }[]>,
      // Owner, Oct 2026: Slack shows what Kaizen does — the activity log's latest lines and the purchase order.
      this.sql`SELECT body, created_by, created_at FROM work_updates WHERE account_id = 1 AND subject = 'task' AND subject_id = ${id} AND kind <> 'note'
                ORDER BY created_at DESC, id DESC LIMIT 3` as Promise<{ body: string; created_by: string | null; created_at: string }[]>,
      this.sql`SELECT concat_ws(' — ', i.name, i.size) AS name, sum((l->>'qty')::numeric)::int AS qty FROM inventory_orders o CROSS JOIN jsonb_array_elements(o.lines) l
                 JOIN inventory_items i ON i.account_id = o.account_id AND i.id::text = l->>'itemId'
                WHERE o.account_id = 1 AND o.todo_id::text = ${id} GROUP BY i.name, i.size ORDER BY 1` as Promise<{ name: string; qty: number }[]>
    ]);
    const line = (u: { body: string; created_by: string | null; created_at: string }) =>
      ({ body: u.body, who: (u.created_by ?? '—').split('@')[0]!, when: nyParts(new Date(u.created_at).toISOString()).short });
    return { appUrl: this.s.config.appUrl, parentId: t.parent_id, claim: t.claim, order: order.length ? order.map(o => `${o.name} × ${o.qty}`) : null, activity: acts.reverse().map(line), id: t.id, title: t.title, kind: t.kind, status: t.status, priority: t.priority, assignee: t.assignee, supervisor: t.supervisor,
      dueOn: t.due_on, scheduledOn: t.scheduled_on, reservationLabel: t.reservation_label, description: t.description, vendor: t.vendor,
      costActual: t.cost_actual == null ? null : Number(t.cost_actual), costEstimate: t.cost_estimate == null ? null : Number(t.cost_estimate),
      resolutionNote: t.resolution_note, unit: t.unit, children: kids, orderForm: await form,
      updates: ups.reverse().map(u => ({ body: u.body, who: (u.created_by ?? '—').split('@')[0]!, when: nyParts(new Date(u.created_at).toISOString()).short })) };
  }
  /** What a to-do's purchase order can hold — only on an open, top-level one (as Kaizen's), for who may order. */
  private async orderForm(t: { parent_id: string | null; status: string }) {
    if (t.parent_id || t.status === 'completed' || t.status === 'cancelled' || !this.may('/api/inventory', 'POST')) return null;
    const [items, sp] = await Promise.all([invItems(this.sql), supplyPlaces(this.sql)]);
    return { items: items.filter(i => i.active).slice(0, 100).map(i => ({ value: i.id, label: i.name.slice(0, 75) })),
             // Storages and closets, then the houses (furniture goes to the house — owner, 2026-10-15).
             places: [...sp.places.map(p => ({ value: p.key, label: (p.self ? `${p.name} closet` : p.name).slice(0, 75) })),
                      ...sp.houses.filter(h => !h.self).map(h => ({ value: h.key, label: `${h.name} (house)`.slice(0, 75) }))].slice(0, 100) };
  }
  /** One line onto the to-do's order: a new item adds, the same item and place changes its quantity, 0 removes it. */
  private async orderLine(todoId: string, itemId: string, place: string, qty: number) {
    const [o] = await this.sql`SELECT lines FROM inventory_orders WHERE account_id = 1 AND todo_id = ${Number(todoId) || 0}` as { lines: { itemId: string; place: string; qty: number }[] }[];
    const lines = (o?.lines ?? []).filter(l => !(String(l.itemId) === itemId && l.place === place));
    if (qty > 0) lines.push({ itemId, place, qty });
    // Saved directly, not through /api/inventory: that answers with the whole inventory, and Slack waits 3 s.
    if (!this.may('/api/inventory', 'POST')) return { ok: false, message: 'Your role does not include inventory.' };
    try {
      const said = await saveTodoOrder(this.sql, this.email, todoId, lines);
      // As Kaizen does: the order is told in the to-do's thread.
      if (said) this.ctx.waitUntil(commentToThread(this.sql, this.ctx.env.ENCRYPTION_KEY, 'task', todoId,
        `🛒 ${said.replace(/^Order draft saved/, 'Purchase order saved')}`, this.email).catch(() => {}));
      return { ok: true };
    } catch (e) { return { ok: false, message: e instanceof Error ? e.message : String(e) }; }
  }

  /* ── "Add to…" (owner, 2026-10-14) ── */
  /** What a message can be added to: open to-dos (plain, with an order, repairs) and open claims — as this member may. */
  async addTargets(): Promise<AddTarget[]> {
    const out: AddTarget[] = [];
    if (this.may('/api/todos', 'POST')) {
      const rows = await this.sql`SELECT t.id::text, t.title, t.kind, u.name AS unit,
                                         EXISTS (SELECT 1 FROM inventory_orders o WHERE o.account_id = 1 AND o.todo_id = t.id) AS ordered,
                                         EXISTS (SELECT 1 FROM work_updates w WHERE w.account_id = 1 AND w.subject = 'task' AND w.subject_id = t.id::text
                                                    AND w.created_at > now() - interval '3 days') AS recent
                                    FROM todos t LEFT JOIN units u ON u.account_id = t.account_id AND u.id = t.unit_ids[1]
                                   WHERE t.account_id = 1 AND t.deleted_at IS NULL AND t.parent_id IS NULL AND t.status NOT IN ('completed', 'cancelled')
                                   ORDER BY t.created_at DESC LIMIT 300` as { id: string; title: string; kind: string; unit: string | null; ordered: boolean; recent: boolean }[];
      for (const r of rows) out.push({ value: `task:${r.id}`, label: `${r.title}${r.unit ? ` · ${r.unit}` : ''}`,
        group: r.kind === 'work_order' ? 'work_order' : r.ordered ? 'order' : 'task', words: `${r.title} ${r.unit ?? ''}`, recent: r.recent });
    }
    if (this.may('/api/claims', 'POST')) {
      const rows = await this.sql`SELECT c.id::text, coalesce(nullif(c.description, ''), c.category) AS what, c.category, u.name AS unit
                                    FROM claims c LEFT JOIN units u ON u.account_id = c.account_id AND u.id = c.unit_id
                                   WHERE c.account_id = 1 AND c.deleted_at IS NULL AND c.status IN ('Open', 'In progress')
                                   ORDER BY c.occurred_on DESC LIMIT 100` as { id: string; what: string; category: string; unit: string | null }[];
      for (const r of rows) out.push({ value: `claim:${r.id}`, label: `${r.unit ? `${r.unit} · ` : ''}${r.what}`, group: 'claim', words: `${r.what} ${r.category} ${r.unit ?? ''}` });
    }
    return out;
  }

  /** A Slack thread's messages (people's, not bots'), with names — or only one of them. */
  private async threadMessages(channel: string, root: string, only?: string) {
    const r = await slackApi<{ messages?: { user?: string; bot_id?: string; text?: string; ts: string; files?: unknown[] }[] }>(this.s.token!, 'conversations.replies', { channel, ts: root, limit: 100 });
    const msgs = (r.messages ?? []).filter(m => !m.bot_id && (!only || m.ts === only));
    const names = new Map<string, string>(), roles = new Map<string, string>();
    for (const u of [...new Set(msgs.map(m => m.user).filter((x): x is string => !!x))]) {
      const i = await slackApi<{ user?: { real_name?: string; profile?: { display_name?: string; email?: string } } }>(this.s.token!, 'users.info', { user: u });
      names.set(u, i.user?.profile?.display_name || i.user?.real_name || 'Someone');
      // Their Kaizen role, so a model reading the thread knows who decides (2026-10-14: the question was taken for the rule).
      const email = i.user?.profile?.email?.toLowerCase();
      const [m] = email ? await this.sql`SELECT role FROM members WHERE account_id = 1 AND lower(email) = ${email}` as { role: string }[] : [];
      if (m) roles.set(u, m.role);
    }
    return msgs.map(m => ({ who: names.get(m.user ?? '') ?? 'Someone', user: m.user ?? '', role: roles.get(m.user ?? '') ?? null, text: m.text ?? '', ts: m.ts, files: m.files ?? [] }));
  }

  /** The message into Kaizen: its words (who said them, a link back) as a comment, its files, and its thread from now on. */
  async addMessageTo(target: string, src: AddSource): Promise<{ ok: boolean; message?: string }> {
    const [subject, id = ''] = target.split(':') as ['task' | 'claim', string];
    if (subject !== 'task' && subject !== 'claim') return { ok: false, message: 'Pick a task or a claim.' };
    const [m] = await this.threadMessages(src.channel, src.thread ?? src.ts, src.ts);
    if (!m) return { ok: false, message: 'Kaizen could not read that message (is the bot in the channel?).' };
    const link = await slackApi<{ permalink?: string }>(this.s.token!, 'chat.getPermalink', { channel: src.channel, message_ts: src.ts });
    const words = slackText(m.text).trim();
    // The author's name only when someone else saves it — the comment already says who saved it (2026-10-14: noise).
    const by = m.user && m.user === this.slackUser ? '' : `${m.who}: `;
    const footer = link.permalink ? `\n— From Slack: ${link.permalink.split('?')[0]}` : '';
    if (m.files.length) {
      // §162: the files go into the comment with the words. After the answer — Slack waits 3 s, Drive does not.
      this.ctx.waitUntil(this.commentWithFiles(subject, id, `${by}${words}`.trim(), m.files, { channel: src.channel, thread: src.thread ?? src.ts }, footer)
        .then(() => {}).catch(() => {}));
    } else {
      const r = await this.comment(subject, id, `${by}${words || '(no text)'}${footer}`);
      if (!r.ok) return { ok: false, message: String(r.message ?? r.error ?? 'Not saved.') };
    }
    // Its thread is this subject's from now on — as a conversation: a reply is saved when someone reacts 📎 to it
    // (or writes @Kaizen), not every reply (owner, 2026-10-14).
    await this.sql`INSERT INTO slack_threads (account_id, channel, ts, subject, subject_id, via)
                   VALUES (1, ${src.channel}, ${src.thread ?? src.ts}, ${subject}, ${id}, 'addto') ON CONFLICT DO NOTHING`;
    // The channel's memory: the next message there offers this first, for an hour.
    await this.sql`INSERT INTO slack_sent (account_id, key) VALUES (1, ${`addto:${src.channel}:${target}`})
                   ON CONFLICT (account_id, key) DO UPDATE SET sent_at = now()`;
    return { ok: true };
  }

  /* ── SOPs from Slack (owner, 2026-10-14) ── */
  private async sopSections(): Promise<SopSectionLite[]> {
    return await this.sql`SELECT key, label, parent_key AS "parentKey" FROM sop_sections WHERE account_id = 1 AND deleted_at IS NULL
                           ORDER BY sort, label` as SopSectionLite[];
  }
  /** The form; from a message, its words first — the whole thread follows a moment later (Slack gives the form 3 s). */
  async openSopForm(trigger: string, title = '', from?: { channel: string; ts: string; root: string; text: string }) {
    const [sections, link] = await Promise.all([this.sopSections(),
      from ? slackApi<{ permalink?: string }>(this.s.token!, 'chat.getPermalink', { channel: from.channel, message_ts: from.ts }) : null]);
    const source: SopSource | null = from ? { channel: from.channel, ts: from.root, link: link?.permalink?.split('?')[0] ?? null } : null;
    const canPublish = this.may('/api/sops', 'POST');
    const first = from ? { ...draftFromThread([{ who: '', text: from.text }]), ...(title ? { title } : {}) } : { title };
    const r = await slackApi<{ view?: { id: string } }>(this.s.token!, 'views.open', { trigger_id: trigger, view: sopModal(sections, first, { canPublish, source }) });
    if (from && r.view?.id) {
      const viewId = r.view.id;
      this.ctx.waitUntil((async () => {
        const msgs = await this.threadMessages(from.channel, from.root);
        if (msgs.length > 1 || !from.text) await slackApi(this.s.token!, 'views.update', { view_id: viewId,
          view: sopModal(sections, { ...draftFromThread(msgs), ...(title ? { title } : {}) }, { canPublish, source, v: 1 }) });
      })().catch(() => {}));
    }
    return ack();
  }
  /** ✨: the thread to a model (Gemini, then flash-lite, then Workers AI), the answer into the form — never saved without a person. */
  private async suggestSop(view: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const meta = JSON.parse(view.private_metadata || '{}') as { source?: SopSource | null; v?: number };
    const source = meta.source;
    if (!source) return;
    const sections = await this.sopSections();
    const canPublish = this.may('/api/sops', 'POST');
    const v = meta.v ?? 0;
    const busy = (note: string) => slackApi(this.s.token!, 'views.update', { view_id: view.id, view: sopModal(sections, {}, { canPublish, source, v, note }) });
    // Same block ids: what is typed stays; only the note changes.
    await busy('✨ Reading the thread…');
    const msgs = await this.threadMessages(source.channel, source.ts);
    // What the person typed goes too: ✨ keeps it, and re-grades it after they add what was missing.
    const current = partialSopForm(view.state?.values ?? {});
    // The team's own standard, from their SOP about SOPs ("## What a complete SOP covers"); else the default.
    const [std] = await this.sql`SELECT body FROM sops WHERE account_id = 1 AND deleted_at IS NULL AND status = 'published'
                                   AND body LIKE '%## What a complete SOP covers%' ORDER BY id LIMIT 1` as { body: string }[];
    const standard = standardFrom(std?.body) ?? undefined;
    const p = sopPrompt(sections, msgs.map(m => ({ who: m.role ? `${m.who} (${m.role})` : m.who, text: m.text })), current, standard);
    const r = await askJson(this.sql, this.ctx.env, p.system, p.user);
    if (!r.ok) { await busy(`⚠ No AI could answer just now — try ✨ again in a minute. (${r.error.slice(0, 200)})`); return; }
    const review = reviewFromAi(r.json);
    await slackApi(this.s.token!, 'views.update', { view_id: view.id,
      view: sopModal(sections, { ...draftFromAi(r.json, sections), ...(current.sectionKey && !draftFromAi(r.json, sections).sectionKey ? { sectionKey: current.sectionKey } : {}) },
                     { canPublish, source, v: v + 1, note: reviewNote(r.by, review), gaps: review.gaps }) });
  }
  /** 🧵: the open questions to the thread, for the team to answer there; the form stays as it is. */
  private async askGapsInThread(view: Record<string, any>) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const meta = JSON.parse(view.private_metadata || '{}') as { source?: SopSource | null; v?: number; gaps?: string[] };
    if (!meta.source || !meta.gaps?.length) return;
    const title = String(partialSopForm(view.state?.values ?? {}).title ?? '');
    const r = await slackApi(this.s.token!, 'chat.postMessage', { channel: meta.source.channel, thread_ts: meta.source.ts, unfurl_links: false, ...gapsInThread(meta.gaps, title) });
    await slackApi(this.s.token!, 'views.update', { view_id: view.id, view: sopModal(await this.sopSections(), {}, { canPublish: this.may('/api/sops', 'POST'), source: meta.source, v: meta.v ?? 0,
      note: r.ok ? '🧵 Asked in the thread. When they answer, tap ✨ again — or close this and use *@Kaizen newsop* there later.' : `⚠ Could not post in the thread: ${r.error}` }) });
  }
  /** A question to the SOPs: a few by words, then a model picks and answers from them — or the thread is asked. */
  async helpFromSops(question: string, from: { channel: string; root: string }): Promise<{ text: string; blocks: unknown[] }> {
    const missing = { text: 'No SOP covers this yet', blocks: helpMissingBlocks(question, from) };
    if (!this.may('/api/sops', 'GET')) return { text: 'Your Kaizen role does not include SOPs.', blocks: [] };
    const rows = await this.sql`SELECT o.id::text, o.title, o.purpose, o.trigger, o.steps, o.body, o.keywords, s.label AS section FROM sops o
                                  LEFT JOIN sop_sections s ON s.account_id = o.account_id AND s.key = o.section_key
                                 WHERE o.account_id = 1 AND o.deleted_at IS NULL AND o.status = 'published'` as SopDoc[];
    const shown = rankSops(question, rows);
    if (!shown.length) return missing;
    const p = helpPrompt(question, shown);
    const r = await askJson(this.sql, this.ctx.env, p.system, p.user);
    if (!r.ok) {
      // No model now: the best matches by words, to read — better than nothing.
      return { text: 'SOPs that may help', blocks: helpAnswerBlocks('No AI could answer just now — these SOPs look closest:', shown.slice(0, 3), this.s.config.appUrl) };
    }
    const h = helpFromAi(r.json, shown);
    if (!h.sops.length) return missing;
    return { text: h.answer || 'From the SOPs',
             blocks: helpAnswerBlocks(h.answer, h.sops, this.s.config.appUrl, h.covers === 'partial' ? { missing: h.missing, from } : null) };
  }

  private async sopCounts() {
    const canEdit = this.may('/api/sops', 'POST');
    return await this.sql`SELECT s.key, s.label, s.parent_key AS "parentKey",
                                 (SELECT count(*)::int FROM sops o WHERE o.account_id = 1 AND o.deleted_at IS NULL AND o.status <> 'archived'
                                    AND (o.status = 'published' OR ${canEdit})
                                    AND (o.section_key = s.key OR o.section_key IN (SELECT c.key FROM sop_sections c WHERE c.account_id = 1 AND c.parent_key = s.key AND c.deleted_at IS NULL))) AS n
                            FROM sop_sections s WHERE s.account_id = 1 AND s.deleted_at IS NULL ORDER BY s.sort, s.label` as (SopSectionLite & { n: number })[];
  }
  async sopsMessage() {
    return { text: 'SOPs', blocks: sopsBlocks(await this.sopCounts(), this.s.config.appUrl) };
  }
  private async sopList(key: string) {
    const canEdit = this.may('/api/sops', 'POST');
    const [sec] = await this.sql`SELECT label FROM sop_sections WHERE account_id = 1 AND key = ${key}` as { label: string }[];
    const rows = await this.sql`SELECT id::text, title, purpose, status FROM sops WHERE account_id = 1 AND deleted_at IS NULL AND status <> 'archived'
                                  AND (status = 'published' OR ${canEdit})
                                  AND (section_key = ${key} OR section_key IN (SELECT c.key FROM sop_sections c WHERE c.account_id = 1 AND c.parent_key = ${key}))
                                ORDER BY title` as { id: string; title: string; purpose: string | null; status: string }[];
    return sopListModal(sec?.label ?? 'SOPs', rows);
  }
  private async sopView(id: string) {
    const canEdit = this.may('/api/sops', 'POST');
    const [s] = await this.sql`SELECT id::text, title, status, purpose, trigger, owner, done_when AS "doneWhen", steps, body FROM sops
                                WHERE account_id = 1 AND id::text = ${id} AND deleted_at IS NULL AND (status = 'published' OR ${canEdit})` as
      { id: string; title: string; status: string; purpose: string | null; trigger: string | null; owner: string | null; doneWhen: string | null; steps: { text: string; who?: string }[]; body: string | null }[];
    return s ? sopViewModal(s, this.s.config.appUrl) : null;
  }

  /* ── the claim card (§113) ── */
  private async claimCardOf(id: string) {
    const [c, row, ups, work] = await Promise.all([
      claimLite(this.sql, id), this.claimRow(id),
      this.sql`SELECT body, created_by, created_at FROM work_updates WHERE account_id = 1 AND subject = 'claim' AND subject_id = ${id} AND kind = 'note'
                ORDER BY created_at, id` as Promise<{ body: string; created_by: string | null; created_at: string }[]>,
      this.sql`SELECT id::text, title, status, kind FROM todos WHERE account_id = 1 AND claim_id::text = ${id} AND parent_id IS NULL AND deleted_at IS NULL
                ORDER BY status IN ('completed', 'cancelled'), created_at` as Promise<{ id: string; title: string; status: string; kind: string }[]>
    ]);
    if (!c || !row) return null;
    return { ...c, work, source: row.source, appUrl: this.s.config.appUrl,
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
      description: [text, link?.permalink ? `From Slack: ${link.permalink.split('?')[0]}` : ''].filter(Boolean).join('\n\n').slice(0, 3800),
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
    if (verb === 'sop') {
      if (!this.may('/api/sops', 'GET')) return this.deny('SOPs');
      return await this.openSopForm(trigger, arg);
    }
    if (verb === 'sops') {
      if (!this.may('/api/sops', 'GET')) return this.deny('SOPs');
      const m = await this.sopsMessage();
      return ephemeral(m.text, m.blocks);
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

    // Owner, 2026-10-14: "Add to…" — the private offer under a message in a listened channel.
    if (id.startsWith('addto_')) {
      if (id === 'addto_dismiss') { await this.reply(url, { delete_original: true }); return ack(); }
      const blocks = (p.message?.blocks ?? []) as { block_id?: string }[];
      const src = sourceOf(String(a.block_id ?? blocks.find(b => String(b.block_id ?? '').startsWith('addto_'))?.block_id ?? ''));
      if (!src || !value) return ack();
      // The name from Kaizen: ✓ Add is a button, with no menu option to read it from ("Saved to the task", 2026-10-14).
      const [subject, sid = ''] = value.split(':');
      const [named] = subject === 'claim'
        ? await this.sql`SELECT concat_ws(' · ', u.name, coalesce(nullif(c.description, ''), c.category)) AS name FROM claims c
                           LEFT JOIN units u ON u.account_id = c.account_id AND u.id = c.unit_id WHERE c.account_id = 1 AND c.id::text = ${sid}` as { name: string }[]
        : await this.sql`SELECT title AS name FROM todos WHERE account_id = 1 AND id::text = ${sid}` as { name: string }[];
      const label = String(named?.name ?? a.selected_option?.text?.text ?? (subject === 'claim' ? 'the claim' : 'the task')).slice(0, 120);
      // After the answer: reading the message, its link and its files takes longer than Slack waits.
      this.ctx.waitUntil((async () => {
        const r = await this.addMessageTo(value, src);
        if (!r.ok) { await this.reply(url, { replace_original: true, response_type: 'ephemeral', text: `Not added: ${r.message}` }); return; }
        // Owner, 2026-10-14: the question goes, and one quiet line in the message's own thread says where it went.
        await this.reply(url, { delete_original: true });
        await slackApi(this.s.token!, 'chat.postMessage', { channel: src.channel, thread_ts: src.thread ?? src.ts, unfurl_links: false,
          text: `📎 Saved to ${label} in Kaizen`, blocks: [{ type: 'context', elements: [{ type: 'mrkdwn',
            text: `📎 Saved to *${label.replace(/[<>&*]/g, '')}* in Kaizen by <@${this.slackUser}> — react :paperclip: to a reply here to add it too.` }] }] });
      })().catch(() => {}));
      return ack();
    }
    // SOPs (owner, 2026-10-14).
    if (id === 'mention_new_sop') {
      if (!this.may('/api/sops', 'GET')) return this.deny('SOPs');
      const v = JSON.parse(value || '{}') as { title?: string; from?: { channel: string; root: string } };
      return await this.openSopForm(p.trigger_id, String(v.title ?? ''), v.from ? { channel: v.from.channel, ts: v.from.root, root: v.from.root, text: '' } : undefined);
    }
    if (id === 'sop_suggest') { this.ctx.waitUntil(this.suggestSop(p.view ?? {}).catch(() => {})); return ack(); }
    if (id === 'sop_ask_thread') { this.ctx.waitUntil(this.askGapsInThread(p.view ?? {}).catch(() => {})); return ack(); }
    if (id === 'sops_section') {
      if (!this.may('/api/sops', 'GET')) return this.deny('SOPs');
      const view = await this.sopList(value);
      await slackApi(this.s.token!, inView ? 'views.push' : 'views.open', { trigger_id: p.trigger_id, view });
      return ack();
    }
    if (id === 'sop_view') {
      const view = await this.sopView(value);
      if (view) await slackApi(this.s.token!, inView ? 'views.push' : 'views.open', { trigger_id: p.trigger_id, view });
      return ack();
    }

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
      // §150: an order closed with nothing bought asks why, on top of the pop-up.
      if (r.error === 'unbought' && t) { await this.pushForm(p.trigger_id, unboughtModal(t, 'complete', this.s.config.appUrl) as Record<string, unknown>, { id: tid, verb: 'complete' }); return ack(); }
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
          status: c.status, source: c.source, description: c.description, caseUrl: c.case_url }, await this.units(), CLAIM_CATEGORIES, CLAIM_SOURCES) as Record<string, unknown>, { id: c.id, root: 'claims' });
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

    // Owner, Oct 2026: a claim's work opens on top of the claim's card.
    if (id === 'claim_task_open') {
      if (!this.may('/api/todos', 'GET')) return this.deny('the to-do list');
      const c = await this.card(value);
      if (c) await slackApi(this.s.token!, 'views.push', { trigger_id: p.trigger_id, view: taskCard(c) });
      return ack();
    }
    // §162: the team answers a field report's urgency on its message (the cleaner is no longer asked) — or calls it a repair.
    // The answer is a line in its thread and the message is redrawn without the question (notifyTask).
    if (id.startsWith('task_urgency_') || id === 'task_make_repair') {
      if (!this.may('/api/todos', 'POST')) return this.deny('the to-do list');
      const [prio = '', tid = ''] = id === 'task_make_repair' ? ['', value] : value.split('|');
      const r = await this.todo(id === 'task_make_repair' ? { action: 'update', id: tid, kind: 'work_order', via: 'slack-kind' } : { action: 'urgency', id: tid, priority: prio });
      if (!r.ok) await this.reply(url, { replace_original: false, response_type: 'ephemeral', text: `Not saved: ${String(r.message ?? r.error ?? 'Kaizen said no.')}` });
      // §164: the private question in a cleaner's channel says what was decided (the channel's own message is redrawn by notifyTask).
      else if (p.container?.is_ephemeral) await this.reply(url, { replace_original: true, text: id === 'task_make_repair' ? '🔧 Made a work order.'
        : `⚑ Urgency set: ${prio}${r.dueOn ? ` — due ${String(r.dueOn)}` : ''}` });
      else if (id === 'task_make_repair') this.ctx.waitUntil(notifyTask(this.sql, this.ctx.env.ENCRYPTION_KEY, tid, 'kind', this.email).catch(() => {}));
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
      if (id === 'card_cancel') { body = { action: 'update', id: value, status: 'cancelled' }; note = '✕ Cancelled'; }
      // Owner, Oct 2026: a sub-task's ⋯ — the card stays on its parent.
      let cardId = value;
      if (id === 'card_sub') {
        const [verb = '', sub = ''] = value.split(':');
        cardId = String(JSON.parse(p.view?.private_metadata || '{}').id ?? '');
        body = verb === 'done' ? { action: 'done', id: sub, done: true } : verb === 'reopen' ? { action: 'done', id: sub, done: false }
          : verb === 'cancel' ? { action: 'update', id: sub, status: 'cancelled' } : null;
        note = verb === 'done' ? '✓ Sub-task done' : verb === 'reopen' ? '↺ Sub-task reopened' : '✕ Sub-task cancelled';
      }
      if (id === 'card_take') {
        const mine = hostawayUserOf(this.s.config, this.slackUser);
        if (!mine) { await this.refreshCard(viewId, value, '⚠ You are not linked to a Hostaway user yet (Settings → Slack → People), so Kaizen cannot make you the owner.'); return ack(); }
        body = { action: 'update', id: value, assigneeUserId: Number(mine) }; note = '🙋 Yours now';
      }
      if (!body) return ack();
      const r = await this.todo(body);
      // §150: a request closed with nothing bought asks why, on top of the card.
      if (r.error === 'unbought' && (id === 'card_complete' || id === 'card_cancel')) {
        const t = await taskLite(this.sql, value);
        if (t) { const verb = id === 'card_cancel' ? 'cancel' : 'complete';
                 await this.pushForm(p.trigger_id, unboughtModal(t, verb, this.s.config.appUrl) as Record<string, unknown>, { id: value, verb }); return ack(); }
      }
      const root = (JSON.parse(p.view?.private_metadata || '{}') as { root?: 'tasks' }).root;
      await this.refreshCard(viewId, cardId, r.ok ? note : `⚠ ${r.message ?? 'Not saved.'}`, root);
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
      if ((v.kind === 'task' || v.kind === 'work_order' || v.kind === 'order') && v.title && v.from) {
        const r = await this.quickCreate(v.kind === 'work_order' ? 'work_order' : v.kind === 'order' ? 'order' : 'task', v.title, v.from, v.from.ts);
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
      // §150: an order closed with nothing bought asks why — or sends to Kaizen to record the purchase.
      if (r.error === 'unbought') {
        const lite = await taskLite(this.sql, taskId);
        if (lite) { await this.open(p.trigger_id, unboughtModal(lite, 'complete', this.s.config.appUrl)); return ack(); }
      }
      if (!r.ok) { await this.reply(url, { response_type: 'ephemeral', replace_original: false, text: r.message ?? 'Not saved.' }); return ack(); }
      const t = await taskLite(this.sql, taskId);
      if (inChannel && t) {
        await this.reply(url, { replace_original: true, ...taskMessage(t, taskVerb === 'complete' ? 'completed' : taskVerb === 'start' ? 'started' : taskVerb === 'reopen' ? 'reopened' : 'updated', this.email.split('@')[0]!) });
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
          status: c.status, source: c.source, description: c.description, caseUrl: c.case_url }, await this.units(), CLAIM_CATEGORIES, CLAIM_SOURCES));
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
    if (view.callback_id === 'sop_save') {
      // Owner, 2026-10-14: anyone saves a draft; only who edits SOPs (sops.edit) publishes — as in Kaizen.
      const f = readSopForm(state);
      if ('error' in f) return json({ response_action: 'errors', errors: { [f.error.block]: f.error.message } });
      const publish = f.publish && this.may('/api/sops', 'POST');
      const src = (meta as unknown as { source?: SopSource | null }).source;
      const r = await this.api(sopsApi.onRequestPost, '/api/sops', 'POST', { action: 'save', kind: 'sop', status: publish ? 'published' : 'draft',
        title: f.draft.title, sectionKey: f.draft.sectionKey, purpose: f.draft.purpose, trigger: f.draft.trigger, owner: f.draft.owner,
        doneWhen: f.draft.doneWhen, steps: f.draft.steps.map(text => ({ text })), body: sopBody(f.draft.rules),
        note: src?.link ? `From Slack: ${src.link}` : 'From Slack' });
      if (!r.ok) return json({ response_action: 'errors', errors: { [Object.keys(state).find(b => b.startsWith('title_')) ?? 'title_0']: String(r.error ?? 'Not saved.') } });
      const sid = String((r.sop as { id?: string } | undefined)?.id ?? '');
      const open = this.s.config.appUrl && sid ? ` · <${this.s.config.appUrl}/?sop=${sid}|Open in Kaizen>` : '';
      return json({ response_action: 'update', view: { type: 'modal', title: { type: 'plain_text', text: 'SOP saved' }, close: { type: 'plain_text', text: 'Close' },
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `✓ *${f.draft.title.replace(/[<>&*]/g, '')}* — ${publish ? 'published' : 'saved as a draft; an SOP editor publishes it in Kaizen'}${open}` } }] } });
    }
    if (view.callback_id === 'task_card') {
      // "Save": the comment and/or a new sub-task (owner, Oct 2026); the card stays open with them in.
      const body = String(state.update?.v?.value ?? '').trim();
      const sub = String(state.subtask?.v?.value ?? '').trim();
      const subRepair = String(state.subrepair?.v?.value ?? '').trim();
      const files = (state.files?.v?.files ?? []) as unknown[];
      const orderItem = String(state.order_item?.v?.selected_option?.value ?? '');
      const orderPlace = String(state.order_place?.v?.selected_option?.value ?? '');
      const orderQty = state.order_qty?.v?.value == null || state.order_qty.v.value === '' ? 1 : Number(state.order_qty.v.value);
      if (!body && !sub && !subRepair && !files.length && !orderItem) return json({ response_action: 'errors', errors: { update: 'Write a comment, a sub-task or a work order, add to the order, or attach a file, first.' } });
      const done: string[] = [];
      if (orderItem) {
        if (!orderPlace) return json({ response_action: 'errors', errors: { order_place: 'Which place is it for?' } });
        const r = await this.orderLine(String(meta.id), orderItem, orderPlace, orderQty);
        if (!r.ok) return json({ response_action: 'errors', errors: { order_item: String(r.message ?? 'Not saved.') } });
        done.push(orderQty > 0 ? '🛒 Order updated' : '🛒 Taken off the order');
      }
      if (files.length) {
        if (!this.may('/api/todo-files', 'POST')) return json({ response_action: 'errors', errors: { files: 'Your role does not include adding files.' } });
        this.attachFiles('task', String(meta.id), files);
        done.push(`📎 ${files.length} file${files.length === 1 ? '' : 's'} being added`);
      }
      for (const [words, kind, block, said] of [[sub, 'task', 'subtask', '✓ Sub-task added'], [subRepair, 'work_order', 'subrepair', '✓ Work order added']] as const) {
        if (!words) continue;
        const r = await this.todo({ action: 'create', title: words.slice(0, 300), parentId: meta.id, kind });
        if (!r.ok) return json({ response_action: 'errors', errors: { [block]: r.message ?? 'Not saved.' } });
        done.push(said);
      }
      if (body) {
        const r = await this.todo({ action: 'note', id: meta.id, body });
        if (!r.ok) return json({ response_action: 'errors', errors: { update: r.message ?? 'Not saved.' } });
        done.push('✓ Comment added');
      }
      const c = await this.card(String(meta.id));
      return c ? json({ response_action: 'update', view: taskCard(c, done.join(' · ')) }) : json({ response_action: 'clear' });
    }
    if (view.callback_id === 'task_unbought') {
      const m = meta as { id: string; verb?: string };
      const closeReason = String(state.why?.v?.value ?? '').trim();
      if (!closeReason) return json({ response_action: 'errors', errors: { why: 'Say why it is closed without buying.' } });
      const r = await this.todo(m.verb === 'cancel' ? { action: 'update', id: m.id, status: 'cancelled', closeReason } : { action: 'done', id: m.id, done: true, closeReason });
      if (!r.ok) return json({ response_action: 'errors', errors: { why: r.message ?? 'Not saved.' } });
      return json({ response_action: 'clear' });
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
      // §113: "Save" on a claim — a comment and/or a to-do for it (owner, Oct 2026); the card stays open with them in.
      const body = String(state.update?.v?.value ?? '').trim();
      const task = String(state.task?.v?.value ?? '').trim();
      const repair = String(state.repair?.v?.value ?? '').trim();
      const files = (state.files?.v?.files ?? []) as unknown[];
      if (!body && !task && !repair && !files.length) return json({ response_action: 'errors', errors: { update: 'Write a comment, a to-do or a repair, or attach a file, first.' } });
      const done: string[] = [];
      if (files.length) {
        if (!this.may('/api/claims', 'POST')) return json({ response_action: 'errors', errors: { files: 'Your role does not include claims.' } });
        this.attachFiles('claim', String(meta.id), files);
        done.push(`📎 ${files.length} file${files.length === 1 ? '' : 's'} being added`);
      }
      for (const [words, kind, block, said] of [[task, 'task', 'task', '✓ To-do added'], [repair, 'work_order', 'repair', '✓ Repair added']] as const) {
        if (!words) continue;
        if (!this.may('/api/todos', 'POST')) return json({ response_action: 'errors', errors: { [block]: 'Your role does not include the to-do list.' } });
        const row = await this.claimRow(String(meta.id));
        const r = await this.todo({ action: 'create', kind, title: words.slice(0, 300), claimId: String(meta.id), priority: 'none',
                                    unitIds: row?.unit_id ? [row.unit_id] : [] });
        if (!r.ok) return json({ response_action: 'errors', errors: { [block]: r.message ?? 'Not saved.' } });
        done.push(said);
      }
      if (body) {
        if (!this.may('/api/claims', 'POST')) return json({ response_action: 'errors', errors: { update: 'Your role does not include claims.' } });
        const r = await this.claimSave({ action: 'note', id: meta.id, body });
        if (!r.ok) return json({ response_action: 'errors', errors: { update: String(r.error ?? 'Not saved.') } });
        done.push('✓ Comment added');
      }
      const root = (meta as { root?: 'claims' }).root;
      const c = await this.claimCardOf(String(meta.id));
      return c ? json({ response_action: 'update', view: claimCard(c, done.join(' · '), root) }) : json({ response_action: 'clear' });
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
      const fromDm = !!m.from && dmChannel(m.from.channel);
      if (fromDm && !m.id) (body as Record<string, unknown>).via = 'slack-dm';
      if (Number.isNaN(body.costActual)) return json({ response_action: 'errors', errors: { cost: 'A number, like 85 or 85.50.' } });
      const r = await this.todo(body);
      if (!r.ok) return json({ response_action: 'errors', errors: { title: r.message ?? 'Not saved.' } });
      // Made from a message: the thread says it is tracked now.
      if (m.from && r.id) {
        // …and becomes the task's thread (§108): "@Kaizen …" there comments on it.
        const from = m.from;
        this.ctx.waitUntil(slackApi(this.s.token!, 'chat.postMessage', { channel: from.channel, thread_ts: from.ts,
          text: `📋 Tracked in Kaizen as a ${m.kind === 'work_order' ? 'repair' : 'task'}: *${String(body.title)}* — reply here with @Kaizen to comment` })
          .then(() => fromDm ? undefined : rememberThread(this.sql, { ok: true, ...from }, 'task', String(r.id))).catch(() => {}));
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
      const r = meta.id ? await this.claimUpdate(meta.id, body) : await this.claimSave(body);
      if (!r.ok) return json({ response_action: 'errors', errors: { description: String(r.error ?? 'Not saved.') } });
      // From the Claims pop-up: back to the list, refreshed.
      if ((meta as { root?: string }).root === 'claims' && view.root_view_id) { await this.refreshClaims(view.root_view_id, '✓ Saved'); return ack(); }
      return json({ response_action: 'clear' });
    }
    return json({ response_action: 'clear' });
  }
}
