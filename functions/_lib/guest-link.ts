/**
 * A stay's guest-portal link: /guest/<reservation id>.<signature> (guests module, agreed 2026-11-05 — Hostaway's ids
 * are sequential, so the id alone would be guessable). The signature is an HMAC of the id with the account's
 * ENCRYPTION_KEY: no token table, and a link can be minted anywhere a reservation id is known (the Inbox, a message
 * template's {{portal_link}}). The portal's own door verifies with `verifyGuest`; it moves to its own domain later
 * (owner, 2026-11-16), so the address in front comes from the account (src/lib/inbox.ts `portalLink`), never from here.
 */
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export async function signGuest(encryptionKey: string, reservationId: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', unb64u(encryptionKey.replace(/=+$/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  // 16 bytes of the MAC: short enough for a text message, far past guessing.
  return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`guest:${reservationId}`))).slice(0, 16));
}

export async function verifyGuest(encryptionKey: string, reservationId: string, sig: string): Promise<boolean> {
  if (!/^\d{1,20}$/.test(reservationId)) return false;
  const want = await signGuest(encryptionKey, reservationId);
  return want.length === sig.length && [...want].reduce((d, c, i) => d | (c.charCodeAt(0) ^ sig.charCodeAt(i)), 0) === 0;
}
