import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ForwardUnit } from './forward.ts';
import { readPortfolio, redUnits } from './verdicts.ts';

const days = (open: number, sold: number) => [
  ...Array.from({ length: sold }, (_, i) => ({ d: `2026-10-${String(i + 1).padStart(2, '0')}`, s: 's' as const, p: 150, m: 2 })),
  ...Array.from({ length: open }, (_, i) => ({ d: `2026-10-${String(sold + i + 1).padStart(2, '0')}`, s: 'o' as const, p: 150, m: 2 }))
];
const unit = (over: Partial<ForwardUnit> = {}): ForwardUnit => ({
  listingId: '1', name: 'U', city: 'Frisco', state: 'TX', active: true, listedActive: true, specialStatus: null,
  parked: false, parkedDays: 0, basePrice: 150, cleaningFeeCharged: 90, cleaningCost: 55,
  weeklyDiscountPct: null, monthlyDiscountPct: null, nights: 30, nightsOpen: 20, nightsSold: 10, nightsBlocked: 0,
  occupancy: 1 / 3, onBooks: 1500, askAvg: 150, openDates: [], hasCalendar: true, days: days(20, 10),
  revpan: 50, adr: 150, openAsk: 150, leadTime: 20, pickup7: 2, lastBookedOn: '2026-09-24', ...over
});

test('a unit with open nights and no pickup in a week is red', () => {
  const stuck = unit({ listingId: 'a', name: 'Stuck', pickup7: 0, leadTime: 5 });
  const moving = unit({ listingId: 'b', name: 'Moving', pickup7: 4, leadTime: 5 });
  const red = redUnits([stuck, moving], 0.6, '2026-09-25');
  assert.deepEqual(red.map(r => r.unit.name), ['Stuck']);
  assert.equal(red[0]!.read.v.kind, 'stuck');
});

test('a unit not taking bookings is never red — its light is off', () => {
  const parked = unit({ listingId: 'p', name: 'Parked', active: false, pickup7: 0 });
  const p = readPortfolio([parked], 0.6, '2026-09-25');
  assert.equal(p.lightOf(p.ranked[0]!), 'off');
  assert.equal(redUnits([parked], 0.6, '2026-09-25').length, 0);
});

test('red units come most money at stake first', () => {
  const small = unit({ listingId: 's', name: 'Small', pickup7: 0, leadTime: 5, nightsOpen: 12, days: days(12, 18), openAsk: 100 });
  const big = unit({ listingId: 'g', name: 'Big', pickup7: 0, leadTime: 5, nightsOpen: 25, days: days(25, 5), openAsk: 300 });
  assert.deepEqual(redUnits([small, big], 0.6, '2026-09-25').map(r => r.unit.name), ['Big', 'Small']);
});
