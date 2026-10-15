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

/**
 * §162 (owner, 2026-10-15: "too much spam"): something new is one message in the channel; what happens to it after
 * is a reply in its thread, and the first message is redrawn. A fake database and a fake Slack, so nothing is posted.
 */
test('news of a task: one message when new, a thread reply (and the first message redrawn) after', async () => {
  const { encrypt } = await import('./crypto.ts');
  const { notifyTask } = await import('./slack.ts');
  const key = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
  const token = await encrypt('xoxb-test', key);
  const threads: { subject: string; subject_id: string; channel: string; ts: string }[] = [];
  const task = { id: '5', title: 'Fix the AC', kind: 'task', status: 'pending', priority: 'none', assignee: null, due_on: null,
                 reservation_label: null, description: null, parent_id: null, unit: 'P2-4308', is_order: false };
  const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join('?');
    if (q.includes('FROM accounts')) return [{ slack_bot_token_enc: token, slack_signing_secret_enc: null,
      slack_config: { channels: { tasks: { id: 'C1', name: 'ops' } }, appUrl: 'https://k.dev' } }];
    if (q.includes('FROM slack_threads')) return threads.filter(t => t.subject === v[0] && t.subject_id === v[1]).reverse().slice(0, 1);
    if (q.includes('INSERT INTO slack_threads')) { threads.push({ channel: String(v[0]), ts: String(v[1]), subject: String(v[2]), subject_id: String(v[3]) }); return []; }
    if (q.includes('SELECT parent_id')) return [{ parent_id: null, claim_id: null }];
    if (q.includes('FROM todos t')) return [task];
    return [];
  }) as unknown as Parameters<typeof notifyTask>[0];
  const calls: { method: string; body: URLSearchParams }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: { body: string }) => {
    calls.push({ method: url.split('/').pop()!, body: new URLSearchParams(init.body) });
    return new Response(JSON.stringify({ ok: true, ts: '111.1', channel: 'C1' }));
  }) as unknown as typeof fetch;
  try {
    await notifyTask(sql, key, '5', 'created', 'juan@x.com');
    assert.deepEqual(calls.map(c => c.method), ['chat.postMessage']);
    assert.equal(calls[0]!.body.get('channel'), 'C1');
    assert.equal(calls[0]!.body.get('thread_ts'), null);
    assert.match(calls[0]!.body.get('blocks')!, /\?todo=5/);
    calls.length = 0; task.status = 'completed';
    await notifyTask(sql, key, '5', 'completed', 'ana@x.com');
    assert.deepEqual(calls.map(c => c.method), ['chat.postMessage', 'chat.update']);
    assert.equal(calls[0]!.body.get('thread_ts'), '111.1');
    assert.match(calls[0]!.body.get('text')!, /Completed/);
    assert.match(calls[0]!.body.get('blocks')!, /ana/);
    assert.equal(calls[1]!.body.get('ts'), '111.1');
    assert.match(calls[1]!.body.get('text')!, /Done/);
  } finally { globalThis.fetch = realFetch; }
});
