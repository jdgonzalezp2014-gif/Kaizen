import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checklistFor, overallResult, progress, readyToFinish, roomsOf, suggestedOutcome, workFor,
         type Check, type InspectionItem } from './inspection.ts';

const item = (id: string, area: InspectionItem['area'], label: string, extra: Partial<InspectionItem> = {}): InspectionItem =>
  ({ id, area, label, defaultOutcome: 'repair', unitId: null, position: Number(id), active: true, ...extra });
const ITEMS = [item('1', 'kitchen', 'Stock'), item('2', 'bedroom', 'Sheets'), item('3', 'bathroom', 'Towels'),
               item('4', 'general', 'Lock'), item('5', 'exterior', 'Pool', { unitId: 'u2' }), item('6', 'living', 'Old', { active: false })];

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

const check = (itemId: string | null, n: number, result: Check['result'], extra: Partial<Check> = {}): Check =>
  ({ itemId, area: 'kitchen', n, label: 'Stock', result, note: null, photos: [], outcome: null, ...extra });

test('progress counts each item in each room', () => {
  const s = checklistFor(ITEMS, { id: 'u1', bedrooms: 2, bathrooms: 1 });
  const p = progress(s, [check('1', 1, 'ok'), check('2', 2, 'attention'), check(null, 1, 'attention', { id: '9' })]);
  assert.deepEqual(p, { total: 5, done: 2, attention: 2 });
});

test('a finding needs a photo and a decision before the inspection can finish', () => {
  const r = readyToFinish([check('1', 1, 'attention', { outcome: 'purchase' }), check('2', 1, 'attention', { photos: [{ name: 'a', url: 'u' }] }),
                           check('3', 1, 'ok')]);
  assert.equal(r.ok, false);
  assert.equal(r.missingPhoto.length, 1);
  assert.equal(r.undecided.length, 1);
  assert.equal(readyToFinish([check('1', 1, 'attention', { outcome: 'purchase', photos: [{ name: 'a', url: 'u' }] })]).ok, true);
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
