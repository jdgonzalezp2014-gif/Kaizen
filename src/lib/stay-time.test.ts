import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourOf, timeOfHour, hourWord, HOURS, syncLogLine, syncState, type TimePush } from './stay-time.ts';

test('a whole hour reads as Hostaway keeps it', () => {
  assert.equal(hourOf('4:00 PM'), 16);
  assert.equal(hourOf('10:00 AM'), 10);
  assert.equal(hourOf('12:00 PM'), 12);
  assert.equal(hourOf('12:00 AM'), 0);
  assert.equal(hourOf('4:00pm'), 16);
});

test('a half hour is not an hour — it is never rounded', () => {
  assert.equal(hourOf('10:30 AM'), null);
  assert.equal(hourOf(''), null);
  assert.equal(hourOf(null), null);
  assert.equal(hourOf('16:00'), null);
});

test('every hour round-trips through the board format', () => {
  for (const h of HOURS) assert.equal(hourOf(timeOfHour(h)), h);
  assert.equal(HOURS.length, 24);
  assert.equal(timeOfHour(0), '12:00 AM');
  assert.equal(hourWord(16), '4 PM');
  assert.equal(hourWord(12), '12 PM');
});

test('the log line says what reached Hostaway, or why not', () => {
  assert.equal(syncLogLine('checkout', 16, false, true), '⇄ Hostaway: check-out 4 PM');
  assert.equal(syncLogLine('checkin', 16, true, true), "⇄ Hostaway: check-in 4 PM (the listing's standard)");
  assert.equal(syncLogLine('checkout', 16, false, false, 'Hostaway answered 403'),
    '⚠ Hostaway: check-out not changed — Hostaway answered 403');
});

const push = (p: Partial<TimePush>): TimePush =>
  ({ hour: 16, standard: false, outcome: 'pushed', detail: null, at: '2026-10-13 10:00', ...p });

test('sync state: sent, failed, or not there yet', () => {
  assert.equal(syncState(null, undefined), null);
  assert.deepEqual(syncState('4:00 PM', undefined), { state: 'pending' });
  assert.deepEqual(syncState('4:00 PM', push({})), { state: 'sent', hour: 16, standard: false });
  assert.deepEqual(syncState('4:00 PM', push({ outcome: 'failed', detail: 'nope' })), { state: 'failed', detail: 'nope' });
  // The last send was 4 PM; Kaizen now holds 2 PM — that one has not landed.
  assert.deepEqual(syncState('2:00 PM', push({})), { state: 'pending' });
  // Back to the standard: only a standard send answers it.
  assert.deepEqual(syncState(null, push({})), { state: 'pending' });
  assert.deepEqual(syncState(null, push({ standard: true, hour: 10 })), { state: 'sent', hour: 10, standard: true });
});
