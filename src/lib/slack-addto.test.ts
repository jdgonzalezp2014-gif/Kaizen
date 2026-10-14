import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addToBlocks, sourceOf, suggestTarget, wordsOf, type AddTarget } from './slack-addto.ts';

const T: AddTarget[] = [
  { value: 'claim:1', label: 'CL2260 · Shan Eviction', group: 'claim', words: 'Shan Eviction Legal CL2260' },
  { value: 'claim:2', label: 'P2-4308 · Missing Fob', group: 'claim', words: 'Missing Fob Damage P2-4308' },
  { value: 'task:5', label: 'Complete Truvi Set up', group: 'task', words: 'Complete Truvi Set up' },
  { value: 'task:6', label: 'Buy towels · Concord', group: 'order', words: 'Buy towels Concord' },
  { value: 'task:7', label: 'Fix AC · P2-4308', group: 'work_order', words: 'Fix AC P2-4308' }
];

test('Add to…: the first guess is by words — a unit code weighs most, a name prefix counts', () => {
  assert.deepEqual(wordsOf('The <@U1> fob for P2-4308!'), ['fob', 'p2-4308']);
  assert.equal(suggestTarget('Here is the judgment for Shannon eviction', T)?.value, 'claim:1');
  assert.equal(suggestTarget('Fob still missing at P2-4308', T)?.value, 'claim:2');
  assert.equal(suggestTarget('P2-4308', T), null);        // a tie: the claim and the repair share the unit
  assert.equal(suggestTarget('good morning team', T), null);
});

test('the private reply: tasks in one menu, orders / repairs / claims grouped in the other, the source in the block ids', () => {
  const b = addToBlocks(T, { channel: 'C9', ts: '1.5', thread: null }, T[0]);
  const s = JSON.stringify(b);
  assert.ok(s.includes('Add this to *CL2260 · Shan Eviction*?') && s.includes('addto_yes'));
  assert.ok(s.includes('Add as comment to task') && s.includes('🛒 Purchase orders') && s.includes('🔧 Work orders') && s.includes('⚑ Claims'));
  assert.deepEqual(sourceOf(String((b[1] as { block_id: string }).block_id)), { channel: 'C9', ts: '1.5', thread: null });
  assert.deepEqual(sourceOf('addto_a|C9|1.6|1.5'), { channel: 'C9', ts: '1.6', thread: '1.5' });
  assert.ok(!JSON.stringify(addToBlocks(T.filter(t => t.group === 'claim'), { channel: 'C', ts: '1' })).includes('addto_task'));
});
