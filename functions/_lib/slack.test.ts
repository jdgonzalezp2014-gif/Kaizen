import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySlack } from './slack.ts';

const secret = '8f742231b10e8888abcd99yyyzzz85a5';
const sign = (ts: string, body: string, s = secret) => 'v0=' + createHmac('sha256', s).update(`v0:${ts}:${body}`).digest('hex');

test("Slack's signature: right body, right secret, fresh — or refused", async () => {
  const now = 1_790_000_000_000;
  const ts = String(now / 1000);
  const body = 'command=%2Fkaizen&text=tasks&user_id=U123';
  assert.equal(await verifySlack(secret, ts, body, sign(ts, body), now), true);
  assert.equal(await verifySlack(secret, ts, body + 'x', sign(ts, body), now), false, 'tampered body');
  assert.equal(await verifySlack(secret, ts, body, sign(ts, body, 'another-secret-0000000000000000'), now), false, 'wrong secret');
  const old = String(now / 1000 - 600);
  assert.equal(await verifySlack(secret, old, body, sign(old, body), now), false, 'replayed after 10 minutes');
  assert.equal(await verifySlack(secret, null, body, sign(ts, body), now), false, 'no timestamp');
  assert.equal(await verifySlack(secret, ts, body, null, now), false, 'no signature');
});
