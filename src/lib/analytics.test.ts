import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleaningSummary, isLow, occupancyByDay, reviewSummary, slices, stars, weekIncome, weekOccupancy, weekOf, type ReviewRow, type Stay } from './analytics.ts';

test('a week runs Sunday to Saturday', () => {
  // 2026-11-22 is a Sunday, 2026-11-28 a Saturday.
  assert.deepEqual(weekOf('2026-11-22'), { from: '2026-11-22', to: '2026-11-28' });
  assert.deepEqual(weekOf('2026-11-25'), { from: '2026-11-22', to: '2026-11-28' });
  assert.deepEqual(weekOf('2026-11-28'), { from: '2026-11-22', to: '2026-11-28' });
});

test('slices: totals by key, biggest first, with shares', () => {
  const s = slices([{ k: 'Cleaning', a: 300 }, { k: 'Repairs', a: 100 }, { k: 'Cleaning', a: 100 }], r => r.k, r => r.a);
  assert.deepEqual(s.map(x => [x.key, x.total, x.count, x.share]), [['Cleaning', 400, 2, 0.8], ['Repairs', 100, 1, 0.2]]);
  assert.deepEqual(slices([], () => '', () => 0), []);
});

test('cleaning summary: count, unpriced apart, per cleaner with average', () => {
  const c = cleaningSummary([
    { key: 'a', on: '2026-11-23', unitId: '1', unit: 'A', cleaner: 'Wilson', price: 80, deep: false },
    { key: 'b', on: '2026-11-24', unitId: '2', unit: 'B', cleaner: 'Wilson', price: 120, deep: true },
    { key: 'c', on: '2026-11-24', unitId: '3', unit: 'C', cleaner: 'Veronica', price: null, deep: false }]);
  assert.equal(c.count, 3); assert.equal(c.deep, 1); assert.equal(c.unpriced, 1); assert.equal(c.total, 200);
  assert.deepEqual(c.byCleaner.map(x => [x.key, x.count, x.total, x.avg]), [['Wilson', 2, 200, 100], ['Veronica', 1, 0, 0]]);
});

const stay = (listingId: string, arrival: string, departure: string, totalPaid = 0): Stay =>
  ({ listingId, reservationId: listingId + arrival, arrival, departure, totalPaid, cleaningFee: 0 });

test('occupancy: a night is arrival ≤ night < departure, over the live units only', () => {
  const days = occupancyByDay([stay('1', '2026-11-22', '2026-11-24'), stay('2', '2026-11-23', '2026-11-25'), stay('9', '2026-11-22', '2026-11-25')],
    ['1', '2'], '2026-11-22', '2026-11-24');
  assert.deepEqual(days.map(d => [d.day, d.occupied, d.arrivals, d.departures]),
    [['2026-11-22', 1, 1, 0], ['2026-11-23', 2, 1, 0], ['2026-11-24', 1, 0, 1]]);
  assert.equal(weekOccupancy(days), 4 / 6);
});

test('week income: the nights inside the range only', () => {
  // 4 nights at $100 net, two of them inside.
  const w = weekIncome([stay('1', '2026-11-20', '2026-11-24', 400)], '2026-11-22', '2026-11-28');
  assert.equal(w.revenue, 200); assert.equal(w.nights, 2); assert.equal(w.units[0]!.listingId, '1');
});

const rev = (rating: number | null, cats: [string, number][] = [], channelId = 2018): ReviewRow =>
  ({ id: String(Math.random()), listingId: '1', channelId, status: 'published', rating, submittedAt: '2026-11-23',
     publicReview: null, privateFeedback: null, categories: cats.map(([category, r]) => ({ category, rating: r })) });

test('reviews: stars from the 10-point scale, the low ones, the weakest category first', () => {
  assert.equal(stars(10), 5); assert.equal(stars(9), 4.5); assert.equal(stars(null), null);
  assert.equal(isLow(rev(10, [['cleanliness', 6]])), true);
  assert.equal(isLow(rev(10, [['cleanliness', 10]])), false);
  const s = reviewSummary([rev(10, [['cleanliness', 10]]), rev(6, [['cleanliness', 4], ['location', 10]], 2002), rev(null)],
    [{ status: 'published' }, { status: 'pending' }, { status: 'submitted' }]);
  assert.equal(s.count, 3); assert.equal(s.stars, 4); assert.equal(s.five, 1); assert.equal(s.low, 1);
  assert.equal(s.categories[0]!.category, 'cleanliness'); assert.equal(s.categories[0]!.stars, 3.5);
  assert.deepEqual(s.byChannel.map(c => [c.key, c.count]), [['Airbnb', 2], ['Vrbo', 1]]);
  assert.equal(s.asked, 3); assert.equal(s.wrote, 2);
});
