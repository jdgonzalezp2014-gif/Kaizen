/**
 * /api/crew — a cleaner's own page (§122), signed in through Cloudflare
 * Access (a one-time code by email).
 *
 *   GET  [?period=YYYY-MM-DD]                    their cleans, invoice, extras, schedule
 *   POST { action: 'addExtra', key, amount, description }
 *   POST { action: 'cancelExtra', id }           only while it is still pending
 *
 * Behind Access and the middleware like every route, so the address is
 * Access's word. The middleware already let only a cleaner's role reach
 * it; whose page comes from that address (accessOf), never the request —
 * no cleaner can read another's pay. The secret-link door is a separate
 * route (/api/crew-link) that never trusts an identity header.
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { crewGet, crewPost, refuse, type CrewCaller } from '../_lib/crew.ts';

async function caller(request: Request, env: Env, sql: SqlFn): Promise<CrewCaller | Response> {
  const who = identify(request, env);
  if (!who) return unauthorised();
  // Local dev has no Access: ?as=<name> stands in for signing in as that cleaner.
  const as = new URL(request.url).searchParams.get('as');
  if (who.local && as) return { name: as, by: `local-dev as ${as}` };
  const access = await accessOf(sql, who);
  if (access.cleaner) return { name: access.cleaner, by: who.email };
  return refuse(403, 'not_a_cleaner', 'This page is for cleaners signing in with their own address. The team sees it in Operations → Crew.');
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;
  const me = await caller(request, env, sql);
  return me instanceof Response ? me : crewGet(request, env, sql, me);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const sql = db(env) as unknown as SqlFn;
  const me = await caller(request, env, sql);
  return me instanceof Response ? me : crewPost(request, env, sql, me, waitUntil);
};
