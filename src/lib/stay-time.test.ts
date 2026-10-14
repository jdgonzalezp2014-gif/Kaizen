import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourOf, timeOfHour, hourWord, HOURS, syncLogLine, syncState, stayTime, isAgreedTime, nightToBlock, timeReminder,
         type TimePush } from './stay-time.ts';

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

test('sync state: Kaizen holds a time until Hostaway confirms it', () => {
  assert.deepEqual(syncState('4:00 PM', 10, undefined), { state: 'pending' });
  assert.deepEqual(syncState('4:00 PM', 10, push({ outcome: 'failed', detail: 'nope' })), { state: 'failed', detail: 'nope' });
  // A failure about an older hour says nothing about this one.
  assert.deepEqual(syncState('2:00 PM', 10, push({ outcome: 'failed', detail: 'nope' })), { state: 'pending' });
});

test("sync state: with nothing held, the reservation's own hour is the answer", () => {
  assert.equal(syncState(null, 10, undefined), null);
  assert.deepEqual(syncState(null, 16, push({})), { state: 'sent', hour: 16, standard: false });
  assert.deepEqual(syncState(null, 10, push({ standard: true, hour: 10 })), { state: 'sent', hour: 10, standard: true });
  // Changed by hand in Hostaway since: the board shows that, no badge.
  assert.equal(syncState(null, 18, push({})), null);
});

test('the board reads Kaizen first, then the reservation, then the default', () => {
  assert.deepEqual(stayTime('4:00 PM', 10, '10:00 AM'), { time: '4:00 PM', from: 'kaizen' });
  assert.deepEqual(stayTime(null, 16, '10:00 AM'), { time: '4:00 PM', from: 'hostaway' });
  assert.deepEqual(stayTime(null, null, '10:00 AM'), { time: '10:00 AM', from: 'default' });
  assert.deepEqual(stayTime(null, 0, '10:00 AM'), { time: '12:00 AM', from: 'hostaway' });
});

test('an agreed time is one off the listing standard', () => {
  assert.equal(isAgreedTime('hostaway', 16, 10), true);
  assert.equal(isAgreedTime('hostaway', 10, 10), false);
  assert.equal(isAgreedTime('hostaway', 18, null), false);
  assert.equal(isAgreedTime('kaizen', 10, 10), true);
  assert.equal(isAgreedTime('default', null, 10), false);
});

test('the night is blocked only after a later check-out with nobody arriving that day', () => {
  assert.equal(nightToBlock('checkout', '2026-10-14', 16, 10, null), '2026-10-14');
  assert.equal(nightToBlock('checkout', '2026-10-14', 16, 10, '2026-10-16'), '2026-10-14');
  assert.equal(nightToBlock('checkout', '2026-10-14', 16, 10, '2026-10-14'), null);
  assert.equal(nightToBlock('checkout', '2026-10-14', 9, 10, null), null);
  assert.equal(nightToBlock('checkout', '2026-10-14', 10, 10, null), null);
  assert.equal(nightToBlock('checkin', '2026-10-14', 12, 16, null), null);
});

test('the log line carries the check and the night', () => {
  assert.equal(syncLogLine('checkout', 16, false, true, null, { checkedWith: 'Irene', night: { date: '2026-10-14', ok: true } }),
    '⇄ Hostaway: check-out 4 PM · checked with Irene · night of 2026-10-14 blocked');
  assert.equal(syncLogLine('checkout', 16, false, true, null, { night: { date: '2026-10-14', ok: false, detail: 'booked' } }),
    '⇄ Hostaway: check-out 4 PM · ⚠ night of 2026-10-14 not blocked — booked');
});

test('the reminder speaks the reader\'s language', () => {
  const m = { unit: 'Amber Valley', date: '2026-10-14', kind: 'checkout' as const, hour: 16, cleaner: 'Irene', night: '2026-10-14' };
  assert.equal(timeReminder('en', m),
    '⏰ *Amber Valley* 2026-10-14: check-out moved to *4 PM* — the clean starts after it. Checked with Irene. The night of 2026-10-14 is blocked.');
  assert.match(timeReminder('es', m), /el check-out ahora es a las \*4 PM\*.*La noche del 2026-10-14 quedó bloqueada/);
});
