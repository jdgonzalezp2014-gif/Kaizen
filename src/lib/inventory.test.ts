import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderList, perClean, reconcile, stockLevels, toBuy, toOrder, type InvItem, type Move } from './inventory.ts';

const mv = (kind: Move['kind'], qty: number, at: string, unitId: string | null = 'u1', itemId = 'tp'): Move => ({ itemId, unitId, kind, qty, at });
const TP: InvItem = { id: 'tp', name: 'Toilet paper', category: 'bathroom', measure: 'roll', perClean: 2, reorderAt: 6, active: true };

test('stock is the last count, plus purchases, minus uses, plus adjustments — in time order', () => {
  const l = stockLevels([mv('used', 2, '2026-10-05'), mv('count', 20, '2026-10-01'), mv('purchase', 12, '2026-10-06'),
                         mv('count', 10, '2026-10-02'), mv('adjust', -1, '2026-10-07')]).get('tp|u1')!;
  assert.equal(l.qty, 10 - 2 + 12 - 1);
  assert.equal(l.countedAt, '2026-10-02');
});

test('a "missing" report asks for a count; it does not change the stock; the next count clears it', () => {
  const ms = [mv('count', 8, '2026-10-01'), mv('missing', 0, '2026-10-03')];
  assert.deepEqual([stockLevels(ms).get('tp|u1')!.qty, stockLevels(ms).get('tp|u1')!.missingSince], [8, '2026-10-03']);
  const after = stockLevels([...ms, mv('count', 1, '2026-10-04')]).get('tp|u1')!;
  assert.deepEqual([after.qty, after.missingSince], [1, null]);
});

test('places are separate, storage included; using more than recorded floors at zero', () => {
  const ls = stockLevels([mv('purchase', 50, '2026-10-01', null), mv('count', 1, '2026-10-01'), mv('used', 3, '2026-10-02')]);
  assert.equal(ls.get('tp|storage')!.qty, 50);
  assert.equal(ls.get('tp|u1')!.qty, 0);
});

test('a count shows how far the record had drifted', () => {
  assert.deepEqual(reconcile(10, 7), { expected: 10, found: 7, gap: -3 });
  assert.deepEqual(reconcile(null, 4), { expected: null, found: 4, gap: null });
});

test('use per clean is learned from reports once there are 3 cleans, else the estimate', () => {
  assert.deepEqual(perClean(TP, 9, 3), { rate: 3, learned: true });
  assert.deepEqual(perClean(TP, 4, 2), { rate: 2, learned: false });
});

test('to order: coming cleans × use, plus the minimum, minus what is there, rounded up', () => {
  assert.equal(toOrder(5, 2, 4, 6), 9);       // 8 + 6 − 5
  assert.equal(toOrder(30, 2, 4, 6), 0);
  assert.equal(toOrder(0, 0.25, 3, 1), 2);    // 0.75 + 1 − 0 → 2
  assert.equal(toOrder(null, 2, 4, 6), 0);     // no record: count it, do not guess
  assert.equal(toBuy(14, 10), 4);
  assert.equal(toBuy(14, null), 14);
  assert.equal(toBuy(3, 10), 0);
  const l = orderList([{ item: TP, place: 'CL1250', qty: 9 }, { item: { ...TP, name: 'Coffee pods', measure: 'pod' }, place: 'Storage', qty: 0 }])!;
  assert.deepEqual(l, { title: 'Buy supplies: Toilet paper × 9', items: ['Buy: Toilet paper × 9 rolls — CL1250'] });
});
