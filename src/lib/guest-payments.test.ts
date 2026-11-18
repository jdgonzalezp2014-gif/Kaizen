import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLines, encodeLines, keptLines, portalFeeCosts, portalIncome, salesByItem, type GuestPayment } from './guest-payments.ts';

const pay = (o: Partial<GuestPayment> = {}): GuestPayment => ({ id: 'cs_1', livemode: true, reservationId: null, unitId: '586502', unitName: 'Frisco', guest: null,
  lines: [{ item: 'waiver', label: 'Damage waiver', amount: 49 }, { item: 'early-checkin', label: 'Early check-in', amount: 40 }],
  amount: 89, fee: 2.88, refunded: 0, status: 'paid', paidOn: '2026-11-17', ...o });

test('lines survive Stripe metadata: item and amount, held ones marked', () => {
  const s = encodeLines([{ item: 'waiver', label: 'x', amount: 49 }, { item: 'deposit', label: 'y', amount: 250, hold: true }]);
  assert.equal(s, 'waiver:49|~deposit:250');
  assert.deepEqual(decodeLines(s), [{ item: 'waiver', label: 'Damage waiver', amount: 49 }, { item: 'deposit', label: 'Security deposit', amount: 250, hold: true }]);
  assert.deepEqual(decodeLines('garbage|<x>:1'), []);
});

test('income: live payments only, held lines never, refunds off every line in proportion', () => {
  assert.deepEqual(portalIncome([pay()]).map(r => [r.amount, r.kind, r.on]), [[49, 'portal', '2026-11-17'], [40, 'portal', '2026-11-17']]);
  assert.deepEqual(portalIncome([pay({ livemode: false })]), []);
  assert.deepEqual(portalIncome([pay({ status: 'held' })]), []);
  assert.deepEqual(keptLines(pay({ refunded: 44.5 })).map(l => l.amount), [24.5, 20]);
  assert.deepEqual(keptLines(pay({ lines: [{ item: 'waiver', label: '', amount: 49 }, { item: 'deposit', label: '', amount: 250, hold: true }] })).map(l => l.item), ['waiver']);
});

test("Stripe's fee is a one-off cost the day it was paid; shared when the unit is unknown", () => {
  assert.deepEqual(portalFeeCosts([pay()]), [{ listingId: '586502', shared: false, start: '2026-11-17', end: '2026-11-17', category: 'Payment fees', frequency: 'One-time', amount: 2.88, source: 'variable' }]);
  assert.equal(portalFeeCosts([pay({ unitId: null })])[0]!.shared, true);
  assert.deepEqual(portalFeeCosts([pay({ livemode: false }), pay({ fee: null })]), []);
});

test('sales by item, biggest first', () => {
  assert.deepEqual(salesByItem([pay(), pay({ id: 'cs_2', lines: [{ item: 'waiver', label: 'Damage waiver', amount: 49 }] })]).map(x => [x.item, x.count, x.amount]),
    [['waiver', 2, 98], ['early-checkin', 1, 40]]);
});
