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
  // An exact word beats a prefix: "Shan Eviction" over "evict Shan" (the real case, 2026-10-14).
  const shan: AddTarget[] = [{ value: 'task:1', label: 'Shan Eviction', group: 'task', words: 'Shan Eviction CL2260' },
                             { value: 'task:2', label: 'court room hearing to evict Shan', group: 'task', words: 'court room hearing to evict Shan from 2260 CL2260' }];
  assert.equal(suggestTarget('Here is the judgment file for the Shan eviction', shan)?.value, 'task:1');
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

test('the guess comes chosen in its menu; the channel’s last target counts by itself; recent work breaks a tie', () => {
  const pick = (b: unknown[], id: string) => JSON.parse(JSON.stringify(b)).flatMap((x: { elements?: { action_id: string; initial_option?: { value: string } }[] }) => x.elements ?? [])
    .find((e: { action_id: string }) => e.action_id === id)?.initial_option?.value;
  assert.equal(pick(addToBlocks(T, { channel: 'C', ts: '1' }, T[2]), 'addto_task'), 'task:5');
  assert.equal(pick(addToBlocks(T, { channel: 'C', ts: '1' }, T[2]), 'addto_other'), undefined);
  assert.equal(pick(addToBlocks(T, { channel: 'C', ts: '1' }, T[0]), 'addto_other'), 'claim:1');
  assert.equal(pick(addToBlocks(T, { channel: 'C', ts: '1' }, null), 'addto_task'), undefined);
  // "the deputy will call me back" — no words in common, but the channel was just adding to the eviction.
  assert.equal(suggestTarget('the deputy will call me back', T, 'claim:1')?.value, 'claim:1');
  assert.equal(suggestTarget('the deputy will call me back', T, null), null);
  // A word that matches beats the channel's memory ("Test 2 Truvi" offered the towels, 2026-10-14).
  assert.equal(suggestTarget('Test 2 Truvi', T, 'task:6')?.value, 'task:5');
  // …and so does a typo of it ("Tuvi will run background checks").
  assert.equal(suggestTarget('Tuvi will run backgorund checks', T, 'task:6')?.value, 'task:5');
  const tie: AddTarget[] = [{ value: 'task:1', label: 'A', group: 'task', words: 'fix door Concord' },
                            { value: 'task:2', label: 'B', group: 'task', words: 'paint door Concord', recent: true }];
  assert.equal(suggestTarget('the door at Concord', tie)?.value, 'task:2');
});

test('one letter off', async () => {
  const { oneOff } = await import('./slack-addto.ts');
  assert.ok(oneOff('tuvi', 'truvi') && oneOff('truvi', 'tuvi') && oneOff('towls', 'towel') === false && oneOff('towel', 'towels'));
  assert.ok(!oneOff('same', 'same') && !oneOff('door', 'dirt'));
});
