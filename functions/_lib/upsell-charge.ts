/**
 * Upsells carried out from the team's side (owner, 2026-11-19; pure rules in src/lib/upsell-charge.ts).
 *
 *  GET  /api/upsell-charge?claim=<id>               → the plan: the stay (channel, dates, hours), free nights, charges
 *  POST /api/upsell-charge { action: 'create', … }  → hold in Hostaway, then a pending charge with its pay link
 *  POST /api/upsell-charge { action: 'cancel', id }  → release what was held, expire the Stripe page
 *  GET  /api/report-link?pay=<id>.<sig>[&go=1|&done=<cs>]  → the guest's pay page (public door, no sign-in)
 *  GET  /api/report-link?charges=<res>.<sig>         → the stay's pending payments, for the portal page
 *
 * Order matters: the hold first (nights blocked and read back, the hour written and read back), the charge only when
 * the hold worked — a guest must never pay for nights someone else can still book. Airbnb is never charged or blocked
 * here: Airbnb collects, and an alteration needs the nights open.
 *
 * Unlike the portal's own checkout (guest-pay.ts, sandbox only because its lines come from the page), the amount here
 * is set by a signed-in team member and kept on the server, so whichever Stripe mode is saved is used. A test-mode
 * payment settles the charge but is never income (charge-settle.ts).
 */
import type { SqlFn } from './accounts.ts';
import { getCredentials } from './accounts.ts';
import { fetchCalendar, fetchReservationDetail, fetchStandardHours, getAccessToken, setNightOpen } from './hostaway.ts';
import { pushStayTimes } from './stay-times.ts';
import { stripeCall, stripeKey } from './payouts.ts';
import { recordSession } from './guest-pay.ts';
import { signCharge, verifyCharge, verifyGuest } from './guest-link.ts';
import { saveCaseMoney } from './claim-money.ts';
import { toCents } from '../../src/lib/payouts.ts';
import { encodeLines } from '../../src/lib/guest-payments.ts';
import { addDays, type DateStr } from '../../src/lib/dates.ts';
import { isUpsell } from '../../src/lib/claims.ts';
import { airbnbGuestText, airbnbLinks, chargeLabel, extraNights, freeAround, hourLabel, hourOptions, hourPrice, isAirbnb, itemOf,
  needOf, nightsPrice, payGuestText, type ChargeNeed, type NightDay, type UpsellCharge } from '../../src/lib/upsell-charge.ts';

type Fail = { ok: false; message: string; status?: number };
const fail = (message: string, status = 400): Fail => ({ ok: false, message, status });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim() : null;
const wholeHour = (v: unknown) => { const n = Number(v); return v != null && v !== '' && Number.isInteger(n) && n >= 0 && n <= 23 ? n : null; };

/** Where the guest's links live: the portal's own domain when set (no Access in front), else this host. */
async function linkBase(sql: SqlFn, origin: string): Promise<string> {
  const [a] = await (sql`SELECT guest_portal_url AS url FROM accounts WHERE id = 1` as Promise<{ url: string | null }[]>).catch(() => []);
  const u = (a?.url ?? '').trim();
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
  nights: string[]; hour: number | null; holds: string[]; created_by: string; created_at: string; paid_at: string | null; livemode: boolean;
  session_id: string | null; unit_id: string | null; unit_name: string | null; guest: string | null; guest_email: string | null; item: string };
// One column list, three readers (Neon's tagged template cannot splice a fragment).
const chargeById = async (sql: SqlFn, id: string) => (await sql`SELECT id::text AS id, claim_id::text AS claim_id, reservation_id, label, amount::float8 AS amount, status, need, nights, hour, holds, created_by, created_at, paid_at, livemode, session_id, unit_id, unit_name, guest, guest_email, item
  FROM upsell_charges WHERE account_id = 1 AND id::text = ${id}` as unknown as ChargeRow[])[0] ?? null;
const chargesOfClaim = (sql: SqlFn, claimId: string) => sql`SELECT id::text AS id, claim_id::text AS claim_id, reservation_id, label, amount::float8 AS amount, status, need, nights, hour, holds, created_by, created_at, paid_at, livemode, session_id, unit_id, unit_name, guest, guest_email, item
  FROM upsell_charges WHERE account_id = 1 AND claim_id::text = ${claimId} ORDER BY id DESC` as unknown as Promise<ChargeRow[]>;
const chargesOfStay = (sql: SqlFn, resId: string) => sql`SELECT id::text AS id, claim_id::text AS claim_id, reservation_id, label, amount::float8 AS amount, status, need, nights, hour, holds, created_by, created_at, paid_at, livemode, session_id, unit_id, unit_name, guest, guest_email, item
  FROM upsell_charges WHERE account_id = 1 AND reservation_id = ${resId} AND status <> 'cancelled' ORDER BY id` as unknown as Promise<ChargeRow[]>;

async function shapeCharge(ek: string, base: string, r: ChargeRow): Promise<UpsellCharge> {
  return { id: r.id, claimId: r.claim_id, reservationId: r.reservation_id, label: r.label, amount: Number(r.amount), status: r.status,
    payUrl: r.status === 'pending' ? base + await payPath(ek, r.id) : null, nights: r.nights ?? [], hour: r.hour, need: r.need,
    holds: r.holds ?? [], createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(),
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
  const rows = await chargesOfClaim(sql, claimId);
  const charges = await Promise.all(rows.map(r => shapeCharge(ek, base, r)));
  const need = needOf(c.category);
  if (!c.reservation_id) return { ok: true as const, need, stay: null, free: null, nightDays: [], charges, links: null };
  const stay = await stayOf(sql, ek, c.reservation_id);
  if (!stay) return { ok: true as const, need, stay: null, free: null, nightDays: [], charges, links: null, message: 'Hostaway did not return this reservation.' };
  const nightDays = need === 'nights' && !stay.airbnb ? await nightsAround(sql, ek, stay) : [];
  const free = stay.arrival && stay.departure ? freeAround(nightDays, stay.arrival, stay.departure) : { before: 0, after: 0 };
  return { ok: true as const, need, charges, nightDays, free,
    stay: { channel: stay.channel, airbnb: stay.airbnb, arrival: stay.arrival, departure: stay.departure, checkInHour: stay.checkInHour,
            checkOutHour: stay.checkOutHour, guest: stay.guest, hasEmail: !!stay.email },
    links: stay.airbnb ? airbnbLinks(stay.code) : null };
}

export interface CreateBody { claim?: unknown; amount?: unknown; before?: unknown; after?: unknown; hour?: unknown }

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
  if (/cancel|declin|expir/i.test(stay.status)) return fail(`The reservation is ${stay.status} in Hostaway.`);
  const need = needOf(c.category);

  // Airbnb collects: nothing is charged or blocked here — the price is what is asked, and the team gets the doors.
  if (stay.airbnb) {
    // Money asked in the Resolution Center is upselling (§162); an alteration's price lands on the reservation instead.
    await saveCaseMoney(sql, claimId, need === 'nights' ? { requested: amount } : { requested: amount, collectedVia: 'Resolution Center' }, who);
    const label = chargeLabel(c.category!, {});
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${claimId}, 'note', ${`Airbnb: ${need === 'nights' ? 'change the reservation on Airbnb' : 'request the money in the Resolution Center'} — $${amount.toFixed(2)}.`}, ${who})`;
    return { ok: true as const, airbnb: true, links: airbnbLinks(stay.code), guestText: airbnbGuestText(need, label, amount) };
  }

  const [open] = await sql`SELECT 1 AS x FROM upsell_charges WHERE account_id = 1 AND claim_id::text = ${claimId} AND status = 'pending'` as { x: number }[];
  if (open) return fail('This case already has a pending charge — cancel it first.');
  const creds = await getCredentials(sql, ek);
  const holds: string[] = [];
  let nights: DateStr[] = [];
  let hour: number | null = null;

  if (need === 'nights') {
    if (!stay.listingId || !stay.arrival || !stay.departure) return fail('The reservation has no listing or dates in Hostaway.');
    const before = Math.max(0, Math.min(7, Math.floor(Number(b.before) || 0))), after = Math.max(0, Math.min(7, Math.floor(Number(b.after) || 0)));
    if (!before && !after) return fail('How many nights — before the arrival or after the departure?');
    // Read again right before blocking: the plan the person saw may be minutes old.
    const days = await nightsAround(sql, ek, stay);
    const free = freeAround(days, stay.arrival, stay.departure);
    if (before > free.before || after > free.after) return fail(`Not free any more: ${free.before} night(s) open before, ${free.after} after.`, 409);
    nights = extraNights(stay.arrival, stay.departure, before, after);
    const token = await getAccessToken(creds);
    const done: DateStr[] = [];
    for (const d of nights) {
      const w = await setNightOpen(creds, stay.listingId, d, false, token).catch(e => ({ ok: false, detail: e instanceof Error ? e.message : String(e) }));
      if (!w.ok) {
        // All or nothing: reopen what was blocked, charge nothing.
        for (const x of done) await setNightOpen(creds, stay.listingId, x, true, token).catch(() => null);
        return fail(`Hostaway did not block ${d}: ${w.detail}. Nothing was charged.`, 502);
      }
      done.push(d);
    }
    holds.push(`${nights.length} night${nights.length === 1 ? '' : 's'} blocked in Hostaway (${nights[0]}${nights.length > 1 ? ` – ${nights[nights.length - 1]}` : ''})`);
    if (nightsPrice(days, nights) == null) holds.push('the calendar had no price for every night — the amount is the one typed');
  }

  if (need === 'checkin' || need === 'checkout') {
    const stayHour = need === 'checkin' ? stay.checkInHour : stay.checkOutHour;
    const h = wholeHour(b.hour);
    if (stayHour == null) return fail("Hostaway has no standard hour for this stay — set it in Hostaway first.");
    if (h == null || !hourOptions(need, stayHour).includes(h)) return fail('Pick the new hour.');
    // The board's own path (stay-times.ts): written on the reservation, read back, logged in stay_time_pushes.
    await pushStayTimes(sql, creds, ek, c.reservation_id, { [need]: hourLabel(h) }, who, null);
    const [p] = await sql`SELECT outcome, detail FROM stay_time_pushes WHERE account_id = 1 AND reservation_id = ${c.reservation_id} AND kind = ${need}
                           ORDER BY id DESC LIMIT 1` as { outcome: string; detail: string | null }[];
    if (p?.outcome !== 'pushed') return fail(`Hostaway did not take the new hour: ${p?.detail ?? 'no answer'}. Nothing was charged.`, 502);
    hour = h;
    holds.push(`${need === 'checkin' ? 'check-in' : 'check-out'} ${hourLabel(h)} set on the reservation (was ${hourLabel(stayHour)})`);
    if (amount !== hourPrice(need, stayHour, h)) holds.push(`the rate would be $${hourPrice(need, stayHour, h)} — $${amount.toFixed(2)} typed`);
  }

  const label = chargeLabel(c.category!, { nights, hour });
  const k = await stripeKey(sql, ek).catch(() => null);
  const [row] = await sql`
    INSERT INTO upsell_charges (account_id, claim_id, reservation_id, unit_id, unit_name, guest, guest_email, need, label, item, amount, nights, hour, holds, livemode, created_by)
    VALUES (1, ${claimId}::bigint, ${c.reservation_id}, ${stay.listingId ?? c.unit_id}, ${c.unit_name}, ${stay.guest}, ${stay.email}, ${need}, ${label},
            ${itemOf(c.category!)}, ${amount}, ${nights}, ${hour}, ${holds}, ${k?.mode === 'live'}, ${who})
    RETURNING id::text AS id` as { id: string }[];
  await saveCaseMoney(sql, claimId, { requested: amount }, who);
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'claim', ${claimId}, 'note', ${[`Payment link made: ${label} $${amount.toFixed(2)}.`, ...holds].join(' · ')}, ${who})`;
  const url = (await linkBase(sql, origin)) + await payPath(ek, row!.id);
  return { ok: true as const, airbnb: false, id: row!.id, url, holds, guestText: payGuestText(label, amount, url),
    warning: k ? (k.mode === 'test' ? 'Stripe is in test mode: the link takes test cards only, and a test payment is not income.' : null)
               : 'Stripe is not set up (Settings → Integrations → Stripe) — the link will not open a payment page until it is.' };
}

export async function cancelCharge(sql: SqlFn, ek: string, id: string, who: string) {
  const r = await chargeById(sql, id);
  if (!r) return fail('No such charge.', 404);
  if (r.status !== 'pending') return fail(`It is ${r.status} — nothing to cancel.`);
  // Claimed first, so a payment arriving now finds it cancelled (settleCharge only moves a pending one).
  const [took] = await sql`UPDATE upsell_charges SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${who}
                            WHERE account_id = 1 AND id::text = ${id} AND status = 'pending' RETURNING id` as { id: string }[];
  if (!took) return fail('It just changed — reload.', 409);
  const notes: string[] = [];
  const k = await stripeKey(sql, ek).catch(() => null);
  if (k && r.session_id) await stripeCall(k.key, 'POST', `/checkout/sessions/${r.session_id}/expire`).catch(() => null);
  const creds = await getCredentials(sql, ek);
  if (r.need === 'nights' && r.nights.length && r.unit_id) {
    const token = await getAccessToken(creds);
    const bad: string[] = [];
    for (const d of r.nights) { const w = await setNightOpen(creds, r.unit_id, d, true, token).catch(() => ({ ok: false })); if (!w.ok) bad.push(d); }
    notes.push(bad.length ? `could not reopen ${bad.join(', ')} — open them in Hostaway` : `${r.nights.length} night(s) reopened`);
  }
  if ((r.need === 'checkin' || r.need === 'checkout') && r.hour != null) {
    await pushStayTimes(sql, creds, ek, r.reservation_id, { [r.need]: null }, who, null);
    const [p] = await sql`SELECT outcome FROM stay_time_pushes WHERE account_id = 1 AND reservation_id = ${r.reservation_id} AND kind = ${r.need}
                           ORDER BY id DESC LIMIT 1` as { outcome: string }[];
    notes.push(p?.outcome === 'pushed' ? 'hour back to the standard one' : 'the hour could not be put back — fix it in Hostaway');
  }
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'claim', ${r.claim_id}, 'note', ${[`Charge cancelled: ${r.label} $${Number(r.amount).toFixed(2)}`, ...notes].join(' · ')}, ${who})`;
  return { ok: true as const, notes };
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

export async function payPage(sql: SqlFn, ek: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('pay') ?? '';
  const id = await verifyCharge(ek, token);
  if (!id) return page('Link not valid', '<h1>This link is not valid</h1><p class="mut">Ask us for it again.</p>', 403);
  const k = await stripeKey(sql, ek).catch(() => null);
  const done = url.searchParams.get('done');
  if (done && k && /^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(done)) {
    // Back from Stripe: record it now (the webhook does the same; whichever is first counts, once).
    await recordSession(sql, k.key, done, ek).catch(() => null);
  }
  const r = await chargeById(sql, id);
  if (!r) return page('Not found', '<h1>This payment is gone</h1>', 404);
  const usd = `$${Number(r.amount).toFixed(2)}`;
  const card = `<div class="card"><div class="row"><div><b>${esc(r.label)}</b><div class="mut">${esc(r.unit_name ?? 'Your stay')}</div></div><div class="amt">${usd}</div></div>`;
  if (r.status === 'paid') return page('Paid', `<h1>Payment received</h1><p class="mut">Thank you${r.guest ? `, ${esc(r.guest.split(' ')[0]!)}` : ''} — you are all set.</p>${card}</div>`);
  if (r.status === 'cancelled') return page('No longer due', `<h1>Nothing to pay</h1><p class="mut">This charge was cancelled.</p>${card}</div>`);
  if (!k) return page('Not ready', `<h1>Payments are not open yet</h1><p class="mut">Please contact us.</p>${card}</div>`, 503);
  if (url.searchParams.get('go') !== '1') {
    return page(`Pay ${usd}`, `<h1>Your payment</h1><p class="mut">Secure payment by Stripe — card, Apple Pay or Google Pay.</p>${card}
      <a class="btn" href="?pay=${esc(token)}&go=1">Pay ${usd}</a>${k.mode === 'test' ? '<p class="mut">Test mode — use card 4242 4242 4242 4242.</p>' : ''}</div>`);
  }
  // An open Stripe page is reused (a guest tapping twice must not make two payments possible).
  if (r.session_id) {
    const s = await stripeCall<{ status: string; url: string | null }>(k.key, 'GET', `/checkout/sessions/${r.session_id}`).catch(() => null);
    if (s?.status === 'open' && s.url) return Response.redirect(s.url, 303);
    if (s?.status === 'complete') { await recordSession(sql, k.key, r.session_id, ek).catch(() => null); return Response.redirect(`${url.origin}${url.pathname}?pay=${token}`, 303); }
  }
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
    const s = await stripeCall<{ id: string; url: string }>(k.key, 'POST', '/checkout/sessions', p, `charge-${r.id}-${Math.floor(Date.now() / 60000)}`);
    await sql`UPDATE upsell_charges SET session_id = ${s.id} WHERE account_id = 1 AND id::text = ${r.id} AND status = 'pending'`;
    return Response.redirect(s.url, 303);
  } catch (e) {
    return page('Could not open', `<h1>The payment page did not open</h1><p class="mut">${esc(e instanceof Error ? e.message : String(e))}</p>${card}</div>`, 502);
  }
}

/** The stay's charges for its portal page: pending ones with their pay link, and the ones paid. */
export async function stayCharges(sql: SqlFn, ek: string, origin: string, token: string): Promise<Response> {
  const m = /^(\d{1,20})\.([A-Za-z0-9_-]{6,64})$/.exec(token);
  if (!m || !await verifyGuest(ek, m[1]!, m[2]!)) return Response.json({ ok: false, message: 'This stay link is not valid.' }, { status: 403 });
  const rows = await chargesOfStay(sql, m[1]!).catch(() => [] as ChargeRow[]);
  const base = await linkBase(sql, origin);
  const charges = await Promise.all(rows.map(async r => ({ id: r.id, label: r.label, amount: Number(r.amount), status: r.status,
    payUrl: r.status === 'pending' ? base + await payPath(ek, r.id) : null, paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null })));
  return Response.json({ ok: true, charges }, { headers: { 'Cache-Control': 'no-store' } });
}
