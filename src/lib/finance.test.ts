import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reservationCounts } from './finance.ts';

test('a request not yet accepted is no stay — no clean, no revenue', () => {
  for (const s of ['unconfirmed', 'pending', 'inquiry', 'inquiryPreapproved', 'inquiryNotPossible', 'awaitingPayment', 'expired', 'declined', 'cancelled', 'unknown', 'somethingNew']) assert.equal(reservationCounts(s), false, s);
  for (const s of ['new', 'modified', 'ownerStay']) assert.equal(reservationCounts(s), true, s);
});
