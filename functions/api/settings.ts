/**
 * GET  /api/settings — what this account looks like, safe for a browser
 * POST /api/settings — save credentials and targets
 *
 * This is the onboarding surface: a new host enters their own Hostaway
 * credentials here rather than someone editing a deployment's
 * environment. That is the whole difference between one installation and
 * a product.
 */
import { getAccount, getCredentials, saveCredentials, type SqlFn } from '../_lib/accounts.ts';
import { getAccessToken, fetchListings } from '../_lib/hostaway.ts';
import { db, type Env } from '../_lib/db.ts';
import { identify, unauthorised } from '../_lib/auth.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;
  const account = await getAccount(sql);
  if (!account) return Response.json({ ok: false, error: 'no_account' }, { status: 404 });

  // Whether Hostaway actually answers, not just whether a key is stored.
  // "Saved" and "working" are different states and a settings screen that
  // conflates them sends people hunting in the wrong place.
  let connection: { ok: boolean; message: string; units?: number } = {
    ok: false, message: 'No Hostaway credentials yet.'
  };

  if (account.hasHostawayKey) {
    try {
      const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
      const listings = await fetchListings(creds);
      connection = {
        ok: true,
        message: `Connected — ${listings.filter(l => l.active).length} active of ${listings.length} listing(s).`,
        units: listings.length
      };
    } catch (err) {
      connection = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  return Response.json({ ok: true, user: who.email, account, connection });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;

  try {
    if (body.hostawayAccountId && body.hostawayApiKey) {
      const accountId = String(body.hostawayAccountId).trim();
      const apiKey = String(body.hostawayApiKey).trim();

      // Verified before it is stored. Saving a credential that does not
      // work moves the failure to somewhere far less obvious than the
      // form the person is currently looking at.
      await getAccessToken({ accountId, apiKey });
      await saveCredentials(sql, env.ENCRYPTION_KEY, accountId, apiKey);
    }

    const targets = ['targetNetPerUnit', 'occFloorPct', 'stayNights'] as const;
    const cols: Record<typeof targets[number], string> = {
      targetNetPerUnit: 'target_net_per_unit',
      occFloorPct: 'occ_floor_pct',
      stayNights: 'stay_nights'
    };
    for (const key of targets) {
      const v = Number(body[key]);
      if (!Number.isFinite(v) || v <= 0) continue;
      // Column name comes from the map above, never from the request.
      if (cols[key] === 'target_net_per_unit') await sql`UPDATE accounts SET target_net_per_unit = ${v} WHERE id = 1`;
      if (cols[key] === 'occ_floor_pct')       await sql`UPDATE accounts SET occ_floor_pct = ${Math.round(v)} WHERE id = 1`;
      if (cols[key] === 'stay_nights')         await sql`UPDATE accounts SET stay_nights = ${Math.round(v)} WHERE id = 1`;
    }

    return Response.json({ ok: true, account: await getAccount(sql) });
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
};
