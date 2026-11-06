import { test } from 'node:test';
import assert from 'node:assert/strict';
import { payState, guide, availability, quote, ready, upsellRequest, choiceLine, guestLink, UPSELLS, type GuestStay } from './guest-portal.ts';

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
