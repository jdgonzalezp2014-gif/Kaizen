/**
 * Upsells carried out from the team's side (owner, 2026-11-19, §178 + round 2; pure rules in src/lib/upsell-charge.ts).
 *
 *  GET  /api/upsell-charge?claim=<id>                 → the plan: the stay (channel, dates, hours), free nights, methods, charges
 *  POST /api/upsell-charge { action: 'create', … }    → a pending charge: card (its pay link) or rc (asked in Airbnb's RC)
 *  POST /api/upsell-charge { action: 'received', id } → RC money came in: settle it (and set Hostaway up)
 *  POST /api/upsell-charge { action: 'cancel', id }   → not wanted any more (nothing was applied: only the Stripe page expires)
 *  GET  /api/report-link?pay=<id>.<sig>[&go=1|&done=<cs>]  → the guest's pay page (public door, no sign-in)
 *  GET  /api/report-link?charges=<res>.<sig>           → the stay's pending payments, for the portal page
 *  POST /api/slack-cron?job=charges                    → the sweep: finished Stripe pages nobody reported (no webhook yet)
 *
 * Nothing moves in Hostaway before the money (owner): creating a charge only checks that what it sells is possible
 * now; the nights / the hour are applied by charge-settle.ts once the payment is confirmed. The pay page checks again
 * before opening Stripe (the reservation still on, the nights still free), so a guest is not taken to pay for nights
 * that went meanwhile.
 *
 * Unlike the portal's own checkout (guest-pay.ts, sandbox only because its lines come from the page), the amount here
 * is set by a signed-in team member and kept on the server, so whichever Stripe mode is saved is used.
 */
import type { SqlFn } from './accounts.ts';
import { getCredentials } from './accounts.ts';
import { fetchCalendar, fetchReservationDetail, fetchStandardHours } from './hostaway.ts';
import { stripeCall, stripeKey } from './payouts.ts';
import { recordSession } from './guest-pay.ts';
import { signCharge, signGuest, verifyCharge, verifyGuest } from './guest-link.ts';
import { saveCaseMoney } from './claim-money.ts';
import { settleCharge } from './charge-settle.ts';
import { notifyClaim } from './slack.ts';
import { rcCheckButtons } from '../../src/lib/slack.ts';
import { toCents } from '../../src/lib/payouts.ts';
import { encodeLines } from '../../src/lib/guest-payments.ts';
import { portalLink } from '../../src/lib/inbox.ts';
import { addDays, type DateStr } from '../../src/lib/dates.ts';
import { isUpsell } from '../../src/lib/claims.ts';
import { AIRBNB_RESOLUTION, airbnbLinks, chargeLabel, extraNights, freeAround, hourOptions, isAirbnb, itemOf, methodsFor, needOf, payGuestText, rcGuestText,
  type ChargeMethod, type ChargeNeed, type NightDay, type UpsellCharge } from '../../src/lib/upsell-charge.ts';

type Fail = { ok: false; message: string; status?: number };
const fail = (message: string, status = 400): Fail => ({ ok: false, message, status });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
const wholeHour = (v: unknown) => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n >= 0 && n <= 23 ? n : null; };
const CANCELLED = /cancel|declin|expir/i;

/** Where the guest's links live: the portal's own domain when set (no Access in front), else this host. */
async function portalBase(sql: SqlFn): Promise<string | null> {
  const [a] = await (sql`SELECT guest_portal_url AS url FROM accounts WHERE id = 1` as Promise<{ url: string | null }[]>).catch(() => []);
  return (a?.url ?? '').trim() || null;
}
async function linkBase(sql: SqlFn, origin: string): Promise<string> {
  const u = await portalBase(sql);
  try { return u ? new URL(u).origin : origin; } catch { return origin; }
}
const payPath = async (ek: string, id: string) => `/api/report-link?pay=${id}.${await signCharge(ek, id)}`;

type ClaimRow = { id: string; category: string | null; status: string; reservation_id: string | null; unit_id: string | null; unit_name: string | null };
async function claimOf(sql: SqlFn, id: string): Promise<ClaimRow | null> {
  const [c] = await sql`SELECT c.id::text AS id, c.category, c.status, c.reservation_id, c.unit_id, u.name AS unit_name
                          FROM claims c LEFT JOIN units u ON u.account_id = c.account_id AND u.id = c.unit_id
                         WHERE c.account_id = 1 AND c.id::text = ${id} AND c.deleted_at IS NULL` as ClaimRow[];
  return c ?? null;
}

type ChargeRow = { id: string; claim_id: string; reservation_id: string; label: string; amount: number; status: UpsellCharge['status']; need: ChargeNeed;
  method: ChargeMethod; nights: string[]; hour: number | null; holds: string[]; apply_error: string | null; refunded: number; created_by: string;
  created_at: string; paid_at: string | null; livemode: boolean; session_id: string | null; unit_id: string | null; unit_name: string | null;
  guest: string | null; guest_email: string | null; item: string };
// One column list, four readers (Neon's tagged template cannot splice a fragment).
const chargeById = async (sql: SqlFn, id: string) => (await sql`SELECT id::text AS id, claim_id::text AS claim_id, reservation_id, label, amount::float8 AS amount, status, need, method, nights, hour, holds, apply_error, refunded::float8 AS refunded, created_by, created_at, paid_at, livemode, session_id, unit_id, unit_name, guest, guest_email, item
  FROM upsell_charges WHERE account_id = 1 AND id::text = ${id}` as unknown as ChargeRow[])[0] ?? null;
const chargesOfClaim = (sql: SqlFn, claimId: string) => sql`SELECT id::text AS id, claim_id::text AS claim_id, reservation_id, label, amount::float8 AS amount, status, need, method, nights, hour, holds, apply_error, refunded::float8 AS refunded, created_by, created_at, paid_at, livemode, session_id, unit_id, unit_name, guest, guest_email, item
  FROM upsell_charges WHERE account_id = 1 AND claim_id::text = ${claimId} ORDER BY id DESC` as unknown as Promise<ChargeRow[]>;
const chargesOfStay = (sql: SqlFn, resId: string) => sql`SELECT id::text AS id, claim_id::text AS claim_id, reservation_id, label, amount::float8 AS amount, status, need, method, nights, hour, holds, apply_error, refunded::float8 AS refunded, created_by, created_at, paid_at, livemode, session_id, unit_id, unit_name, guest, guest_email, item
  FROM upsell_charges WHERE account_id = 1 AND reservation_id = ${resId} AND status <> 'cancelled' ORDER BY id` as unknown as Promise<ChargeRow[]>;
const pendingSessions = (sql: SqlFn) => sql`SELECT id::text AS id, session_id FROM upsell_charges
  WHERE account_id = 1 AND status = 'pending' AND method = 'card' AND session_id IS NOT NULL ORDER BY id LIMIT 5` as unknown as Promise<{ id: string; session_id: string }[]>;

async function shapeCharge(ek: string, base: string, r: ChargeRow): Promise<UpsellCharge> {
  return { id: r.id, claimId: r.claim_id, reservationId: r.reservation_id, label: r.label, amount: Number(r.amount), status: r.status, method: r.method,
    payUrl: r.status === 'pending' && r.method === 'card' ? base + await payPath(ek, r.id) : null, nights: r.nights ?? [], hour: r.hour, need: r.need,
    holds: r.holds ?? [], applyError: r.apply_error, refunded: Number(r.refunded) || 0, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(),
    paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null, livemode: r.livemode };
}

/** The stay as the charge needs it, read from Hostaway (the truth — never the board's copy). */
interface StayFacts {
  reservationId: string; channel: string; airbnb: boolean; listingId: string | null; arrival: DateStr | null; departure: DateStr | null;
  checkInHour: number | null; checkOutHour: number | null; guest: string | null; email: string | null; code: string | null; status: string;
}
async function stayOf(sql: SqlFn, ek: string, resId: string): Promise<StayFacts | null> {
  const creds = await getCredentials(sql, ek);
  const r = await fetchReservationDetail(creds, resId);
  if (!r) return null;
  const listingId = r.listingMapId != null ? String(r.listingMapId) : null;
  let cin = wholeHour(r.checkInTime), cout = wholeHour(r.checkOutTime);
  if ((cin == null || cout == null) && listingId) {
    const std = await fetchStandardHours(creds, listingId).catch(() => null);
    cin ??= std?.checkInTime ?? null; cout ??= std?.checkOutTime ?? null;
  }
  const channel = String(r.channelName ?? '');
  return { reservationId: resId, channel, airbnb: isAirbnb(channel), listingId,
    arrival: DAY.test(String(r.arrivalDate)) ? String(r.arrivalDate) : null, departure: DAY.test(String(r.departureDate)) ? String(r.departureDate) : null,
    checkInHour: cin, checkOutHour: cout, guest: str(r.guestName), email: str(r.guestEmail),
    code: str(r.confirmationCode) ?? /-confirmation-([A-Z0-9]+)$/.exec(String(r.channelReservationId ?? ''))?.[1] ?? null, status: String(r.status ?? '') };
}

/** The nights around the stay (a week each side), as the calendar has them now. */
async function nightsAround(sql: SqlFn, ek: string, s: StayFacts): Promise<NightDay[]> {
  if (!s.listingId || !s.arrival || !s.departure) return [];
  const creds = await getCredentials(sql, ek);
  return (await fetchCalendar(creds, s.listingId, addDays(s.arrival, -7), addDays(s.departure, 7)))
    .map(d => ({ date: d.date, available: d.available, price: d.price }));
}

export async function chargePlan(sql: SqlFn, ek: string, origin: string, claimId: string) {
  const c = await claimOf(sql, claimId);
  if (!c) return fail('That case is gone.', 404);
  if (!isUpsell(c.category)) return fail('Only an upsell is charged.');
  const base = await linkBase(sql, origin);
  const charges = await Promise.all((await chargesOfClaim(sql, claimId)).map(r => shapeCharge(ek, base, r)));
  const need = needOf(c.category);
  const none = { ok: true as const, need, stay: null, free: null, nightDays: [], charges, links: null, methods: [] as ChargeMethod[] };
  if (!c.reservation_id) return none;
  const stay = await stayOf(sql, ek, c.reservation_id);
  if (!stay) return { ...none, message: 'Hostaway did not return this reservation.' };
  // Airbnb paid outside blocks the calendar too (owner), so every channel needs the nights around the stay.
  const nightDays = need === 'nights' ? await nightsAround(sql, ek, stay) : [];
  const free = stay.arrival && stay.departure ? freeAround(nightDays, stay.arrival, stay.departure) : { before: 0, after: 0 };
  return { ok: true as const, need, charges, nightDays, free, methods: methodsFor(stay.airbnb),
    stay: { channel: stay.channel, airbnb: stay.airbnb, arrival: stay.arrival, departure: stay.departure, checkInHour: stay.checkInHour,
            checkOutHour: stay.checkOutHour, guest: stay.guest, cancelled: CANCELLED.test(stay.status) },
    links: stay.airbnb ? airbnbLinks(stay.code) : null };
}

export interface CreateBody { claim?: unknown; amount?: unknown; before?: unknown; after?: unknown; hour?: unknown; method?: unknown }

export async function createCharge(sql: SqlFn, ek: string, origin: string, b: CreateBody, who: string) {
  const claimId = String(b.claim ?? '');
  const c = await claimOf(sql, claimId);
  if (!c) return fail('That case is gone.', 404);
  if (!isUpsell(c.category)) return fail('Only an upsell is charged.');
  if (!c.reservation_id) return fail('Pick the stay first (✎ Edit claim → Stay).');
  const amount = Math.round(Number(b.amount) * 100) / 100;
  if (!(amount > 0) || amount > 5000) return fail('The amount is dollars, above zero (at most $5,000).');
  const stay = await stayOf(sql, ek, c.reservation_id);
  if (!stay) return fail('Hostaway did not return this reservation.', 502);
  if (CANCELLED.test(stay.status)) return fail(`The reservation is ${stay.status} in Hostaway.`);
  const method: ChargeMethod = b.method === 'rc' ? 'rc' : 'card';
  if (!methodsFor(stay.airbnb).includes(method)) return fail('The Resolution Center is Airbnb’s — this booking pays by card.');
  const need = needOf(c.category);

  // What it sells must be possible now; it is applied in Hostaway only once paid (charge-settle.ts).
  let nights: DateStr[] = [];
  let hour: number | null = null;
  if (need === 'nights') {
    if (!stay.listingId || !stay.arrival || !stay.departure) return fail('The reservation has no listing or dates in Hostaway.');
    const before = Math.max(0, Math.min(7, Math.floor(Number(b.before) || 0))), after = Math.max(0, Math.min(7, Math.floor(Number(b.after) || 0)));
    if (!before && !after) return fail('How many nights — before the arrival or after the departure?');
    const free = freeAround(await nightsAround(sql, ek, stay), stay.arrival, stay.departure);
    if (before > free.before || after > free.after) return fail(`Not free: ${free.before} night(s) open before, ${free.after} after.`, 409);
    nights = extraNights(stay.arrival, stay.departure, before, after);
  }
  if (need === 'checkin' || need === 'checkout') {
    const stayHour = need === 'checkin' ? stay.checkInHour : stay.checkOutHour;
    const h = wholeHour(b.hour);
    if (stayHour == null) return fail('Hostaway has no standard hour for this stay — set it in Hostaway first.');
    if (h == null || !hourOptions(need, stayHour).includes(h)) return fail('Pick the new hour.');
    hour = h;
  }

  const label = chargeLabel(c.category!, { nights, hour });
  const k = await stripeKey(sql, ek).catch(() => null);
  if (method === 'card' && !k) return fail('Stripe is not set up (Settings → Integrations → Stripe) — there is no card link to make.', 503);
  let row: { id: string } | undefined;
  try {
    [row] = await sql`
      INSERT INTO upsell_charges (account_id, claim_id, reservation_id, unit_id, unit_name, guest, guest_email, need, label, item, amount, nights, hour, method, livemode, created_by)
      VALUES (1, ${claimId}::bigint, ${c.reservation_id}, ${stay.listingId ?? c.unit_id}, ${c.unit_name}, ${stay.guest}, ${stay.email}, ${need}, ${label},
              ${itemOf(c.category!)}, ${amount}, ${nights}, ${hour}, ${method}, ${method === 'rc' || k?.mode === 'live'}, ${who})
      RETURNING id::text AS id` as { id: string }[];
  } catch {
    // The one-pending-per-case index (121): someone made one a moment ago.
    return fail('This case already has a pending charge — cancel it first.', 409);
  }
  await saveCaseMoney(sql, claimId, method === 'rc' ? { requested: amount, collectedVia: 'Resolution Center' } : { requested: amount }, who);
  const then = need === 'nights' ? ' — the nights are set up in Hostaway once it is paid' : hour != null ? ' — the hour is set in Hostaway once it is paid' : '';
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'claim', ${claimId}, 'note', ${`${method === 'rc' ? 'Asked through the Resolution Center' : 'Card pay link made'}: ${label} $${amount.toFixed(2)}${then}.`}, ${who})`;
  if (method === 'rc') return { ok: true as const, method, id: row!.id, guestText: rcGuestText(label, amount), links: airbnbLinks(stay.code), warning: null };
  const url = (await linkBase(sql, origin)) + await payPath(ek, row!.id);
  const stayPage = portalLink(await portalBase(sql), c.reservation_id, await signGuest(ek, c.reservation_id));
  return { ok: true as const, method, id: row!.id, url, guestText: payGuestText(label, amount, url, stayPage),
    warning: k?.mode === 'test' ? 'Stripe is in test mode: the link takes test cards only; a test payment is not income and changes nothing in Hostaway.' : null };
}

/** The team saw the Resolution Center money come in: settle it (case Paid, then Hostaway set up). */
export async function rcReceived(sql: SqlFn, ek: string, id: string, amount: unknown, who: string) {
  const r = await chargeById(sql, id);
  if (!r) return fail('No such charge.', 404);
  if (r.method !== 'rc' || r.status !== 'pending') return fail('Only a pending Resolution Center request is marked received.');
  const got = amount === undefined || amount === '' ? Number(r.amount) : Math.round(Number(amount) * 100) / 100;
  if (!(got > 0) || got > 5000) return fail('What came in, in dollars.');
  const s = await settleCharge(sql, id, { via: 'rc', livemode: true, amount: got, by: who }, ek);
  return s.ok ? { ok: true as const } : fail(s.message ?? 'Not saved.', 409);
}

/**
 * "Not there" (owner, 2026-11-23): the team looked in Airbnb and the money is not in. The guest's "I already paid" is taken
 * back, so their stay page shows the request pending with its button again; a note says who looked.
 */
export async function rcNotThere(sql: SqlFn, id: string, who: string) {
  const r = await chargeById(sql, id);
  if (!r) return fail('No such charge.', 404);
  if (r.method !== 'rc' || r.status !== 'pending') return fail(`It is ${r.status} — nothing to check.`);
  await sql`DELETE FROM work_updates WHERE account_id = 1 AND subject = 'claim' AND subject_id::text = ${r.claim_id} AND kind = 'note' AND body LIKE ${`${SAID_PAID}%`}`;
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'claim', ${r.claim_id}, 'note', ${`Not in Airbnb yet: ${r.label} $${Number(r.amount).toFixed(2)} — the guest sees it pending again.`}, ${who})`;
  return { ok: true as const };
}

export async function cancelCharge(sql: SqlFn, ek: string, id: string, who: string) {
  const r = await chargeById(sql, id);
  if (!r) return fail('No such charge.', 404);
  if (r.status !== 'pending') return fail(`It is ${r.status} — nothing to cancel.`);
  // Claimed first, so a payment arriving now finds it cancelled (settleCharge only moves a pending one). Nothing was
  // applied in Hostaway yet — that only happens once paid — so there is nothing to undo there.
  const [took] = await sql`UPDATE upsell_charges SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${who}
                            WHERE account_id = 1 AND id::text = ${id} AND status = 'pending' RETURNING id` as { id: string }[];
  if (!took) return fail('It just changed — reload.', 409);
  const k = await stripeKey(sql, ek).catch(() => null);
  if (k && r.session_id) await stripeCall(k.key, 'POST', `/checkout/sessions/${r.session_id}/expire`).catch(() => null);
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'claim', ${r.claim_id}, 'note', ${`Charge cancelled: ${r.label} $${Number(r.amount).toFixed(2)}.`}, ${who})`;
  return { ok: true as const, notes: [] as string[] };
}

/**
 * The clock's sweep (owner: "build the logic; I'll set Stripe up later"): a guest who paid and closed the page before
 * coming back, with no webhook set, would leave the charge pending. Every pending card charge that has a Stripe page is
 * asked about; the first finished one is recorded (and set up). One a call — a setup is many requests.
 */
export async function sweepCharges(sql: SqlFn, ek: string) {
  const k = await stripeKey(sql, ek).catch(() => null);
  if (!k) return { checked: 0, settled: 0 };
  const rows = await pendingSessions(sql).catch(() => []);
  let checked = 0;
  for (const r of rows) {
    checked++;
    const s = await stripeCall<{ status: string }>(k.key, 'GET', `/checkout/sessions/${r.session_id}`).catch(() => null);
    if (s?.status === 'complete') { await recordSession(sql, k.key, r.session_id, ek); return { checked, settled: 1 }; }
  }
  return { checked, settled: 0 };
}

/* ── the guest's side (public door) ─────────────────────────────────────────── */

const esc = (s: string) => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#151515;--mut:#6b6b6b;--line:#e6e2da;--gold:#9a6a26;--cta:#c9a46a}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#f2f0ec;--mut:#a3a09a;--line:#2b2925;--gold:#d8b57a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif}
main{max-width:440px;margin:0 auto;padding:48px 16px}.brand{letter-spacing:.3em;font-size:12px;color:var(--gold);font-weight:600}
h1{font-size:24px;margin:12px 0 4px}.card{border:1px solid var(--line);border-radius:16px;padding:20px;margin:24px 0}
.row{display:flex;justify-content:space-between;gap:12px}.amt{font-size:28px;font-weight:600}.mut{color:var(--mut);font-size:14px}
a.btn{display:block;text-align:center;background:var(--cta);color:#151515;text-decoration:none;font-weight:600;padding:14px;border-radius:12px;margin-top:16px}
</style></head><body><main><div class="brand">KAIZEN</div>${body}</main></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

/** Before opening Stripe: is it still on? A cancelled stay cancels the charge; nights that went stop the payment. */
async function stillPossible(sql: SqlFn, ek: string, r: ChargeRow): Promise<string | null> {
  const stay = await stayOf(sql, ek, r.reservation_id).catch(() => null);
  if (!stay) return null; // Hostaway unreachable: do not stop a payment over it; the setup checks again after.
  if (CANCELLED.test(stay.status)) {
    await sql`UPDATE upsell_charges SET status = 'cancelled', cancelled_at = now(), cancelled_by = 'Kaizen (reservation cancelled)'
               WHERE account_id = 1 AND id::text = ${r.id} AND status = 'pending'`;
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${r.claim_id}, 'note', ${`Charge cancelled on its own: the reservation is ${stay.status} in Hostaway.`}, 'Kaizen')`;
    return 'cancelled';
  }
  if (r.need === 'nights' && r.nights.length && stay.listingId) {
    const sorted = [...r.nights].sort();
    const days = await fetchCalendar(await getCredentials(sql, ek), stay.listingId, sorted[0]!, sorted[sorted.length - 1]!).catch(() => null);
    if (days && sorted.some(d => !days.find(x => x.date === d)?.available)) {
      await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
                VALUES (1, 'claim', ${r.claim_id}, 'note', 'The guest opened the pay link, but the nights are no longer free — the payment was not opened. Cancel this charge or offer other dates.', 'Kaizen')`;
      return 'taken';
    }
  }
  return null;
}

export async function payPage(sql: SqlFn, ek: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('pay') ?? '';
  const id = await verifyCharge(ek, token);
  if (!id) return page('Link not valid', '<h1>This link is not valid</h1><p class="mut">Ask us for it again.</p>', 403);
  const k = await stripeKey(sql, ek).catch(() => null);
  const done = url.searchParams.get('done');
  if (done && k && /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(done)) {
    // Back from Stripe: record it now (the webhook and the sweep do the same; whichever is first counts, once).
    await recordSession(sql, k.key, done, ek).catch(() => null);
  }
  let r = await chargeById(sql, id);
  if (!r || r.method !== 'card') return page('Not found', '<h1>This payment is gone</h1>', 404);
  const usd = `$${Number(r.amount).toFixed(2)}`;
  const card = () => `<div class="card"><div class="row"><div><b>${esc(r!.label)}</b><div class="mut">${esc(r!.unit_name ?? 'Your stay')}</div></div><div class="amt">${usd}</div></div>`;
  if (r.status === 'paid') return page('Paid', `<h1>Payment received</h1><p class="mut">Thank you${r.guest ? `, ${esc(r.guest.split(' ')[0]!)}` : ''} — we are setting it up for you.</p>${card()}</div>`);
  if (r.status === 'cancelled') return page('No longer due', `<h1>Nothing to pay</h1><p class="mut">This charge was cancelled.</p>${card()}</div>`);
  if (!k) return page('Not ready', `<h1>Payments are not open yet</h1><p class="mut">Please contact us.</p>${card()}</div>`, 503);
  if (url.searchParams.get('go') !== '1') {
    return page(`Pay ${usd}`, `<h1>Your payment</h1><p class="mut">Secure payment by Stripe — card, Apple Pay or Google Pay.</p>${card()}
      <a class="btn" href="?pay=${esc(token)}&go=1">Pay ${usd}</a>${k.mode === 'test' ? '<p class="mut">Test mode — use card 4242 4242 4242 4242.</p>' : ''}</div>`);
  }
  // An open Stripe page is reused (a guest tapping twice must not make two payments possible).
  if (r.session_id) {
    const s = await stripeCall<{ status: string; url: string | null }>(k.key, 'GET', `/checkout/sessions/${r.session_id}`).catch(() => null);
    if (s?.status === 'open' && s.url) return Response.redirect(s.url, 303);
    if (s?.status === 'complete') { await recordSession(sql, k.key, r.session_id, ek).catch(() => null); return Response.redirect(`${url.origin}${url.pathname}?pay=${token}`, 303); }
  }
  const why = await stillPossible(sql, ek, r);
  if (why === 'cancelled') return page('No longer due', `<h1>Nothing to pay</h1><p class="mut">This stay was cancelled.</p>${card()}</div>`);
  if (why === 'taken') return page('Not available', `<h1>Those nights are no longer available</h1><p class="mut">Nothing was charged — we will contact you with other options.</p>${card()}</div>`, 409);
  r = (await chargeById(sql, id))!;
  const back = `${url.origin}${url.pathname}?pay=${token}`;
  const p: Record<string, string | number | undefined> = {
    mode: 'payment', 'payment_method_types[0]': 'card',
    success_url: `${back}&done={CHECKOUT_SESSION_ID}`, cancel_url: back,
    'line_items[0][quantity]': 1, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': toCents(Number(r.amount)),
    'line_items[0][price_data][product_data][name]': r.label.slice(0, 120),
    'line_items[0][price_data][product_data][description]': (r.unit_name ?? 'Kaizen stay').slice(0, 200),
    'metadata[source]': 'guest-portal-charge', 'metadata[charge]': r.id, 'metadata[claim]': r.claim_id,
    'metadata[lines]': encodeLines([{ item: r.item, label: r.label, amount: Number(r.amount) }]),
    'metadata[reservation]': r.reservation_id, 'metadata[unit]': r.unit_id ?? undefined, 'metadata[unit_name]': r.unit_name ?? undefined,
    'metadata[guest]': r.guest ?? undefined, 'payment_intent_data[description]': `Upsell: ${r.label}`.slice(0, 200),
  };
  if (r.guest_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.guest_email) && !/guest\.airbnb|relay/i.test(r.guest_email)) p.customer_email = r.guest_email;
  try {
    // No idempotency key: a key reused after an expired page would hand back that dead page.
    const s = await stripeCall<{ id: string; url: string }>(k.key, 'POST', '/checkout/sessions', p);
    await sql`UPDATE upsell_charges SET session_id = ${s.id} WHERE account_id = 1 AND id::text = ${r.id} AND status = 'pending'`;
    return Response.redirect(s.url, 303);
  } catch (e) {
    return page('Could not open', `<h1>The payment page did not open</h1><p class="mut">${esc(e instanceof Error ? e.message : String(e))}</p>${card()}</div>`, 502);
  }
}

/** The note a guest's "I already paid" leaves on the case — also how the portal knows it was said (no column, no migration). */
const SAID_PAID = 'Guest says they paid in the Resolution Center';

/**
 * The stay's charges for its portal page: pending card ones with their pay link, pending Resolution Center requests (owner,
 * 2026-11-23: on Airbnb the guest sees it pending until the team marks it received, with Airbnb's link and "I already paid"),
 * and the ones paid.
 */
export async function stayCharges(sql: SqlFn, ek: string, origin: string, token: string): Promise<Response> {
  const m = /^(\d{1,20})\.([A-Za-z0-9_-]{6,64})$/.exec(token);
  if (!m || !await verifyGuest(ek, m[1]!, m[2]!)) return Response.json({ ok: false, message: 'This stay link is not valid.' }, { status: 403 });
  const rows = (await chargesOfStay(sql, m[1]!).catch(() => [] as ChargeRow[])).filter(r => r.status === 'pending' || r.status === 'paid');
  const rcClaims = rows.filter(r => r.method === 'rc' && r.status === 'pending').map(r => r.claim_id);
  const said = rcClaims.length ? await (sql`SELECT subject_id::text AS id, max(created_at) AS at FROM work_updates
      WHERE account_id = 1 AND subject = 'claim' AND kind = 'note' AND subject_id::text = ANY(${rcClaims}) AND body LIKE ${`${SAID_PAID}%`}
      GROUP BY 1` as Promise<{ id: string; at: string | Date }[]>).catch(() => []) : [];
  const saidAt = new Map(said.map(s => [s.id, new Date(s.at).toISOString()]));
  const base = await linkBase(sql, origin);
  const charges = await Promise.all(rows.map(async r => ({ id: r.id, label: r.label, amount: Number(r.amount), status: r.status, method: r.method,
    // What it changes: an hour waiting on this payment shows "!" beside the stay's check-in / checkout until it is paid.
    need: r.need, hour: r.hour,
    payUrl: r.status === 'pending' && r.method === 'card' ? base + await payPath(ek, r.id) : null,
    rcUrl: r.status === 'pending' && r.method === 'rc' ? AIRBNB_RESOLUTION : null,
    saidPaidAt: r.method === 'rc' && r.status === 'pending' ? saidAt.get(r.claim_id) ?? null : null,
    paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null })));
  return Response.json({ ok: true, charges }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * The guest's "I already paid" on a Resolution Center request: a note on the case and a line in its Slack thread — the team checks
 * Airbnb and marks it received (`rcReceived`). Said once; nothing is marked paid on the guest's word.
 */
export async function staySaidPaid(sql: SqlFn, ek: string, token: string, chargeId: unknown): Promise<Response> {
  const m = /^(\d{1,20})\.([A-Za-z0-9_-]{6,64})$/.exec(token);
  if (!m || !await verifyGuest(ek, m[1]!, m[2]!)) return Response.json({ ok: false, message: 'This stay link is not valid.' }, { status: 403 });
  const r = (await chargesOfStay(sql, m[1]!).catch(() => [] as ChargeRow[])).find(x => x.id === String(chargeId ?? ''));
  if (!r || r.method !== 'rc' || r.status !== 'pending') return Response.json({ ok: false, message: 'This payment is not waiting any more.' }, { status: 409 });
  const [done] = await sql`SELECT 1 AS ok FROM work_updates WHERE account_id = 1 AND subject = 'claim' AND subject_id::text = ${r.claim_id}
                            AND kind = 'note' AND body LIKE ${`${SAID_PAID}%`} LIMIT 1` as { ok: number }[];
  if (!done) {
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${r.claim_id}, 'note', ${`${SAID_PAID}: ${r.label} $${Number(r.amount).toFixed(2)} — check Airbnb and mark it received.`}, 'Guest (stay page)')`;
    await notifyClaim(sql, ek, r.claim_id, 'changed', 'Guest (stay page)', `— ${r.label} $${Number(r.amount).toFixed(2)}: the guest says it is paid in Airbnb. Verify it`,
      rcCheckButtons(r.id)).catch(() => {});
  }
  return Response.json({ ok: true, saidPaidAt: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
}
