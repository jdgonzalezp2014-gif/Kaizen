import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeOf, diffLooks, runsOf, isBlockChange, type ChangeRow } from './calendar-watch.ts';

test('codeOf maps Hostaway statuses', () => {
  assert.equal(codeOf('available'), 'a');
  assert.equal(codeOf('Blocked'), 'b');
  assert.equal(codeOf('reserved'), 'r');
  assert.equal(codeOf('something-new'), '?');
});

test('diffLooks compares only the days both looks cover', () => {
  const prev = { from: '2026-10-27', codes: 'aaab', notes: {} };
  // A day later: the 27th left the window, the 31st is new — neither is a change.
  const next = { from: '2026-10-28', codes: 'abaab', notes: { '2026-10-29': 'owner stay' } };
  assert.deepEqual(diffLooks(prev, next), [
    { day: '2026-10-29', was: 'a', now: 'b', note: 'owner stay' },
    { day: '2026-10-30', was: 'b', now: 'a', note: null }
  ]);
});

test('diffLooks keeps the old note when a block is taken off', () => {
  const prev = { from: '2026-11-01', codes: 'b', notes: { '2026-11-01': 'repair' } };
  assert.equal(diffLooks(prev, { from: '2026-11-01', codes: 'a', notes: {} })[0]!.note, 'repair');
});

test('runsOf joins consecutive nights changed the same way in one look', () => {
  const row = (day: string, now: 'b' | 'r' = 'b', unitId = 'u1'): ChangeRow =>
    ({ unitId, day, was: 'a', now, note: null, seenAt: 't1', since: 't0' });
  const runs = runsOf([row('2026-12-20'), row('2026-12-21'), row('2026-12-22'), row('2026-12-24'), row('2026-12-25', 'r')]);
  assert.deepEqual(runs.map(r => [r.first, r.last, r.nights, r.now]), [
    ['2026-12-20', '2026-12-22', 3, 'b'], ['2026-12-24', '2026-12-24', 1, 'b'], ['2026-12-25', '2026-12-25', 1, 'r']
  ]);
});

test('isBlockChange is a block put on or taken off', () => {
  assert.equal(isBlockChange({ was: 'a', now: 'b' }), true);
  assert.equal(isBlockChange({ was: 'b', now: 'r' }), true);
  assert.equal(isBlockChange({ was: 'a', now: 'r' }), false);
});
