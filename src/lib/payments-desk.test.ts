import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureFor, chargesOf, holdEndsOn, holdOf, pickOf, refundable, share, tally } from './payments-desk.ts';

const lines = [{ item: 'waiver', label: 'Damage waiver', amount: 60 }, { item: 'deposit', label: 'Security deposit', amount: 350, hold: true }];

test('charges and hold of a check-in bill', () => {
  assert.equal(chargesOf(lines), 60);
  assert.equal(holdOf(lines), 350);
});

test('refundable: only a captured payment, less what came back', () => {
  assert.equal(refundable({ status: 'paid', amount: 75, refunded: 0 }), 75);
  assert.equal(refundable({ status: 'paid', amount: 75, refunded: 25 }), 50);
  assert.equal(refundable({ status: 'held', amount: 350, refunded: 0 }), 0);
  assert.equal(refundable({ status: 'refunded', amount: 75, refunded: 75 }), 0);
});

test('keeping part of a deposit captures the charges plus what is kept', () => {
  assert.equal(captureFor(lines, 100), 160);
  assert.equal(captureFor(lines, 350), 410);
  assert.equal(captureFor(lines, 351), null);
  assert.equal(captureFor(lines, 0), null);
});

test('a hold ends 7 days after it was made', () => {
  assert.equal(holdEndsOn('2026-11-26T01:59:04Z'), '2026-12-03');
});

test('protection picks', () => {
  const t = tally(['waiver', 'none', 'none', pickOf('deposit'), pickOf(null)]);
  assert.deepEqual(t, { completed: 5, waiver: 1, deposit: 1, none: 2, unknown: 1 });
  assert.equal(share(1, 4), '25%');
  assert.equal(share(1, 0), '—');
});
