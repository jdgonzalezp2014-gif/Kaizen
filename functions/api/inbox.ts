/**
 * /api/inbox — Guest Services → Inbox, the CRM (owner, 2026-11-16). One reservation, everything about its guest:
 *   GET                              → the list: Hostaway's conversations (latest first) with their stay, open to-dos and waiting messages
 *   GET ?conversation=<id>&reservation=<id> → one stay: the thread (Hostaway + Kaizen's outbox), its to-dos, its automatic plan, its portal link
 *   GET ?sms=<reservation id>        → the guest's SMS thread in Quo (the phone number never leaves the server)
 *   POST { action: send | schedule | cancel | retry | suggest }
 * Reading is permission `messages`; anything that writes is `messages.send` (roles.ts). Sending goes through the outbox
 * (guest-outbox.ts): while the account's guest messages are off, "send" keeps the message as staged and says so.
 * The tables come with migration 116; until it runs the list and the threads still read (Hostaway needs no table).
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { can } from '../_lib/roles.ts';
import { decrypt } from '../_lib/crypto.ts';
import { readGuestAi, suggestReply } from '../_lib/guest-ai.ts';
import { GUEST_TZ, deliver, guestLive, loadTemplates, outMsg, portalFor, type OutRow } from '../_lib/guest-outbox.ts';
import { fetchConversation, fetchConversationOf, fetchConversations, fetchMessages } from '../_lib/hostaway-messages.ts';
import { quoThread } from '../_lib/quo.ts';
import { todayIn } from '../../src/lib/dates.ts';
import { MAX_BODY, maskPhone, mergeThread, planFor, type Channel, type InboxRow } from '../../src/lib/inbox.ts';

const ID = /^\d{1,20}$/;
const bad = (message: string, status = 400) => Response.json({ ok: false, message }, { status });
const json = (body: unknown) => Response.json(body, { headers: { 'Cache-Control': 'no-store' } });

const outbox = (sql: SqlFn, reservationId: string, channel: Channel) =>
  (sql`SELECT id::text AS id, reservation_id, conversation_id, listing_id, channel, body, status, send_at, sent_at, attempts, error,
              template_id::text AS template_id, source, created_by
         FROM guest_messages WHERE account_id = 1 AND reservation_id = ${reservationId} AND channel = ${channel}
        ORDER BY send_at` as Promise<OutRow[]>).catch(() => [] as OutRow[]);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const q = new URL(request.url).searchParams;
  const today = todayIn(GUEST_TZ);
  try {
    const creds = await getCredentials(sql, env.ENCRYPTION_KEY);

    const sms = q.get('sms');
    if (sms !== null) {
      if (!ID.test(sms)) return bad('Which stay?');
      const [[a], conv, ours] = await Promise.all([
        sql`SELECT quo_api_key_enc, quo_from FROM accounts WHERE id = 1` as Promise<{ quo_api_key_enc: string | null; quo_from: string | null }[]>,
        fetchConversationOf(creds, sms), outbox(sql, sms, 'sms'),
      ]);
      const connected = !!(a?.quo_api_key_enc && a.quo_from);
      const phone = conv?.phone ?? null;
      let note = '', theirs = [] as Awaited<ReturnType<typeof quoThread>>;
      if (connected && phone) {
        try { theirs = await quoThread({ apiKey: await decrypt(a!.quo_api_key_enc!, env.ENCRYPTION_KEY), from: a!.quo_from }, phone); }
        catch (e) { note = e instanceof Error ? e.message : String(e); }
      }
      return json({ ok: true, connected, phone: maskPhone(phone), note, messages: mergeThread(theirs, ours.map(outMsg)) });
    }

    const conversation = q.get('conversation');
    if (conversation !== null) {
      const reservation = q.get('reservation') ?? '';
      if (!ID.test(conversation) || (reservation && !ID.test(reservation))) return bad('Which conversation?');
      const access = await accessOf(sql, who);
      const [theirs, ours, tasks, templates, row, link] = await Promise.all([
        fetchMessages(creds, conversation),
        reservation ? outbox(sql, reservation, 'hostaway') : [],
        reservation && can(access.permissions, 'todos')
          ? sql`SELECT id::text AS id, title, status, priority, kind, due_on::text AS "dueOn", assignee, done_at IS NOT NULL AS done
                  FROM todos WHERE account_id = 1 AND deleted_at IS NULL AND reservation_id = ${reservation}
                 ORDER BY done_at IS NOT NULL, created_at DESC LIMIT 50`
          : [],
        loadTemplates(sql),
        fetchConversation(creds, conversation),
        reservation ? portalFor(sql, env.ENCRYPTION_KEY, reservation) : null,
      ]);
      const log = ours.filter(o => o.source === 'auto').map(o => ({ templateId: o.template_id, status: o.status }));
      return json({
        ok: true, messages: mergeThread(theirs, ours.map(outMsg)), tasks, portalLink: link, phone: maskPhone(row?.phone),
        plan: row ? planFor(row, templates, log, new Date(), GUEST_TZ) : [],
      });
    }

    const offset = Math.max(0, Math.min(2000, Number(q.get('offset')) || 0));
    const [convs, units, tasks, waiting, templates, live, ai, acct] = await Promise.all([
      fetchConversations(creds, 50, offset),
      sql`SELECT id::text AS id, name FROM units WHERE account_id = 1` as Promise<{ id: string; name: string }[]>,
      sql`SELECT reservation_id AS id, count(*)::int AS n FROM todos
           WHERE account_id = 1 AND deleted_at IS NULL AND done_at IS NULL AND reservation_id IS NOT NULL GROUP BY 1` as Promise<{ id: string; n: number }[]>,
      (sql`SELECT reservation_id AS id, count(*)::int AS n FROM guest_messages WHERE account_id = 1 AND status = 'scheduled' GROUP BY 1` as
        Promise<{ id: string; n: number }[]>).catch(() => []),
      loadTemplates(sql), guestLive(sql), readGuestAi(sql),
      sql`SELECT quo_api_key_enc IS NOT NULL AND quo_from IS NOT NULL AS quo FROM accounts WHERE id = 1` as Promise<{ quo: boolean }[]>,
    ]);
    const names = new Map(units.map(u => [u.id, u.name]));
    const nTasks = new Map(tasks.map(t => [t.id, t.n])), nWait = new Map(waiting.map(t => [t.id, t.n]));
    const rows: InboxRow[] = convs.map(({ phone: _phone, type: _type, ...c }) => ({
      ...c, listing: (c.listingId && names.get(c.listingId)) || c.listing || 'Unknown listing',
      tasks: nTasks.get(c.reservationId) ?? 0, scheduled: nWait.get(c.reservationId) ?? 0,
    }));
    return json({ ok: true, rows, today, more: convs.length === 50, live, aiMode: ai.mode, quo: acct[0]?.quo === true, templates });
  } catch (e) {
    return bad(`Hostaway: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!b) return bad('Nothing was sent.');
  const reservationId = String(b.reservationId ?? ''), conversationId = b.conversationId ? String(b.conversationId) : null;
  const needs116 = (e: unknown) => /guest_messages|does not exist/i.test(String(e)) ? bad('The database needs migration 116 first (npm run migrate).', 409) : bad(String(e), 500);

  if (b.action === 'suggest') {
    if (!conversationId || !ID.test(conversationId)) return bad('Which conversation?');
    try {
      const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
      const [row, thread, units] = await Promise.all([fetchConversation(creds, conversationId), fetchMessages(creds, conversationId),
        sql`SELECT id::text AS id, name FROM units WHERE account_id = 1` as Promise<{ id: string; name: string }[]>]);
      if (!row) return bad('That conversation is not in Hostaway any more.', 404);
      const stay = { ...row, listing: units.find(u => u.id === row.listingId)?.name ?? row.listing };
      const r = await suggestReply(sql, env, stay, thread, todayIn(GUEST_TZ));
      return r.ok ? json(r) : bad(r.error, 422);
    } catch (e) { return bad(e instanceof Error ? e.message : String(e), 502); }
  }

  if (b.action === 'cancel' || b.action === 'retry') {
    const id = String(b.id ?? '').replace(/^k/, '');
    if (!ID.test(id)) return bad('Which message?');
    try {
      if (b.action === 'cancel') {
        const done = await sql`UPDATE guest_messages SET status = 'cancelled' WHERE account_id = 1 AND id = ${id} AND status = 'scheduled' RETURNING id`;
        return done.length ? json({ ok: true, status: 'cancelled' }) : bad('That message is no longer waiting.', 409);
      }
      // Claimed first (back to "scheduled" from failed / staged only), so two clicks cannot send it twice.
      const [row] = await sql`UPDATE guest_messages SET status = 'scheduled' WHERE account_id = 1 AND id = ${id} AND status IN ('failed', 'staged')
                              RETURNING id::text AS id, reservation_id, conversation_id, channel, body, attempts` as
        Pick<OutRow, 'id' | 'reservation_id' | 'conversation_id' | 'channel' | 'body' | 'attempts'>[];
      if (!row) return bad('That message cannot be sent again.', 409);
      return json({ ok: true, ...(await deliver(sql, env, { ...row, source: 'manual' })) });
    } catch (e) { return needs116(e); }
  }

  if (b.action !== 'send' && b.action !== 'schedule') return bad('Unknown action.');
  if (!ID.test(reservationId)) return bad('This conversation has no reservation yet — answer it in Hostaway.');
  if (conversationId && !ID.test(conversationId)) return bad('Which conversation?');
  const channel: Channel = b.channel === 'sms' ? 'sms' : 'hostaway';
  const body = typeof b.body === 'string' ? b.body.trim() : '';
  if (!body) return bad('Write the message first.');
  if (body.length > MAX_BODY) return bad(`Too long — ${MAX_BODY} characters at most.`);
  if (/\{\{\s*[a-z_]+\s*\}\}/i.test(body)) return bad('The message still has an empty {{variable}} — fill it in or remove it.');
  const listingId = b.listingId && ID.test(String(b.listingId)) ? String(b.listingId) : null;
  const templateId = b.templateId && ID.test(String(b.templateId)) ? String(b.templateId) : null;
  const aiDraft = typeof b.aiDraft === 'string' ? b.aiDraft.slice(0, MAX_BODY) : null;
  let sendAt = new Date();
  if (b.action === 'schedule') {
    sendAt = new Date(String(b.sendAt ?? ''));
    if (Number.isNaN(sendAt.getTime())) return bad('When should it go?');
    if (sendAt.getTime() < Date.now() + 60_000) return bad('Pick a time in the future.');
    if (sendAt.getTime() > Date.now() + 366 * 86_400_000) return bad('Within a year, please.');
  }
  try {
    const [row] = await sql`
      INSERT INTO guest_messages (account_id, reservation_id, conversation_id, listing_id, channel, body, status, send_at, template_id, source, ai_draft, created_by)
      VALUES (1, ${reservationId}, ${conversationId}, ${listingId}, ${channel}, ${body}, 'scheduled', ${sendAt.toISOString()}, ${templateId},
              ${b.action === 'schedule' ? 'scheduled' : 'manual'}, ${aiDraft}, ${who.email})
      RETURNING id::text AS id` as { id: string }[];
    if (b.action === 'schedule') return json({ ok: true, status: 'scheduled', id: row!.id });
    const r = await deliver(sql, env, { id: row!.id, reservation_id: reservationId, conversation_id: conversationId, channel, body, attempts: 0, source: 'manual' });
    return json({ ok: true, id: row!.id, ...r });
  } catch (e) { return needs116(e); }
};
