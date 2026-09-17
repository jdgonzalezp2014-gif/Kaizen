/**
 * POST /api/sync-units
 *
 * Refreshes `units` from Hostaway. POST rather than GET because it
 * writes — a GET that mutates gets called by a link prefetcher sooner or
 * later.
 */
import { syncUnits } from '../_lib/sync.ts';
import { db, type Env } from '../_lib/db.ts';
import { userEmail } from '../_lib/auth.ts';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env);
  const creds = { accountId: env.HOSTAWAY_ACCOUNT_ID, apiKey: env.HOSTAWAY_API_KEY };

  try {
    const result = await syncUnits(creds, sql as never);
    return Response.json({ ok: true, by: userEmail(request), ...result });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
};
