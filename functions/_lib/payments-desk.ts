/**
 * Guest Services → Payments (owner, 2026-11-26; screen src/screens/Payments.tsx, rules src/lib/payments-desk.ts).
 *
 *  GET  /api/payments?days=N  — the portal's payments with their set-up to-dos, the team's upsell charges, the log of
 *                               refunds / released / kept deposits / cancelled charges, the check-ins' protection picks,
 *                               and each active listing's refundable deposit as Hostaway has it now.
 *  POST /api/payments         — { action: 'refund', id, amount, reason } · { action: 'release', id, reason }
 *                               · { action: 'keep', id, amount, reason } · { action: 'cancel-charge', id }
 *
 * Every money action re-reads the payment from Stripe afterwards (recordSession), so the row shows what Stripe says, not
 * what was asked. Idempotency keys make a double click one action.
 */
import type { SqlFn } from './accounts.ts';
import { getCredentials } from './accounts.ts';
import { fetchListingsRaw } from './hostaway.ts';
import { stripeCall, stripeKey } from './payouts.ts';
import { recordSession } from './guest-pay.ts';
import { cancelCharge } from './upsell-charge.ts';
import { captureFor, chargesOf, holdEndsOn, holdOf, pickOf, refundable } from '../../src/lib/payments-desk.ts';
import type { GuestPayment, PaidLine } from '../../src/lib/guest-payments.ts';

const fail = (message: string, status = 400) => ({ ok: false as const, message, status });
const money = (n: number) => `$${n.toFixed(2)}`;

type PayRow = { session_id: string; payment_intent: string | null; livemode: boolean; reservation_id: string | null; unit_id: string | null;
  unit_name: string | null; guest: string | null; lines: PaidLine[]; amount: number; fee: number | null; refunded: number;
  status: GuestPayment['status']; paid_on: string; created_at: string; claim_id: string | null };

export async function paymentsOverview(sql: SqlFn, ek: string, days: number) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const [pays, todos, charges, actions, flows, units] = await Promise.all([
    sql`SELECT session_id, payment_intent, livemode, reservation_id, unit_id, unit_name, guest, lines, amount::float8 AS amount, fee::float8 AS fee,
               refunded::float8 AS refunded, status, paid_on::text AS paid_on, created_at::text AS created_at, claim_id::text AS claim_id
          FROM guest_payments WHERE account_id = 1 AND (created_at >= ${since} OR status = 'held') ORDER BY created_at DESC LIMIT 500` as Promise<PayRow[]>,
    // The set-up to-do of an extra paid in the portal names its Stripe session (guest-pay.ts extraTodo).
    sql`SELECT id::text AS id, status, description FROM todos WHERE account_id = 1 AND created_by = 'Guest portal' AND created_at >= ${since}::timestamptz - interval '1 day'` as Promise<TodoRow[]>,
    sql`SELECT id::text AS id, claim_id::text AS claim_id, reservation_id, unit_name, guest, label, amount::float8 AS amount, status, method,
               created_by, created_at::text AS created_at, paid_at::text AS paid_at, cancelled_at::text AS cancelled_at, cancelled_by
          FROM upsell_charges WHERE account_id = 1 AND (created_at >= ${since} OR status = 'pending') ORDER BY created_at DESC LIMIT 300` as Promise<Record<string, unknown>[]>,
    (sql`SELECT a.id::text AS id, a.session_id, a.kind, a.amount::float8 AS amount, a.reason, a.created_by, a.created_at::text AS created_at,
               p.guest, p.unit_name, p.livemode
          FROM guest_payment_actions a LEFT JOIN guest_payments p ON p.account_id = a.account_id AND p.session_id = a.session_id
         WHERE a.account_id = 1 AND a.created_at >= ${since} ORDER BY a.created_at DESC LIMIT 300` as Promise<Record<string, unknown>[]>)
      // Without migration 128 there is no log yet: the rest of the screen still answers.
      .catch(() => [] as Record<string, unknown>[]),
    sql`SELECT c.reservation_id, c.listing_id, c.source, c.completed_at::text AS completed_at, f.flow->>'protection' AS protection
          FROM guest_checkins c LEFT JOIN guest_flows f ON f.account_id = c.account_id AND f.reservation_id = c.reservation_id
         WHERE c.account_id = 1 AND c.completed_at >= ${since}` as Promise<{ reservation_id: string; listing_id: string | null; source: string; completed_at: string; protection: string | null }[]>,
    sql`SELECT id::text AS id, name FROM units WHERE account_id = 1 AND active ORDER BY name` as Promise<{ id: string; name: string }[]>,
  ]);

  // Hostaway now, not a copy: the field changes by hand in Hostaway too. Not read → null per listing, said on screen.
  const creds = await getCredentials(sql, ek).catch(() => null);
  const raw = creds ? await fetchListingsRaw(creds).catch(() => null) : null;
  const dep = new Map((raw ?? []).map(l => [String(l.id), Number(l.refundableDamageDeposit ?? 0) || 0]));

  const payments = shapePayments(pays, todos);

  const checkins = flows.map(f => ({ reservationId: f.reservation_id, listingId: f.listing_id, source: f.source, completedAt: f.completed_at,
    pick: pickOf(f.protection), depositOn: f.listing_id && raw ? (dep.get(f.listing_id) ?? 0) > 0 : null }));
  const listings = units.map(u => ({ id: u.id, name: u.name, deposit: raw ? (dep.get(u.id) ?? 0) : null,
    picks: checkins.filter(c => c.listingId === u.id).map(c => c.pick) }));

  return { ok: true as const, days, payments, charges, actions, checkins, listings, hostawayRead: !!raw };
}

type TodoRow = { id: string; status: string; description: string };

/** Rows as the screens show them: the set-up to-dos, the hold and its last day, what is left to refund. */
function shapePayments(pays: PayRow[], todos: TodoRow[]) {
  return pays.map(p => {
    const lines = Array.isArray(p.lines) ? p.lines : [];
    const followUps = todos.filter(t => t.description.includes(p.session_id)).map(t => ({ id: t.id, status: t.status, done: t.status === 'completed' || t.status === 'cancelled' }));
    return {
      id: p.session_id, livemode: p.livemode, reservationId: p.reservation_id, unitId: p.unit_id, unitName: p.unit_name, guest: p.guest,
      lines, amount: Number(p.amount), fee: p.fee == null ? null : Number(p.fee), refunded: Number(p.refunded), status: p.status,
      paidOn: p.paid_on, createdAt: p.created_at, claimId: p.claim_id, followUps,
      hold: p.status === 'held' ? holdOf(lines) : 0, holdEndsOn: p.status === 'held' ? holdEndsOn(p.created_at) : null,
      refundable: refundable({ status: p.status, amount: Number(p.amount), refunded: Number(p.refunded) }),
    };
  });
}

/** One stay's payments (the CRM's reservation card, owner 2026-11-26): every payment it made, whatever the date. */
export async function reservationPayments(sql: SqlFn, reservationId: string) {
  const [pays, todos] = await Promise.all([
    sql`SELECT session_id, payment_intent, livemode, reservation_id, unit_id, unit_name, guest, lines, amount::float8 AS amount, fee::float8 AS fee,
               refunded::float8 AS refunded, status, paid_on::text AS paid_on, created_at::text AS created_at, claim_id::text AS claim_id
          FROM guest_payments WHERE account_id = 1 AND reservation_id = ${reservationId} ORDER BY created_at DESC LIMIT 50` as Promise<PayRow[]>,
    sql`SELECT id::text AS id, status, description FROM todos WHERE account_id = 1 AND created_by = 'Guest portal' AND reservation_id = ${reservationId}` as Promise<TodoRow[]>,
  ]);
  return { ok: true as const, payments: shapePayments(pays, todos) };
}

async function paymentOf(sql: SqlFn, id: string) {
  const [p] = await sql`SELECT session_id, payment_intent, lines, amount::float8 AS amount, refunded::float8 AS refunded, status
                          FROM guest_payments WHERE account_id = 1 AND session_id = ${id}` as { session_id: string; payment_intent: string | null; lines: PaidLine[]; amount: number; refunded: number; status: GuestPayment['status'] }[];
  return p ?? null;
}

async function logAction(sql: SqlFn, id: string, kind: 'refund' | 'release' | 'capture', amount: number, reason: string | null, stripeId: string | null, who: string) {
  await sql`INSERT INTO guest_payment_actions (account_id, session_id, kind, amount, reason, stripe_id, created_by)
            VALUES (1, ${id}, ${kind}, ${amount}, ${reason}, ${stripeId}, ${who})`;
}

const cents = (n: number) => Math.round(n * 100);
const reasonOf = (v: unknown) => typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null;

export async function paymentAction(sql: SqlFn, ek: string, b: Record<string, unknown>, who: string) {
  const action = String(b.action ?? '');
  if (action === 'cancel-charge') return cancelCharge(sql, ek, String(b.id ?? ''), who);
  const id = String(b.id ?? '');
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(id)) return fail('Which payment?');
  const p = await paymentOf(sql, id);
  if (!p) return fail('No such payment.', 404);
  if (!p.payment_intent) return fail('Stripe has no payment for it yet — reload.');
  const k = await stripeKey(sql, ek).catch(() => null);
  if (!k) return fail('Stripe is not set up (Settings → Integrations).', 503);
  if (!id.startsWith(`cs_${k.mode}_`)) return fail(`This is a ${k.mode === 'live' ? 'test' : 'live'} payment; Kaizen's Stripe key is ${k.mode}.`);
  const lines = Array.isArray(p.lines) ? p.lines : [];
  const reason = reasonOf(b.reason);

  if (action === 'refund') {
    const amount = Number(b.amount);
    const max = refundable(p);
    if (!(amount > 0) || cents(amount) > cents(max)) return fail(max > 0 ? `Refund between $0.01 and ${money(max)}.` : 'Nothing left to refund.');
    if (!reason) return fail('Say why — the guest\'s folio and the books keep it.');
    // Keyed on what was refunded before, so the same click twice is one refund and a later one is a new one.
    const r = await stripeCall<{ id: string }>(k.key, 'POST', '/refunds', { payment_intent: p.payment_intent, amount: cents(amount),
      'metadata[by]': who, 'metadata[reason]': reason }, `kz-refund-${id}-${cents(p.refunded)}-${cents(amount)}`);
    await logAction(sql, id, 'refund', amount, reason, r.id, who);
  } else if (action === 'release' || action === 'keep') {
    if (p.status !== 'held') return fail('It is not a held deposit any more — reload.');
    const charges = chargesOf(lines), hold = holdOf(lines);
    if (action === 'release') {
      // A check-in bill holds the charges too: capture only them, the deposit goes back. A deposit alone: cancel the hold.
      if (charges > 0) await stripeCall(k.key, 'POST', `/payment_intents/${p.payment_intent}/capture`, { amount_to_capture: cents(charges) }, `kz-release-${id}`);
      else await stripeCall(k.key, 'POST', `/payment_intents/${p.payment_intent}/cancel`, { cancellation_reason: 'requested_by_customer' }, `kz-release-${id}`);
      await logAction(sql, id, 'release', hold, reason, p.payment_intent, who);
    } else {
      const keep = Number(b.amount);
      const total = captureFor(lines, keep);
      if (total == null) return fail(`Keep between $0.01 and ${money(hold)}.`);
      if (!reason) return fail('Say what the deposit pays for (the damage) — the guest is told.');
      await stripeCall(k.key, 'POST', `/payment_intents/${p.payment_intent}/capture`, { amount_to_capture: cents(total) }, `kz-keep-${id}-${cents(total)}`);
      await logAction(sql, id, 'capture', keep, reason, p.payment_intent, who);
    }
  } else return fail('Unknown action.');

  await recordSession(sql, k.key, id, ek).catch(() => null);
  return { ok: true as const };
}
