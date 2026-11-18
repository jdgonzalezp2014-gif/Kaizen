/**
 * Hostaway's conversations (Guest Services → Inbox, 2026-11-16). Read on 2026-11-16 against the live account:
 *   GET /conversations?limit&offset&includeResources=1 — newest activity first; each carries its `Reservation`
 *       (dates, status, guest, phone) and its last message in `conversationMessages` — one call draws the whole list.
 *   GET /conversations?reservationId=<id> — the stay's conversation.
 *   GET /conversations/<id>/messages — `isIncoming` 1/0, `date` in UTC, `communicationType` (channel, email, sms…).
 *   POST /conversations/<id>/messages { body, communicationType } — NOT yet exercised: nothing has been sent to a
 *       real guest from here. It only runs when the account's guest messages are ON (guest-outbox.ts).
 */
import { getAccessToken, type HostawayCredentials } from './hostaway.ts';
import { hostawayIso, paidOf, preview, signedOf, type InboxRow, type ThreadMsg } from '../../src/lib/inbox.ts';

const BASE = 'https://api.hostaway.com/v1';
type Raw = Record<string, unknown>;
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
const id = (v: unknown) => v == null || v === '' ? null : String(v);
const day = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
const hour = (v: unknown) => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n >= 0 && n <= 23 ? n : null; };

async function get(creds: HostawayCredentials, path: string): Promise<Raw[]> {
  const token = await getAccessToken(creds);
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Hostaway ${res.status} on ${path.split('?')[0]}`);
  const j = await res.json() as { result?: unknown };
  return Array.isArray(j.result) ? j.result as Raw[] : j.result ? [j.result as Raw] : [];
}

/**
 * The list's last message comes as Hostaway stored it: for one of its automated messages that is the raw template
 * ("Hey {{guest_name}} , …") — the guest got it filled (the thread shows so, checked 2026-11-16). The preview fills
 * the name and drops the other blanks, so a row never looks like a broken message.
 */
const plain = (body: string, guest: string) => body
  .replace(/\{\{\s*guest_(first_)?name\s*\}\}/gi, guest.split(/\s+/)[0] ?? guest).replace(/\{\{[^}]*\}\}/g, '…');

/** A conversation with its stay — and the guest's phone, which never leaves the server. */
export type ConversationRow = Omit<InboxRow, 'tasks' | 'scheduled'> & { phone: string | null; type: string };

function rowOf(c: Raw): ConversationRow {
  const r = (c.Reservation && typeof c.Reservation === 'object' ? c.Reservation : {}) as Raw;
  const last = (Array.isArray(c.conversationMessages) ? c.conversationMessages[0] : null) as Raw | null;
  const sent = hostawayIso(c.messageSentOn), got = hostawayIso(c.messageReceivedOn);
  const lastAt = sent && got ? (sent > got ? sent : got) : sent ?? got;
  const guest = str(c.recipientName) ?? str(r.guestName) ?? 'Guest';
  return {
    conversationId: String(c.id), type: str(c.type) ?? '',
    reservationId: id(c.reservationId) ?? '', listingId: id(c.listingMapId), listing: str(r.listingName) ?? '',
    guest, photo: str(c.recipientPicture) ?? str(r.guestPicture),
    channel: str(r.channelName) ?? str(r.source) ?? '', guests: Number(r.numberOfGuests) || null,
    arrival: day(r.arrivalDate), departure: day(r.departureDate), status: str(r.status) ?? (c.reservationId ? 'new' : 'inquiry'),
    checkInHour: hour(r.checkInTime), checkOutHour: hour(r.checkOutTime), bookedAt: hostawayIso(r.reservationDate),
    unread: Number(c.hasUnreadMessages) === 1, lastAt, lastIncoming: !!got && (!sent || got >= sent),
    preview: preview(plain(str(last?.body) ?? '', guest)), phone: str(r.phone),
    payment: str(r.paymentStatus), agreement: str(r.reservationAgreement), idVerified: Number(r.isGuestIdentityVerified) === 1,
    paid: paidOf(r.paymentStatus), signed: signedOf(r.reservationAgreement),
    // Only that there is one: the address stays in Hostaway, which is who sends the email.
    hasEmail: !!(str(c.recipientEmail) ?? str(r.guestEmail)),
  };
}

/** The inbox: the conversations with the latest activity, each with its stay. One Hostaway call per page of 50. */
export async function fetchConversations(creds: HostawayCredentials, limit = 50, offset = 0): Promise<ConversationRow[]> {
  return (await get(creds, `/conversations?limit=${limit}&offset=${offset}&includeResources=1`)).map(rowOf);
}

/** One stay's conversation — null when the guest and the host never wrote (a direct booking with no email thread). */
export async function fetchConversationOf(creds: HostawayCredentials, reservationId: string): Promise<ConversationRow | null> {
  const rows = await get(creds, `/conversations?reservationId=${encodeURIComponent(reservationId)}&limit=5&includeResources=1`);
  return rows.length ? rowOf(rows[0]!) : null;
}

export async function fetchConversation(creds: HostawayCredentials, conversationId: string): Promise<ConversationRow | null> {
  const rows = await get(creds, `/conversations/${encodeURIComponent(conversationId)}?includeResources=1`).catch(() => []);
  return rows.length ? rowOf(rows[0]!) : null;
}

export function messageOf(m: Raw): ThreadMsg {
  const incoming = Number(m.isIncoming) === 1;
  const st = str(m.status);
  return {
    id: `h${String(m.id)}`, at: hostawayIso(m.date) ?? hostawayIso(m.insertedOn) ?? new Date(0).toISOString(), incoming,
    body: str(m.body) ?? '', channel: 'hostaway', via: str(m.communicationType),
    status: incoming ? 'received' : st === 'failed' || st === 'error' ? 'failed' : st === 'scheduled' || st === 'pending' ? 'scheduled' : 'sent',
    images: Array.isArray(m.imagesUrls) ? m.imagesUrls.filter((u): u is string => typeof u === 'string' && u.startsWith('https://')).slice(0, 6) : [],
  };
}

/** A conversation's messages, oldest first. */
export async function fetchMessages(creds: HostawayCredentials, conversationId: string, limit = 100): Promise<ThreadMsg[]> {
  return (await get(creds, `/conversations/${encodeURIComponent(conversationId)}/messages?limit=${limit}`))
    .map(messageOf).filter(m => m.body || m.images?.length).sort((a, b) => a.at < b.at ? -1 : 1);
}

/** How a reply travels: the way the thread already talks (an Airbnb thread answers on the channel, a direct one by email). */
export function replyType(conversationType: string, thread: ThreadMsg[]): string {
  const last = [...thread].reverse().find(m => m.via);
  return last?.via ?? (conversationType === 'host-guest-email' ? 'email' : 'channel');
}

/** Send one message into a conversation. The caller has already decided this account sends for real. */
export async function sendMessage(creds: HostawayCredentials, conversationId: string, body: string, communicationType: string): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  try {
    const token = await getAccessToken(creds);
    const res = await fetch(`${BASE}/conversations/${encodeURIComponent(conversationId)}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, communicationType }), signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => ({})) as { status?: string; message?: string; result?: Raw };
    if (!res.ok || j.status === 'fail') return { ok: false, error: `Hostaway ${res.status}: ${String(j.message ?? '').slice(0, 200) || 'refused'}` };
    return { ok: true, id: id(j.result?.id) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
