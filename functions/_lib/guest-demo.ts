/**
 * An open demo link for one real unit (owner, 2026-11-15: "use it with an open link") — /crew/guest-demo?house=<token>.
 * The token = unit id + expiry, HMAC-signed with the account's ENCRYPTION_KEY, so only someone handed the link sees that
 * unit's guide (it carries the lockbox code and the Wi-Fi), and it stops working after its days. Served through the
 * public door /api/report-link (?house=… and ?house=…&photo=<id>), so no new Access bypass. Mint with `signHouse()`.
 * The real guest link (/guest/<reservation>.<sig>) will replace this once reservations are read from Hostaway.
 */
import type { SqlFn } from './accounts.ts';
import { driveToken } from './gdrive.ts';
import { guestHouse } from '../api/guest-guide.ts';
import { isPhotoId } from '../../src/lib/checkin.ts';

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function mac(encryptionKey: string, text: string) {
  const k = await crypto.subtle.importKey('raw', unb64u(encryptionKey.replace(/=+$/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`guest-demo:${text}`))));
}

export async function signHouse(encryptionKey: string, unitId: string, days = 14, now = Date.now()): Promise<string> {
  const body = `${unitId}.${Math.floor(now / 1000) + days * 86400}`;
  return `${body}.${await mac(encryptionKey, body)}`;
}

export async function verifyHouse(encryptionKey: string, token: string, now = Date.now()): Promise<string | null> {
  const [unit, exp, sig] = token.split('.');
  if (!unit || !/^\d{1,12}$/.test(unit) || !exp || !sig || Number(exp) * 1000 < now) return null;
  const want = await mac(encryptionKey, `${unit}.${exp}`);
  if (want.length !== sig.length || [...want].reduce((d, c, i) => d | (c.charCodeAt(0) ^ sig.charCodeAt(i)), 0) !== 0) return null;
  return unit;
}

export async function demoHouse(sql: SqlFn, encryptionKey: string, url: URL): Promise<Response> {
  const unit = await verifyHouse(encryptionKey, url.searchParams.get('house') ?? '');
  if (!unit) return Response.json({ ok: false, message: 'This demo link is not valid or has expired.' }, { status: 403 });
  const photo = url.searchParams.get('photo');
  if (photo) return guidePhoto(sql, encryptionKey, unit, photo);
  const house = await guestHouse(sql, unit, encryptionKey, { arrival: url.searchParams.get('arrival'), departure: url.searchParams.get('departure') });
  return house ? Response.json(house, { headers: { 'Cache-Control': 'no-store' } }) : Response.json({ ok: false, message: 'No such unit.' }, { status: 404 });
}

/** A photo of a unit's arrival guide — only one its own guide (or its building's shared one) names. Also the stay link's. */
export async function guidePhoto(sql: SqlFn, encryptionKey: string, unit: string, photo: string): Promise<Response> {
    // Only a photo this unit's own guide (or its building's shared one) names.
    if (!isPhotoId(photo)) return new Response('Which photo?', { status: 400 });
    const [named] = await sql`SELECT 1 AS ok FROM checkin_guides g, jsonb_array_elements(g.steps) s
                               WHERE g.account_id = 1 AND s->'photos' ? ${photo}
                                 AND (g.unit_id = ${unit} OR g.unit_id = (SELECT uses FROM checkin_guides WHERE account_id = 1 AND unit_id = ${unit})) LIMIT 1` as { ok: number }[];
    if (!named) return new Response('No such photo.', { status: 404 });
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(photo)}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${await driveToken(sql, encryptionKey)}` } });
    const type = res.headers.get('Content-Type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return new Response('Photo unavailable.', { status: 502 });
    return new Response(res.body, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' } });
}
