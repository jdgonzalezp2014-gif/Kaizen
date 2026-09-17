/**
 * Encrypting tenant credentials at rest.
 *
 * A customer's Hostaway API key is full read/write on their bookings and
 * guest data. Storing it in plaintext means a database dump — a leaked
 * backup, a misconfigured read replica, a support engineer with a console
 * — hands over every tenant's account at once.
 *
 * AES-256-GCM via WebCrypto, which exists in both the Workers runtime and
 * Node 24, so one implementation serves the API routes and the scheduled
 * jobs. GCM rather than CBC because it authenticates as well as encrypts:
 * a tampered ciphertext fails to decrypt instead of silently producing
 * garbage that gets sent to Hostaway as a credential.
 *
 * The master key lives in the environment (`ENCRYPTION_KEY`), never in
 * the database. That separation is the entire point — an attacker needs
 * both the dump and the deployment's secrets.
 *
 * Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

const ALGO = 'AES-GCM';
const IV_BYTES = 12;   // 96 bits, the size GCM is specified for

async function importKey(base64Key: string): Promise<CryptoKey> {
  if (!base64Key) throw new Error('ENCRYPTION_KEY is not set.');
  const raw = Uint8Array.from(atob(base64Key), c => c.charCodeAt(0));
  if (raw.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes, got ${raw.length}.`);
  }
  return crypto.subtle.importKey('raw', raw, ALGO, false, ['encrypt', 'decrypt']);
}

/**
 * Returns base64 of `iv || ciphertext`. The IV is random per call and
 * stored alongside — it is not secret, but reusing one with the same key
 * in GCM is catastrophic, so it must never be fixed.
 */
export async function encrypt(plaintext: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(plaintext);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: ALGO, iv }, key, data));

  const joined = new Uint8Array(iv.length + cipher.length);
  joined.set(iv);
  joined.set(cipher, iv.length);
  return btoa(String.fromCharCode(...joined));
}

export async function decrypt(stored: string, base64Key: string): Promise<string> {
  const key = await importKey(base64Key);
  const joined = Uint8Array.from(atob(stored), c => c.charCodeAt(0));
  const iv = joined.slice(0, IV_BYTES);
  const cipher = joined.slice(IV_BYTES);
  const plain = await crypto.subtle.decrypt({ name: ALGO, iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

/**
 * What a settings screen shows instead of the key. Never return the
 * plaintext to a browser — it only ever travels inward.
 */
export function maskKey(plaintext: string): string {
  if (!plaintext) return '';
  return plaintext.length <= 8 ? '••••' : `••••••••${plaintext.slice(-4)}`;
}
