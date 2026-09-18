import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreboard, type Dataset } from './series.ts';

const P = { from: '2026-09-01', to: '2026-09-30' };

/**
 * One live unit and one archived unit that earned before it was
 * archived. The archived one is in `listingIds` but not in
 * `sharedAmong`.
 */
const set: Dataset = {
  reservations: [
    { listingId: 'live', arrival: '2026-09-01', departure: '2026-09-11', totalPaid: 2000, cleaningFee: 100 },
    { listingId: 'gone', arrival: '2026-09-02', departure: '2026-09-07', totalPaid: 900, cleaningFee: 100 }
  ],
  costs: [
    { listingId: '', shared: true, start: '2026-09-01', end: '', category: 'Internet',
      frequency: 'Monthly', amount: 300, source: 'fixed' }
  ],
  listingIds: ['live', 'gone'],
  sharedAmong: ['live']
};

test('an archived unit keeps the money it earned', () => {
  // One archived listing in this portfolio carries $91,672 across 68
  // real reservations. Filtering it out of the dataset removed all of
  // it from every total, as though it had never earned anything.
  const b = scoreboard(set, P, 1500);
  const gone = b.units.find(u => u.listingId === 'gone')!;
  assert.ok(gone, 'the archived unit must still appear');
  assert.ok(gone.revenue > 0, 'and must still carry its revenue');
  assert.ok(b.portfolio.revenue > 2000, 'the portfolio total must include it');
});

test('but it does not take a share of this month s shared costs', () => {
  // It did not consume this month's internet, and giving it a share
  // moves cost off the units that did.
  const b = scoreboard(set, P, 1500);
  const gone = b.units.find(u => u.listingId === 'gone')!;
  const live = b.units.find(u => u.listingId === 'live')!;
  assert.equal(gone.costs.shared, 0);
  assert.ok(live.costs.shared > 0, 'the whole share lands on the live unit');
});

test('sharedAmong defaults to listingIds when it is not given', () => {
  const { sharedAmong, ...noSplit } = set;
  const b = scoreboard(noSplit as Dataset, P, 1500);
  const gone = b.units.find(u => u.listingId === 'gone')!;
  assert.ok(gone.costs.shared > 0, 'without the split, every listed unit shares');
});
