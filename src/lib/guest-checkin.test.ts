import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bill, doorCodeFor, entry, portalFrom, newFlow, doneFlow, nextStep, progress, protectionFor, rulesList, steps, IDENTITY_STEP_ON, flowExtras, arrivalTimes, LATE_ARRIVAL, type Flow } from './guest-checkin.ts';
import type { GuestStay } from './guest-portal.ts';

const stay = (o: Partial<GuestStay> = {}): GuestStay => ({
  id: '101', guestFirst: 'Ana', unitName: 'Frisco 3BR', address: null, photo: null,
  arrival: '2026-11-14', departure: '2026-11-18', checkInTime: '4:00 PM', checkOutTime: '11:00 AM', guests: 4,
  channel: 'direct', total: 0, paid: 0, nightly: 180, freeBefore: 1, freeAfter: 2, turnIn: true, turnOut: false,
  guideReleaseAt: '2026-11-13T17:00:00Z', pay: { provider: 'none', url: null }, ...o,
});
const P = protectionFor('apartment');
const NOW = new Date('2026-11-14T12:00:00Z');
const f = (o: Partial<Flow>): Flow => ({ ...newFlow(), ...o });

test('protection: defaults by unit type, a listing value wins, blanks keep the default', () => {
  assert.deepEqual(protectionFor('house'), { waiver: { price: 60, min: 60, perNight: 12, cap: 3000 }, deposit: { hold: 500 } });
  assert.deepEqual(protectionFor('room', { waiverMin: 35, waiverCap: null }), { waiver: { price: 35, min: 35, perNight: 12, cap: 1000 }, deposit: { hold: 500 } });
  assert.equal(protectionFor('room', { depositHold: -5 }).deposit.hold, 500);
});

test('protection: the waiver is $/night × nights, never under the minimum (owner, 2026-11-23)', () => {
  assert.equal(protectionFor('house', {}, 3).waiver.price, 60);   // 3 × 12 = 36 → the $60 minimum
  assert.equal(protectionFor('house', {}, 6).waiver.price, 72);   // 6 × 12 = 72 > 60
  assert.equal(protectionFor('house', { waiverNight: 15, waiverMin: 50 }, 4).waiver.price, 60);
  assert.equal(protectionFor('house', {}, 0).waiver.price, 60);
});

test('steps: four required, extras optional, pay only when something is charged', () => {
  const st = steps(newFlow(), stay(), P);
  assert.deepEqual(st.map(x => x.key), ['details', ...(IDENTITY_STEP_ON ? ['identity'] : []), 'protection', 'rules', 'extras']);
  assert.deepEqual(progress(st), { done: 0, of: IDENTITY_STEP_ON ? 4 : 3 });
  assert.equal(nextStep(st), 'details');
  const withWaiver = steps(f({ details: true, identity: true, protection: 'waiver' }), stay(), P);
  assert.equal(withWaiver.at(-1)!.key, 'pay');
  assert.equal(nextStep(withWaiver), 'rules');
  assert.deepEqual(progress(withWaiver), IDENTITY_STEP_ON ? { done: 3, of: 5 } : { done: 2, of: 4 });
});

test('Airbnb: waiver / deposit like everyone, or "none" (nothing to pay); other channels cannot pick none', () => {
  const base = { details: true, identity: true, rules: true, extrasSeen: true } as const;
  assert.equal(steps(f(base), stay({ channel: 'airbnb' }), P).find(x => x.key === 'protection')!.done, false);
  const none = steps(f({ ...base, protection: 'none' }), stay({ channel: 'airbnb' }), P);
  assert.equal(none.some(x => x.key === 'pay'), false);
  assert.equal(nextStep(none), null);
  assert.equal(bill(f({ protection: 'waiver' }), stay({ channel: 'airbnb' }), P).today, 60);
  assert.equal(steps(f({ ...base, protection: 'none' }), stay(), P).find(x => x.key === 'protection')!.done, false);
});

test('bill: waiver is charged, deposit is held, extras are charged now; early on a turnover drops off', () => {
  assert.deepEqual(bill(f({ protection: 'waiver' }), stay(), P), { lines: [{ label: 'Damage waiver', amount: 60, kind: 'charge', item: 'waiver', note: 'Covers up to $1,500' }], today: 60, hold: 0 });
  const b = bill(f({ protection: 'deposit', extras: { 'welcome': {}, 'early-checkin': { time: '1:00 PM' } } }), stay(), P);
  assert.equal(b.today, 35);
  assert.equal(b.hold, 500);
  assert.deepEqual(b.lines.map(l => l.kind), ['hold', 'charge']);
  const n = bill(f({ extras: { 'early-checkin': { time: '1:00 PM' } } }), stay({ turnIn: false }), P);
  assert.deepEqual(n.lines.map(l => [l.item, l.kind]), [['early-checkin', 'charge']]);
});

test('entry opens after the required steps and the release time', () => {
  assert.deepEqual(entry(newFlow(), stay(), P, NOW), { open: false, why: 'steps' });
  assert.deepEqual(entry(doneFlow(), stay(), P, NOW), { open: true });
  assert.deepEqual(entry(doneFlow(), stay({ guideReleaseAt: '2026-11-14T17:00:00Z' }), P, NOW), { open: false, why: 'release', at: '2026-11-14T17:00:00Z' });
  // Waiver picked but not paid: still closed.
  assert.equal(entry({ ...doneFlow(), paid: false }, stay(), P, NOW).open, false);
});

test('flow extras: a short stay hides the mid-stay clean', () => {
  assert.deepEqual(flowExtras(stay({ turnIn: false })).map(x => x.u.kind), ['early-checkin', 'late-checkout', 'mid-clean', 'welcome']);
  assert.deepEqual(flowExtras(stay({ turnIn: false, departure: '2026-11-16' })).map(x => x.u.kind), ['early-checkin', 'late-checkout', 'welcome']);
  // A guest leaving the day this one arrives: no early check-in to sell.
  assert.deepEqual(flowExtras(stay()).map(x => x.u.kind), ['late-checkout', 'mid-clean', 'welcome']);
});

test('rules: lines, bullets and "Title: detail" become short items', () => {
  assert.deepEqual(rulesList('No smoking: $250 fee\n- Quiet hours 10 PM – 8 AM\n• No parties — registered guests only'), [
    { title: 'No smoking', detail: '$250 fee' },
    { title: 'Quiet hours 10 PM – 8 AM', detail: '' },
    { title: 'No parties', detail: 'registered guests only' },
  ]);
  assert.deepEqual(rulesList(''), []);
  assert.deepEqual(rulesList('No pets. No smoking.').map(r => r.title), ['No pets', 'No smoking']);
});

test('portal fields from the record: unit type and protection, blanks and junk ignored', () => {
  assert.deepEqual(portalFrom({ unit_type: 'Apartment', waiver_price: '$59', waiver_cap: 2000, deposit_hold: '' }),
    { unitType: 'apartment', protection: { waiverMin: 59, waiverNight: null, waiverCap: 2000, depositHold: null } });
  assert.deepEqual(portalFrom({ waiver_price: 70, insurance_fee: 12, damage_deposit: 300 }).protection, { waiverMin: 70, waiverNight: 12, waiverCap: null, depositHold: 300 });
  assert.deepEqual(portalFrom(null), { unitType: null, protection: { waiverMin: null, waiverNight: null, waiverCap: null, depositHold: null } });
});

test('doorCodeFor: smart lock → reservation code, else the Repository code; fob / keys → none', () => {
  assert.equal(doorCodeFor('Yale Smart Lock', '2580', null), '2580');
  assert.equal(doorCodeFor('Schlage Smart Lock', '2580', '7731'), '7731');
  assert.equal(doorCodeFor('Access Fob', '2580', '7731'), null);
  assert.equal(doorCodeFor('Keys', null, '7731'), null);
  assert.equal(doorCodeFor('None', null, null), null);
  assert.equal(doorCodeFor(null, ' ', '4821'), '4821');
});

test('portalFrom: blank Unit type falls back to Property type', () => {
  assert.equal(portalFrom({ property_type: 'Apartment' }).unitType, 'apartment');
  assert.equal(portalFrom({ property_type: 'House', unit_type: 'Room' }).unitType, 'room');
  assert.equal(portalFrom({}).unitType, null);
});

test('arrivalTimes: from check-in every 30 minutes, then after midnight', () => {
  const t = arrivalTimes('4:00 PM');
  assert.equal(t[0], '4:00 PM'); assert.equal(t[1], '4:30 PM'); assert.equal(t.at(-2), '11:30 PM'); assert.equal(t.at(-1), LATE_ARRIVAL);
  assert.equal(arrivalTimes('3:15 PM')[0], '3:30 PM');
});

test('cleanPhone: US 10 / 11 digits and +country numbers; anything short is not a number', async () => {
  const { cleanPhone } = await import('./guest-checkin.ts');
  assert.equal(cleanPhone('(312) 555-0199'), '+13125550199');
  assert.equal(cleanPhone('1 312 555 0199'), '+13125550199');
  assert.equal(cleanPhone('+57 300 123 4567'), '+573001234567');
  assert.equal(cleanPhone('555-0199'), null);
  assert.equal(cleanPhone(42), null);
});
