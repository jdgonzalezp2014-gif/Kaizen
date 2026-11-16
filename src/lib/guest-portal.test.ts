import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payState, guide, availability, quote, ready, upsellRequest, choiceLine, guestLink, minutesOf, hoursOf, centralInstant, requestMode, calendarFit, UPSELLS, type GuestStay } from './guest-portal.ts';

const stay = (o: Partial<GuestStay> = {}): GuestStay => ({
  id: '101', guestFirst: 'Ana', unitName: 'Frisco 3BR', address: null, photo: null,
  arrival: '2026-11-14', departure: '2026-11-17', checkInTime: '4:00 PM', checkOutTime: '11:00 AM', guests: 4,
  channel: 'direct', total: 75, paid: 0, nightly: 180, freeBefore: 1, freeAfter: 2, turnIn: false, turnOut: true,
  guideReleaseAt: '2026-11-13T17:00:00Z', pay: { provider: 'hostaway', url: null }, ...o,
});
const U = (k: string) => UPSELLS.find(u => u.kind === k)!;
const NOW = new Date('2026-11-14T12:00:00Z');

test('pay state: unpaid, partial, paid, and Airbnb collects itself', () => {
  assert.deepEqual(payState(stay()), { state: 'unpaid', due: 75 });
  assert.deepEqual(payState(stay({ paid: 36 })), { state: 'partial', due: 39 });
  assert.deepEqual(payState(stay({ paid: 75 })), { state: 'paid', due: 0 });
  assert.deepEqual(payState(stay({ channel: 'airbnb', total: 0 })), { state: 'channel', due: 0 });
});

test('check-in instructions need nothing due and the release time passed', () => {
  assert.deepEqual(guide(stay(), NOW), { open: false, why: 'unpaid' });
  assert.deepEqual(guide(stay({ paid: 75, guideReleaseAt: '2026-11-15T00:00:00Z' }), NOW), { open: false, why: 'release', at: '2026-11-15T00:00:00Z' });
  assert.deepEqual(guide(stay({ paid: 75 }), NOW), { open: true });
  assert.equal(guide(stay({ paid: 75, guideReleaseAt: null }), NOW).open, false);
});

test('extra nights only as far as the calendar gap; turnover flags, never blocks', () => {
  assert.deepEqual(availability(stay({ freeBefore: 0, freeAfter: 0 }), U('extra-nights')), { ok: false, why: 'calendar' });
  assert.deepEqual(availability(stay({ nightly: null }), U('extra-nights')), { ok: false, why: 'price' });
  assert.equal(quote(stay(), U('extra-nights'), { before: 5, after: 1 }), 360); // 1 before (gap) + 1 after
  assert.deepEqual(availability(stay(), U('late-checkout')), { ok: true, flag: 'turnover' });
  assert.deepEqual(availability(stay(), U('early-checkin')), { ok: true });
  assert.deepEqual(availability(stay(), U('mid-clean')), { ok: false, why: 'short' });
});

test('a request is ready only with what it asks for', () => {
  assert.equal(ready(stay(), U('early-checkin'), {}), false);
  assert.equal(ready(stay(), U('early-checkin'), { time: '1:00 PM' }), true);
  assert.equal(ready(stay(), U('extra-nights'), {}), false);
  assert.equal(ready(stay(), U('welcome'), {}), true);
});

test('the new upselling request keeps only its own choice, clamped, with its quote', () => {
  const r = upsellRequest(stay(), U('crib'), { qty: 9, time: 'x' }, NOW);
  assert.deepEqual(r.choice, { qty: 2 });
  assert.equal(r.quote, 50);
  assert.equal(r.status, 'new');
  const l = upsellRequest(stay(), U('late-checkout'), { time: '1:00 PM' }, NOW);
  assert.equal(l.turnover, true);
  assert.equal(choiceLine(l), 'until 1:00 PM');
  assert.equal(choiceLine(upsellRequest(stay(), U('extra-nights'), { after: 2 }, NOW)), '2 after');
});

test('the guest link: the Hostaway reservation id and its signature, nothing else', () => {
  assert.deepEqual(guestLink('/guest/48211903.Ab_9-x'), { id: '48211903', sig: 'Ab_9-x' });
  assert.deepEqual(guestLink('/guest/demo'), { id: 'demo', sig: null });
  assert.equal(guestLink('/guest/48211903'), null); // a bare id is guessable — not a link
  assert.equal(guestLink('/guest/1;drop.x'), null);
  assert.equal(guestLink('/crew'), null);
});

test('Pay opens the guest\'s own Hostaway portal; "Unknown" is not "unpaid"', async () => {
  const { payFromHostaway } = await import('./guest-portal.ts');
  const r = payFromHostaway({ guestPortalUrl: 'https://guest-portal.hostaway.com/70782256/abc', paymentStatus: 'Paid', remainingBalance: null });
  assert.deepEqual(r, { pay: { provider: 'hostaway', url: 'https://guest-portal.hostaway.com/70782256/abc' }, hostawayPaid: true, balance: null });
  assert.equal(payFromHostaway({ paymentStatus: 'Unknown' }).hostawayPaid, null);
  assert.equal(payFromHostaway({ paymentStatus: 'Unpaid' }).hostawayPaid, false);
  assert.deepEqual(payFromHostaway({ guestPortalUrl: 'https://evil.example/x' }).pay, { provider: 'none', url: null });
});

test('check-in guide from the Repository: maps the Units fields, never the team codes (2026-11-09)', async () => {
  const { guideFrom, pricesFrom, priceOf } = await import('./guest-portal.ts');
  const g = guideFrom({ hw_address: ' 1 Main St, Frisco TX ', wifi_network: 'Kaizen', password_2: 'abc123', checkin_from: '4 PM',
    checkout_time: '11 AM', parking: '', parking_free_street: true, parking_extra_price: '', house_manual: 'not a link',
    cleaner_code: '9999', lockbox: '1234', pet_fee: 100 })!;
  assert.equal(g.address, '1 Main St, Frisco TX');
  assert.deepEqual(g.wifi, { network: 'Kaizen', password: 'abc123' });
  assert.deepEqual(g.parking, { notes: null, freeStreet: true, coveredPerNight: null });
  assert.equal(g.manual, null);
  assert.doesNotMatch(JSON.stringify(g), /9999|1234/);
  assert.equal(guideFrom(null), null);
  const pet = UPSELLS.find(u => u.kind === 'pet')!;
  const prices = pricesFrom({ pet_fee: 100 });
  assert.equal(priceOf({ prices }, pet), 100);
  assert.equal(priceOf({}, pet), pet.price);
  assert.equal(quote(stay({ prices }), pet, { qty: 2 }), 200);
});

test('early / late: $20 per hour over the stay’s own times', () => {
  assert.equal(minutesOf('4:00 PM'), 960);
  assert.equal(minutesOf('12 PM'), 720);
  assert.equal(minutesOf('11:30'), 690);
  assert.equal(minutesOf('13 PM'), null);
  assert.equal(hoursOf(stay(), U('early-checkin'), '1:00 PM'), 3);
  assert.equal(hoursOf(stay(), U('late-checkout'), '12:00 PM'), 1);
  assert.equal(hoursOf(stay(), U('early-checkin'), '5:00 PM'), null);
  assert.equal(quote(stay(), U('early-checkin'), { time: '12:00 PM' }), 80);
  assert.equal(quote(stay(), U('late-checkout'), { time: '2:00 PM' }), 60);
});

test('Central time: 8 PM in Texas, in summer and in winter', () => {
  assert.equal(centralInstant('2026-11-14', 20).toISOString(), '2026-11-15T02:00:00.000Z');
  assert.equal(centralInstant('2026-07-14', 20).toISOString(), '2026-07-15T01:00:00.000Z');
});

test('request mode: by 8 PM the day before → automatic; later or a turnover → approval', () => {
  const s = stay({ arrival: '2026-11-20', departure: '2026-11-23', turnIn: false, turnOut: false });
  assert.deepEqual(requestMode(s, U('early-checkin'), new Date('2026-11-20T01:59:00Z')), { mode: 'auto' });       // Nov 19, 7:59 PM CST
  assert.deepEqual(requestMode(s, U('early-checkin'), new Date('2026-11-20T02:00:00Z')), { mode: 'approval', why: 'late' });
  assert.deepEqual(requestMode(s, U('late-checkout'), new Date('2026-11-21T12:00:00Z')), { mode: 'auto' });
  assert.deepEqual(requestMode({ ...s, turnOut: true }, U('late-checkout'), new Date('2026-11-21T12:00:00Z')), { mode: 'approval', why: 'turnover' });
  const r = upsellRequest(s, U('early-checkin'), { time: '2:00 PM' }, new Date('2026-11-18T12:00:00Z'));
  assert.equal(r.mode, 'auto');
  assert.equal(r.status, 'confirmed');
  assert.equal(r.quote, 40);
});

test('Guest services: "No" hides an extra, blank offers it; prices from the record', async () => {
  const { notOfferedFrom, offered, pricesFrom } = await import('./guest-portal.ts');
  const off = notOfferedFrom({ svc_welcome: 'No', svc_crib: 'Yes', svc_pet: '' });
  assert.deepEqual(off, ['welcome']);
  assert.ok(!offered({ notOffered: off }).some(u => u.kind === 'welcome'));
  assert.equal(offered({}).length, 7);
  assert.deepEqual(pricesFrom({ mid_clean_price: '91', welcome_price: 40 }), { 'mid-clean': 91, welcome: 40 });
});

test('calendarFit: free nights each side, turnovers, unknown nights are taken', () => {
  const n = (date: string, available: boolean) => ({ date, available });
  const days = [n('2026-11-08', false), n('2026-11-09', true), n('2026-11-10', true), /* stay 11–14 */
    n('2026-11-14', true), n('2026-11-15', false)];
  assert.deepEqual(calendarFit(days, '2026-11-11', '2026-11-14'), { freeBefore: 2, freeAfter: 1, turnIn: false, turnOut: false });
  assert.deepEqual(calendarFit([n('2026-11-10', false), n('2026-11-14', false)], '2026-11-11', '2026-11-14'), { freeBefore: 0, freeAfter: 0, turnIn: true, turnOut: true });
  assert.deepEqual(calendarFit([], '2026-11-11', '2026-11-14'), { freeBefore: 0, freeAfter: 0, turnIn: false, turnOut: false });
});
