import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signPayee, verifyPayee } from './payouts.ts';

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

test('a payee setup link opens only for that payee, untampered and within 30 days', async () => {
  const now = Date.UTC(2026, 9, 25);
  const t = await signPayee(KEY, 'vendor', 'Tim', now);
  assert.deepEqual(await verifyPayee(KEY, t, now), { kind: 'vendor', name: 'Tim' });
  assert.deepEqual(await verifyPayee(KEY, t, now + 29 * 86400e3), { kind: 'vendor', name: 'Tim' });
  assert.equal(await verifyPayee(KEY, t, now + 31 * 86400e3), null);
  const [body, sig] = t.split('.');
  const other = Buffer.from(JSON.stringify({ k: 'vendor', n: 'Mallory', e: 9e9 })).toString('base64url');
  assert.equal(await verifyPayee(KEY, `${other}.${sig}`, now), null);
  assert.equal(await verifyPayee(KEY, `${body}.${sig!.slice(0, -2)}xx`, now), null);
  assert.equal(await verifyPayee(Buffer.from(new Uint8Array(32).fill(8)).toString('base64'), t, now), null);
  assert.equal(await verifyPayee(KEY, 'garbage', now), null);
});
