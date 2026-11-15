import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bill, entry, portalFrom, newFlow, doneFlow, nextStep, progress, protectionFor, rulesList, steps, flowExtras, type Flow } from './guest-checkin.ts';
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
  assert.deepEqual(protectionFor('house'), { waiver: { price: 79, cap: 3000 }, deposit: { hold: 500 } });
  assert.deepEqual(protectionFor('room', { waiverPrice: 35, waiverCap: null }), { waiver: { price: 35, cap: 1000 }, deposit: { hold: 150 } });
  assert.equal(protectionFor('room', { depositHold: -5 }).deposit.hold, 150);
});

test('steps: four required, extras optional, pay only when something is charged', () => {
  const st = steps(newFlow(), stay(), P);
  assert.deepEqual(st.map(x => x.key), ['details', 'identity', 'protection', 'rules', 'extras']);
  assert.deepEqual(progress(st), { done: 0, of: 4 });
  assert.equal(nextStep(st), 'details');
  const withWaiver = steps(f({ details: true, identity: true, protection: 'waiver' }), stay(), P);
  assert.equal(withWaiver.at(-1)!.key, 'pay');
  assert.equal(nextStep(withWaiver), 'rules');
  assert.deepEqual(progress(withWaiver), { done: 3, of: 5 });
});

test('Airbnb: protection is covered by the channel, nothing to pay', () => {
  const st = steps(f({ details: true, identity: true, rules: true, extrasSeen: true }), stay({ channel: 'airbnb' }), P);
  assert.equal(st.find(x => x.key === 'protection')!.done, true);
  assert.equal(st.some(x => x.key === 'pay'), false);
  assert.equal(nextStep(st), null);
});

test('bill: waiver is charged, deposit is held, early/late are requests', () => {
  assert.deepEqual(bill(f({ protection: 'waiver' }), stay(), P), { lines: [{ label: 'Damage waiver', amount: 49, kind: 'charge', note: 'Covers up to $1,500' }], today: 49, hold: 0 });
  const b = bill(f({ protection: 'deposit', extras: { 'welcome': {}, 'early-checkin': { time: '1:00 PM' } } }), stay(), P);
  assert.equal(b.today, 35);
  assert.equal(b.hold, 250);
  assert.deepEqual(b.lines.map(l => l.kind), ['hold', 'request', 'charge']);
});

test('entry opens after the required steps and the release time', () => {
  assert.deepEqual(entry(newFlow(), stay(), P, NOW), { open: false, why: 'steps' });
  assert.deepEqual(entry(doneFlow(), stay(), P, NOW), { open: true });
  assert.deepEqual(entry(doneFlow(), stay({ guideReleaseAt: '2026-11-14T17:00:00Z' }), P, NOW), { open: false, why: 'release', at: '2026-11-14T17:00:00Z' });
  // Waiver picked but not paid: still closed.
  assert.equal(entry({ ...doneFlow(), paid: false }, stay(), P, NOW).open, false);
});

test('flow extras: a short stay hides the mid-stay clean', () => {
  assert.deepEqual(flowExtras(stay()).map(x => x.u.kind), ['early-checkin', 'late-checkout', 'mid-clean', 'welcome']);
  assert.deepEqual(flowExtras(stay({ departure: '2026-11-16' })).map(x => x.u.kind), ['early-checkin', 'late-checkout', 'welcome']);
  assert.equal(flowExtras(stay())[0]!.turnover, true);
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
    { unitType: 'apartment', protection: { waiverPrice: 59, waiverCap: 2000, depositHold: null } });
  assert.deepEqual(portalFrom(null), { unitType: null, protection: { waiverPrice: null, waiverCap: null, depositHold: null } });
});
