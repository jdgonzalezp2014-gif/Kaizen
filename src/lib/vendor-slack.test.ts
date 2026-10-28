import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daySummary, newWorkMessage } from './vendor-slack.ts';

const L = 'https://k/crew#v=x';
const av = (title: string, day: string | null = '2026-10-28') => ({ title, unit: 'Amber Valley', day });

test('a new job is one line: the job, the house, the page — the handyman mentioned', () => {
  const m = newWorkMessage([av('Towel bar <broken>')], L, 'U1')!;
  assert.equal(m.blocks[0]!.text.text, '🔧 <@U1> New job at *Amber Valley*: Towel bar &lt;broken&gt; · <https://k/crew#v=x|Open ›>');
  assert.equal(newWorkMessage([av('a'), av('b')], L)!.blocks[0]!.text.text, '🔧 2 jobs new at *Amber Valley* · <https://k/crew#v=x|Open ›>');
  assert.match(newWorkMessage([av('a'), { title: 'b', unit: 'Bobcat', day: null }], L)!.blocks[0]!.text.text, /2 jobs new — Amber Valley 1 · Bobcat 1/);
  assert.equal(newWorkMessage([], L), null);
});

test('the day summary counts per house, most first, and says how many are today', () => {
  const js = [av('a'), av('b'), { title: 'c', unit: 'Bobcat', day: '2026-10-30' }];
  const t = daySummary(js, L, '2026-10-28', 'U1')!.blocks[0]!.text.text;
  assert.match(t, /^☀️ <@U1> 3 jobs open in 2 houses — Amber Valley 2 · Bobcat 1 · \*2 today\* \(Wed, Oct 28\) · </);
  assert.doesNotMatch(daySummary(js, L, '2026-10-29')!.blocks[0]!.text.text, /today/);
  assert.equal(daySummary([], L, '2026-10-28'), null, 'nothing open, nothing sent');
});
