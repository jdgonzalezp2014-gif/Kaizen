import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchListings, getAccessToken, type HostawayCredentials, type HostawayToken } from './hostaway.ts';

/** A stand-in Hostaway: counts token requests, and refuses any token in `refused`. */
function stubHostaway(refused = new Set<string>()) {
  const calls = { tokens: 0, listings: [] as string[] };
  let n = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).endsWith('/accessTokens')) {
      calls.tokens++;
      await new Promise(r => setTimeout(r, 5));
      return Response.json({ access_token: `new-${++n}`, expires_in: 731 * 86400 });
    }
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '').replace('Bearer ', '');
    calls.listings.push(auth);
    if (refused.has(auth)) return new Response('no', { status: 403 });
    return Response.json({ result: [], count: 0 });
  }) as typeof fetch;
  return calls;
}
let acct = 0;
const creds = (token: HostawayToken | null, kept: (HostawayToken | null)[] = []): HostawayCredentials => ({
  accountId: `acct-${++acct}`, apiKey: 'k', token, onToken: async t => { kept.push(t); }
});
const later = () => Date.now() + 86400_000;

test('a kept token is reused — no new token is asked for', async () => {
  const calls = stubHostaway();
  await fetchListings(creds({ value: 'kept', expires: later() }));
  assert.equal(calls.tokens, 0);
  assert.deepEqual(calls.listings, ['kept']);
});

test('requests racing for a token share ONE request to Hostaway, and it is kept', async () => {
  const calls = stubHostaway();
  const kept: (HostawayToken | null)[] = [];
  const c = creds(null, kept);
  await Promise.all([getAccessToken(c), getAccessToken(c), getAccessToken(c)]);
  assert.equal(calls.tokens, 1);
  assert.equal(kept.length, 1);
  assert.ok(kept[0]!.value.startsWith('new-'));
});

test('a refused token is dropped, renewed once, and the call retried', async () => {
  const calls = stubHostaway(new Set(['stale']));
  const kept: (HostawayToken | null)[] = [];
  await fetchListings(creds({ value: 'stale', expires: later() }, kept));
  assert.equal(calls.tokens, 1);
  assert.equal(calls.listings.length, 2);                  // refused, then retried
  assert.equal(kept[0], null);                              // the stored copy cleared…
  assert.ok(kept[1]!.value.startsWith('new-'));             // …and replaced
});

test('an expired kept token is not used', async () => {
  const calls = stubHostaway();
  await fetchListings(creds({ value: 'old', expires: Date.now() - 1000 }));
  assert.equal(calls.tokens, 1);
  assert.notEqual(calls.listings[0], 'old');
});
