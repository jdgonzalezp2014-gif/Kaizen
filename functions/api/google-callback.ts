/**
 * GET /api/google-callback?code=…&state=…
 *
 * Where Google sends the admin back after "Allow" (§72). The state must be
 * the one Settings just issued, and younger than ten minutes — a code
 * arriving any other way is refused. The refresh token is stored
 * encrypted; the browser is sent back to Settings with a word on how it
 * went, never with a token.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { encrypt } from '../_lib/crypto.ts';
import { about, exchangeCode, googleClient, redirectUri } from '../_lib/gdrive.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const url = new URL(request.url);
  const back = (drive: string) => Response.redirect(`${url.origin}/?drive=${encodeURIComponent(drive)}#settings`, 302);

  if (url.searchParams.get('error')) return back(url.searchParams.get('error')!);
  const code = url.searchParams.get('code') ?? '';
  const state = url.searchParams.get('state') ?? '';
  const ok = (await sql`SELECT 1 FROM accounts WHERE id = 1 AND google_oauth_state = ${state}
                          AND google_oauth_state_at > now() - interval '10 minutes'`).length > 0;
  await sql`UPDATE accounts SET google_oauth_state = NULL WHERE id = 1`;
  if (!code || !ok) return back('expired — try Connect again');

  try {
    const client = await googleClient(sql, env.ENCRYPTION_KEY);
    if (!client) return back('no client');
    const t = await exchangeCode(client, code, redirectUri(request));
    if (!t.refresh_token) return back('Google sent no refresh token — remove Kaizen from the account’s third-party access and connect again');
    if (!String(t.scope ?? '').includes('auth/drive')) return back('Drive access was not granted');
    const who2 = await about(t.access_token!);
    await sql`UPDATE accounts SET google_refresh_token_enc = ${await encrypt(t.refresh_token, env.ENCRYPTION_KEY)},
                     google_access_token_enc = ${await encrypt(t.access_token!, env.ENCRYPTION_KEY)},
                     google_token_expires_at = ${new Date(Date.now() + (t.expires_in ?? 3600) * 1000).toISOString()},
                     google_drive_email = ${who2.user.emailAddress} WHERE id = 1`;
    return back('connected');
  } catch (e) {
    return back(e instanceof Error ? e.message.slice(0, 200) : 'failed');
  }
};
