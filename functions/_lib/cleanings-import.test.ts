import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAssignment } from './cleanings-import.ts';

test('"not needed" is the absence of a cleaner, not a cleaner', () => {
  // It appeared in the by-cleaner breakdown as though it were a person,
  // and counted as a clean — which inflates the count and makes the
  // average cost per clean look lower than it is.
  const r = readAssignment('🚫 Not needed');
  assert.equal(r.cleaner, null);
  assert.equal(r.assignment, 'not_needed');
});

test('TBD means unassigned, which is not the same as not needed', () => {
  // One is work that will happen and has no name on it yet; the other is
  // work that will not happen. Collapsing them loses the difference.
  const r = readAssignment('❓ TBD');
  assert.equal(r.cleaner, null);
  assert.equal(r.assignment, 'tbd');
});

test('the match is on the words, not the emoji', () => {
  // The emoji is decoration somebody may drop, and a match depending on
  // it would silently stop working the day they did.
  assert.equal(readAssignment('Not needed').assignment, 'not_needed');
  assert.equal(readAssignment('TBD').assignment, 'tbd');
  assert.equal(readAssignment('  tbd  ').assignment, 'tbd');
});

test('a real cleaner keeps their name exactly as written', () => {
  assert.deepEqual(readAssignment('Karina and Marvin'),
    { cleaner: 'Karina and Marvin', assignment: 'assigned' });
  assert.deepEqual(readAssignment('Michelle'),
    { cleaner: 'Michelle', assignment: 'assigned' });
});

test('an empty cell is unassigned, not a cleaner called ""', () => {
  assert.deepEqual(readAssignment(''), { cleaner: null, assignment: 'tbd' });
});
