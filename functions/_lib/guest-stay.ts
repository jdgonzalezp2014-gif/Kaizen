/**
 * The guest portal's real door (Phase 2 of docs/roadmap.md, owner 2026-11-23): /guest/<reservation>.<sig> reads the stay
 * from Hostaway and keeps the online check-in on the server (guest_flows, migration 123).
 *
 *   GET  /api/report-link?stay=<res>.<sig>               → { stay, flow, entry }  (the stay as the portal shows it)
 *   GET  /api/report-link?stay=<res>.<sig>&photo=<id>    → an arrival-guide photo, only once the entry is open
 *   POST /api/report-link?stay=<res>.<sig>  { flow }     → saves the guest's answers, answers like GET
 *
 * The rules the page cannot bend: the ID check and the payment count only when Stripe says so (guest-pay.ts writes
 * identity_ok / paid_ok); the address, Wi-Fi, arrival steps and door code leave the server only when `entry()` opens
 * (every required step + the release time). When the steps are all done the stay gets its guest_checkins row (source
 * 'portal') and its "After online check-in" automations run. "Request a change" becomes a to-do for the team.
 * Same public door as the other guest links (report-link), so no new Access bypass; the signature is the credential.
 */
import { getCredentials, type SqlFn } from './accounts.ts';
import type { Env } from './db.ts';
import { fetchReservationDetail } from './hostaway.ts';
import { verifyGuest } from './guest-link.ts';
import { guestHouse } from '../api/guest-guide.ts';
import { guidePhoto } from './guest-demo.ts';
import { fireStay } from './guest-outbox.ts';
import { mirrorTodos } from './inventory.ts';
import { todayIn } from '../../src/lib/dates.ts';
import { doneFlow, doorCodeFor, entry, protectionFor, steps, type Flow } from '../../src/lib/guest-checkin.ts';
import { nights, type GuestStay } from '../../src/lib/guest-portal.ts';
import { cleanFlow, isLive, lockedStay, stayFrom, testReservation } from '../../src/lib/guest-stay.ts';

const no = (message: string, status = 403) => Response.json({ ok: false, message }, { status, headers: { 'Cache-Control': 'no-store' } });
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;

/** "<reservation>.<sig>" → the reservation id, or null when the signature is not this account's. */
export async function stayId(ek: string, token: string | null | undefined): Promise<string | null> {
  const m = /^(\d{1,20})\.([A-Za-z0-9_-]{6,64})$/.exec(token ?? '');
  return m && await verifyGuest(ek, m[1]!, m[2]!) ? m[1]! : null;
}

type FlowRow = { flow: unknown; identity_ok: boolean; paid_ok: boolean; paid_total: string | null; pay_session: string | null; change_todo: string | null };

export interface Loaded {
  stay: GuestStay; flow: Flow; open: boolean; listingId: string; reservation: Record<string, unknown>; row: FlowRow | null; label: string;
}

/** Everything the door knows about one stay right now. A string is why it cannot be served. */
export async function loadStay(sql: SqlFn, env: Env, id: string, now = new Date(), defer?: (p: Promise<unknown>) => void): Promise<Loaded | string> {
  const test = testReservation(id);
  const r = test ?? await fetchReservationDetail(await getCredentials(sql, env.ENCRYPTION_KEY), id).catch(() => null);
  if (!r) return 'We could not find this reservation — message us and we will help.';
  if (!isLive(r.status)) return 'This reservation is no longer active. If that looks wrong, message us.';
  const listingId = String(r.listingMapId ?? '');
  const house = listingId ? await guestHouse(sql, listingId, env.ENCRYPTION_KEY, { arrival: str(r.arrivalDate), departure: str(r.departureDate) }) : null;
  if (!house) return 'This home is not set up for online check-in yet — message us and we will help.';
  const [rows, checkins] = await Promise.all([
    sql`SELECT flow, identity_ok, paid_ok, paid_total::text, pay_session, change_todo FROM guest_flows WHERE account_id = 1 AND reservation_id = ${id}` as Promise<FlowRow[]>,
    sql`SELECT source FROM guest_checkins WHERE account_id = 1 AND reservation_id = ${id}`.catch(() => []) as Promise<{ source: string }[]>,
  ]);
  let row = rows[0] ?? null;
  // The payment reported by Stripe's webhook while the page was closed (guest_payments is written either way).
  if (row?.pay_session && !row.paid_ok) {
    const [p] = await sql`SELECT amount::text FROM guest_payments WHERE account_id = 1 AND session_id = ${row.pay_session} AND status IN ('held', 'paid')` as { amount: string }[];
    if (p) {
      await sql`UPDATE guest_flows SET paid_ok = true, paid_total = ${p.amount}, updated_at = now() WHERE account_id = 1 AND reservation_id = ${id}`;
      row = { ...row, paid_ok: true, paid_total: p.amount };
    }
  }
  const checkedIn = checkins.length > 0;
  const doorCode = doorCodeFor(house.lockType, house.guestCode, str(r.doorCode));
  const stay = stayFrom(r, house, { checkedIn, doorCode });
  if (!stay) return 'This reservation has no dates yet — message us and we will help.';
  // A stay the team marked as checked in (the Inbox) is done: nothing is asked again.
  const marked = checkins.some(c => c.source === 'team');
  const flow = marked ? { ...doneFlow(), protection: cleanFlow(row?.flow, { identity: true, paid: true }).protection ?? 'waiver' }
    : cleanFlow(row?.flow, { identity: !!row?.identity_ok, paid: !!row?.paid_ok, paidTotal: row?.paid_total ? Number(row.paid_total) : null });
  const prot = protectionFor(stay.unitType ?? 'house', stay.protection ?? {}, nights(stay));
  const e = entry(flow, stay, prot, now);
  const stepsDone = e.open || e.why === 'release';
  if (stepsDone && !checkedIn) {
    // Done = the event the "After online check-in" automations wait for (the door-code message): it runs now.
    const [ins] = await (sql`INSERT INTO guest_checkins (account_id, reservation_id, listing_id, source, marked_by)
                             VALUES (1, ${id}, ${listingId}, 'portal', 'guest') ON CONFLICT DO NOTHING RETURNING reservation_id` as Promise<unknown[]>).catch(() => []);
    // A test stay has no Hostaway conversation: the "After online check-in" messages are not sent.
    if (ins && !test) { const job = fireStay(sql, env, id).catch(() => null); if (defer) defer(job); else await job; }
  }
  const label = `${stay.guest?.name ?? stay.guestFirst} · ${stay.unitName} · ${stay.arrival} → ${stay.departure}`;
  return { stay: e.open ? stay : lockedStay(stay), flow, open: e.open, listingId, reservation: r, row, label };
}

const answer = (l: Loaded) => Response.json({ ok: true, stay: l.stay, flow: l.flow, open: l.open,
  steps: steps(l.flow, l.stay, protectionFor(l.stay.unitType ?? 'house', l.stay.protection ?? {}, nights(l.stay))).map(s => ({ key: s.key, done: s.done })) },
  { headers: { 'Cache-Control': 'no-store' } });

export async function stayGet(sql: SqlFn, env: Env, url: URL, defer?: (p: Promise<unknown>) => void): Promise<Response> {
  const id = await stayId(env.ENCRYPTION_KEY, url.searchParams.get('stay'));
  if (!id) return no('This stay link is not valid.');
  const l = await loadStay(sql, env, id, new Date(), defer).catch(e => e instanceof Error && /guest_flows/.test(e.message) ? 'Online check-in is not switched on yet.' : `Could not load your stay — try again. (${e instanceof Error ? e.message.slice(0, 80) : ''})`);
  if (typeof l === 'string') return no(l, 404);
  const photo = url.searchParams.get('photo');
  if (photo) return l.open ? guidePhoto(sql, env.ENCRYPTION_KEY, l.listingId, photo) : new Response('Opens after check-in.', { status: 403 });
  return answer(l);
}

/** The guest's answers. A new "Request a change" text becomes one to-do on the stay (owner: the team confirms with the guest). */
export async function stayPost(sql: SqlFn, env: Env, request: Request, defer?: (p: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url);
  const id = await stayId(env.ENCRYPTION_KEY, url.searchParams.get('stay'));
  if (!id) return no('This stay link is not valid.');
  const b = await request.json().catch(() => null) as { flow?: unknown } | null;
  const before = await loadStay(sql, env, id);
  if (typeof before === 'string') return no(before, 404);
  const f = cleanFlow(b?.flow, { identity: false, paid: false });
  // Stored without identity / paid: those columns are Stripe's.
  const { identity: _i, paid: _p, paidTotal: _t, ...answers } = f;
  await sql`INSERT INTO guest_flows (account_id, reservation_id, listing_id, flow) VALUES (1, ${id}, ${before.listingId}, ${JSON.stringify(answers)}::jsonb)
            ON CONFLICT (account_id, reservation_id) DO UPDATE SET flow = EXCLUDED.flow, listing_id = EXCLUDED.listing_id, updated_at = now()`;
  const prev = before.row ? cleanFlow(before.row.flow, { identity: false, paid: false }).changeAsk : null;
  // A new text, or one whose to-do was never made (a failed insert must not lose the guest's ask).
  if (f.changeAsk && (f.changeAsk !== prev || !before.row?.change_todo)) {
    const [t] = await sql`INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority, due_on, reservation_id, reservation_label)
                          VALUES (1, ${`Guest asked for a change: ${f.changeAsk}`.slice(0, 300)},
                                  ${`From the online check-in (guest portal). Confirm with the guest, then fix the booking.\n\n${before.label}\n\n"${f.changeAsk}"`},
                                  ${before.listingId ? [before.listingId] : []}, 'Guest portal', 'task', 'pending', 'high', ${todayIn('America/New_York')}::date, ${id}, ${before.label})
                          RETURNING id::text AS id` as { id: string }[];
    if (t) {
      await sql`UPDATE guest_flows SET change_todo = ${t.id} WHERE account_id = 1 AND reservation_id = ${id}`;
      const job = mirrorTodos(sql, env.ENCRYPTION_KEY, [t.id], 'Guest portal').catch(() => {});
      if (defer) defer(job); else await job;
    }
  }
  const l = await loadStay(sql, env, id, new Date(), defer);
  return typeof l === 'string' ? no(l, 404) : answer(l);
}

/** For guest-pay.ts: Stripe confirmed something for this stay. */
export async function markStay(sql: SqlFn, id: string, listingId: string | null, set: { identityVs?: string; identityOk?: boolean; paySession?: string; paidTotal?: number }) {
  await sql`INSERT INTO guest_flows (account_id, reservation_id, listing_id) VALUES (1, ${id}, ${listingId}) ON CONFLICT DO NOTHING`;
  if (set.identityVs) await sql`UPDATE guest_flows SET identity_vs = ${set.identityVs}, updated_at = now() WHERE account_id = 1 AND reservation_id = ${id}`;
  if (set.identityOk) await sql`UPDATE guest_flows SET identity_ok = true, updated_at = now() WHERE account_id = 1 AND reservation_id = ${id}`;
  if (set.paySession) await sql`UPDATE guest_flows SET pay_session = ${set.paySession}, updated_at = now() WHERE account_id = 1 AND reservation_id = ${id}`;
  if (set.paidTotal != null) await sql`UPDATE guest_flows SET paid_ok = true, paid_total = ${set.paidTotal}, updated_at = now() WHERE account_id = 1 AND reservation_id = ${id}`;
}
