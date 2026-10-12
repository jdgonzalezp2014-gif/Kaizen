import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appliesHere, areaKey, checklistFor, overallResult, unitTypeOf, progress, purchaseList, readyToFinish, reviewSteps, roomsOf, suggestedOutcome, workFor,
         type Check, type InspectionItem } from './inspection.ts';

const item = (id: string, area: InspectionItem['area'], label: string, extra: Partial<InspectionItem> = {}): InspectionItem =>
  ({ id, area, label, defaultOutcome: 'repair', appliesTo: 'all', unitIds: [], position: Number(id), active: true, ...extra });
const ITEMS = [item('1', 'kitchen', 'Stock'), item('2', 'bedroom', 'Sheets'), item('3', 'bathroom', 'Towels'),
               item('4', 'general', 'Lock'), item('5', 'exterior', 'Pool', { appliesTo: 'units', unitIds: ['u2'] }), item('6', 'living', 'Old', { active: false })];

test('the unit decides the rooms: one section per bedroom and per bathroom (a half bath counts)', () => {
  assert.equal(roomsOf({ bedrooms: 3, bathrooms: 2.5 }, 'bathroom'), 3);
  assert.equal(roomsOf({ bedrooms: null, bathrooms: null }, 'bedroom'), 1);
  const s = checklistFor(ITEMS, { id: 'u1', bedrooms: 2, bathrooms: 1 });
  assert.deepEqual(s.map(x => x.title), ['General & entry', 'Kitchen', 'Bedroom 1', 'Bedroom 2', 'Bathroom']);
});

test('an item for one unit only shows there; an inactive one nowhere', () => {
  assert.ok(checklistFor(ITEMS, { id: 'u2', bedrooms: 1, bathrooms: 1 }).some(x => x.area === 'exterior'));
  assert.ok(!checklistFor(ITEMS, { id: 'u1', bedrooms: 1, bathrooms: 1 }).some(x => x.area === 'exterior' || x.area === 'living'));
});

test('an item applies to every unit, houses, apartments, or the units listed (§138)', () => {
  const house = { id: 'h1', type: 'house' as const }, flat = { id: 'a1', type: 'apartment' as const }, unknown = { id: 'x1', type: null };
  assert.ok(appliesHere({ appliesTo: 'house', unitIds: [] }, house));
  assert.ok(!appliesHere({ appliesTo: 'house', unitIds: [] }, flat));
  assert.ok(appliesHere({ appliesTo: 'apartment', unitIds: [] }, flat));
  assert.ok(!appliesHere({ appliesTo: 'apartment', unitIds: [] }, unknown), 'a unit of unknown type gets neither');
  assert.ok(appliesHere({ appliesTo: 'all', unitIds: [] }, unknown));
  assert.ok(appliesHere({ appliesTo: 'units', unitIds: ['h1', 'a1'] }, flat));
  assert.ok(!appliesHere({ appliesTo: 'units', unitIds: ['h1'] }, flat));
  assert.equal(unitTypeOf('House'), 'house');
  assert.equal(unitTypeOf(' apartment '), 'apartment');
  assert.equal(unitTypeOf(''), null);
});

test('the team’s own areas: in their place in the walk, single, and gone when switched off', () => {
  const areas = [{ key: 'general', label: 'General & entry', perRoom: false, position: 1 },
                 { key: 'bedroom', label: 'Bedroom', perRoom: true, position: 2 },
                 { key: 'pool', label: 'Pool & hot tub', perRoom: false, position: 3 },
                 { key: 'garage', label: 'Garage', perRoom: false, position: 4, active: false }];
  const its = [item('1', 'general', 'Lock'), item('2', 'bedroom', 'Sheets'), item('3', 'pool', 'Pool clean', { appliesTo: 'units', unitIds: ['bob'] }),
               item('4', 'garage', 'Door')];
  const bob = checklistFor(its, { id: 'bob', type: 'house', bedrooms: 2, bathrooms: 1 }, areas);
  assert.deepEqual(bob.map(x => x.title), ['General & entry', 'Bedroom 1', 'Bedroom 2', 'Pool & hot tub']);
  const other = checklistFor(its, { id: 'cl', type: 'apartment', bedrooms: 1, bathrooms: 1 }, areas);
  assert.deepEqual(other.map(x => x.title), ['General & entry', 'Bedroom']);
  assert.equal(areaKey('Pool & hot tub'), 'pool_hot_tub');
  assert.equal(areaKey('Balcón'), 'balcon');
});

const check = (itemId: string | null, n: number, result: Check['result'], extra: Partial<Check> = {}): Check =>
  ({ itemId, area: 'kitchen', n, label: 'Stock', result, note: null, photos: [], outcome: null, ...extra });

test('progress counts each item in each room', () => {
  const s = checklistFor(ITEMS, { id: 'u1', bedrooms: 2, bathrooms: 1 });
  const p = progress(s, [check('1', 1, 'ok'), check('2', 2, 'attention'), check(null, 1, 'attention', { id: '9' })]);
  assert.deepEqual(p, { total: 5, done: 2, attention: 2 });
});

test('a finding needs a decision before the inspection can finish — a photo never (§135)', () => {
  const r = readyToFinish([check('1', 1, 'attention', { outcome: 'purchase' }), check('2', 1, 'attention', { photos: [{ name: 'a', url: 'u' }] }),
                           check('3', 1, 'ok')]);
  assert.equal(r.ok, false);
  assert.equal(r.undecided.length, 1);
  assert.equal(readyToFinish([check('1', 1, 'attention', { outcome: 'purchase' })]).ok, true);
});

test('overall result: OK, minor issues, or maintenance needed when anything becomes a repair', () => {
  assert.equal(overallResult([check('1', 1, 'ok')]), 'OK');
  assert.equal(overallResult([check('1', 1, 'attention', { outcome: 'purchase' })]), 'Minor issues');
  assert.equal(overallResult([check('1', 1, 'attention', { outcome: 'repair' })]), 'Maintenance needed');
  assert.equal(suggestedOutcome('clean'), 'clean_next');
});

test('a finding becomes a repair or a purchase, with where, who and the photos', () => {
  const ctx = { unit: 'CL1250', date: '2026-10-12', inspector: 'Sharon', sectionTitle: 'Bathroom 2' };
  const rep = workFor(check('3', 2, 'attention', { label: 'Grout', note: 'cracked by the tub', outcome: 'repair', photos: [{ name: 'p', url: 'https://x/p' }] }), ctx)!;
  assert.equal(rep.kind, 'work_order');
  assert.equal(rep.title, 'Bathroom 2: Grout — cracked by the tub');
  assert.match(rep.description, /inspection of CL1250 on 2026-10-12 by Sharon — Bathroom 2[\s\S]*Photo: https:\/\/x\/p/);
  assert.equal(workFor(check('1', 1, 'attention', { label: 'Coffee', outcome: 'purchase' }), ctx)!.title, 'Buy: Coffee');
  assert.equal(workFor(check('1', 1, 'attention', { outcome: 'clean_next' }), ctx), null);
});



test('all purchases become one shopping list, an item per sub-task', () => {
  const cs = [check('1', 1, 'attention', { label: 'Coffee', note: 'none left', outcome: 'purchase', photos: [{ name: 'p', url: 'https://x/p' }] }),
              check('2', 1, 'attention', { label: 'Towels', outcome: 'purchase', area: 'bathroom' }),
              check('3', 1, 'attention', { label: 'Grout', outcome: 'repair' })];
  const l = purchaseList(cs, { unit: 'CL1250', date: '2026-10-12', inspector: 'Sharon' }, c => c.area === 'bathroom' ? 'Bathroom' : 'Kitchen')!;
  assert.equal(l.title, 'Buy for CL1250: 2 items');
  assert.deepEqual(l.items, ['Buy: Coffee — none left (Kitchen)', 'Buy: Towels (Bathroom)']);
  assert.match(l.description, /• Coffee — none left \(Kitchen\)\n  Photo: https:\/\/x\/p\n• Towels/);
  assert.equal(purchaseList([cs[2]!], { unit: 'X', date: 'd', inspector: '' }, () => ''), null);
});

test('the review walks repairs, then purchases, then cleaning — only the steps with findings', () => {
  assert.deepEqual(reviewSteps([check('1', 1, 'attention', { outcome: 'clean_new' }), check('2', 1, 'attention', { outcome: 'repair' })]),
                   ['repair', 'clean', 'finish']);
  assert.deepEqual(reviewSteps([check('1', 1, 'ok')]), ['finish']);
});
