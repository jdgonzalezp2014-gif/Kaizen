import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVendorInvoice, flaggedPay, VENDOR_VOID, vendorInvoiceNumber, type VendorJob } from './vendor-pay.ts';
import { payBlockers, payState, stripeMode, toCents } from './payouts.ts';
import { customPeriod, periodOf } from './crew.ts';

const job = (id: string, date: string, over: Partial<VendorJob> = {}): VendorJob => ({
  id, title: `Fix ${id}`, unit: 'P2-4212', date, status: 'completed', pay: 100, payFixed: false, payNote: null,
  flagNote: null, voidReason: null, chargeOwner: false, resolution: null, charges: [], ...over
});

test('a vendor invoice: done jobs in the period, not-paid ones listed apart, open jobs left out', () => {
  const p = periodOf('2026-10-11', 'monthly');
  const inv = buildVendorInvoice('Tim', p, [
    job('3', '2026-10-20'),
    job('1', '2026-10-02', { pay: 80.5, flagNote: 'left a mess' }),
    job('2', '2026-10-05', { voidReason: `${VENDOR_VOID}redo, no charge` }),
    job('4', '2026-10-09', { status: 'in_progress' }),
    job('5', '2026-09-30'),
    job('6', '2026-10-12', { pay: null }),
    job('7', '2026-10-13', { charges: [{ id: 'c', amount: 5, description: 'x', status: 'pending', decisionNote: null, photos: [] }] })
  ], '2026-11-02');
  assert.deepEqual(inv.lines.map(l => l.id), ['1', '6', '7', '3']);
  assert.equal(inv.total, 280.5);
  assert.equal(inv.unpriced, 1);
  assert.equal(inv.pendingCharges, 1);
  assert.deepEqual(inv.excluded.map(x => x.id), ['2']);
  assert.equal(inv.lines[0]!.flag, 'left a mess');
  assert.equal(inv.open, false);
  assert.equal(inv.number, 'KZ-V-TIM-20261001');
});

test('the invoice is open until its last day; a custom span keeps the vendor prefix', () => {
  const p = periodOf('2026-10-25', 'weekly');
  assert.equal(buildVendorInvoice('Tim', p, [], '2026-10-30').open, true);
  assert.equal(buildVendorInvoice('Tim', p, [], '2026-10-31').open, false);
  assert.match(vendorInvoiceNumber('PGA maintenance', customPeriod('2026-10-01', '2026-10-20')), /^KZ-V-PGAMAINTEN-20261001$/);
});

test('a flag leaves the pay, deducts from it, or sets it — never below zero', () => {
  assert.equal(flaggedPay(100, 'none', null), 100);
  assert.equal(flaggedPay(100, 'deduct', 25.255), 74.75);
  assert.equal(flaggedPay(100, 'pay', 60), 60);
  assert.equal(flaggedPay(null, 'pay', 60), 60);
  assert.throws(() => flaggedPay(100, 'deduct', 120), /more than the pay/);
  assert.throws(() => flaggedPay(null, 'deduct', 10), /no pay yet/);
  assert.throws(() => flaggedPay(100, 'pay', -1), /0 or more/);
  assert.throws(() => flaggedPay(100, 'deduct', null), /0 or more/);
});

test('pay state: open, nothing, due, paid, changed after paid', () => {
  const paid = (amount: number) => ({ id: '1', invoiceNumber: 'X', amount, method: 'manual' as const, stripeMode: null, transferId: null, note: null, by: 'a', at: 'b' });
  assert.equal(payState({ open: true, total: 50 }, null), 'open');
  assert.equal(payState({ open: false, total: 0 }, null), 'nothing');
  assert.equal(payState({ open: false, total: 50 }, null), 'due');
  assert.equal(payState({ open: false, total: 50 }, paid(50)), 'paid');
  assert.equal(payState({ open: false, total: 70 }, paid(50)), 'changed');
});

test('what stops a payout is said, one reason each', () => {
  assert.deepEqual(payBlockers({ open: false, total: 50, unpriced: 0, pending: 0 }, '2026-11-02', '2026-10-31'), []);
  const all = payBlockers({ open: true, total: 0, unpriced: 2, pending: 1 }, '2026-10-20', '2026-10-31');
  assert.equal(all.length, 4);
  assert.match(all[2]!, /2 jobs have no pay/);
});

test('Stripe keys: test or live, anything else refused; cents without drift', () => {
  assert.equal(stripeMode('sk_test_51AbCdEfGhIjKlMn'), 'test');
  assert.equal(stripeMode(' rk_live_51AbCdEfGhIjKlMn '), 'live');
  assert.equal(stripeMode('pk_test_51AbCdEfGhIjKlMn'), null);
  assert.equal(stripeMode('sk_test_short'), null);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents(0.1 + 0.2), 30);
});

test('a pay check: its title and lines say who, what and how much; flags and missing prices block it', async () => {
  const { payCheckTitle, payCheckText, payCheckBlock } = await import('./vendor-pay.ts');
  const j = (id: string, over = {}) => ({ id, title: `Fix ${id}`, vendor: 'Tim', cost: null, flag: null, pending: 1, pendingSum: 40, charges: 1, ...over });
  assert.equal(payCheckTitle([j('1')]), 'Validate pay — Tim: Fix 1 · $40.00 charged');
  assert.equal(payCheckTitle([j('1', { pending: 2, pendingSum: 60 }), j('2'), j('3', { pending: 0, pendingSum: 0, charges: 0 })]),
               'Validate pay — Tim: 3 jobs · $100.00 charged, 1 with no price');
  assert.equal(payCheckTitle([j('3', { pending: 0, pendingSum: 0 })]), 'Validate pay — Tim: Fix 3 · no price yet');
  assert.equal(payCheckText([j('1', { pending: 2, pendingSum: 60, flag: 'two charges for one fix?' }), j('3', { pending: 0, pendingSum: 0 })]),
               '#1 Fix 1 — $60.00 in 2 charges waiting · ⚑ flagged: two charges for one fix?\n#3 Fix 3 — no price yet');
  assert.equal(payCheckBlock([j('1'), j('2')]), null);
  assert.match(payCheckBlock([j('1', { flag: 'x' })])!, /^#1 is flagged/);
  // A flag on a job with nothing waiting does not hold the others.
  assert.equal(payCheckBlock([j('1'), j('2', { flag: 'x', pending: 0, pendingSum: 0, cost: 30 })]), null);
  assert.match(payCheckBlock([j('3', { pending: 0, pendingSum: 0 })])!, /^#3 has no price/);
});
