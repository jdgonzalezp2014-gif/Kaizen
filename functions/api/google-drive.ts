/**
 * GET  /api/google-drive                       who is connected, and the room left
 * POST /api/google-drive { action: 'client', clientId, clientSecret }
 * POST /api/google-drive { action: 'connect' }      → { url } to send the browser to
 * POST /api/google-drive { action: 'disconnect' }
 * POST /api/google-drive { action: 'guestRoot', folder }   where guest IDs and agreements live (§73)
 *
 * Settings' Google Drive panel (§72), under `settings`. The client secret
 * and every token are encrypted with Kaizen's key and never come back to
 * a browser — the panel can say they EXIST, never what they are.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { encrypt } from '../_lib/crypto.ts';
import { DRIVE_SCOPE, about, driveToken, folderIdFromUrl, googleClient, redirectUri } from '../_lib/gdrive.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const r = (await sql`SELECT google_client_id, google_client_secret_enc IS NOT NULL AS has_secret,
                              google_refresh_token_enc IS NOT NULL AS connected, google_drive_email, guest_docs_root_id
                         FROM accounts WHERE id = 1`)[0] as
    { google_client_id: string | null; has_secret: boolean; connected: boolean; google_drive_email: string | null;
      guest_docs_root_id: string | null };
  const out = { ok: true, clientId: r.google_client_id, hasSecret: r.has_secret, connected: r.connected,
                email: r.google_drive_email, redirectUri: redirectUri(request), guestRootId: r.guest_docs_root_id,
                quota: null as null | { usage: number; limit: number | null }, problem: null as string | null };
  if (r.connected) {
    // Asked live, so "connected" means Google still says yes right now.
    try {
      const a = await about(await driveToken(sql, env.ENCRYPTION_KEY));
      out.quota = { usage: Number(a.storageQuota.usage), limit: a.storageQuota.limit ? Number(a.storageQuota.limit) : null };
    } catch (e) { out.problem = e instanceof Error ? e.message : String(e); }
  }
  return Response.json(out);
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, unknown>;

  if (b.action === 'client') {
    const id = String(b.clientId ?? '').trim();
    const secret = String(b.clientSecret ?? '').trim();
    if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) return bad('The client ID ends in .apps.googleusercontent.com.');
    if (secret) {
      await sql`UPDATE accounts SET google_client_id = ${id}, google_client_secret_enc = ${await encrypt(secret, env.ENCRYPTION_KEY)}
                 WHERE id = 1`;
    } else {
      const has = (await sql`SELECT google_client_secret_enc IS NOT NULL AS h, google_client_id FROM accounts WHERE id = 1`)[0];
      if (!has.h || has.google_client_id !== id) return bad('A new client ID needs its client secret too.');
    }
    return Response.json({ ok: true });
  }

  if (b.action === 'connect') {
    const client = await googleClient(sql, env.ENCRYPTION_KEY);
    if (!client) return bad('Save the Google client ID and secret first.');
    const state = crypto.randomUUID();
    await sql`UPDATE accounts SET google_oauth_state = ${state}, google_oauth_state_at = now() WHERE id = 1`;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: client.id, redirect_uri: redirectUri(request), response_type: 'code', scope: DRIVE_SCOPE,
      // Offline + consent: the only way Google hands over a refresh token
      // every time, so a reconnect never ends up without one.
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state
    }).toString();
    return Response.json({ ok: true, url: url.toString() });
  }

  if (b.action === 'guestRoot') {
    // A folder link or a bare ID. Changing it points Kaizen at another
    // tree; the remembered folder IDs are per root, so nothing stale is used.
    const raw = String(b.folder ?? '').trim();
    const id = folderIdFromUrl(raw) ?? (/^[\w-]{10,}$/.test(raw) ? raw : null);
    if (raw && !id) return bad('Paste the Drive folder’s link.');
    await sql`UPDATE accounts SET guest_docs_root_id = ${id} WHERE id = 1`;
    return Response.json({ ok: true });
  }

  if (b.action === 'disconnect') {
    await sql`UPDATE accounts SET google_refresh_token_enc = NULL, google_access_token_enc = NULL,
                     google_token_expires_at = NULL, google_drive_email = NULL WHERE id = 1`;
    return Response.json({ ok: true });
  }
  return bad('Unknown action.');
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: message }, { status: 400 });
}
