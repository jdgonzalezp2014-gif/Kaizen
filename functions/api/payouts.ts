/**
 * /api/payouts — paying an invoice, a cleaner's or a handyman's (owner, 2026-10-25).
 * Stripe Connect with Kaizen's key (Settings → Payments), or marked paid by hand.
 *
 *   GET                              Stripe: set up or not, its mode, the balance it can pay from
 *   GET ?kind=cleaner|vendor&payee=  that, plus the payee's Stripe account state and their payouts
 *   POST { action: 'link', kind, payee }   their setup link (made once, good 30 days) — the team sends it
 *   POST { action: 'pay', kind, payee, period, method: 'stripe' | 'manual', note? }
 *                                     pays the invoice of the period starting `period` — rebuilt here,
 *                                     never an amount from the browser
 *   POST { action: 'undo', id }       a payout marked by hand (a Stripe transfer is reversed in Stripe)
 *
 * GET and POST need `payouts` (roles.ts).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { loadCrewPage, refuse } from '../_lib/crew.ts';
import { loadVendorPage } from '../_lib/vendor-pay.ts';
import { accountState, connectAccount, ensureVendor, payeeOf, payInvoice, platformBalance, signPayee, stripeKey, undoPayout,
         type PayeeKind, type ToPay } from '../_lib/payouts.ts';
import { payBlockers } from '../../src/lib/payouts.ts';
import { todayIn } from '../../src/lib/dates.ts';

const kindOf = (v: unknown): PayeeKind | null => v === 'cleaner' || v === 'vendor' ? v : null;
const msg = (e: unknown) => e instanceof Error ? e.message : String(e);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const url = new URL(request.url);
  const s = await stripeKey(sql, env.ENCRYPTION_KEY).catch(() => null);
  const stripe: { configured: boolean; mode: string | null; balance: { available: number; pending: number } | null; problem: string | null } =
    { configured: !!s, mode: s?.mode ?? null, balance: null, problem: null };
  if (s) { try { stripe.balance = await platformBalance(s.key); } catch (e) { stripe.problem = msg(e); } }
  const kind = kindOf(url.searchParams.get('kind'));
  const name = url.searchParams.get('payee');
  if (!kind || !name) return Response.json({ ok: true, stripe });
  const p = await payeeOf(sql, kind, name);
  let account: (Awaited<ReturnType<typeof accountState>> & { mode: string }) | { id: string; mode: string | null; problem: string } | null = null;
  if (p?.account) {
    if (s && p.mode === s.mode) {
      try { account = { ...(await accountState(s.key, p.account)), mode: s.mode }; }
      catch (e) { account = { id: p.account, mode: p.mode, problem: msg(e) }; }
    } else account = { id: p.account, mode: p.mode, problem: s ? `This account is ${p.mode} mode; the key is ${s.mode} — a new link makes one in ${s.mode} mode.` : 'Stripe is not set up.' };
  }
  const payouts = await sql`SELECT id::text, invoice_number AS "invoiceNumber", amount::float AS amount, method, stripe_mode AS "stripeMode",
                                   stripe_transfer_id AS "transferId", note, created_by AS by,
                                   to_char(created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD HH24:MI') AS at
                              FROM payouts WHERE account_id = 1 AND payee_kind = ${kind} AND lower(payee) = lower(${name})
                             ORDER BY period_from DESC LIMIT 12`;
  return Response.json({ ok: true, stripe, payee: p ? { name: p.name, email: p.email, account } : null, payouts },
                       { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, unknown>;

  if (b.action === 'undo') {
    try { await undoPayout(sql, String(b.id ?? '')); } catch (e) { return refuse(400, 'bad_request', msg(e)); }
    return Response.json({ ok: true });
  }

  const kind = kindOf(b.kind);
  let name = String(b.payee ?? '').trim();
  if (!kind || !name) return refuse(400, 'bad_request', 'Whom to pay: a cleaner or a handyman.');

  if (b.action === 'link') {
    const s = await stripeKey(sql, env.ENCRYPTION_KEY);
    if (!s) return refuse(400, 'bad_request', 'Stripe is not set up — add the secret key in Settings → Payments.');
    if (kind === 'vendor') name = await ensureVendor(sql, name);
    const p = await payeeOf(sql, kind, name);
    if (!p) return refuse(404, 'not_found', `${name} is not on the roster.`);
    try { await connectAccount(sql, s, p); } catch (e) { return refuse(502, 'stripe', msg(e)); }
    const link = `${new URL(request.url).origin}/api/report-link?stripe=${encodeURIComponent(await signPayee(env.ENCRYPTION_KEY, kind, p.name))}`;
    const [ph] = kind === 'vendor' ? await sql`SELECT phone FROM vendors WHERE account_id = 1 AND lower(name) = lower(${p.name})` as { phone: string | null }[] : [];
    return Response.json({ ok: true, link, phone: ph?.phone ?? null, mode: s.mode });
  }

  if (b.action === 'pay') {
    const method = b.method === 'manual' ? 'manual' : b.method === 'stripe' ? 'stripe' : null;
    if (!method) return refuse(400, 'bad_request', 'Pay through Stripe, or mark it paid by hand.');
    const note = String(b.note ?? '').trim().slice(0, 300) || null;
    if (method === 'manual' && !note) return refuse(400, 'bad_request', 'Say how it was paid (cash, Zelle, check #…).');
    const period = String(b.period ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) return refuse(400, 'bad_request', 'Which invoice period?');
    // The invoice, rebuilt here exactly as the payee's page shows it.
    let inv: ToPay, unpriced: number, pending: number, open: boolean;
    if (kind === 'cleaner') {
      const page = await loadCrewPage(sql, env.ENCRYPTION_KEY, name, period);
      if (!page) return refuse(404, 'not_found', `${name} is not on the roster.`);
      const i = page.invoice;
      inv = { kind, name: page.cleaner.name, number: i.number, from: i.period.from, to: i.period.to, total: Math.round(i.total * 100) / 100 };
      unpriced = i.unpriced; pending = i.pendingExtras; open = i.open;
    } else {
      const page = await loadVendorPage(sql, name, period);
      if (!page) return refuse(404, 'not_found', `${name} has no work orders and is not in the vendor directory.`);
      const i = page.invoice;
      inv = { kind, name: page.vendor.name, number: i.number, from: i.period.from, to: i.period.to, total: i.total };
      unpriced = i.unpriced; pending = i.pendingCharges; open = i.open;
    }
    if (inv.from !== period) return refuse(400, 'bad_request', 'That is not the start of one of their invoice periods — reload.');
    const stop = payBlockers({ open, total: inv.total, unpriced, pending }, todayIn('America/New_York'), inv.to);
    if (stop.length) return refuse(400, 'not_payable', stop.join(' '));
    try {
      const payout = await payInvoice(sql, env.ENCRYPTION_KEY, inv, method, note, who.email);
      return Response.json({ ok: true, payout });
    } catch (e) { return refuse(409, 'not_paid', msg(e)); }
  }

  return refuse(400, 'bad_request', 'Unknown action.');
};
