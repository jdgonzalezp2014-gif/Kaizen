/**
 * /api/stripe-domains (Settings → Integrations → Stripe, 2026-11-16) — the web domains Stripe may show Apple Pay /
 * Google Pay on when the payment sits inside our own page (Embedded Checkout). Apple requires each domain to be
 * registered with Stripe; Google Pay does not, but Stripe lists both. Registered with the account's own secret key,
 * so each tenant registers its own domains (docs/product.md).
 *   GET               → { domains: [{ domain, applePay, googlePay }] , here }
 *   POST { domain }   → registers it (or answers that it already is)
 * Permission `settings`.
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { can } from '../_lib/roles.ts';
import { stripeCall, stripeKey } from '../_lib/payouts.ts';

type PMD = { id: string; domain_name: string; enabled: boolean; apple_pay?: { status?: string }; google_pay?: { status?: string } };
const shape = (d: PMD) => ({ domain: d.domain_name, enabled: d.enabled, applePay: d.apple_pay?.status ?? null, googlePay: d.google_pay?.status ?? null });

async function gate(request: Request, env: Env) {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  if (!can((await accessOf(sql, who)).permissions, 'settings')) return Response.json({ ok: false, message: 'Settings permission needed.' }, { status: 403 });
  const k = await stripeKey(sql, env.ENCRYPTION_KEY).catch(() => null);
  if (!k) return Response.json({ ok: false, message: 'Save the Stripe secret key first.' }, { status: 400 });
  return k;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const k = await gate(request, env);
  if (k instanceof Response) return k;
  try {
    const r = await stripeCall<{ data: PMD[] }>(k.key, 'GET', '/payment_method_domains', { limit: 50 });
    return Response.json({ ok: true, mode: k.mode, here: new URL(request.url).hostname, domains: r.data.map(shape) });
  } catch (e) { return Response.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, { status: 502 }); }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const k = await gate(request, env);
  if (k instanceof Response) return k;
  const b = await request.json().catch(() => ({})) as { domain?: string };
  const domain = String(b.domain ?? '').trim().toLowerCase();
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(domain)) return Response.json({ ok: false, message: 'Type a domain like stay.example.com.' }, { status: 400 });
  try {
    const d = await stripeCall<PMD>(k.key, 'POST', '/payment_method_domains', { domain_name: domain });
    return Response.json({ ok: true, domain: shape(d) });
  } catch (e) { return Response.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, { status: 502 }); }
};
