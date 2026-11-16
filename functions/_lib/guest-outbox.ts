/**
 * The guest outbox (Guest Services → Inbox, owner 2026-11-16): every message Kaizen sends, schedules or would send to a
 * guest is a row in `guest_messages` first, and only then goes out — so there is always a record of what was meant,
 * what happened and why (owner, 2026-11-15: guest messages must never fail silently).
 *
 * STAGED BY DEFAULT, like Quo (quo.ts): while `accounts.guest_messages_live` is false the whole path runs — the
 * template is filled, the stay is matched, the row is written — and the send is simply not made; the row says
 * "staged". Hostaway's own automations keep sending meanwhile, so the two can be read side by side before the switch.
 *
 * A message that fails keeps its row: a scheduled or automatic one is tried again (3 times, 10 minutes apart) by the
 * clock; one a person just typed says so at once and offers Retry.
 */
import { getCredentials, type SqlFn } from './accounts.ts';
import { decrypt } from './crypto.ts';
import type { Env } from './db.ts';
import { signGuest } from './guest-link.ts';
import { fetchReservationsActiveSince, fetchReservationsTouching, type HostawayReservation } from './hostaway.ts';
import { fetchConversationOf, fetchMessages, replyType, sendMessage } from './hostaway-messages.ts';
import { sendSms } from './quo.ts';
import { addDays, todayIn } from '../../src/lib/dates.ts';
import { fill, planFor, portalLink, stayWindow, varsFor, type Channel, type MsgStatus, type Stay, type Template, type ThreadMsg, type Trigger } from '../../src/lib/inbox.ts';

/** Kaizen's listings are all in Texas; a per-account zone is product debt (docs/product.md). */
export const GUEST_TZ = 'America/Chicago';
const MAX_TRIES = 3, RETRY_MIN = 10, PER_TICK = 8;

export interface OutRow {
  id: string; reservation_id: string; conversation_id: string | null; listing_id: string | null; channel: Channel; body: string;
  status: MsgStatus; send_at: string | Date; sent_at: string | Date | null; attempts: number; error: string | null;
  template_id: string | null; source: 'manual' | 'scheduled' | 'auto'; created_by: string | null;
}
const iso = (d: string | Date) => new Date(d).toISOString();

/** A row as the thread draws it. */
export const outMsg = (r: OutRow): ThreadMsg => ({
  id: `k${r.id}`, at: iso(r.sent_at ?? r.send_at), incoming: false, body: r.body, channel: r.channel, status: r.status, ours: true,
  by: r.source === 'auto' ? 'Automatic' : r.created_by, detail: r.error, via: r.channel === 'sms' ? 'sms' : null,
});

/** Does this account really send to guests? False until migration 116 and the switch in Settings. */
export async function guestLive(sql: SqlFn): Promise<boolean> {
  const rows = await (sql`SELECT guest_messages_live AS live FROM accounts WHERE id = 1` as Promise<{ live: boolean }[]>).catch(() => []);
  return rows[0]?.live === true;
}

export async function loadTemplates(sql: SqlFn): Promise<Template[]> {
  const rows = await (sql`SELECT id::text AS id, name, body, channel, trigger, offset_hours, active FROM message_templates
                           WHERE account_id = 1 AND deleted_at IS NULL ORDER BY name` as
    Promise<{ id: string; name: string; body: string; channel: Channel; trigger: Trigger; offset_hours: number; active: boolean }[]>).catch(() => []);
  return rows.map(r => ({ id: r.id, name: r.name, body: r.body, channel: r.channel, trigger: r.trigger, offsetHours: r.offset_hours, active: r.active }));
}

/** This stay's portal link — null until the account has a portal address. */
export async function portalFor(sql: SqlFn, encryptionKey: string, reservationId: string): Promise<string | null> {
  const rows = await (sql`SELECT guest_portal_url AS url FROM accounts WHERE id = 1` as Promise<{ url: string | null }[]>).catch(() => []);
  return rows[0]?.url ? portalLink(rows[0].url, reservationId, await signGuest(encryptionKey, reservationId)) : null;
}

/** Send one row now (or stage it), and write what happened on the row. */
export async function deliver(sql: SqlFn, env: Env, row: Pick<OutRow, 'id' | 'reservation_id' | 'conversation_id' | 'channel' | 'body' | 'attempts' | 'source'>):
  Promise<{ status: MsgStatus; error: string | null }> {
  const live = await guestLive(sql);
  let status: MsgStatus = 'staged', error: string | null = null, conversationId = row.conversation_id;
  try {
    if (!live) error = 'Guest messages are off in Settings — kept here, not sent.';
    else if (row.channel === 'hostaway') {
      const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
      const conv = await fetchConversationOf(creds, row.reservation_id);
      conversationId = conversationId ?? conv?.conversationId ?? null;
      if (!conversationId) { status = 'failed'; error = 'This stay has no conversation in Hostaway yet.'; }
      else {
        const thread = await fetchMessages(creds, conversationId, 20).catch(() => []);
        const r = await sendMessage(creds, conversationId, row.body, replyType(conv?.type ?? '', thread));
        status = r.ok ? 'sent' : 'failed';
        error = r.ok ? null : r.error;
      }
    } else {
      const [q] = await sql`SELECT quo_api_key_enc, quo_from FROM accounts WHERE id = 1` as { quo_api_key_enc: string | null; quo_from: string | null }[];
      const phone = (await fetchConversationOf(await getCredentials(sql, env.ENCRYPTION_KEY), row.reservation_id))?.phone ?? null;
      if (!phone) { status = 'failed'; error = 'The guest has no phone number on this reservation.'; }
      else {
        const r = await sendSms({ apiKey: q?.quo_api_key_enc ? await decrypt(q.quo_api_key_enc, env.ENCRYPTION_KEY) : null,
                                  from: q?.quo_from ?? null, recipients: [phone], live: true }, row.body);
        status = r.outcome === 'sent' ? 'sent' : 'failed';
        error = r.outcome === 'sent' ? null : r.detail;
      }
    }
  } catch (e) {
    status = 'failed';
    error = e instanceof Error ? e.message.slice(0, 300) : String(e);
  }
  // Something a person is not waiting on gets another go; the row stays "scheduled" with the reason on it.
  const again = status === 'failed' && row.source !== 'manual' && row.attempts + 1 < MAX_TRIES;
  await sql`UPDATE guest_messages
               SET status = ${again ? 'scheduled' : status}, attempts = attempts + 1, error = ${error},
                   conversation_id = COALESCE(conversation_id, ${conversationId}),
                   sent_at = CASE WHEN ${status} = 'sent' THEN now() ELSE sent_at END,
                   send_at = CASE WHEN ${again} THEN now() + make_interval(mins => ${RETRY_MIN}) ELSE send_at END
             WHERE account_id = 1 AND id = ${row.id}`;
  return { status: again ? 'scheduled' : status, error };
}

const stayOf = (r: HostawayReservation, names: Map<string, string>): Stay => ({
  reservationId: r.reservationId, listingId: r.listingId, listing: names.get(r.listingId) ?? '', guest: r.guestName ?? 'Guest',
  arrival: r.arrival, departure: r.departure, status: r.status, checkInHour: r.checkInHour, checkOutHour: r.checkOutHour, bookedAt: r.bookedAt,
});

/**
 * The clock's pass (/api/slack-cron?job=messages, every 5 minutes): first what a person scheduled and is now due, then
 * the automatic templates whose moment has come. A handful per pass — a Pages Function may make 50 subrequests, and
 * the next pass is five minutes away. With nothing scheduled and no automatic template it costs two queries.
 */
export async function runDue(sql: SqlFn, env: Env, now = new Date()) {
  const out = { sent: 0, staged: 0, failed: 0, retrying: 0, created: 0, skipped: '' };
  const count = (s: MsgStatus) => { if (s === 'sent') out.sent++; else if (s === 'staged') out.staged++; else if (s === 'scheduled') out.retrying++; else out.failed++; };
  const due = await (sql`SELECT id::text AS id, reservation_id, conversation_id, channel, body, attempts, source FROM guest_messages
                          WHERE account_id = 1 AND status = 'scheduled' AND send_at <= now() ORDER BY send_at LIMIT ${PER_TICK}` as
    Promise<Pick<OutRow, 'id' | 'reservation_id' | 'conversation_id' | 'channel' | 'body' | 'attempts' | 'source'>[]>).catch(() => null);
  if (due === null) return { ...out, skipped: 'migration 116 has not run' };
  for (const r of due) count((await deliver(sql, env, r)).status);

  const templates = (await loadTemplates(sql)).filter(t => t.active && t.trigger !== 'manual');
  let room = PER_TICK - due.length;
  if (!templates.length || room <= 0) return out;
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
  const today = todayIn(GUEST_TZ, now), w = stayWindow(templates, today);
  const [touching, fresh, units] = await Promise.all([
    fetchReservationsTouching(creds, w.from, w.to),
    // "After booking" is about when it was booked, whatever its dates: yesterday's and today's activity.
    templates.some(t => t.trigger === 'booked') ? fetchReservationsActiveSince(creds, addDays(today, -1)) : [],
    sql`SELECT id::text AS id, name FROM units WHERE account_id = 1` as Promise<{ id: string; name: string }[]>,
  ]);
  const names = new Map(units.map(u => [u.id, u.name]));
  const stays = [...new Map([...touching, ...fresh].map(r => [r.reservationId, stayOf(r, names)])).values()];
  if (!stays.length) return out;
  const log = await sql`SELECT reservation_id, template_id::text AS "templateId", status FROM guest_messages
                         WHERE account_id = 1 AND source = 'auto' AND reservation_id = ANY(${stays.map(s => s.reservationId)})` as
    { reservation_id: string; templateId: string | null; status: MsgStatus }[];
  for (const s of stays) {
    for (const p of planFor(s, templates, log.filter(l => l.reservation_id === s.reservationId), now, GUEST_TZ)) {
      if (p.state !== 'due' || room <= 0) continue;
      const t = templates.find(x => x.id === p.templateId)!;
      const f = fill(t.body, varsFor(s, await portalFor(sql, env.ENCRYPTION_KEY, s.reservationId)));
      const why = f.missing.length ? `Not sent: no value for ${f.missing.map(m => `{{${m}}}`).join(', ')}.` : null;
      // The unique index (one automatic template per stay) is what makes a second pass harmless.
      const [row] = await sql`INSERT INTO guest_messages (account_id, reservation_id, listing_id, channel, body, status, send_at, template_id, source, error)
                              VALUES (1, ${s.reservationId}, ${s.listingId}, ${t.channel}, ${f.text}, ${why ? 'failed' : 'scheduled'}, ${p.at}, ${t.id}, 'auto', ${why})
                              ON CONFLICT DO NOTHING RETURNING id::text AS id` as { id: string }[];
      if (!row) continue;
      out.created++; room--;
      if (why) out.failed++;
      else count((await deliver(sql, env, { id: row.id, reservation_id: s.reservationId, conversation_id: null, channel: t.channel, body: f.text, attempts: 0, source: 'auto' })).status);
    }
  }
  return out;
}
