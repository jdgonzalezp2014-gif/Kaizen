/**
 * Guest portal payments (guests module, 2026-11-15): the "Review and pay" step opens Stripe Checkout, Stripe's
 * hosted page (decided for replicability — no publishable key or Apple Pay domain per tenant; see docs/product.md).
 *
 *  POST /api/report-link?checkout=1  { lines, email?, back } → { url }   (a Checkout Session)
 *  GET  /api/report-link?checkout=<cs_…>                     → { paid }  (did the guest finish it?)
 *
 * Same public door as the payee Stripe link, so no new Access bypass. **Sandbox only for now:** the lines come from the
 * page (the demo stay has no reservation behind it), so a live key is refused until the signed /guest/<id> link
 * computes the bill on the server. A hold (security deposit) makes the whole payment manual-capture: the team
 * captures only what is owed after check-out (Stripe allows a partial capture) and the rest is released.
 */
import type { SqlFn } from './accounts.ts';
import { stripeCall, stripeKey } from './payouts.ts';
import { toCents } from '../../src/lib/payouts.ts';

type Line = { label: string; amount: number; kind: 'charge' | 'hold' | 'request'; note?: string };
const bad = (message: string, status = 400) => Response.json({ ok: false, message }, { status });
// Where Stripe may send the guest back: only the portal's own pages, on this host.
const portalPath = (p: unknown): p is string => typeof p === 'string' && /^\/(crew\/guest-demo|guest\/)[^\s]*$/.test(p) && p.length < 600;

async function sandbox(sql: SqlFn, encryptionKey: string) {
  const k = await stripeKey(sql, encryptionKey).catch(() => null);
  if (!k) return bad('Stripe is not set up — Settings → Integrations → Stripe.', 503);
  if (k.mode !== 'test') return bad('Guest payments run in Stripe test mode only for now.', 409);
  return k;
}

export async function guestCheckout(sql: SqlFn, encryptionKey: string, request: Request): Promise<Response> {
  const k = await sandbox(sql, encryptionKey);
  if (k instanceof Response) return k;
  const b = await request.json().catch(() => ({})) as { lines?: Line[]; email?: string; back?: string };
  const lines = (Array.isArray(b.lines) ? b.lines : []).filter(l => l && (l.kind === 'charge' || l.kind === 'hold'));
  if (!lines.length || lines.length > 8) return bad('Nothing to pay.');
  if (lines.some(l => typeof l.label !== 'string' || !(Number(l.amount) > 0) || Number(l.amount) > 5000)) return bad('A line is not valid.');
  if (!portalPath(b.back)) return bad('Bad return page.');
  const origin = new URL(request.url).origin;
  const back = origin + b.back;
  const hold = lines.some(l => l.kind === 'hold');
  const p: Record<string, string | number> = {
    mode: 'payment',
    success_url: `${back}${back.includes('?') ? '&' : '?'}paid={CHECKOUT_SESSION_ID}`,
    cancel_url: back,
    'metadata[source]': 'guest-portal-demo',
    'payment_intent_data[description]': hold ? 'Guest check-in (deposit held, captured after check-out)' : 'Guest check-in',
  };
  if (hold) p['payment_intent_data[capture_method]'] = 'manual';
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
    const s = await stripeCall<{ id: string; url: string }>(k.key, 'POST', '/checkout/sessions', p);
    return Response.json({ ok: true, url: s.url });
  } catch (e) { return bad(e instanceof Error ? e.message : String(e), 502); }
}

export async function guestCheckoutState(sql: SqlFn, encryptionKey: string, id: string): Promise<Response> {
  if (!/^cs_test_[A-Za-z0-9]{10,200}$/.test(id)) return bad('Bad session.');
  const k = await sandbox(sql, encryptionKey);
  if (k instanceof Response) return k;
  try {
    const s = await stripeCall<{ status: string; payment_status: string; amount_total: number }>(k.key, 'GET', `/checkout/sessions/${id}`);
    // A manual-capture (hold) session is complete but "unpaid" until the team captures — complete is what counts here.
    return Response.json({ ok: true, paid: s.status === 'complete', total: s.amount_total / 100 }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return bad(e instanceof Error ? e.message : String(e), 502); }
}
