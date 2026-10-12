/**
 * /api/crew-link — the same page as /api/crew, opened by a cleaner's
 * secret link instead of a sign-in (§122). The fallback for someone the
 * code-by-email does not work for.
 *
 * It only answers once Cloudflare Access lets /crew, /assets/* and this
 * route through without a sign-in. Because that bypass means anyone can
 * reach it — and send any header they like — this route reads NO identity
 * header: the `X-Crew-Token` secret is the only credential, matched by its
 * SHA-256. A token that matches nothing is refused the same way as none.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { cleanerByToken, crewGet, crewPost, refuse, type CrewCaller } from '../_lib/crew.ts';

async function caller(request: Request, sql: SqlFn): Promise<CrewCaller | Response> {
  const token = request.headers.get('X-Crew-Token') ?? '';
  const name = token ? await cleanerByToken(sql, token) : null;
  if (name) return { name, by: `link:${name}` };
  return refuse(403, 'bad_link', 'This link is not valid any more — ask the team for a new one.');
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;
  const me = await caller(request, sql);
  return me instanceof Response ? me : crewGet(request, env, sql, me);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const sql = db(env) as unknown as SqlFn;
  const me = await caller(request, sql);
  return me instanceof Response ? me : crewPost(request, env, sql, me, waitUntil);
};
