import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needByPlace, orderList, perClean, reconcile, stockLevels, toOrder, unitUses, type InvItem, type Move } from './inventory.ts';

const S1105 = 'the_links/ROW-0010', S4116 = 'the_links/ROW-0011', S13 = 'cortland_legacy/ROW-0021', PRESTON = 'houses/ROW-0002';
const mv = (kind: Move['kind'], qty: number, at: string, place: string | null = S1105, unitId: string | null = null,
            itemId = 'tp', cleaningKey: string | null = null): Move => ({ itemId, place, unitId, kind, qty, at, cleaningKey });
const TP: InvItem = { id: 'tp', name: 'Toilet paper', category: 'bathroom', measure: 'roll', perClean: 2, reorderAt: 6, active: true };

test('stock is the last count, plus purchases, minus uses, plus adjustments — in time order', () => {
  const l = stockLevels([mv('used', 2, '2026-10-05'), mv('count', 20, '2026-10-01'), mv('purchase', 12, '2026-10-06'),
                         mv('count', 10, '2026-10-02'), mv('adjust', -1, '2026-10-07')]).get(`tp|${S1105}`)!;
  assert.equal(l.qty, 10 - 2 + 12 - 1);
  assert.equal(l.countedAt, '2026-10-02');
});

test('a "missing" report asks for a count; it does not change the stock; the next count clears it', () => {
  const ms = [mv('count', 8, '2026-10-01'), mv('missing', 0, '2026-10-03')];
  assert.deepEqual([stockLevels(ms).get(`tp|${S1105}`)!.qty, stockLevels(ms).get(`tp|${S1105}`)!.missingSince], [8, '2026-10-03']);
  const after = stockLevels([...ms, mv('count', 1, '2026-10-04')]).get(`tp|${S1105}`)!;
  assert.deepEqual([after.qty, after.missingSince], [1, null]);
});

test('every place keeps its own stock (§150): storages and a house closet; more used than recorded floors at zero', () => {
  const ls = stockLevels([mv('count', 40, '2026-10-01', S1105), mv('count', 30, '2026-10-01', S13), mv('count', 5, '2026-10-01', PRESTON),
                          mv('taken', 6, '2026-10-02', S1105, 'p2-4315'), mv('taken', 4, '2026-10-02', S13, 'cl-1125'),
                          mv('taken', 9, '2026-10-02', PRESTON, 'preston')]);
  assert.deepEqual([ls.get(`tp|${S1105}`)!.qty, ls.get(`tp|${S13}`)!.qty, ls.get(`tp|${PRESTON}`)!.qty], [34, 26, 0]);
  // A unit with no place at the time: its own bucket, never someone else's stock.
  assert.equal(stockLevels([mv('taken', 2, '2026-10-02', null, 'u9')]).get('tp|')!.qty, 0);
});

test('a unit moved to another storage leaves its past where it happened (§150)', () => {
  // P2-4315 took from S1105, then was moved to S4116 and took from there.
  const ms = [mv('count', 20, '2026-10-01', S1105), mv('count', 20, '2026-10-01', S4116),
              mv('taken', 3, '2026-10-02', S1105, 'p2-4315', 'tp', 'c1'), mv('taken', 5, '2026-10-09', S4116, 'p2-4315', 'tp', 'c2')];
  const ls = stockLevels(ms);
  assert.equal(ls.get(`tp|${S1105}`)!.qty, 17);
  assert.equal(ls.get(`tp|${S4116}`)!.qty, 15);
  // What it learned per clean follows the unit, from both places.
  assert.deepEqual(unitUses(ms, 'tp', 'p2-4315', '2026-09-01'), { qty: 8, cleans: 2 });
  // Its coming cleans now count toward S4116 only.
  const need = needByPlace([{ place: S4116, rate: 4, cleansAhead: 3 }, { place: S1105, rate: 2, cleansAhead: 2 }, { place: S1105, rate: 1, cleansAhead: 1 }]);
  assert.deepEqual([need.get(S4116), need.get(S1105)], [12, 5]);
});

test('a count shows how far the record had drifted', () => {
  assert.deepEqual(reconcile(10, 7), { expected: 10, found: 7, gap: -3 });
  assert.deepEqual(reconcile(null, 4), { expected: null, found: 4, gap: null });
});

test('per clean is the average of what cleaners reported, "nothing" cleans included — the estimate until 3 cleans', () => {
  assert.deepEqual(perClean(TP, 9, 3), { rate: 3, learned: true });
  assert.deepEqual(perClean(TP, 4, 2), { rate: 2, learned: false });
  // 3 answered cleans, one of them "nothing": 6 rolls over 3 cleans = 2, not 6 / 2.
  const ms = [mv('taken', 4, '2026-10-02', S1105, 'u1', 'tp', 'c1'), mv('taken', 2, '2026-10-03', S1105, 'u1', 'tp', 'c2')];
  const u = unitUses(ms, 'tp', 'u1', '2026-09-01', ['c1', 'c2', 'c3']);
  assert.deepEqual(u, { qty: 6, cleans: 3 });
  assert.deepEqual(perClean(TP, u.qty, u.cleans), { rate: 2, learned: true });
  // Another unit's takes and old ones do not count.
  assert.deepEqual(unitUses([...ms, mv('taken', 9, '2026-10-03', S1105, 'u2')], 'tp', 'u1', '2026-10-03'), { qty: 2, cleans: 1 });
});

test('to order per place: what its units will take + its minimum − what it holds; never-counted is not guessed', () => {
  assert.equal(toOrder(5, 8, 6), 9);       // 8 + 6 − 5
  assert.equal(toOrder(30, 8, 6), 0);
  assert.equal(toOrder(0, 0.75, 1), 2);    // 0.75 + 1 − 0 → 2
  assert.equal(toOrder(null, 8, 6), 0);    // never counted: count it, do not guess
  assert.equal(toOrder(3, 0, null), 0);
});

test('the shopping to-do has a line per item, split between the places it goes to (§150)', () => {
  const CP = { ...TP, id: 'cp', name: 'Coffee pods', measure: 'pod' };
  assert.deepEqual(orderList([{ item: TP, place: 'S1105 Storage (stock)', qty: 9 }, { item: CP, place: 'S13', qty: 0 }]),
    { title: 'Buy supplies: Toilet paper × 9', items: ['Buy: Toilet paper × 9 rolls — S1105 Storage (stock)'] });
  assert.deepEqual(orderList([{ item: TP, place: 'S1105', qty: 10 }, { item: CP, place: 'S13', qty: 24 }, { item: TP, place: 'Preston Vineyard closet', qty: 4 }]),
    { title: 'Buy supplies: 2 items', items: ['Buy: Toilet paper × 14 rolls — S1105 10 · Preston Vineyard closet 4', 'Buy: Coffee pods × 24 pods — S13'] });
  assert.equal(orderList([{ item: TP, place: 'S13', qty: 0 }]), null);
});
