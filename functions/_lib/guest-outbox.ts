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
 *
 * Automations (migration 117): a template with a trigger, for all listings or the chosen ones, with a condition.
 * Two ways in, one path (`createDue`): the clock's pass over the stays whose moment has come, and `fireStay` — the
 * moment something happens to one stay (the online check-in is done, Hostaway's webhook says it was just booked).
 * The unique index (one automatic template per stay) is what makes the two harmless together.
 */
import { confirmedPhone } from './guest-phone.ts';
import { getCredentials, type SqlFn } from './accounts.ts';
import { decrypt } from './crypto.ts';
import type { Env } from './db.ts';
import { signGuest } from './guest-link.ts';
import { fetchReservationDetail, fetchReservationsActiveSince, fetchReservationsTouching, type HostawayCredentials, type HostawayReservation } from './hostaway.ts';
import { fetchConversationOf, fetchMessages, replyType, sendMessage } from './hostaway-messages.ts';
import { sendSms } from './quo.ts';
import { guestHouse } from '../api/guest-guide.ts';
import { addDays, daysBetween, todayIn, type DateStr } from '../../src/lib/dates.ts';
import { doorCodeFor } from '../../src/lib/guest-checkin.ts';
import { GRACE_HOURS, HOUSE_VARS, condsOf, fill, hostawayIso, isConfirmed, paidOf, planFor, signedOf, portalLink, stayWindow, varsFor,
  type Channel, type MsgStatus, type Stay, type Template, type ThreadMsg, type Trigger, type Via } from '../../src/lib/inbox.ts';

/** Kaizen's listings are all in Texas; a per-account zone is product debt (docs/product.md). */
export const GUEST_TZ = 'America/Chicago';
const MAX_TRIES = 3, RETRY_MIN = 10, PER_TICK = 8;

export interface OutRow {
  id: string; reservation_id: string; conversation_id: string | null; listing_id: string | null; channel: Channel; body: string;
  status: MsgStatus; send_at: string | Date; sent_at: string | Date | null; attempts: number; error: string | null;
  template_id: string | null; source: 'manual' | 'scheduled' | 'auto'; created_by: string | null; via?: Via | null;
}
const iso = (d: string | Date) => new Date(d).toISOString();

/** A row as the thread draws it. */
export const outMsg = (r: OutRow): ThreadMsg => ({
  id: `k${r.id}`, at: iso(r.sent_at ?? r.send_at), incoming: false, body: r.body, channel: r.channel, status: r.status, ours: true,
  by: r.source === 'auto' ? 'Automatic' : r.created_by, detail: r.error, via: r.channel === 'sms' ? 'sms' : r.via ?? null,
});

/** Does this account really send to guests? False until migration 116 and the switch in Settings. */
export async function guestLive(sql: SqlFn): Promise<boolean> {
  const rows = await (sql`SELECT guest_messages_live AS live FROM accounts WHERE id = 1` as Promise<{ live: boolean }[]>).catch(() => []);
  return rows[0]?.live === true;
}

type TplRow = { id: string; name: string; body: string; channel: Channel; trigger: Trigger; offset_hours: number; active: boolean;
  listing_ids?: string[] | null; only_if?: string | null; hold_hours?: number | null };
const tplOf = (r: TplRow): Template => ({ id: r.id, name: r.name, body: r.body, channel: r.channel, trigger: r.trigger, offsetHours: r.offset_hours, active: r.active,
  listingIds: r.listing_ids?.length ? r.listing_ids : null, conditions: condsOf(r.only_if), holdHours: r.hold_hours ?? null });

export async function loadTemplates(sql: SqlFn): Promise<Template[]> {
  const rows = await (sql`SELECT id::text AS id, name, body, channel, trigger, offset_hours, active, listing_ids, only_if, hold_hours FROM message_templates
                           WHERE account_id = 1 AND deleted_at IS NULL ORDER BY name` as Promise<TplRow[]>)
    // Before migration 117 the three new columns are not there: the templates still read, as "all listings, always".
    .catch(() => sql`SELECT id::text AS id, name, body, channel, trigger, offset_hours, active FROM message_templates
                      WHERE account_id = 1 AND deleted_at IS NULL ORDER BY name` as Promise<TplRow[]>).catch(() => []);
  return rows.map(tplOf);
}

/** This stay's portal link — null until the account has a portal address. */
export async function portalFor(sql: SqlFn, encryptionKey: string, reservationId: string): Promise<string | null> {
  const rows = await (sql`SELECT guest_portal_url AS url FROM accounts WHERE id = 1` as Promise<{ url: string | null }[]>).catch(() => []);
  return rows[0]?.url ? portalLink(rows[0].url, reservationId, await signGuest(encryptionKey, reservationId)) : null;
}

/** The open bad-experience records of these stays (`guest_issues`): reservation → why. Empty before migration 124. */
/**
 * Is the night of check-out open on each stay's listing? From the hourly calendar look (`calendar_watch`, a character a day
 * from `from_day`, 'a' = open) — no Hostaway call. Only asked when an automation has the "night after check-out" condition.
 */
export async function openAfterOf(sql: SqlFn, stays: Stay[]): Promise<void> {
  const ids = [...new Set(stays.map(s => s.listingId).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const rows = await (sql`SELECT listing_id, from_day::text AS from_day, codes FROM calendar_watch WHERE account_id = 1 AND listing_id = ANY(${ids})
                           AND checked_at > now() - interval '1 day'` as Promise<{ listing_id: string; from_day: string; codes: string }[]>).catch(() => []);
  const look = new Map(rows.map(r => [r.listing_id, r]));
  for (const s of stays) {
    const r = s.listingId ? look.get(s.listingId) : undefined;
    const c = r && s.departure ? r.codes[daysBetween(r.from_day as DateStr, s.departure)] : undefined;
    s.openAfter = c === 'a' ? true : c === 'b' || c === 'r' || c === 'p' ? false : null;
  }
}

/** Stays with an extra charge still pending (`upsell_charges`, the portal's "Pending payments"). No table yet = none. */
export async function chargesDueOf(sql: SqlFn, reservationIds: string[]): Promise<Set<string>> {
  if (!reservationIds.length) return new Set();
  const rows = await (sql`SELECT DISTINCT reservation_id FROM upsell_charges WHERE account_id = 1 AND status = 'pending' AND reservation_id = ANY(${reservationIds})` as
    Promise<{ reservation_id: string }[]>).catch(() => []);
  return new Set(rows.map(r => String(r.reservation_id)));
}

export async function issuesOf(sql: SqlFn, reservationIds: string[]): Promise<Map<string, string>> {
  if (!reservationIds.length) return new Map();
  const rows = await (sql`SELECT reservation_id, why FROM guest_issues WHERE account_id = 1 AND cleared_at IS NULL AND reservation_id = ANY(${reservationIds})` as
    Promise<{ reservation_id: string; why: string }[]>).catch(() => []);
  return new Map(rows.map(r => [r.reservation_id, r.why]));
}

/** Owner, 2026-11-23: a bad experience goes on record (once per stay while open) — the review ask is then held. Nothing is said to the guest. */
export async function recordIssue(sql: SqlFn, a: { reservationId: string; conversationId?: string | null; listingId?: string | null; why: string; source: 'ai' | 'team'; by?: string | null }) {
  return (sql`INSERT INTO guest_issues (account_id, reservation_id, conversation_id, listing_id, why, source, created_by)
              VALUES (1, ${a.reservationId}, ${a.conversationId ?? null}, ${a.listingId ?? null}, ${a.why.slice(0, 300)}, ${a.source}, ${a.by ?? null})
              ON CONFLICT DO NOTHING RETURNING id::text AS id` as Promise<{ id: string }[]>).then(r => r.length > 0).catch(() => false);
}

/** When each of these stays finished its online check-in (`guest_checkins`) — empty before migration 117. */
export async function checkinsOf(sql: SqlFn, reservationIds: string[]): Promise<Map<string, string>> {
  if (!reservationIds.length) return new Map();
  const rows = await (sql`SELECT reservation_id, completed_at FROM guest_checkins WHERE account_id = 1 AND reservation_id = ANY(${reservationIds})` as
    Promise<{ reservation_id: string; completed_at: string | Date }[]>).catch(() => []);
  return new Map(rows.map(r => [r.reservation_id, iso(r.completed_at)]));
}

/**
 * The blanks only the server can fill (owner, 2026-11-16: the door code comes from Hostaway and goes in the message):
 * the reservation's own code in Hostaway for a smart lock, else the Repository's guest code — the same rule the guest
 * portal shows it by (`doorCodeFor`) — plus the house's Wi-Fi and address. Read only when the text names one.
 */
export async function houseVars(sql: SqlFn, creds: HostawayCredentials, body: string, stay: Pick<Stay, 'reservationId' | 'listingId'>): Promise<Record<string, string | null>> {
  const wanted = HOUSE_VARS.filter(k => new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'i').test(body));
  if (!wanted.length || !stay.listingId) return {};
  const [house, detail] = await Promise.all([
    guestHouse(sql, stay.listingId).catch(() => null),
    wanted.includes('door_code') ? fetchReservationDetail(creds, stay.reservationId).catch(() => null) : null,
  ]);
  const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
  return {
    door_code: wanted.includes('door_code') ? doorCodeFor(house?.lockType, house?.guestCode, text(detail?.doorCode)) : null,
    wifi_network: house?.guide?.wifi?.network ?? null, wifi_password: house?.guide?.wifi?.password ?? null, address: house?.guide?.address ?? null,
  };
}

type Deliverable = Pick<OutRow, 'id' | 'reservation_id' | 'conversation_id' | 'channel' | 'body' | 'attempts' | 'source'> & { via?: Via | null };

/** Send one row now (or stage it), and write what happened on the row. */
export async function deliver(sql: SqlFn, env: Env, row: Deliverable): Promise<{ status: MsgStatus; error: string | null }> {
  const live = await guestLive(sql);
  let status: MsgStatus = 'staged', error: string | null = null, conversationId = row.conversation_id;
  try {
    if (!live) error = 'Guest messages are off in Settings — kept here, not sent.';
    else {
      const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
      const conv = await fetchConversationOf(creds, row.reservation_id);
      // An automatic message was planned for a booking: if that booking is gone by now, it is not sent — and not retried.
      if (row.source === 'auto' && conv && !isConfirmed(conv.status)) { status = 'cancelled'; error = `The booking is ${conv.status} — not sent.`; }
      else if (row.channel === 'hostaway') {
        conversationId = conversationId ?? conv?.conversationId ?? null;
        if (!conversationId) { status = 'failed'; error = 'This stay has no conversation in Hostaway yet.'; }
        else if (row.via === 'email' && conv && !conv.hasEmail) { status = 'failed'; error = 'Hostaway has no email address for this guest.'; }
        else {
          // The person's choice of tab (email / chat) wins; otherwise the reply travels the way the thread already talks.
          const type = row.via ?? replyType(conv?.type ?? '', await fetchMessages(creds, conversationId, 20).catch(() => []));
          const r = await sendMessage(creds, conversationId, row.body, type);
          status = r.ok ? 'sent' : 'failed';
          error = r.ok ? null : r.error;
        }
      } else {
        const [q] = await sql`SELECT quo_api_key_enc, quo_from FROM accounts WHERE id = 1` as { quo_api_key_enc: string | null; quo_from: string | null }[];
        const phone = await confirmedPhone(sql, row.reservation_id) ?? conv?.phone ?? null;
        if (!phone) { status = 'failed'; error = 'The guest has no phone number on this reservation.'; }
        else {
          const r = await sendSms({ apiKey: q?.quo_api_key_enc ? await decrypt(q.quo_api_key_enc, env.ENCRYPTION_KEY) : null,
                                    from: q?.quo_from ?? null, recipients: [phone], live: true }, row.body);
          status = r.outcome === 'sent' ? 'sent' : 'failed';
          error = r.outcome === 'sent' ? null : r.detail;
        }
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
  // The guest has an answer now: whatever they wrote before is no longer waiting (the unanswered watch, guest-events.ts).
  if (status === 'sent' && conversationId) {
    await sql`UPDATE guest_events SET answered_at = now() WHERE account_id = 1 AND kind = 'message' AND conversation_id = ${conversationId} AND answered_at IS NULL`.catch(() => {});
  }
  return { status: again ? 'scheduled' : status, error };
}

const stayOf = (r: HostawayReservation, names: Map<string, string>): Stay => ({
  reservationId: r.reservationId, listingId: r.listingId, listing: names.get(r.listingId) ?? '', guest: r.guestName ?? 'Guest',
  arrival: r.arrival, departure: r.departure, status: r.status, checkInHour: r.checkInHour, checkOutHour: r.checkOutHour, bookedAt: r.bookedAt,
  paid: paidOf(r.paymentStatus), signed: r.agreement === 'signed' ? true : r.agreement === 'not_signed' ? false : null, idVerified: r.idVerified,
});

/** One reservation as Hostaway returns it by id (GET /reservations/<id>), as a stay. */
export function stayFromDetail(d: Record<string, unknown>, names: Map<string, string>): Stay | null {
  const text = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
  const day = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  const hour = (v: unknown) => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n >= 0 && n <= 23 ? n : null; };
  if (d.id == null) return null;
  const listingId = d.listingMapId == null ? null : String(d.listingMapId);
  return {
    reservationId: String(d.id), listingId, listing: (listingId && names.get(listingId)) || text(d.listingName) || '', guest: text(d.guestName) ?? 'Guest',
    arrival: day(d.arrivalDate), departure: day(d.departureDate), status: text(d.status) ?? '', checkInHour: hour(d.checkInTime), checkOutHour: hour(d.checkOutTime),
    bookedAt: hostawayIso(d.reservationDate),
    paid: paidOf(d.paymentStatus), signed: signedOf(d.reservationAgreement),
    idVerified: Number(d.isGuestIdentityVerified) === 1 || Number(d.isGuestVerifiedByGovernmentId) === 1,
  };
}

type Tally = { sent: number; staged: number; failed: number; retrying: number; created: number };
const count = (out: Tally, s: MsgStatus) => { if (s === 'sent') out.sent++; else if (s === 'staged') out.staged++; else if (s === 'scheduled') out.retrying++; else out.failed++; };

/**
 * One stay's automations whose moment is now: each becomes a row (once per stay, the unique index) and goes out.
 * Returns how much room it used — a pass sends a handful, the next one is five minutes away.
 */
async function createDue(sql: SqlFn, env: Env, creds: HostawayCredentials, s: Stay, templates: Template[], log: { templateId: string | null; status: MsgStatus }[],
                         now: Date, out: Tally, room: number): Promise<number> {
  let used = 0;
  for (const p of planFor(s, templates, log, now, GUEST_TZ)) {
    if (p.state !== 'due' || used >= room || !p.at) continue;
    const t = templates.find(x => x.id === p.templateId)!;
    const house = await houseVars(sql, creds, t.body, s).catch(() => ({}));
    const f = fill(t.body, varsFor(s, await portalFor(sql, env.ENCRYPTION_KEY, s.reservationId), undefined, house));
    const why = f.missing.length ? `Not sent: no value for ${f.missing.map(m => `{{${m}}}`).join(', ')}.` : null;
    const [row] = await sql`INSERT INTO guest_messages (account_id, reservation_id, listing_id, channel, body, status, send_at, template_id, source, error)
                            VALUES (1, ${s.reservationId}, ${s.listingId}, ${t.channel}, ${f.text}, ${why ? 'failed' : 'scheduled'}, ${p.at}, ${t.id}, 'auto', ${why})
                            ON CONFLICT DO NOTHING RETURNING id::text AS id` as { id: string }[];
    if (!row) continue;
    out.created++; used++;
    if (why) out.failed++;
    else count(out, (await deliver(sql, env, { id: row.id, reservation_id: s.reservationId, conversation_id: null, channel: t.channel, body: f.text, attempts: 0, source: 'auto' })).status);
  }
  return used;
}

const autoLog = (sql: SqlFn, ids: string[]) => sql`SELECT reservation_id, template_id::text AS "templateId", status FROM guest_messages
   WHERE account_id = 1 AND source = 'auto' AND reservation_id = ANY(${ids})` as Promise<{ reservation_id: string; templateId: string | null; status: MsgStatus }[]>;

/**
 * Something just happened to one stay — its online check-in was finished, or Hostaway's webhook says it was booked:
 * run its automations now instead of waiting for the clock. Reads the reservation from Hostaway (the event is a hint).
 */
export async function fireStay(sql: SqlFn, env: Env, reservationId: string, now = new Date()): Promise<Tally & { skipped?: string }> {
  const out: Tally = { sent: 0, staged: 0, failed: 0, retrying: 0, created: 0 };
  const templates = (await loadTemplates(sql)).filter(t => t.active && t.trigger !== 'manual');
  if (!templates.length) return { ...out, skipped: 'no automations' };
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
  const [detail, units, done, issues] = await Promise.all([
    fetchReservationDetail(creds, reservationId),
    sql`SELECT id::text AS id, name FROM units WHERE account_id = 1` as Promise<{ id: string; name: string }[]>,
    checkinsOf(sql, [reservationId]),
    issuesOf(sql, [reservationId]),
  ]);
  const due = await chargesDueOf(sql, [reservationId]);
  const stay = detail ? stayFromDetail(detail, new Map(units.map(u => [u.id, u.name]))) : null;
  if (!stay) return { ...out, skipped: 'Hostaway does not know this reservation' };
  stay.checkinDoneAt = done.get(reservationId) ?? null;
  stay.issue = issues.has(reservationId);
  stay.chargeDue = due.has(reservationId);
  if (templates.some(t => t.conditions.some(c => c.startsWith('open_')))) await openAfterOf(sql, [stay]);
  await createDue(sql, env, creds, stay, templates, await autoLog(sql, [reservationId]), now, out, PER_TICK);
  return out;
}

/**
 * The clock's pass (/api/slack-cron?job=messages, every 5 minutes): first what a person scheduled and is now due, then
 * the automations whose moment has come. A handful per pass — a Pages Function may make 50 subrequests, and
 * the next pass is five minutes away. With nothing scheduled and no automation it costs two queries.
 */
export async function runDue(sql: SqlFn, env: Env, now = new Date()) {
  const out = { sent: 0, staged: 0, failed: 0, retrying: 0, created: 0, skipped: '' };
  const due = await (sql`SELECT id::text AS id, reservation_id, conversation_id, channel, body, attempts, source, via FROM guest_messages
                          WHERE account_id = 1 AND status = 'scheduled' AND send_at <= now() ORDER BY send_at LIMIT ${PER_TICK}` as Promise<Deliverable[]>)
    .catch(() => sql`SELECT id::text AS id, reservation_id, conversation_id, channel, body, attempts, source FROM guest_messages
                      WHERE account_id = 1 AND status = 'scheduled' AND send_at <= now() ORDER BY send_at LIMIT ${PER_TICK}` as Promise<Deliverable[]>)
    .catch(() => null);
  if (due === null) return { ...out, skipped: 'migration 116 has not run' };
  for (const r of due) count(out, (await deliver(sql, env, r)).status);

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
  // A check-in finished in the last hours for a stay still far away is in neither list: the safety net for a
  // `fireStay` that did not get through (Hostaway down at that moment). A few per pass, each one a Hostaway call.
  if (templates.some(t => t.trigger === 'checkin_done')) {
    const recent = await (sql`SELECT reservation_id FROM guest_checkins WHERE account_id = 1 AND completed_at > now() - make_interval(hours => ${GRACE_HOURS})
                               ORDER BY completed_at DESC LIMIT 20` as Promise<{ reservation_id: string }[]>).catch(() => []);
    for (const r of recent.filter(x => !stays.some(s => s.reservationId === x.reservation_id)).slice(0, 3)) {
      const d = await fetchReservationDetail(creds, r.reservation_id).catch(() => null), s = d ? stayFromDetail(d, names) : null;
      if (s) stays.push(s);
    }
  }
  if (!stays.length) return out;
  const ids = stays.map(s => s.reservationId);
  const [log, done, issues, unpaid] = await Promise.all([autoLog(sql, ids), checkinsOf(sql, ids), issuesOf(sql, ids), chargesDueOf(sql, ids),
    templates.some(t => t.conditions.some(c => c.startsWith('open_'))) ? openAfterOf(sql, stays) : null]);
  for (const s of stays) {
    if (room <= 0) break;
    s.checkinDoneAt = done.get(s.reservationId) ?? null;
    s.issue = issues.has(s.reservationId);
    s.chargeDue = unpaid.has(s.reservationId);
    room -= await createDue(sql, env, creds, s, templates, log.filter(l => l.reservation_id === s.reservationId), now, out, room);
  }
  return out;
}
