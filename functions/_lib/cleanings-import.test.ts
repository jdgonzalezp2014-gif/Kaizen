import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAssignment, readCleaningsLog } from './cleanings-import.ts';

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

test('a Cleanings Log whose header row went blank is read by its fixed order', () => {
  // The live shape, September 2026: every header cell empty but Res ID.
  // Read by name, every row was skipped and the import still said ok.
  const csv = [
    ',,,,,,,,,,,Res ID',
    '2026-09-18 17:31,2026-09-18,P2-1304,Ann,1,Michelle,$35.00,10:00 AM,,⚡,,66238216'
  ].join('\n');
  const { rows, repaired } = readCleaningsLog(csv);
  assert.equal(repaired, true);
  assert.equal(rows[0]!.unit, 'P2-1304');
  assert.equal(rows[0]!.checkout, '2026-09-18');
  assert.equal(rows[0]!.price, '$35.00');
  assert.equal(rows[0]!.time, '10:00 AM');
  assert.equal(rows[0]!.resid, '66238216');
});

test('an intact header is read by name, never by position', () => {
  const csv = 'Unit,Checkout,Cleaner\nCL1250,2026-09-18,Veronica';
  const { rows, repaired } = readCleaningsLog(csv);
  assert.equal(repaired, false);
  assert.equal(rows[0]!.cleaner, 'Veronica');
});

test('a blank header on some OTHER shape is not guessed at', () => {
  const { repaired } = readCleaningsLog(',,Res ID\na,b,1');
  assert.equal(repaired, false);
});
