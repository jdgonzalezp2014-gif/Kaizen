import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureFor, chargesOf, holdEndsOn, holdOf, pickOf, refundable, reminderText, share, tally } from './payments-desk.ts';

test('reminder: card link, or the Airbnb request first', () => {
  assert.equal(reminderText({ first: 'Ravi', unit: 'P2-4304', what: 'damage waiver', amount: 60, method: 'rc', link: 'https://x/guest/1.a' }),
    'Hi Ravi, a quick reminder that the damage waiver ($60) for your stay at P2-4304 is still pending. Please accept the payment request we sent you on Airbnb (Resolution Center). You can also pay by card in your online check-in: https://x/guest/1.a Thank you!');
  assert.equal(reminderText({ first: null, unit: null, what: 'security deposit', amount: null, method: 'card', link: null }),
    'Hi, a quick reminder that the security deposit for your stay is still pending. You can complete it in your online check-in. Thank you!');
});

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
