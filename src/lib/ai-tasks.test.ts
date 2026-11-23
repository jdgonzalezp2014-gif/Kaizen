import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSteps, parseAiTasks, plan, stepsFor, LITE, WORKERS_MODEL } from './ai-tasks.ts';

test('defaults keep the order the code had before the screen', () => {
  assert.deepEqual(defaultSteps('assistant').map(s => s.model), [LITE, WORKERS_MODEL, 'claude-haiku-5-5']);
  assert.deepEqual(defaultSteps('orders', { geminiModel: 'gemini-x' }).map(s => s.model), ['gemini-x', LITE, WORKERS_MODEL, 'claude-sonnet-5-5']);
  assert.ok(!defaultSteps('receipts').some(s => s.provider === 'workers'));
  assert.deepEqual(defaultSteps('guest', { guest: { provider: 'gemini', model: 'gemini-y' } }).map(s => s.provider), ['gemini', 'claude']);
  assert.ok(defaultSteps('pricing').every(s => s.provider === 'gemini'));
});

test('saved chains are cleaned: wrong provider for the task, bad ids and repeats dropped, capped at four', () => {
  const p = parseAiTasks({
    pricing: [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'gemini', model: 'gemini-a', on: false }],
    assistant: [1, 2, 3, 4, 5].map(i => ({ provider: 'gemini', model: `gemini-${i}` })),
    triage: [{ provider: 'claude', model: 'x y' }, { provider: 'claude', model: 'claude-haiku-5-5' }, { provider: 'claude', model: 'claude-haiku-5-5' }],
    nope: [{ provider: 'gemini', model: 'gemini-a' }],
  });
  assert.deepEqual(p.pricing, [{ provider: 'gemini', model: 'gemini-a', on: false }]);
  assert.equal(p.assistant!.length, 4);
  assert.deepEqual(p.triage, [{ provider: 'claude', model: 'claude-haiku-5-5', on: true }]);
  assert.ok(!('nope' in p));
});

test('a saved task wins; an unsaved one is its default', () => {
  const raw = { assistant: [{ provider: 'claude', model: 'claude-haiku-5-5' }] };
  assert.deepEqual(stepsFor('assistant', raw).map(s => s.model), ['claude-haiku-5-5']);
  assert.equal(stepsFor('triage', raw)[0]!.model, LITE);
  assert.equal(stepsFor('triage', null)[0]!.model, LITE);
});

test('plan says why a step is skipped', () => {
  const steps = [{ provider: 'gemini' as const, model: 'g', on: true }, { provider: 'workers' as const, model: WORKERS_MODEL, on: true },
                 { provider: 'claude' as const, model: 'c', on: false }];
  assert.deepEqual(plan(steps, { gemini: false, claude: true }, { files: true }).map(r => r.skip), ['no Gemini key', 'cannot read images or PDFs', 'off']);
  assert.deepEqual(plan(steps, { gemini: true, claude: true }).map(r => r.skip), [null, null, 'off']);
});
