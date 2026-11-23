/**
 * Guest portal payments (guests module, 2026-11-15): the "Review and pay" step opens Stripe Checkout, Stripe's
 * hosted page (decided for replicability — no publishable key or Apple Pay domain per tenant; see docs/product.md).
 *
 *  POST /api/report-link?checkout=1  { lines, email?, back } → { url }   (a Checkout Session)
 *  GET  /api/report-link?checkout=<cs_…>                     → { paid }  (did the guest finish it?)
 *  POST /api/report-link?identity=1  { back }                → { url }   (Stripe Identity: ID photo + selfie)
 *  GET  /api/report-link?identity=<vs_…>                     → { done, status }
 *
 * Inside the page (boss, 2026-11-16: "that it does not leave the portal"): with `embedded: true` and a publishable key
 * saved, checkout answers { clientSecret, id, publishableKey } for Stripe's Embedded Checkout and identity answers
 * { clientSecret, id, publishableKey } for Stripe.js's verifyIdentity modal. No key → the hosted pages, as before.
 *
 * Same public door as the payee Stripe link, so no new Access bypass. **Sandbox only for now:** the lines come from the
 * page (the demo stay has no reservation behind it), so a live key is refused until the signed /guest/<id> link
 * computes the bill on the server. A hold (security deposit) makes the whole payment manual-capture: the team
 * captures only what is owed after check-out (Stripe allows a partial capture) and the rest is released.
 */
import { stripePublishableKey, type SqlFn } from './accounts.ts';
import { stripeCall, stripeKey } from './payouts.ts';
import { decrypt } from './crypto.ts';
import { toCents } from '../../src/lib/payouts.ts';
import { decodeLines, encodeLines, itemLabel, type PaidLine } from '../../src/lib/guest-payments.ts';
import { settleCharge, syncChargeRefund } from './charge-settle.ts';
import type { Env } from './db.ts';
import { loadStay, markStay, stayId } from './guest-stay.ts';
import { verifyHouse } from './guest-demo.ts';
import { mirrorTodos } from './inventory.ts';
import { bill, protectionFor } from '../../src/lib/guest-checkin.ts';
import { UPSELLS, APPROVAL_NOTE, allowedTime, availability, needsApproval, nights, offered, quote, type Choice } from '../../src/lib/guest-portal.ts';
import { todayIn } from '../../src/lib/dates.ts';

type Line = { label: string; amount: number; kind: 'charge' | 'hold'; note?: string; item?: string };
/** Which stay the payment is for — the demo knows the unit's name; the real link (Phase 2) knows the reservation. */
type StayRef = { id?: unknown; unitId?: unknown; unitName?: unknown; guest?: unknown };
const short = (v: unknown, n = 120) => typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined;
const bad = (message: string, status = 400) => Response.json({ ok: false, message }, { status });
// Where Stripe may send the guest back: only the portal's own pages, on this host.
const portalPath = (p: unknown): p is string => typeof p === 'string' && /^\/(crew\/guest-demo|guest\/)[^\s]*$/.test(p) && p.length < 600;

/** The publishable key, only when it is the same mode as the secret key (a test page never meets a live key). */
async function embedKey(sql: SqlFn, mode: 'test' | 'live') {
  const pk = await stripePublishableKey(sql);
  return pk && pk.startsWith(`pk_${mode}_`) ? pk : null;
}

/** The real stay link (Phase 2): the bill is the server's, so a live key is allowed there. */
async function anyKey(sql: SqlFn, encryptionKey: string) {
  const k = await stripeKey(sql, encryptionKey).catch(() => null);
  return k ?? bad('Payments are not set up yet — message us and we will help.', 503);
}

/**
 * What a real stay pays, computed here from the stay as Hostaway and the Repository give it (never from the page):
 * the check-in bill from the saved answers, or one extra priced by the same rules as the page shows.
 */
async function stayLines(sql: SqlFn, env: Env, id: string, purpose: unknown, extra: unknown) {
  const l = await loadStay(sql, env, id);
  if (typeof l === 'string') return l;
  const prot = protectionFor(l.stay.unitType ?? 'house', l.stay.protection ?? {}, nights(l.stay));
  if (purpose === 'checkin') {
    if (l.flow.paid) return 'This check-in is already paid.';
    return { l, lines: bill(l.flow, l.stay, prot).lines as Line[] };
  }
  const x = (extra && typeof extra === 'object' ? extra : {}) as { kind?: unknown; choice?: unknown };
  const u = UPSELLS.find(v => v.kind === x.kind);
  if (!u || !offered(l.stay).some(o => o.kind === u.kind) || !availability(l.stay, u).ok) return 'That extra is not available for this stay.';
  const c = (x.choice && typeof x.choice === 'object' ? x.choice : {}) as Choice;
  if (!allowedTime(l.stay, u, typeof c.time === 'string' ? c.time : undefined)) return 'That time is not available for this stay.';
  const q = quote(l.stay, u, { time: typeof c.time === 'string' ? c.time : undefined, before: Number(c.before) || 0, after: Number(c.after) || 0, qty: Number(c.qty) || undefined });
  if (q == null || !(q > 0)) return 'That extra cannot be priced — message us and we will help.';
  return { l, lines: [{ label: u.title, amount: q, kind: 'charge', item: u.kind, note: c.time ? `${u.kind === 'early-checkin' ? 'From' : 'Until'} ${c.time}${needsApproval(l.stay, u) ? ` · ${APPROVAL_NOTE}` : ''}` : undefined }] as Line[] };
}

async function sandbox(sql: SqlFn, encryptionKey: string) {
  const k = await stripeKey(sql, encryptionKey).catch(() => null);
  if (!k) return bad('Stripe is not set up — Settings → Integrations → Stripe.', 503);
  if (k.mode !== 'test') return bad('Guest payments run in Stripe test mode only for now.', 409);
  return k;
}

export async function guestCheckout(sql: SqlFn, encryptionKey: string, request: Request, env?: Env): Promise<Response> {
  const b = await request.json().catch(() => ({})) as { lines?: Line[]; email?: string; back?: string; embedded?: boolean; stay?: StayRef;
    stayToken?: string; purpose?: 'checkin' | 'extra'; extra?: { kind?: string; choice?: Choice }; house?: string };
  // The real stay link: its own bill, from the server.
  const real = env && b.stayToken ? await stayId(encryptionKey, b.stayToken) : null;
  if (b.stayToken && !real) return bad('This stay link is not valid.', 403);
  // Owner, 2026-11-23 ("I want to test that it works"): a signed demo link (staff only, it expires) may pay with the
  // live key too — the payer is whoever holds the link, so the page's lines only cost themselves; capped below.
  const demoLive = !real && b.house ? await verifyHouse(encryptionKey, b.house) : null;
  const k = real || demoLive ? await anyKey(sql, encryptionKey) : await sandbox(sql, encryptionKey);
  if (k instanceof Response) return k;
  const fromStay = real ? await stayLines(sql, env!, real, b.purpose, b.extra) : null;
  if (typeof fromStay === 'string') return bad(fromStay, 409);
  if (fromStay) b.stay = { id: real, unitId: fromStay.l.listingId, unitName: fromStay.l.stay.unitName, guest: fromStay.l.stay.guest?.name ?? null };
  const lines = (fromStay ? fromStay.lines : Array.isArray(b.lines) ? b.lines : []).filter(l => l && (l.kind === 'charge' || l.kind === 'hold'));
  if (!lines.length || lines.length > 8) return bad('Nothing to pay.');
  if (lines.some(l => typeof l.label !== 'string' || !(Number(l.amount) > 0) || Number(l.amount) > 5000)) return bad('A line is not valid.');
  if (!real && lines.reduce((t, l) => t + Number(l.amount), 0) > 1500) return bad('A demo payment is limited to $1,500.');
  if (!portalPath(b.back)) return bad('Bad return page.');
  const origin = new URL(request.url).origin;
  const back = origin + b.back;
  const hold = lines.some(l => l.kind === 'hold');
  const p: Record<string, string | number | undefined> = {
    mode: 'payment',
    // Card only: Apple Pay / Google Pay ride on it. Stripe's dynamic list added Klarna, Affirm, Cash App, Amazon Pay —
    // pay-later makes no sense for a waiver and cannot hold a deposit.
    'payment_method_types[0]': 'card',
    success_url: `${back}${back.includes('?') ? '&' : '?'}paid={CHECKOUT_SESSION_ID}`,
    cancel_url: back,
    'metadata[source]': real ? 'guest-portal' : 'guest-portal-demo',
    'metadata[purpose]': real ? (b.purpose === 'checkin' ? 'checkin' : 'extra') : undefined,
    // What was sold, for the books (recordSession): item:amount per line, held lines marked ~.
    'metadata[lines]': encodeLines(lines.map(l => ({ item: short(l.item, 24) ?? (l.kind === 'hold' ? 'deposit' : 'other'), label: l.label, amount: Number(l.amount), hold: l.kind === 'hold' }))),
    'metadata[reservation]': short(b.stay?.id, 40),
    'metadata[unit]': short(b.stay?.unitId, 40),
    'metadata[unit_name]': short(b.stay?.unitName),
    'metadata[guest]': short(b.stay?.guest),
    'payment_intent_data[description]': hold ? 'Guest check-in (deposit held, captured after check-out)' : 'Guest check-in',
  };
  if (hold) p['payment_intent_data[capture_method]'] = 'manual';
  const pk = b.embedded ? await embedKey(sql, k.mode) : null;
  if (pk) {
    // Inside the portal: no redirect at all — the page hears onComplete and asks guestCheckoutState.
    delete p.success_url; delete p.cancel_url;
    p.ui_mode = 'embedded'; p.redirect_on_completion = 'never';
  }
  if (typeof b.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) p.customer_email = b.email;
  lines.forEach((l, i) => {
    p[`line_items[${i}][quantity]`] = 1;
    p[`line_items[${i}][price_data][currency]`] = 'usd';
    p[`line_items[${i}][price_data][unit_amount]`] = toCents(Number(l.amount));
    p[`line_items[${i}][price_data][product_data][name]`] = l.label.slice(0, 120);
    const d = l.kind === 'hold' ? 'Held on your card, released after check-out' : l.note;
    if (d) p[`line_items[${i}][price_data][product_data][description]`] = d.slice(0, 200);
  });
  try {
    const s = await stripeCall<{ id: string; url: string | null; client_secret: string | null }>(k.key, 'POST', '/checkout/sessions', p);
    if (real && b.purpose === 'checkin') await markStay(sql, real, fromStay!.l.listingId, { paySession: s.id });
    return Response.json(pk ? { ok: true, id: s.id, clientSecret: s.client_secret, publishableKey: pk } : { ok: true, url: s.url });
  } catch (e) { return bad(e instanceof Error ? e.message : String(e), 502); }
}

export async function guestCheckoutState(sql: SqlFn, encryptionKey: string, id: string, stayToken?: string | null, house?: string | null): Promise<Response> {
  const real = stayToken ? await stayId(encryptionKey, stayToken) : null;
  const demoLive = !real && house ? await verifyHouse(encryptionKey, house) : null;
  if (!(real || demoLive ? /^cs_(test|live)_[A-Za-z0-9]{10,200}$/ : /^cs_test_[A-Za-z0-9]{10,200}$/).test(id)) return bad('Bad session.');
  const k = real || demoLive ? await anyKey(sql, encryptionKey) : await sandbox(sql, encryptionKey);
  if (k instanceof Response) return k;
  try {
    const s = await recordSession(sql, k.key, id, encryptionKey);
    const m = s.metadata ?? {};
    // The stay's own payment, confirmed by Stripe: only a session made for THIS reservation counts.
    if (real && s.status === 'complete' && m.reservation === real) {
      if (m.purpose === 'checkin') await markStay(sql, real, m.unit ?? null, { paySession: s.id, paidTotal: s.amount_total / 100 });
      else await extraTodo(sql, encryptionKey, s, real);
    }
    // A manual-capture (hold) session is complete but "unpaid" until the team captures — complete is what counts here.
    return Response.json({ ok: true, paid: s.status === 'complete', total: s.amount_total / 100 }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return bad(e instanceof Error ? e.message : String(e), 502); }
}

/* ── Into the books (owner, 2026-11-17): guest_payments, read by /api/portfolio and Revenue → Portal sales ── */

type Charge = { id: string; created: number; amount_captured: number; amount_refunded: number; captured: boolean;
  balance_transaction: { fee: number } | string | null };
type Intent = { id: string; status: string; amount: number; amount_received: number; latest_charge: Charge | string | null };
type Session = { id: string; status: string; payment_status: string; amount_total: number; livemode: boolean; created: number;
  metadata: Record<string, string> | null; customer_details?: { name?: string | null } | null; payment_intent: Intent | string | null };

/** YYYY-MM-DD in Texas (the houses' day) for a Stripe timestamp. */
const texasDay = (unix: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(unix * 1000));

/**
 * The session as it stands in Stripe → one `guest_payments` row. Called by the page's check and by the webhook, so it
 * is written whichever comes first and corrected by the other. A held (manual-capture) payment is `held` until the team
 * captures it; what is captured beyond the charges is the deposit kept, income too.
 */
export async function recordSession(sql: SqlFn, key: string, id: string, encryptionKey?: string): Promise<Session> {
  const s = await stripeCall<Session>(key, 'GET', `/checkout/sessions/${id}`, { 'expand[0]': 'payment_intent.latest_charge.balance_transaction' });
  if (s.status !== 'complete') return s;
  const pi = typeof s.payment_intent === 'object' ? s.payment_intent : null;
  const ch = pi && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const m = s.metadata ?? {};
  let lines: PaidLine[] = decodeLines(m.lines);
  if (!lines.length) lines = [{ item: 'other', label: 'Guest payment', amount: s.amount_total / 100 }];
  const captured = ch?.captured ? ch.amount_captured / 100 : 0;
  const status = ch?.captured ? (ch.amount_refunded >= ch.amount_captured && ch.amount_captured > 0 ? 'refunded' : 'paid') : 'held';
  if (ch?.captured && lines.some(l => l.hold)) {
    // A captured hold: the charges, plus whatever of the deposit was kept.
    const charges = lines.filter(l => !l.hold).reduce((a, l) => a + l.amount, 0);
    const kept = Math.round((captured - charges) * 100) / 100;
    lines = [...lines.filter(l => !l.hold), ...(kept > 0 ? [{ item: 'deposit', label: itemLabel('deposit') + ' kept', amount: kept }] : [])];
  }
  const fee = ch && typeof ch.balance_transaction === 'object' && ch.balance_transaction ? ch.balance_transaction.fee / 100 : null;
  const amount = ch?.captured ? captured : s.amount_total / 100;
  const refunded = ch ? ch.amount_refunded / 100 : 0;
  await sql`
    INSERT INTO guest_payments (account_id, session_id, payment_intent, livemode, reservation_id, unit_id, unit_name, guest, lines, amount, fee, refunded, status, paid_on, claim_id)
    VALUES (1, ${s.id}, ${pi?.id ?? (typeof s.payment_intent === 'string' ? s.payment_intent : null)}, ${s.livemode}, ${m.reservation ?? null}, ${m.unit ?? null},
            ${m.unit_name ?? null}, ${m.guest ?? s.customer_details?.name ?? null}, ${JSON.stringify(lines)}::jsonb, ${amount}, ${fee}, ${refunded}, ${status},
            ${texasDay(ch?.created ?? s.created)}, ${/^\d+$/.test(m.claim ?? '') ? m.claim : null})
    ON CONFLICT (account_id, session_id) DO UPDATE SET payment_intent = EXCLUDED.payment_intent, lines = EXCLUDED.lines, amount = EXCLUDED.amount,
      fee = COALESCE(EXCLUDED.fee, guest_payments.fee), refunded = EXCLUDED.refunded, status = EXCLUDED.status,
      guest = COALESCE(guest_payments.guest, EXCLUDED.guest), updated_at = now()`;
  // An upsell charge the team made (upsell-charge.ts): paid → its case settles and Hostaway is set up, once; a refund
  // comes off the case (charge-settle.ts).
  if (m.charge && (status === 'paid' || status === 'refunded')) {
    await settleCharge(sql, m.charge, { via: 'card', sessionId: s.id, livemode: s.livemode }, encryptionKey);
    if (refunded > 0) await syncChargeRefund(sql, m.charge, refunded);
  }
  return s;
}

/** Stripe-Signature: t=…,v1=… — HMAC-SHA256 of `${t}.${body}` with the endpoint's secret, within five minutes. */
export async function stripeSignatureOk(secret: string, header: string, body: string, now = Date.now()): Promise<boolean> {
  const parts = Object.fromEntries(header.split(',').map(x => x.split('=') as [string, string]).filter(x => x.length === 2).map(([a, b]) => [a.trim(), b]));
  const sigs = header.split(',').filter(x => x.trim().startsWith('v1=')).map(x => x.trim().slice(3));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${t}.${body}`)));
  const hex = [...mac].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(sg => sg.length === hex.length && [...sg].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}

/**
 * POST /api/report-link?stripe-event — Stripe's webhook (Settings → Integrations → Stripe → webhook secret). The event
 * is only a hint: the session is re-read from Stripe, so a forged or stale body can change nothing.
 * Events: checkout.session.completed · charge.captured · charge.refunded.
 */
export async function stripeWebhook(sql: SqlFn, encryptionKey: string, request: Request): Promise<Response> {
  const body = await request.text();
  const [a] = await sql`SELECT stripe_webhook_secret_enc FROM accounts WHERE id = 1` as { stripe_webhook_secret_enc: string | null }[];
  if (!a?.stripe_webhook_secret_enc) return bad('No webhook secret saved.', 503);
  const secret = await decrypt(a.stripe_webhook_secret_enc, encryptionKey);
  if (!await stripeSignatureOk(secret, request.headers.get('Stripe-Signature') ?? '', body)) return bad('Bad signature.', 401);
  const k = await stripeKey(sql, encryptionKey).catch(() => null);
  if (!k) return bad('Stripe is not set up.', 503);
  const ev = JSON.parse(body) as { type: string; data: { object: { id: string; object: string; payment_intent?: string | null; metadata?: Record<string, string> | null } } };
  const o = ev.data.object;
  let sessionId: string | null = null;
  if (ev.type.startsWith('checkout.session.')) sessionId = o.metadata?.source?.startsWith('guest-portal') ? o.id : null;
  else if (ev.type === 'charge.captured' || ev.type === 'charge.refunded') {
    const [row] = o.payment_intent ? await sql`SELECT session_id FROM guest_payments WHERE account_id = 1 AND payment_intent = ${o.payment_intent}` as { session_id: string }[] : [];
    sessionId = row?.session_id ?? null;
  }
  // Not ours (a vendor payout, another product) → 200 so Stripe stops retrying.
  if (sessionId) await recordSession(sql, k.key, sessionId, encryptionKey);
  return Response.json({ ok: true, recorded: !!sessionId });
}

/* ── Identity (Stripe Identity, sandbox — Truvi vs Stripe still open) ───────────────── */

export async function guestIdentity(sql: SqlFn, encryptionKey: string, request: Request): Promise<Response> {
  const b = await request.json().catch(() => ({})) as { back?: string; embedded?: boolean; stayToken?: string };
  const real = b.stayToken ? await stayId(encryptionKey, b.stayToken) : null;
  if (b.stayToken && !real) return bad('This stay link is not valid.', 403);
  const k = real ? await anyKey(sql, encryptionKey) : await sandbox(sql, encryptionKey);
  if (k instanceof Response) return k;
  if (!portalPath(b.back)) return bad('Bad return page.');
  const back = new URL(request.url).origin + b.back;
  try {
    const pk = b.embedded ? await embedKey(sql, k.mode) : null;
    const v = await stripeCall<{ id: string; url: string; client_secret: string }>(k.key, 'POST', '/identity/verification_sessions', {
      type: 'document',
      'options[document][require_matching_selfie]': true,
      'options[document][allowed_types][0]': 'driving_license',
      'options[document][allowed_types][1]': 'passport',
      'options[document][allowed_types][2]': 'id_card',
      'metadata[source]': real ? 'guest-portal' : 'guest-portal-demo',
      'metadata[reservation]': real ?? undefined,
      // Stripe adds nothing to return_url: the page keeps the session id in the tab (sessionStorage) and checks it on return.
      return_url: `${back}${back.includes('?') ? '&' : '?'}verified=1`,
    });
    if (real) await markStay(sql, real, null, { identityVs: v.id });
    return Response.json(pk ? { ok: true, id: v.id, clientSecret: v.client_secret, publishableKey: pk } : { ok: true, url: v.url, id: v.id });
  } catch (e) { return bad(e instanceof Error ? e.message : String(e), 502); }
}

export async function guestIdentityState(sql: SqlFn, encryptionKey: string, id: string, stayToken?: string | null): Promise<Response> {
  if (!/^vs_[A-Za-z0-9]{10,200}$/.test(id)) return bad('Bad session.');
  const real = stayToken ? await stayId(encryptionKey, stayToken) : null;
  const k = real ? await anyKey(sql, encryptionKey) : await sandbox(sql, encryptionKey);
  if (k instanceof Response) return k;
  try {
    const v = await stripeCall<{ status: string; last_error?: { reason?: string } | null }>(k.key, 'GET', `/identity/verification_sessions/${id}`);
    // Only the session this stay started counts for it (a session id from another stay changes nothing).
    if (real && (v.status === 'verified' || v.status === 'processing')) {
      const [row] = await sql`SELECT identity_vs FROM guest_flows WHERE account_id = 1 AND reservation_id = ${real}` as { identity_vs: string | null }[];
      if (row?.identity_vs === id) await markStay(sql, real, null, { identityOk: true });
    }
    // processing = submitted, Stripe is checking (seconds); verified = match. requires_input = failed or left.
    return Response.json({ ok: true, done: v.status === 'verified' || v.status === 'processing', status: v.status,
      message: v.status === 'requires_input' ? (v.last_error?.reason ?? 'Verification was not finished.') : undefined }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return bad(e instanceof Error ? e.message : String(e), 502); }
}

/**
 * An extra paid on the real stay link (Phase 2): the team's to-do, once per Stripe session — early check-in / late
 * check-out (cleaner + the hours in Hostaway), extra nights (extend the reservation; Kaizen does not write it yet),
 * a mid-stay clean, crib, basket, parking. The money is already in guest_payments.
 */
async function extraTodo(sql: SqlFn, encryptionKey: string, s: Session, reservation: string) {
  const [seen] = await sql`SELECT 1 FROM todos WHERE account_id = 1 AND reservation_id = ${reservation} AND description LIKE ${'%' + s.id + '%'} LIMIT 1` as unknown[];
  if (seen) return;
  const m = s.metadata ?? {};
  const what = decodeLines(m.lines).map(l => `${l.label} $${l.amount}`).join(', ') || 'an extra';
  const [t] = await sql`INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority, due_on, reservation_id, reservation_label)
                        VALUES (1, ${`Guest paid in the portal: ${what}`.slice(0, 300)},
                                ${`Paid by card in the guest portal (Stripe ${s.id}). Set it up: early check-in / late check-out → the cleaner and the hours in Hostaway; extra nights → extend the reservation in Hostaway; a clean, crib, basket or parking → prepare it.`},
                                ${m.unit ? [m.unit] : []}, 'Guest portal', 'task', 'pending', 'urgent', ${todayIn('America/New_York')}::date, ${reservation},
                                ${[m.guest, m.unit_name].filter(Boolean).join(' · ') || null})
                        RETURNING id::text AS id` as { id: string }[];
  if (t) await mirrorTodos(sql, encryptionKey, [t.id], 'Guest portal').catch(() => {});
}
