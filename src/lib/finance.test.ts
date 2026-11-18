import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reservationCounts } from './finance.ts';

test('a request not yet accepted is no stay — no clean, no revenue', () => {
  for (const s of ['unconfirmed', 'pending', 'inquiry', 'inquiryPreapproved', 'inquiryNotPossible', 'awaitingPayment', 'expired', 'declined', 'cancelled', 'unknown', 'somethingNew']) assert.equal(reservationCounts(s), false, s);
  for (const s of ['new', 'modified', 'ownerStay']) assert.equal(reservationCounts(s), true, s);
});

test('channel cut (2026-11-17): Airbnb keeps total − tax − payout; others report commission and tax', async () => {
  const { channelCut } = await import('./finance.ts');
  // A real Airbnb stay: 1465.98 total, 82.98 occupancy tax, 1157.31 payout → 225.69 host fee.
  assert.deepEqual(channelCut({ totalPrice: 1465.98, airbnbExpectedPayoutAmount: 1157.31, airbnbListingHostFee: 225.69, airbnbTransientOccupancyTaxPaidAmount: 82.98 }), { taxes: 82.98, channelFee: 225.69 });
  // A withholding beyond the fee is Airbnb's too (it never reaches the bank).
  assert.deepEqual(channelCut({ totalPrice: 592.12, airbnbExpectedPayoutAmount: 420.08, airbnbListingHostFee: 81.92, airbnbTransientOccupancyTaxPaidAmount: 30.12 }), { taxes: 30.12, channelFee: 141.92 });
  assert.deepEqual(channelCut({ totalPrice: 580.1, taxAmount: 33.42, channelCommissionAmount: 78 }), { taxes: 33.42, channelFee: 78 });
  assert.deepEqual(channelCut({ totalPrice: 4448.25 }), { taxes: 0, channelFee: 0 });
});

test('revenue is net: taxes and the channel fee both leave it, night by night', async () => {
  const { reservationContribution } = await import('./finance.ts');
  const r = { listingId: 'A', arrival: '2026-11-01', departure: '2026-11-05', totalPaid: 1100, cleaningFee: 100, taxes: 40, channelFee: 160 };
  assert.equal(reservationContribution(r, { from: '2026-11-01', to: '2026-11-02' })!.revenue, 400);   // (1100 − 100 − 40 − 160) / 4 × 2
  assert.equal(reservationContribution(r, { from: '2026-11-01', to: '2026-11-30' })!.revenue, 900);   // + the cleaning fee at checkout
});
