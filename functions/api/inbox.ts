/**
 * /api/inbox — Guest Services → Inbox, the CRM (owner, 2026-11-16). One reservation, everything about its guest:
 *   GET                              → the list: Hostaway's conversations (latest first) with their stay, open to-dos and waiting messages
 *   GET ?conversation=<id>&reservation=<id> → one stay: the thread (Hostaway + Kaizen's outbox), its to-dos, its automatic plan, its portal link
 *   GET ?sms=<reservation id>        → the guest's SMS thread in Quo (the phone number never leaves the server)
 *   GET ?events=<last id>            → what Hostaway's webhook reported since: guests waiting for an answer (the rail's count, the browser's notification)
 *   GET ?automations=1               → the automations with what each one did in the last 30 days, and the listings to choose from
 *   POST { action: send | schedule | cancel | retry | suggest | checkin | hold | resume | extend }
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
import { openEvents } from '../_lib/guest-events.ts';
import { GUEST_TZ, deliver, fireStay, guestLive, loadTemplates, outMsg, portalFor, type OutRow } from '../_lib/guest-outbox.ts';
import { fetchConversation, fetchConversationOf, fetchConversations, fetchMessages } from '../_lib/hostaway-messages.ts';
import { quoThread } from '../_lib/quo.ts';
import { fetchCalendar } from '../_lib/hostaway.ts';
import { calendarFit } from '../../src/lib/guest-portal.ts';
import { todayIn } from '../../src/lib/dates.ts';
import { HOUSE_VARS, MAX_BODY, isVia, maskPhone, mergeThread, planFor, type Channel, type InboxRow } from '../../src/lib/inbox.ts';

const ID = /^\d{1,20}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const bad = (message: string, status = 400) => Response.json({ ok: false, message }, { status });
const json = (body: unknown) => Response.json(body, { headers: { 'Cache-Control': 'no-store' } });

// An automation a person held for this stay (action 'hold') is a mark, not a message: it stays out of the thread.
const outbox = (sql: SqlFn, reservationId: string, channel: Channel) =>
  (sql`SELECT id::text AS id, reservation_id, conversation_id, listing_id, channel, body, status, send_at, sent_at, attempts, error,
              template_id::text AS template_id, source, created_by, via
         FROM guest_messages WHERE account_id = 1 AND reservation_id = ${reservationId} AND channel = ${channel}
          AND NOT (source = 'auto' AND status = 'cancelled' AND created_by IS NOT NULL)
        ORDER BY send_at` as Promise<OutRow[]>)
    // Before migration 117 there is no `via` column: the rows still read.
    .catch(() => sql`SELECT id::text AS id, reservation_id, conversation_id, listing_id, channel, body, status, send_at, sent_at, attempts, error,
              template_id::text AS template_id, source, created_by
         FROM guest_messages WHERE account_id = 1 AND reservation_id = ${reservationId} AND channel = ${channel}
          AND NOT (source = 'auto' AND status = 'cancelled' AND created_by IS NOT NULL)
        ORDER BY send_at` as Promise<OutRow[]>).catch(() => [] as OutRow[]);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const q = new URL(request.url).searchParams;
  const today = todayIn(GUEST_TZ);
  try {
    // Kaizen's own tables only — no Hostaway call: this is asked every half minute by every open app.
    const asked = q.get('events');
    if (asked !== null) {
      const since = Number(asked) || 0;
      const open = await openEvents(sql);
      const newest = new Map<string, (typeof open)[number]>();
      for (const e of open) newest.set(e.conversationId, e);
      const waiting = [...newest.values()].filter(e => e.needsReply !== false);
      return json({ ok: true, last: open.length ? Number(open[open.length - 1]!.id) : since, waiting: waiting.length,
        fresh: waiting.filter(e => Number(e.id) > since).map(e => ({ id: e.id, conversationId: e.conversationId, guest: e.guest ?? 'A guest', preview: e.preview ?? '', urgent: e.urgent })) });
    }
    if (q.get('automations') !== null) {
      const [templates, stats, units] = await Promise.all([
        loadTemplates(sql),
        (sql`SELECT template_id::text AS id, status, count(*)::int AS n, max(COALESCE(sent_at, send_at)) AS last FROM guest_messages
              WHERE account_id = 1 AND source = 'auto' AND template_id IS NOT NULL AND created_at > now() - interval '30 days' GROUP BY 1, 2` as
          Promise<{ id: string; status: string; n: number; last: string | null }[]>).catch(() => []),
        sql`SELECT id::text AS id, name FROM units WHERE account_id = 1 AND active ORDER BY name` as Promise<{ id: string; name: string }[]>,
      ]);
      return json({ ok: true, templates, stats, units, live: await guestLive(sql) });
    }
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
      const [theirs, ours, tasks, cases, templates, row, link, checkins] = await Promise.all([
        fetchMessages(creds, conversation),
        reservation ? outbox(sql, reservation, 'hostaway') : [],
        // A purchase order is a to-do made as an order (clean_group 'request', todos.ts) — the Work section's third kind.
        reservation && can(access.permissions, 'todos')
          ? sql`SELECT id::text AS id, title, status, priority, kind, due_on::text AS "dueOn", assignee, done_at IS NOT NULL AS done,
                       COALESCE(clean_group = 'request', false) AS "order"
                  FROM todos WHERE account_id = 1 AND deleted_at IS NULL AND reservation_id = ${reservation} AND parent_id IS NULL
                 ORDER BY done_at IS NOT NULL, created_at DESC LIMIT 50`
          : [],
        // 2026-11-17 (owner): the stay's claims and upsells, each in its own section of the conversation.
        reservation && can(access.permissions, 'claims')
          ? (sql`SELECT id::text AS id, category, status, description, requested::float AS requested, refund::float AS received
                   FROM claims WHERE account_id = 1 AND deleted_at IS NULL AND reservation_id = ${reservation}
                  ORDER BY created_at DESC LIMIT 30` as Promise<unknown[]>).catch(() => [])
          : [],
        loadTemplates(sql),
        fetchConversation(creds, conversation),
        reservation ? portalFor(sql, env.ENCRYPTION_KEY, reservation) : null,
        reservation ? sql`SELECT completed_at, source, marked_by FROM guest_checkins WHERE account_id = 1 AND reservation_id = ${reservation}`
          .catch(() => []) as Promise<{ completed_at: string | Date; source: string; marked_by: string | null }[]> : [],
      ]);
      // The plan counts every automatic row of the stay, whatever channel it went by (an SMS automation shows here too).
      const auto = reservation ? await (sql`SELECT template_id::text AS "templateId", status FROM guest_messages
                                             WHERE account_id = 1 AND reservation_id = ${reservation} AND source = 'auto'` as
        Promise<{ templateId: string | null; status: OutRow['status'] }[]>).catch(() => []) : [];
      const ci = checkins[0] ? { at: new Date(checkins[0].completed_at).toISOString(), source: checkins[0].source, by: checkins[0].marked_by } : null;
      // Reading the thread is also how an answer given from Hostaway's own app is noticed: nothing waits any more.
      if (theirs.length && !theirs[theirs.length - 1]!.incoming) {
        await sql`UPDATE guest_events SET answered_at = now() WHERE account_id = 1 AND kind = 'message' AND conversation_id = ${conversation} AND answered_at IS NULL`.catch(() => {});
      }
      return json({
        ok: true, messages: mergeThread(theirs, ours.map(outMsg)), tasks, cases, portalLink: link, phone: maskPhone(row?.phone), checkin: ci,
        plan: row ? planFor({ ...row, checkinDoneAt: ci?.at ?? null }, templates, auto, new Date(), GUEST_TZ) : [],
      });
    }

    const offset = Math.max(0, Math.min(2000, Number(q.get('offset')) || 0));
    const [convs, units, tasks, waiting, templates, live, ai, acct, events] = await Promise.all([
      fetchConversations(creds, 50, offset),
      sql`SELECT id::text AS id, name FROM units WHERE account_id = 1` as Promise<{ id: string; name: string }[]>,
      sql`SELECT reservation_id AS id, count(*)::int AS n FROM todos
           WHERE account_id = 1 AND deleted_at IS NULL AND done_at IS NULL AND reservation_id IS NOT NULL GROUP BY 1` as Promise<{ id: string; n: number }[]>,
      (sql`SELECT reservation_id AS id, count(*)::int AS n FROM guest_messages WHERE account_id = 1 AND status = 'scheduled' GROUP BY 1` as
        Promise<{ id: string; n: number }[]>).catch(() => []),
      loadTemplates(sql), guestLive(sql), readGuestAi(sql),
      sql`SELECT quo_api_key_enc IS NOT NULL AND quo_from IS NOT NULL AS quo FROM accounts WHERE id = 1` as Promise<{ quo: boolean }[]>,
      // What the light model said about each conversation's last guest message (guest-events.ts) — empty without the webhook.
      (sql`SELECT DISTINCT ON (conversation_id) conversation_id AS id, needs_reply, msg_at, created_at FROM guest_events
            WHERE account_id = 1 AND kind = 'message' AND conversation_id IS NOT NULL AND created_at > now() - interval '14 days'
            ORDER BY conversation_id, id DESC` as Promise<{ id: string; needs_reply: boolean | null; msg_at: string | Date | null; created_at: string | Date }[]>).catch(() => []),
    ]);
    const triaged = new Map(events.map(e => [e.id, e]));
    // "Thanks!" is not waiting — but only while it IS the last word: a later message is a new question until it is sorted.
    const quiet = (c: { conversationId: string; lastAt: string | null; lastIncoming: boolean }) => {
      const e = triaged.get(c.conversationId);
      return !!e && c.lastIncoming && e.needs_reply === false && (!c.lastAt || new Date(e.msg_at ?? e.created_at).getTime() >= Date.parse(c.lastAt) - 60_000);
    };
    // The list is the truth about who has the last word: an event whose conversation was answered meanwhile is closed here, for free.
    const answered = convs.filter(c => !c.lastIncoming && triaged.has(c.conversationId)).map(c => c.conversationId);
    if (answered.length) await sql`UPDATE guest_events SET answered_at = now() WHERE account_id = 1 AND kind = 'message' AND answered_at IS NULL AND conversation_id = ANY(${answered})`.catch(() => {});
    const names = new Map(units.map(u => [u.id, u.name]));
    const nTasks = new Map(tasks.map(t => [t.id, t.n])), nWait = new Map(waiting.map(t => [t.id, t.n]));
    const rows: InboxRow[] = convs.map(({ phone: _phone, type: _type, ...c }) => ({
      ...c, listing: (c.listingId && names.get(c.listingId)) || c.listing || 'Unknown listing',
      tasks: nTasks.get(c.reservationId) ?? 0, scheduled: nWait.get(c.reservationId) ?? 0, noReply: quiet(c),
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

  // The online check-in, marked by a person until the guest portal's real door writes it (roadmap, phase 2). Marking it
  // done is the event "After online check-in" automations wait for: they run now, not at the clock's next pass.
  if (b.action === 'checkin') {
    if (!ID.test(reservationId)) return bad('Which stay?');
    const listingId = b.listingId && ID.test(String(b.listingId)) ? String(b.listingId) : null;
    try {
      if (b.done === false) {
        await sql`DELETE FROM guest_checkins WHERE account_id = 1 AND reservation_id = ${reservationId} AND source = 'team'`;
        return json({ ok: true, status: 'cancelled' });
      }
      await sql`INSERT INTO guest_checkins (account_id, reservation_id, listing_id, source, marked_by) VALUES (1, ${reservationId}, ${listingId}, 'team', ${who.email})
                ON CONFLICT DO NOTHING`;
      const fired = await fireStay(sql, env, reservationId).catch(e => ({ skipped: e instanceof Error ? e.message : String(e) }));
      return json({ ok: true, status: 'sent', fired });
    } catch (e) { return /guest_checkins|does not exist/i.test(String(e)) ? bad('The database needs migration 117 first (npm run migrate).', 409) : bad(String(e), 500); }
  }

  // 2026-11-17 (owner): can this stay be extended? The listing's live Hostaway calendar around it — the free nights before
  // and after (calendarFit, the same reading as the guest portal's Extra nights). Read only: the change itself is made in
  // Hostaway or the channel (an alteration), never from here.
  if (b.action === 'extend') {
    const listingId = String(b.listingId ?? ''), arrival = String(b.arrival ?? ''), departure = String(b.departure ?? '');
    if (!ID.test(listingId) || !DAY_RE.test(arrival) || !DAY_RE.test(departure)) return bad('Which stay?');
    const shift = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    try {
      const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
      const days = await fetchCalendar(creds, listingId, shift(arrival, -7), shift(departure, 7));
      return json({ ok: true, ...calendarFit(days.map(d => ({ date: d.date, available: d.available, price: d.price })), arrival, departure) });
    } catch (e) { return bad(`Hostaway: ${e instanceof Error ? e.message : String(e)}`, 502); }
  }

  // 2026-11-17 (owner): stop what is still to go for one stay — "something happened" (a cancellation, a change of plan).
  // A manual message waiting is cancelled; an automation is held by writing its once-per-stay row as 'cancelled'
  // (the unique index guest_messages_auto_once), so the clock never makes it. `resume` deletes that row: it goes again.
  if (b.action === 'hold' || b.action === 'resume') {
    if (!ID.test(reservationId)) return bad('Which stay?');
    const ids = (Array.isArray(b.templateIds) ? b.templateIds : []).map(String).filter(x => ID.test(x)).slice(0, 50);
    const msgs = (Array.isArray(b.messageIds) ? b.messageIds : []).map(x => String(x).replace(/^k/, '')).filter(x => ID.test(x)).slice(0, 50);
    try {
      if (b.action === 'resume') {
        await sql`DELETE FROM guest_messages WHERE account_id = 1 AND reservation_id = ${reservationId} AND source = 'auto'
                  AND status = 'cancelled' AND template_id::text = ANY(${ids})`;
        return json({ ok: true, status: 'scheduled' });
      }
      if (msgs.length) await sql`UPDATE guest_messages SET status = 'cancelled' WHERE account_id = 1 AND reservation_id = ${reservationId}
                                 AND status = 'scheduled' AND id::text = ANY(${msgs})`;
      const templates = (await loadTemplates(sql)).filter(t => ids.includes(t.id));
      const listingId = b.listingId && ID.test(String(b.listingId)) ? String(b.listingId) : null;
      for (const t of templates) {
        await sql`INSERT INTO guest_messages (account_id, reservation_id, conversation_id, listing_id, channel, body, status, send_at, template_id, source, created_by)
                  VALUES (1, ${reservationId}, ${conversationId}, ${listingId}, ${t.channel}, ${`Held: ${t.name}`}, 'cancelled', now(), ${t.id}, 'auto', ${who.email})
                  ON CONFLICT DO NOTHING`;
      }
      return json({ ok: true, status: 'cancelled' });
    } catch (e) { return needs116(e); }
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
                              RETURNING id::text AS id, reservation_id, conversation_id, channel, body, attempts, to_jsonb(guest_messages)->>'via' AS via` as
        Pick<OutRow, 'id' | 'reservation_id' | 'conversation_id' | 'channel' | 'body' | 'attempts' | 'via'>[];
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
  if (/\{\{\s*[a-z_]+\s*\}\}/i.test(body)) return bad(new RegExp(`\\{\\{\\s*(${HOUSE_VARS.join('|')})\\s*\\}\\}`, 'i').test(body)
    ? 'The door code, Wi-Fi and address blanks are filled only in automations — type the value here, or remove the blank.'
    : 'The message still has an empty {{variable}} — fill it in or remove it.');
  // The tab the person wrote in: email or the booking channel's chat. Nothing = the way the thread already talks.
  const via = channel === 'hostaway' && isVia(b.via) ? b.via : null;
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
    // Its own statement: before migration 117 there is no such column, and a reply must still go (the thread's own way).
    if (via) {
      const set = await sql`UPDATE guest_messages SET via = ${via} WHERE account_id = 1 AND id = ${row!.id} RETURNING id`.catch(() => []);
      if (!set.length) { await sql`DELETE FROM guest_messages WHERE account_id = 1 AND id = ${row!.id}`; return bad('Choosing email or chat needs migration 117 first (npm run migrate).', 409); }
    }
    if (b.action === 'schedule') return json({ ok: true, status: 'scheduled', id: row!.id });
    const r = await deliver(sql, env, { id: row!.id, reservation_id: reservationId, conversation_id: conversationId, channel, body, attempts: 0, source: 'manual', via });
    return json({ ok: true, id: row!.id, ...r });
  } catch (e) { return needs116(e); }
};
