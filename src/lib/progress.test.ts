import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressAt } from './progress.ts';

test('it never reaches 100% on its own', () => {
  // Completion is the response landing, not a timer expiring. A bar that
  // hits 100% and then waits has told the reader something false.
  assert.ok(progressAt(10_000, 1_000) < 1);
  assert.ok(progressAt(1e9, 1_000) < 1);
});

test('about four fifths of the way at the expected duration', () => {
  const p = progressAt(1_000, 1_000);
  assert.ok(p > 0.75 && p < 0.85, `expected ~0.8, got ${p}`);
});

test('it keeps moving past the estimate instead of freezing', () => {
  // A bar stuck at 95% for eight seconds reads as "broken" when nothing
  // is. Slower is fine; stopped is not.
  const a = progressAt(2_000, 1_000);
  const b = progressAt(4_000, 1_000);
  assert.ok(b > a, 'must still advance after overrunning the estimate');
});

test('it starts at zero and is monotonic', () => {
  assert.equal(progressAt(0, 5_000), 0);
  let prev = -1;
  for (let t = 0; t <= 20_000; t += 250) {
    const p = progressAt(t, 5_000);
    assert.ok(p >= prev, 'progress must never go backwards');
    prev = p;
  }
});

test('a nonsense estimate does not produce a nonsense bar', () => {
  assert.ok(progressAt(500, 0) <= 0.99);
  assert.ok(progressAt(500, -1) >= 0);
});
