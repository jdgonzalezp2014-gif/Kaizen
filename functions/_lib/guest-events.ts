/**
 * The guests' live events (Guest Services → Inbox, migration 117; owner, 2026-11-16).
 *
 * `takeEvent` — Hostaway's webhook, the moment a guest writes or a booking is made. The body is a hint: the
 * conversation is re-read from Hostaway before anything is believed. A guest's message becomes one `guest_events`
 * row, sorted by a light model (ai-chain's chat tier: does it ask for an answer? is it urgent?). Something urgent is
 * told to the team at once; a new booking runs its "After booking" automations at once.
 *
 * `watchPass` — the clock's look, every 5 minutes, at the messages still waiting: a guest who is coming or in the
 * house and has waited longer than the account allows is reported ONCE in Slack (the Escalations channel). No line
 * per message (owner: overwhelming) — and before reporting, the thread is read again: if the team answered from
 * Hostaway's own app, the event is closed instead.
 */
import { getCredentials, type SqlFn } from './accounts.ts';
import { askJson } from './ai-chain.ts';
import type { Env } from './db.ts';
import { fireStay, GUEST_TZ } from './guest-outbox.ts';
import { fetchConversation, fetchMessages } from './hostaway-messages.ts';
import { postTo, slackSetup } from './slack.ts';
import { readGuestAi, suggestFor } from './guest-ai.ts';
import { todayIn } from '../../src/lib/dates.ts';
import { STAGE_LABEL, awaitingReply, preview, stageOf } from '../../src/lib/inbox.ts';
import { eventFrom, stayOpen, toCheck, triageFrom, triagePrompt, watchFrom, watchMessage, type GuestWatch, type OpenEvent, type Triage } from '../../src/lib/guest-watch.ts';

export async function readWatch(sql: SqlFn): Promise<GuestWatch> {
  const rows = await (sql`SELECT guest_watch FROM accounts WHERE id = 1` as Promise<{ guest_watch: unknown }[]>).catch(() => []);
  return watchFrom(rows[0]?.guest_watch);
}

const inboxLink = (origin: string, conversationId: string) => `${origin}/?tab=inbox&c=${conversationId}`;

async function tellTeam(sql: SqlFn, env: Env, msg: ReturnType<typeof watchMessage>): Promise<boolean> {
  const s = await slackSetup(sql, env.ENCRYPTION_KEY);
  const r = await postTo(s, 'escalations', msg).catch(() => null);
  return !!r?.ok;
}

/**
 * One webhook call. Always answers what it did; only a database that is down is an error (Hostaway retries those).
 * `defer` (the request's waitUntil) lets the reply's draft be written after Hostaway has its answer.
 */
export async function takeEvent(sql: SqlFn, env: Env, payload: unknown, origin: string, defer?: (p: Promise<unknown>) => void) {
  const ev = eventFrom(payload);
  if (!ev) return { ok: true, took: 'ignored' };

  if (ev.kind === 'reservation') {
    // Only a new booking runs anything: "updated" fires for every price or note change, and the clock covers the rest.
    if (!/created/.test(ev.event) || !ev.reservationId) return { ok: true, took: 'ignored' };
    const fired = await fireStay(sql, env, ev.reservationId).catch(e => ({ skipped: e instanceof Error ? e.message : String(e) }));
    return { ok: true, took: 'booking', fired };
  }

  const conversationId = ev.conversationId!;
  if (!ev.incoming) {
    await sql`UPDATE guest_events SET answered_at = now() WHERE account_id = 1 AND kind = 'message' AND conversation_id = ${conversationId} AND answered_at IS NULL`;
    return { ok: true, took: 'answered' };
  }
  const [row] = await sql`INSERT INTO guest_events (account_id, kind, event, ext_id, reservation_id, conversation_id, listing_id, preview, msg_at)
                          VALUES (1, 'message', ${ev.event}, ${ev.extId}, ${ev.reservationId}, ${conversationId}, ${ev.listingId}, ${preview(ev.body, 200)}, ${ev.at})
                          ON CONFLICT DO NOTHING RETURNING id::text AS id` as { id: string }[];
  if (!row) return { ok: true, took: 'duplicate' };

  // The truth, from Hostaway: who the guest is, where the stay stands, what was said before.
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
  const [conv, thread, units, acct] = await Promise.all([
    fetchConversation(creds, conversationId).catch(() => null), fetchMessages(creds, conversationId, 12).catch(() => []),
    sql`SELECT id::text AS id, name FROM units WHERE account_id = 1` as Promise<{ id: string; name: string }[]>,
    sql`SELECT name FROM accounts WHERE id = 1` as Promise<{ name: string }[]>,
  ]);
  const today = todayIn(GUEST_TZ);
  const listing = units.find(u => u.id === (conv?.listingId ?? ev.listingId))?.name ?? conv?.listing ?? '';
  const stage = conv ? STAGE_LABEL[stageOf(conv, today)] : 'Unknown stay';
  const last = [...thread].reverse().find(m => m.incoming);
  const body = last?.body || ev.body;
  // Already answered by the time this ran (or the "message" was the host's): nothing waits.
  if (thread.length && !awaitingReply(thread)) {
    await sql`UPDATE guest_events SET answered_at = now(), guest = ${conv?.guest ?? null}, listing_id = COALESCE(listing_id, ${conv?.listingId ?? null}) WHERE id = ${row.id}`;
    return { ok: true, took: 'message', waiting: false };
  }
  let t: Triage = triageFrom(null), by = '';
  if (body) {
    const p = triagePrompt({ message: body, before: thread.slice(-7, -1).map(m => `${m.incoming ? 'GUEST' : 'HOST'}: ${m.body}`), stage, company: acct[0]?.name ?? 'the host' });
    const r = await askJson(sql, env, p.system, p.user, [], { tier: 'chat', log: false }).catch(() => null);
    if (r?.ok) { t = triageFrom(r.json); by = r.by; }
  }
  const watch = await readWatch(sql);
  const open = !conv || stayOpen(conv.departure, conv.status, today);
  let told = false;
  if (t.urgent && watch.watch && open) {
    told = await tellTeam(sql, env, watchMessage({ guest: conv?.guest ?? 'A guest', listing, stage, body, minutes: 0, urgent: true, why: t.why, link: inboxLink(origin, conversationId) }));
  }
  await sql`UPDATE guest_events SET guest = ${conv?.guest ?? null}, reservation_id = COALESCE(reservation_id, ${conv?.reservationId || null}),
                   listing_id = COALESCE(listing_id, ${conv?.listingId ?? null}), preview = ${preview(body, 200)},
                   needs_reply = ${by ? t.needsReply : null}, urgent = ${t.urgent}, why = ${t.why || null},
                   reminded_at = CASE WHEN ${told} THEN now() ELSE reminded_at END
             WHERE id = ${row.id}`;
  // Owner, 2026-11-23: the reply is drafted now, so it is waiting in the Inbox when someone opens the conversation.
  // Only when an answer is needed (no triage = needed) and the stay is still open.
  if ((by ? t.needsReply : true) && open) {
    const job = draftEvent(sql, env, row.id, conversationId).catch(() => null);
    if (defer) defer(job); else await job;
  }
  return { ok: true, took: 'message', waiting: t.needsReply, urgent: t.urgent, told, by };
}

type OpenRow = { id: string; conversation_id: string; reservation_id: string | null; guest: string | null; preview: string | null; created_at: string | Date;
  needs_reply: boolean | null; urgent: boolean; reminded_at: string | Date | null; checked_at: string | Date | null; why: string | null };
const iso = (d: string | Date | null) => d ? new Date(d).toISOString() : null;
const openOf = (r: OpenRow): OpenEvent => ({ id: r.id, conversationId: r.conversation_id, reservationId: r.reservation_id, guest: r.guest, preview: r.preview,
  createdAt: iso(r.created_at)!, needsReply: r.needs_reply, urgent: r.urgent, remindedAt: iso(r.reminded_at), checkedAt: iso(r.checked_at) });

/** The guest messages still waiting (a week back at most) — empty before migration 117. */
export async function openEvents(sql: SqlFn): Promise<(OpenEvent & { why: string | null })[]> {
  const rows = await (sql`SELECT id::text AS id, conversation_id, reservation_id, guest, preview, created_at, needs_reply, urgent, reminded_at, checked_at, why
                           FROM guest_events WHERE account_id = 1 AND kind = 'message' AND answered_at IS NULL AND conversation_id IS NOT NULL
                            AND created_at > now() - interval '7 days' ORDER BY id` as Promise<OpenRow[]>).catch(() => []);
  return rows.map(r => ({ ...openOf(r), why: r.why }));
}

/** The clock's look at who is still waiting. A few Hostaway reads per pass; nothing to do costs one query. */
export async function watchPass(sql: SqlFn, env: Env, origin: string, now = new Date()) {
  const out = { checked: 0, answered: 0, reminded: 0, left: 0 };
  const watch = await readWatch(sql);
  const due = toCheck(await openEvents(sql), now, watch);
  if (!due.length) return out;
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
  const today = todayIn(GUEST_TZ, now);
  const units = await sql`SELECT id::text AS id, name FROM units WHERE account_id = 1` as { id: string; name: string }[];
  for (const e of due) {
    out.checked++;
    const [conv, thread] = await Promise.all([fetchConversation(creds, e.conversationId).catch(() => null), fetchMessages(creds, e.conversationId, 12).catch(() => null)]);
    // Hostaway did not answer: look again on a later pass, report nothing on a guess.
    if (!thread) { await sql`UPDATE guest_events SET checked_at = now() WHERE id = ${e.id}`; continue; }
    const close = async () => sql`UPDATE guest_events SET answered_at = now() WHERE account_id = 1 AND kind = 'message' AND conversation_id = ${e.conversationId} AND answered_at IS NULL`;
    if (!awaitingReply(thread)) { await close(); out.answered++; continue; }
    if (conv && !stayOpen(conv.departure, conv.status, today)) { await close(); out.left++; continue; }
    const body = [...thread].reverse().find(m => m.incoming)?.body ?? e.preview ?? '';
    const told = await tellTeam(sql, env, watchMessage({
      guest: conv?.guest ?? e.guest ?? 'A guest', listing: units.find(u => u.id === conv?.listingId)?.name ?? conv?.listing ?? '',
      stage: conv ? STAGE_LABEL[stageOf(conv, today)] : '', body, minutes: (now.getTime() - Date.parse(e.createdAt)) / 60_000, urgent: e.urgent, why: '',
      link: inboxLink(origin, e.conversationId) }));
    // No Escalations channel in Slack: nothing was told — the event stays open for the Inbox's own count, and is not asked about again.
    await sql`UPDATE guest_events SET checked_at = now(), reminded_at = now() WHERE account_id = 1 AND kind = 'message' AND conversation_id = ${e.conversationId} AND answered_at IS NULL`;
    if (told) out.reminded++;
  }
  return out;
}

export type EventDraft = { reply: string; confidence: string; handoff: boolean; reason: string; sources: string[]; missing: string; by: string; sops: string[]; at: string }
  | { error: string; at: string };

/**
 * The AI's draft for a guest message, kept on its event (guest_events.draft, migration 122) — written once, shown in the
 * Inbox to send or dismiss; never sent from here (owner: "a draft that can be sent or not", 2026-11-23). An error is kept
 * too, so a failing model is not asked again every pass. Off when the account's AI or "Draft on arrival" is off.
 */
export async function draftEvent(sql: SqlFn, env: Env, eventId: string, conversationId: string): Promise<EventDraft | null> {
  const cfg = await readGuestAi(sql);
  if (cfg.mode === 'off' || !cfg.autoDraft) return null;
  // Claim it first: the webhook and the clock's catch-up must not both pay for the same draft.
  const claimed = await (sql`UPDATE guest_events SET draft = '{"pending":true}'::jsonb WHERE id = ${eventId} AND draft IS NULL RETURNING id` as Promise<unknown[]>).catch(() => []);
  if (!claimed.length) return null;
  const at = new Date().toISOString();
  const r = await suggestFor(sql, env, conversationId).catch(e => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
  const draft: EventDraft = r.ok ? { ...r.suggestion, by: r.by, sops: r.sops, at } : { error: r.error.slice(0, 300), at };
  await sql`UPDATE guest_events SET draft = ${JSON.stringify(draft)}::jsonb WHERE id = ${eventId}`;
  return draft;
}

/** The clock's catch-up: one waiting message with no draft yet (the webhook's draft failed to start or ran out of time). */
export async function draftPass(sql: SqlFn, env: Env) {
  const rows = await (sql`SELECT id::text AS id, conversation_id FROM guest_events
                           WHERE account_id = 1 AND kind = 'message' AND answered_at IS NULL AND needs_reply IS NOT FALSE AND draft IS NULL
                             AND conversation_id IS NOT NULL AND created_at > now() - interval '6 hours'
                           ORDER BY id DESC LIMIT 1` as Promise<{ id: string; conversation_id: string }[]>).catch(() => []);
  // A draft claimed but never finished (the request died) is retried after 15 minutes.
  await sql`UPDATE guest_events SET draft = NULL WHERE account_id = 1 AND draft = '{"pending":true}'::jsonb AND answered_at IS NULL
              AND created_at > now() - interval '6 hours' AND created_at < now() - interval '15 minutes'`.catch(() => {});
  const r = rows[0];
  if (!r) return { drafted: 0 };
  const d = await draftEvent(sql, env, r.id, r.conversation_id);
  return { drafted: d && !('error' in d) ? 1 : 0, error: d && 'error' in d ? d.error : undefined };
}

/** The newest finished draft still waiting in a conversation (null before migration 122, or when none). */
export async function draftOf(sql: SqlFn, conversationId: string): Promise<EventDraft | null> {
  const rows = await (sql`SELECT draft FROM guest_events WHERE account_id = 1 AND kind = 'message' AND conversation_id = ${conversationId}
                           AND answered_at IS NULL AND draft IS NOT NULL AND NOT (draft ? 'pending') ORDER BY id DESC LIMIT 1` as Promise<{ draft: EventDraft }[]>).catch(() => []);
  return rows[0]?.draft ?? null;
}
