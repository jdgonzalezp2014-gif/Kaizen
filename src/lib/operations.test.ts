import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBoard, inspectionPanel, inspectionTier, summarize,
  type OpsCleaning, type OpsListing, type OpsReservation, type OpsRules
} from './operations.ts';

const RULES: OpsRules = {
  longVacancyDays: 25, nextResValueHorizonDays: 30,
  inspectionIntervalDays: 30, inspectionSoonDays: 24, inspectionValueTrigger: 2000
};
const TODAY = '2026-09-24';
const L: OpsListing[] = [
  { id: '1', name: 'CL1250', bedrooms: 2, active: true },
  { id: '2', name: 'P2 - 1406', bedrooms: 1, active: true },
  { id: '3', name: 'Charger Luxe', bedrooms: 3, active: false }
];
const res = (id: string, listingId: string, arrival: string, departure: string, total = 500): OpsReservation =>
  ({ reservationId: id, listingId, arrival, departure, nights: 3, totalPaid: total, channel: 'airbnb' });
const clean = (over: Partial<OpsCleaning> = {}): OpsCleaning => ({
  cleaner: 'Michelle', assignment: 'assigned', price: 55, deep: false, urgency: null,
  checkoutTime: '10:00 AM', beds: 2, ...over
});

const board = (reservations: OpsReservation[], cleanings = new Map<string, OpsCleaning>(),
               inspections = inspectionPanel(L, reservations, [], [], TODAY, RULES)) =>
  buildBoard({ today: TODAY, windowDays: 10, listings: L, reservations, cleanings,
               notes: new Map(), inspections, rules: RULES });

test('a stay inside the window gives an arrival row and a departure row', () => {
  const rows = board([res('a', '1', '2026-09-25', '2026-09-28')]);
  assert.deepEqual(rows.map(r => [r.date, r.kind]), [['2026-09-25', 'in'], ['2026-09-28', 'out']]);
});

test('the departure before the arrival on the same day — the clean comes first', () => {
  const rows = board([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-26', '2026-09-29')]);
  const day = rows.filter(r => r.date === '2026-09-26');
  assert.deepEqual(day.map(r => r.kind), ['out', 'in']);
  assert.equal(day[0]!.next?.gapDays, 0);
  assert.equal(summarize(rows).turnovers, 1);
});

test('who cleans comes from the Cleanings Log, never re-decided here', () => {
  const rows = board([res('a', '1', '2026-09-20', '2026-09-26')],
    new Map([['a', clean({ cleaner: 'Veronica', price: 90 })]]));
  const out = rows.find(r => r.kind === 'out')!;
  assert.equal(out.cleaner, 'Veronica');
  assert.equal(out.price, 90);
  assert.equal(out.inDailyFile, true);
});

test('a checkout the daily file has not seen yet says so, rather than inventing a cleaner', () => {
  const out = board([res('a', '1', '2026-09-20', '2026-09-26')]).find(r => r.kind === 'out')!;
  assert.equal(out.inDailyFile, false);
  assert.equal(out.assignment, 'unknown');
  assert.equal(out.cleaner, null);
});

test('a next booking past the value horizon has no value, but the gap stays factual', () => {
  const rows = board([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-11-15', '2026-11-20', 9000)]);
  const out = rows.find(r => r.kind === 'out')!;
  assert.equal(out.next?.total, null);
  assert.equal(out.next?.gapDays, 50);
  assert.equal(out.next?.longVacancy, true);
});

test('a big next booking forces an inspection at that turnover', () => {
  const rows = board([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-10-05', 2400)],
    new Map(), inspectionPanel(L, [], [{ date: '2026-09-20', unit: 'CL1250', by: 'Owner', result: 'OK', notes: '' }], [], TODAY, RULES));
  assert.equal(rows.find(r => r.kind === 'out')!.inspection.key, 'req');
});

test('the monthly flag lands on the first turnover only, not every one in the window', () => {
  const rows = board([
    res('a', '1', '2026-09-20', '2026-09-25'), res('b', '1', '2026-09-25', '2026-09-28'),
    res('c', '1', '2026-09-28', '2026-10-10')
  ]);
  const outs = rows.filter(r => r.kind === 'out' && r.unitId === '1');
  assert.deepEqual(outs.map(r => r.inspection.key), ['due', 'none']);
});

test('an inspection logged on or after the checkout marks it handled', () => {
  const panel = inspectionPanel(L, [], [{ date: '2026-09-26', unit: 'CL1250', by: 'Karina', result: 'OK', notes: '' }], [], '2026-09-26', RULES);
  const rows = buildBoard({ today: '2026-09-26', windowDays: 10, listings: L,
    reservations: [res('a', '1', '2026-09-20', '2026-09-26')], cleanings: new Map(),
    notes: new Map(), inspections: panel, rules: RULES });
  assert.equal(rows[0]!.inspection.key, 'ok');
});

test('tiers: never, overdue at the interval, soon at the warning line', () => {
  assert.equal(inspectionTier(null, RULES), 'never');
  assert.equal(inspectionTier(30, RULES), 'overdue');
  assert.equal(inspectionTier(24, RULES), 'soon');
  assert.equal(inspectionTier(23, RULES), 'ok');
});

test('the panel matches the log loosely by name and leaves archived units out', () => {
  const panel = inspectionPanel(L, [], [{ date: '2026-09-01', unit: 'p2-1406', by: 'Owner', result: 'OK', notes: '' }], [], TODAY, RULES);
  assert.equal(panel.length, 2);
  const p2 = panel.find(p => p.unitId === '2')!;
  assert.equal(p2.last, '2026-09-01');
  assert.equal(p2.tier, 'ok');
  // Never inspected sorts first — it is the one that needs someone.
  assert.equal(panel[0]!.tier, 'never');
});

test('no clean needed is not a clean, and a blank price is not free', () => {
  const rows = board([
    res('a', '1', '2026-09-20', '2026-09-26'), res('b', '2', '2026-09-20', '2026-09-27')
  ], new Map([
    ['a', clean({ assignment: 'not_needed', cleaner: null, price: null })],
    ['b', clean({ price: null })]
  ]));
  const s = summarize(rows);
  assert.equal(s.departures, 2);
  assert.equal(s.cleanings, 1);
  assert.equal(s.unpriced, 1);
  assert.equal(s.cleaningCost, 0);
});

test('an arrival names who prepped the unit', () => {
  const rows = board([res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-09-30')],
    new Map([['a', clean({ cleaner: 'Veronica' })]]));
  assert.equal(rows.find(r => r.kind === 'in' && r.resId === 'b')!.preppedBy, 'Veronica');
});

test('without a readable Inspection Log, nothing is called overdue — but a big booking still is', () => {
  const rows = buildBoard({ today: TODAY, windowDays: 10, listings: L,
    reservations: [res('a', '1', '2026-09-20', '2026-09-26'), res('b', '1', '2026-09-27', '2026-10-05', 2400),
                   res('c', '2', '2026-09-20', '2026-09-26')],
    cleanings: new Map(), notes: new Map(),
    inspections: inspectionPanel(L, [], [], [], TODAY, RULES), rules: RULES, inspectionLogRead: false });
  const outs = rows.filter(r => r.kind === 'out');
  assert.equal(outs.find(r => r.unitId === '1')!.inspection.key, 'req');
  assert.equal(outs.find(r => r.unitId === '2')!.inspection.key, 'none');
});
