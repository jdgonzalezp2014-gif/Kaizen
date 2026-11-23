import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelOf, cleanFlow, hourLabel, isLive, lockedStay, releaseAt, stayFrom, type HouseFacts } from './guest-stay.ts';
import { stayTokenOf } from './guest-portal.ts';

const house: HouseFacts = {
  unitName: 'P2-1304', photo: null, lockType: 'Access Fob', guestCode: null, unitType: 'apartment', protection: null, prices: {},
  guide: { address: '1 Main St', wifi: { network: 'K', password: 'pw' }, checkIn: '4 PM', checkOut: '10 AM', parking: null, access: 'All of it',
    manual: 'https://m', rules: 'No parties', phone: '555', steps: [{ title: 'Door', text: 'Lockbox 1234', pin: null }] },
};
const res = { id: 586502, arrivalDate: '2026-12-01', departureDate: '2026-12-04', guestFirstName: 'Ana', guestName: 'Ana Ruiz', guestEmail: 'a@x.com',
  checkInTime: 16, checkOutTime: 10, numberOfGuests: 3, adults: 2, children: 1, channelName: 'homeaway', status: 'new' };

test('stayFrom: the reservation as the portal shows it', () => {
  const s = stayFrom(res, house, { checkedIn: false, doorCode: null })!;
  assert.equal(s.id, '586502');
  assert.equal(s.guestFirst, 'Ana');
  assert.equal(s.channel, 'vrbo');
  assert.equal(s.checkInTime, '4:00 PM');
  assert.equal(s.checkOutTime, '10:00 AM');
  assert.equal(s.guests, 3);
  assert.equal(s.total, 0);
  assert.equal(stayFrom({ ...res, departureDate: '2026-12-01' }, house, { checkedIn: false, doorCode: null }), null);
});

test('locked: before the entry opens no address, Wi-Fi, steps, manual, phone or code leave the server — the rules do', () => {
  const s = lockedStay(stayFrom(res, house, { checkedIn: false, doorCode: '9876' })!);
  const text = JSON.stringify(s);
  for (const x of ['1 Main St', 'pw', 'Lockbox 1234', 'https://m', '555', '9876']) assert.doesNotMatch(text, new RegExp(x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  assert.equal(s.guide?.rules, 'No parties');
  assert.equal(s.guide?.checkIn, '4 PM');
});

test('release: noon Central the day before arrival', () => {
  assert.equal(releaseAt('2026-12-01'), '2026-11-30T18:00:00.000Z');
  assert.equal(releaseAt('2026-07-01'), '2026-06-30T17:00:00.000Z');
});

test('cleanFlow: the page never sets identity or paid; junk is dropped', () => {
  const f = cleanFlow({ details: true, identity: true, paid: true, protection: 'deposit', rules: 'yes', arrival: '6:00 PM', changeAsk: '  2 more guests ',
    extras: { 'early-checkin': { time: '2:00 PM' }, hack: { qty: 3 }, 'mid-clean': { qty: 99 } } }, { identity: false, paid: false });
  assert.equal(f.identity, false);
  assert.equal(f.paid, false);
  assert.equal(f.details, true);
  assert.equal(f.rules, false);
  assert.equal(f.protection, 'deposit');
  assert.equal(f.changeAsk, '2 more guests');
  assert.deepEqual(f.extras, { 'early-checkin': { time: '2:00 PM' }, 'mid-clean': { qty: 20 } });
  assert.equal(cleanFlow(null, { identity: true, paid: true, paidTotal: 70 }).paidTotal, 70);
});

test('channels, hours, live statuses, the token from the path', () => {
  assert.equal(channelOf('airbnbOfficial'), 'airbnb');
  assert.equal(channelOf('bookingcom'), 'booking');
  assert.equal(channelOf('direct'), 'direct');
  assert.equal(hourLabel(0, 'x'), '12:00 AM');
  assert.equal(hourLabel(null, '4:00 PM'), '4:00 PM');
  assert.ok(isLive('new') && isLive('modified') && !isLive('cancelled') && !isLive('inquiry'));
  assert.equal(stayTokenOf('/guest/586502.abcdefgh'), '586502.abcdefgh');
  assert.equal(stayTokenOf('/guest/demo'), null);
  assert.equal(stayTokenOf('/crew/guest-demo'), null);
});
