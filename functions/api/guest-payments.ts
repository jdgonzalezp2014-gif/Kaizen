/**
 * GET /api/guest-payments?from=&to= — Revenue → Portal sales (permission `revenue`): every Stripe payment the guest
 * portal took in the window, test ones included (marked, never counted in profit).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { guestPaymentsBetween } from '../_lib/guest-payments.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const q = new URL(request.url).searchParams;
  const from = q.get('from') ?? '', to = q.get('to') ?? '';
  if (!DAY.test(from) || !DAY.test(to)) return Response.json({ ok: false, message: 'Which dates?' }, { status: 400 });
  const payments = await guestPaymentsBetween(db(env) as unknown as SqlFn, from, to);
  return Response.json({ ok: true, payments }, { headers: { 'Cache-Control': 'no-store' } });
};
