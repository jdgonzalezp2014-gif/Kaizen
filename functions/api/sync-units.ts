/**
 * POST /api/sync-units
 *
 * Refreshes `units` from Hostaway. POST rather than GET because it
 * writes — a GET that mutates gets called by a link prefetcher sooner or
 * later.
 */
import { syncUnits } from '../_lib/sync.ts';
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;

  try {
    const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
    const result = await syncUnits(creds, sql);
    return Response.json({ ok: true, by: who.email, ...result });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
};
