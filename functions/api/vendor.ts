/**
 * /api/vendor — a handyman signed in with the email in the vendor directory
 * (§137): their open work orders, and the same steps as their link.
 *
 *   GET [?period=YYYY-MM-DD]     their work orders not closed (and those closed in the last 7 days),
 *                                and their pay: the invoice of that period (owner, 2026-10-25)
 *   POST { todoId, action, … }   a step (multipart for photos and receipts) — only on one of theirs
 *
 * The `vendor` permission opens only this route (roles.ts); who they are
 * comes from the sign-in (accessOf), never from the request.
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { vendorGet, vendorPost } from '../_lib/vendor-door.ts';

async function me(request: Request, env: Env, sql: SqlFn): Promise<string | Response> {
  const who = identify(request, env);
  if (!who) return unauthorised();
  // Local dev has no Access: ?as=<vendor> stands in for signing in as them.
  const as = new URL(request.url).searchParams.get('as');
  if (who.local && as) return as;
  const a = await accessOf(sql, who);
  return a.vendor ?? Response.json({ ok: false, error: 'not_a_vendor', message: 'This page is for handymen signing in with the email the team has for them.' }, { status: 403 });
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;
  const v = await me(request, env, sql);
  return v instanceof Response ? v : vendorGet(request, env, sql, v);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const sql = db(env) as unknown as SqlFn;
  const v = await me(request, env, sql);
  return v instanceof Response ? v : vendorPost(request, env, sql, v, waitUntil);
};
