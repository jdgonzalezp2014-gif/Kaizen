/**
 * /api/upsell-charge — carry out an upsell from its case (owner, 2026-11-19; functions/_lib/upsell-charge.ts).
 * Permission `claims` (roles.ts). Makes a card pay link or logs a Resolution Center request; Hostaway is set up only
 * once the payment is confirmed (charge-settle.ts).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { cancelCharge, chargePlan, createCharge, rcNotThere, rcReceived } from '../_lib/upsell-charge.ts';

const answer = (r: { ok: boolean; status?: number }) => {
  const { status, ...rest } = r as { ok: boolean; status?: number };
  return Response.json(rest, { status: r.ok ? 200 : status ?? 400, headers: { 'Cache-Control': 'no-store' } });
};
const crash = (e: unknown) => Response.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, { status: 502 });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const claim = new URL(request.url).searchParams.get('claim') ?? '';
  if (!/^\d{1,15}$/.test(claim)) return Response.json({ ok: false, message: 'Which case?' }, { status: 400 });
  try { return answer(await chargePlan(db(env) as unknown as SqlFn, env.ENCRYPTION_KEY, new URL(request.url).origin, claim)); }
  catch (e) { return crash(e); }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, unknown>;
  try {
    if (b.action === 'create') return answer(await createCharge(sql, env.ENCRYPTION_KEY, new URL(request.url).origin, b, who.email));
    if (b.action === 'received') return answer(await rcReceived(sql, env.ENCRYPTION_KEY, String(b.id ?? ''), b.amount, who.email));
    if (b.action === 'not_there') return answer(await rcNotThere(sql, String(b.id ?? ''), who.email));
    if (b.action === 'cancel') return answer(await cancelCharge(sql, env.ENCRYPTION_KEY, String(b.id ?? ''), who.email));
  } catch (e) { return crash(e); }
  return Response.json({ ok: false, message: 'Unknown action.' }, { status: 400 });
};
