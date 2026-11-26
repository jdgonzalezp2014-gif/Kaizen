/**
 * /api/payments — Guest Services → Payments (functions/_lib/payments-desk.ts). GET needs `payments`; POST (refund, release
 * or keep a deposit, cancel a charge) needs `payments.refund` — money goes back to a guest, so it is its own trust (roles.ts).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { paymentAction, paymentsOverview } from '../_lib/payments-desk.ts';

const answer = (r: { ok: boolean; status?: number }) => {
  const { status, ...rest } = r as { ok: boolean; status?: number };
  return Response.json(rest, { status: r.ok ? 200 : status ?? 400, headers: { 'Cache-Control': 'no-store' } });
};
const crash = (e: unknown) => Response.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, { status: 502 });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!identify(request, env)) return unauthorised();
  const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get('days')) || 30));
  try { return answer(await paymentsOverview(db(env) as unknown as SqlFn, env.ENCRYPTION_KEY, days)); }
  catch (e) { return crash(e); }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const b = await request.json().catch(() => ({})) as Record<string, unknown>;
  try { return answer(await paymentAction(db(env) as unknown as SqlFn, env.ENCRYPTION_KEY, b, who.email)); }
  catch (e) { return crash(e); }
};
