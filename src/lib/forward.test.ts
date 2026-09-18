import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, rank, suspectedDuplicates, type ForwardUnit } from './forward.ts';

const unit = (over: Partial<ForwardUnit> = {}): ForwardUnit => ({
  listingId: '1', name: 'U', city: 'Frisco', state: 'TX', active: true, listedActive: true, specialStatus: null, parked: false, parkedDays: 0,
  basePrice: 150, cleaningFeeCharged: 90, cleaningCost: 55,
  weeklyDiscountPct: null, monthlyDiscountPct: null,
  nights: 30, nightsOpen: 15, nightsSold: 15, nightsBlocked: 0,
  occupancy: 0.5, onBooks: 0, askAvg: 150, openDates: [], hasCalendar: true, days: [],
  revpan: null, adr: null, openAsk: 150, leadTime: null, pickup7: 0, lastBookedOn: null, ...over
});

test('a unit blocked solid is offline, not zero per cent occupied', () => {
  // Four real units in this portfolio are blocked for the whole window.
  // Measured against calendar nights they read 0% and sort straight to
  // the top of "needs a discount" — a price cut on something nobody can
  // book. The denominator is sellable nights, and there are none.
  const u = unit({ nightsOpen: 0, nightsSold: 0, nightsBlocked: 30, occupancy: null });
  assert.equal(classify(u, 0.6), 'offline');
  assert.equal(rank([u], 0.6)[0]!.atRisk, 0);
});

test('a genuinely empty unit ranks first, because zero is not missing', () => {
  // `occupancy || fallback` treats 0 as absent and buries the single
  // most urgent row in the table. This is that bug, pinned.
  const empty = unit({ name: 'Empty', nightsOpen: 30, nightsSold: 0, occupancy: 0 });
  const half  = unit({ name: 'Half',  nightsOpen: 15, nightsSold: 15, occupancy: 0.5 });
  const order = rank([half, empty], 0.6).map(u => u.name);
  assert.deepEqual(order, ['Empty', 'Half']);
});

test('no calendar is unknown, never empty', () => {
  const u = unit({ hasCalendar: false, nights: 0, nightsOpen: 0, nightsSold: 0, occupancy: null });
  assert.equal(classify(u, 0.6), 'unknown');
  // Unknown sorts below every unit we actually know something about.
  const known = unit({ name: 'Known', occupancy: 0.2, nightsOpen: 20 });
  assert.deepEqual(rank([u, known], 0.6).map(x => x.state), ['thin', 'unknown']);
});

test('urgency is money at risk, not the occupancy percentage', () => {
  // A 55%-occupied house with 18 open nights at $300 is a bigger problem
  // than a 40%-occupied studio with 4 open at $150, and sorting on
  // occupancy alone puts them the wrong way round.
  const house  = unit({ name: 'House',  occupancy: 0.55, nightsOpen: 18, nightsSold: 22, askAvg: 300 });
  const studio = unit({ name: 'Studio', occupancy: 0.40, nightsOpen: 4,  nightsSold: 3,  askAvg: 150 });
  assert.deepEqual(rank([studio, house], 0.6).map(u => u.name), ['House', 'Studio']);
});

test('a unit under the floor with nothing left to sell is not a decision', () => {
  const spent = unit({ occupancy: 0.5, nightsOpen: 1, nightsSold: 1 });
  assert.equal(classify(spent, 0.6), 'watch');
  const actionable = unit({ occupancy: 0.5, nightsOpen: 10, nightsSold: 10 });
  assert.equal(classify(actionable, 0.6), 'thin');
});

test('at or above the floor is ok', () => {
  assert.equal(classify(unit({ occupancy: 0.6 }), 0.6), 'ok');
  assert.equal(classify(unit({ occupancy: 0.61 }), 0.6), 'ok');
});

test('identical twins are reported, never merged', () => {
  const a = unit({ listingId: 'a', name: 'Kingsford Home',      onBooks: 12052, nightsSold: 27 });
  const b = unit({ listingId: 'b', name: 'Kingsford Duplicate', onBooks: 12052, nightsSold: 27 });
  const c = unit({ listingId: 'c', name: 'Other',               onBooks: 900,   nightsSold: 5 });
  assert.deepEqual(suspectedDuplicates([a, b, c]), [['Kingsford Home', 'Kingsford Duplicate']]);
});

test('two units at zero revenue are not duplicates of each other', () => {
  // Every blocked unit has onBooks 0 and nightsSold 0; pairing them all
  // would report a duplicate for every combination of them.
  const a = unit({ name: 'A', onBooks: 0, nightsSold: 0 });
  const b = unit({ name: 'B', onBooks: 0, nightsSold: 0 });
  assert.deepEqual(suspectedDuplicates([a, b]), []);
});

test('blocked past the horizon is parked, and parked outranks offline', () => {
  // Hostaway still flags these active, so every portfolio average
  // divides by them and the per-unit target is set against a unit
  // count nobody could book against.
  const u = unit({ parked: true, parkedDays: 45, nightsOpen: 0, nightsSold: 0,
                   nightsBlocked: 30, occupancy: null });
  assert.equal(classify(u, 0.6), 'parked');
  assert.equal(u.listedActive, true);        // the flag still says yes
  // Sorts below everything, including a short block.
  const gap = unit({ name: 'Gap', nightsOpen: 0, nightsSold: 0, nightsBlocked: 30, occupancy: null });
  assert.deepEqual(rank([u, gap], 0.6).map(x => x.state), ['offline', 'parked']);
});

test('an archived listing is never diagnosed, whatever its calendar says', () => {
  // A draft listing still returns a calendar full of available nights,
  // so every later test reads it as a healthy unit sitting empty. One
  // did exactly that: it topped "needs a decision" with $13,560
  // supposedly at stake on something nobody could book.
  const u = unit({
    listedActive: false, specialStatus: 'archived',
    nightsOpen: 30, nightsSold: 0, occupancy: 0, hasCalendar: true
  });
  assert.equal(classify(u, 0.6), 'archived');
  const ranked = rank([u, unit({ name: 'Live', occupancy: 0.2, nightsOpen: 20 })], 0.6);
  assert.deepEqual(ranked.map(r => r.state), ['thin', 'archived']);
  assert.equal(ranked.find(r => r.state === 'archived')!.atRisk, 0);
});

test('an unrecognised Hostaway status does not delete a working unit', () => {
  // Only known non-live values disqualify. A status nobody has seen
  // before should surface as a label to investigate, not silently drop a
  // unit out of the portfolio and its target.
  const u = unit({ listedActive: true, specialStatus: 'something_new' });
  assert.notEqual(classify(u, 0.6), 'archived');
});
