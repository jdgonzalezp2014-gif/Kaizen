/**
 * Google Drive — the Repository's file store (§72).
 *
 * One Google account, connected once from Settings with offline access;
 * Kaizen acts as it. Files land in the folders the old repository already
 * built (record folder → one subfolder per document column), so Drive
 * reads the same whether a file came from the old app or from Kaizen.
 *
 * The access token is kept (encrypted, with its expiry) like Hostaway's:
 * minting one on every upload would add a round trip to Google each time.
 */
import type { SqlFn } from './accounts.ts';
import { decrypt, encrypt } from './crypto.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
/** Full Drive: writing into folders Kaizen did not create needs it (drive.file cannot). */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const FOLDER = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,size,webViewLink,modifiedTime';

export class DriveError extends Error {}

/** Where Google returns after "Allow" — registered as is in the Google client. */
export const redirectUri = (request: Request) => `${new URL(request.url).origin}/api/google-callback`;

export interface DriveFile { id: string; name: string; mimeType: string; size?: string; webViewLink: string; modifiedTime: string }

/** The OAuth client, decrypted, or null when Settings has none. */
export async function googleClient(sql: SqlFn, key: string): Promise<{ id: string; secret: string } | null> {
  const r = (await sql`SELECT google_client_id, google_client_secret_enc FROM accounts WHERE id = 1`)[0] as
    { google_client_id: string | null; google_client_secret_enc: string | null } | undefined;
  if (!r?.google_client_id || !r.google_client_secret_enc) return null;
  return { id: r.google_client_id, secret: await decrypt(r.google_client_secret_enc, key) };
}

/**
 * A working access token, or a DriveError that says what a person must
 * do. Refreshed a minute before it expires; a refused refresh (the
 * access was revoked in the Google account) says to reconnect.
 */
export async function driveToken(sql: SqlFn, key: string): Promise<string> {
  const r = (await sql`SELECT google_refresh_token_enc, google_access_token_enc,
                              extract(epoch FROM google_token_expires_at) * 1000 AS exp
                         FROM accounts WHERE id = 1`)[0] as
    { google_refresh_token_enc: string | null; google_access_token_enc: string | null; exp: string | null } | undefined;
  if (!r?.google_refresh_token_enc) throw new DriveError('Google Drive is not connected — an admin connects it in Settings.');
  if (r.google_access_token_enc && Number(r.exp) - 60_000 > Date.now()) return decrypt(r.google_access_token_enc, key);

  const client = await googleClient(sql, key);
  if (!client) throw new DriveError('The Google client is missing in Settings.');
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, grant_type: 'refresh_token',
                                refresh_token: await decrypt(r.google_refresh_token_enc, key) })
  });
  const body = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !body.access_token) {
    throw new DriveError(body.error === 'invalid_grant'
      ? 'Google no longer accepts Kaizen’s access to Drive — reconnect it in Settings.'
      : `Google refused a Drive token (${body.error ?? res.status}).`);
  }
  const expires = new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString();
  await sql`UPDATE accounts SET google_access_token_enc = ${await encrypt(body.access_token, key)},
                                google_token_expires_at = ${expires} WHERE id = 1`;
  return body.access_token;
}

/** Exchange the code Google returned for tokens (the Settings connect flow). */
export async function exchangeCode(client: { id: string; secret: string }, code: string, redirectUri: string) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, code,
                                grant_type: 'authorization_code', redirect_uri: redirectUri })
  });
  const body = await res.json().catch(() => ({})) as
    { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) throw new DriveError(body.error_description ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

async function drive<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  if (!res.ok) {
    const e = await res.json().catch(() => ({})) as { error?: { message?: string } };
    throw new DriveError(`Drive: ${e.error?.message ?? `HTTP ${res.status}`}`);
  }
  return (res.status === 204 ? {} : await res.json()) as T;
}

/** Who is connected, and how much room is left — for Settings. */
export const about = (token: string) =>
  drive<{ user: { emailAddress: string; displayName: string }; storageQuota: { limit?: string; usage: string } }>(
    token, `${API}/about?fields=user(emailAddress,displayName),storageQuota(limit,usage)`);

export const folderIdFromUrl = (url: string | null | undefined): string | null =>
  /\/folders\/([\w-]{10,})/.exec(url ?? '')?.[1] ?? /[?&]id=([\w-]{10,})/.exec(url ?? '')?.[1] ?? null;
export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`;

export const parentOf = async (token: string, id: string): Promise<string | null> =>
  (await drive<{ parents?: string[] }>(token, `${API}/files/${id}?fields=parents&supportsAllDrives=true`)).parents?.[0] ?? null;

export const createFolder = (token: string, parent: string | null, name: string) =>
  drive<DriveFile>(token, `${API}/files?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) })
  });

/** An empty Google Doc or Sheet, made in place. */
export const createGoogleFile = (token: string, parent: string, name: string, kind: 'doc' | 'sheet') =>
  drive<DriveFile>(token, `${API}/files?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parent],
      mimeType: kind === 'sheet' ? 'application/vnd.google-apps.spreadsheet' : 'application/vnd.google-apps.document' })
  });

/**
 * One file into a folder. Resumable, always: Drive's one-request upload
 * stops at 5 MB, and a lease scan is often more.
 */
export async function uploadFile(token: string, parent: string, name: string, mimeType: string,
                                 bytes: ArrayBuffer): Promise<DriveFile> {
  const start = await fetch(`${UPLOAD}/files?uploadType=resumable&supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8',
               'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(bytes.byteLength) },
    body: JSON.stringify({ name, parents: [parent] })
  });
  const session = start.headers.get('Location');
  if (!start.ok || !session) {
    const e = await start.json().catch(() => ({})) as { error?: { message?: string } };
    throw new DriveError(`Drive refused the upload: ${e.error?.message ?? `HTTP ${start.status}`}`);
  }
  const put = await fetch(session, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: bytes });
  if (!put.ok) throw new DriveError(`Drive did not take the file (HTTP ${put.status}).`);
  return await put.json() as DriveFile;
}

export const renameFile = (token: string, id: string, name: string) =>
  drive<DriveFile>(token, `${API}/files/${id}?supportsAllDrives=true&fields=${FILE_FIELDS}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  });

/** To Drive's trash — restorable for 30 days, as the old repository did. */
export const trashFile = (token: string, id: string) =>
  drive<DriveFile>(token, `${API}/files/${id}?supportsAllDrives=true&fields=id`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true })
  });
