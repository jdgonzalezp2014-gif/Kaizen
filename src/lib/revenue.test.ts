import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findGaps, leadTimeDays, pickup, paceVsPortfolio } from './revenue.ts';
import type { CalendarNight } from './forward.ts';

const n = (d: string, s: 'o' | 's' | 'b', p = 150, m: number | null = 2): CalendarNight =>
  ({ d, s, p, m });

test('a gap shorter than its minimum stay is orphaned', () => {
  // Two open nights under a three-night minimum cannot be booked at any
  // price. Without this they sit in the "discount harder" pile forever
  // while the discount does nothing, because price was never the blocker.
  const days = [
    n('2026-10-01', 's'), n('2026-10-02', 'o', 150, 3), n('2026-10-03', 'o', 150, 3),
    n('2026-10-04', 's')
  ];
  const [gap] = findGaps(days);
  assert.equal(gap!.nights, 2);
  assert.equal(gap!.minStay, 3);
  assert.equal(gap!.orphaned, true);
});

test('a gap at or above its minimum stay is sellable', () => {
  const days = [n('2026-10-01', 's'), n('2026-10-02', 'o', 150, 2), n('2026-10-03', 'o', 150, 2), n('2026-10-04', 's')];
  assert.equal(findGaps(days)[0]!.orphaned, false);
});

test('gaps are split by sold AND blocked nights', () => {
  const days = [n('2026-10-01', 'o'), n('2026-10-02', 'b'), n('2026-10-03', 'o'), n('2026-10-04', 'o')];
  const gaps = findGaps(days);
  assert.equal(gaps.length, 2);
  assert.deepEqual(gaps.map(g => g.nights), [1, 2]);
});

test('lead time is the median, so one far-out booking cannot define it', () => {
  const res = [
    { bookedOn: '2026-10-01', arrival: '2026-10-08' },   //   7
    { bookedOn: '2026-10-01', arrival: '2026-10-06' },   //   5
    { bookedOn: '2026-10-01', arrival: '2027-04-01' }    // 182
  ];
  assert.equal(leadTimeDays(res), 7);
});

test('pickup counts only the nights inside the window', () => {
  // A 20-night stay straddling the edge is not 20 nights of pickup for
  // a 30-night window it only partly touches.
  const res = [{ bookedOn: '2026-10-02', arrival: '2026-09-25', departure: '2026-10-15', nights: 20 }];
  const r = pickup(res, '2026-10-01', '2026-10-01', '2026-10-30');
  assert.equal(r.bookings, 1);
  assert.equal(r.nights, 14);          // Oct 1 → Oct 15
});

test('pickup ignores bookings made before the cutoff', () => {
  const res = [{ bookedOn: '2026-09-01', arrival: '2026-10-05', departure: '2026-10-08', nights: 3 }];
  assert.deepEqual(pickup(res, '2026-10-01', '2026-10-01', '2026-10-30'), { bookings: 0, nights: 0 });
});

test('pace is in percentage points against the portfolio', () => {
  assert.equal(paceVsPortfolio(0.42, 0.60), -18);
  assert.equal(paceVsPortfolio(0.60, 0.60), 0);
  assert.equal(paceVsPortfolio(null, 0.60), null);
});

import { signals } from './revenue.ts';

const base = {
  occupancy: 0.5, nightsOpen: 10, pickup7: 4, leadTime: 10,
  adr: 150, openAsk: 160, lastBookedOn: '2026-09-15',
  orphanNights: 0, portfolioAdr: 150, today: '2026-09-17'
};

test('asking far above its own achieved rate is called out', () => {
  const s = signals({ ...base, adr: 120, openAsk: 220 });
  const hit = s.find(x => x.kind === 'ask-above-adr');
  assert.ok(hit, 'expected an overpricing signal');
  assert.match(hit!.text, /83% above/);
});

test('a unit with nothing booked is measured against the portfolio instead', () => {
  // Charger Luxe: asking $423, zero booked, so it has no ADR of its own.
  const s = signals({ ...base, adr: 0, openAsk: 423, portfolioAdr: 150 });
  assert.ok(s.some(x => x.kind === 'ask-above-adr'));
});

test('zero pickup with nights open is the stuck signal', () => {
  assert.ok(signals({ ...base, pickup7: 0, nightsOpen: 20 }).some(x => x.kind === 'no-pickup'));
  // Not raised when there is almost nothing left to sell.
  assert.ok(!signals({ ...base, pickup7: 0, nightsOpen: 2 }).some(x => x.kind === 'no-pickup'));
});

test('a late-booking unit is excused, not flagged', () => {
  // P2-4304 books 1.5 days out. 33% at thirty days is normal for it,
  // and discounting it would give away rate for nothing.
  const s = signals({ ...base, leadTime: 2, occupancy: 0.33 });
  const hit = s.find(x => x.kind === 'books-late');
  assert.ok(hit);
  assert.equal(hit!.tone, 'info');
});

test('a long-lead unit gets no such excuse', () => {
  assert.ok(!signals({ ...base, leadTime: 65, occupancy: 0.33 }).some(x => x.kind === 'books-late'));
});

test('silence is reported in days', () => {
  const s = signals({ ...base, lastBookedOn: '2026-08-01', today: '2026-09-17' });
  assert.match(s.find(x => x.kind === 'no-recent-booking')!.text, /47 days/);
});
