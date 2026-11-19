import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airbnbLinks, applyPlan, chargeLabel, extraNights, followUp, freeAround, hourLabel, hourOptions, hourPrice, isAirbnb, isDirect,
  itemOf, methodsFor, needOf, nightsPrice, payGuestText, runsOf } from './upsell-charge.ts';

test('what each upsell kind needs besides money', () => {
  assert.equal(needOf('Extra nights'), 'nights');
  assert.equal(needOf('Early check-in'), 'checkin');
  assert.equal(needOf('Late checkout'), 'checkout');
  assert.equal(needOf('Pet fee'), 'amount');
  assert.equal(needOf(null), 'amount');
});

test('Airbnb is told apart by Hostaway channel name', () => {
  assert.equal(isAirbnb('airbnbOfficial'), true);
  assert.equal(isAirbnb('vrboical'), false);
  assert.equal(isAirbnb(null), false);
});

test('hours: options, price at $20 an hour, labels', () => {
  assert.deepEqual(hourOptions('checkin', 12), [8, 9, 10, 11]);
  assert.deepEqual(hourOptions('checkout', 15), [16, 17, 18]);
  assert.equal(hourPrice('checkin', 16, 13), 60);
  assert.equal(hourPrice('checkout', 11, 14), 60);
  assert.equal(hourPrice('checkout', 11, 10), 0);
  assert.equal(hourLabel(0), '12:00 AM');
  assert.equal(hourLabel(12), '12:00 PM');
  assert.equal(hourLabel(14), '2:00 PM');
});

test('extra nights: before the arrival and from the departure night on', () => {
  assert.deepEqual(extraNights('2026-11-20', '2026-11-23', 2, 1), ['2026-11-18', '2026-11-19', '2026-11-23']);
  assert.deepEqual(extraNights('2026-11-20', '2026-11-23', 0, 0), []);
});

test('free nights stop at the first taken one; price needs every night', () => {
  const days = [
    { date: '2026-11-18', available: false, price: 100 }, { date: '2026-11-19', available: true, price: 110 },
    { date: '2026-11-23', available: true, price: 120 }, { date: '2026-11-24', available: true, price: null },
    { date: '2026-11-25', available: false, price: 90 },
  ];
  assert.deepEqual(freeAround(days, '2026-11-20', '2026-11-23'), { before: 1, after: 2 });
  assert.equal(nightsPrice(days, ['2026-11-19', '2026-11-23']), 230);
  assert.equal(nightsPrice(days, ['2026-11-23', '2026-11-24']), null);
});

test('labels and book items', () => {
  assert.equal(chargeLabel('Extra nights', { nights: ['2026-11-23', '2026-11-24'] }), 'Extra nights · 2 nights (Nov 23 – Nov 24)');
  assert.equal(chargeLabel('Late checkout', { hour: 14 }), 'Late checkout · 2:00 PM');
  assert.equal(chargeLabel('Pet fee', {}), 'Pet fee');
  assert.equal(itemOf('Late checkout'), 'late-checkout');
  assert.equal(itemOf('Other upsell'), 'other');
});

test('Airbnb links: the reservation only with a real HM code', () => {
  assert.equal(airbnbLinks('HMYAFSWFWH').reservation, 'https://www.airbnb.com/hosting/reservations/details/HMYAFSWFWH');
  assert.equal(airbnbLinks('123').reservation, null);
  assert.equal(airbnbLinks(null).resolution, 'https://www.airbnb.com/resolutions');
});

test('how the guest can pay: card anywhere, Airbnb also the Resolution Center', () => {
  assert.deepEqual(methodsFor(true), ['rc', 'card']);
  assert.deepEqual(methodsFor(false), ['card']);
  assert.equal(isDirect('direct'), true);
  assert.equal(isDirect('bookingengine'), true);
  assert.equal(isDirect('homeaway'), false);
  assert.equal(isDirect('airbnbOfficial'), false);
});

test('after the payment: an hour, an extension of a direct booking, or a block', () => {
  const stay = { arrival: '2026-11-20', departure: '2026-11-23' };
  assert.deepEqual(applyPlan({ need: 'checkout', hour: 14, nights: [] }, { ...stay, channel: 'airbnbOfficial' }), { kind: 'hour', field: 'checkout', hour: 14 });
  assert.deepEqual(applyPlan({ need: 'nights', hour: null, nights: ['2026-11-23', '2026-11-24'] }, { ...stay, channel: 'direct' }),
    { kind: 'extend', arrival: '2026-11-20', departure: '2026-11-25' });
  assert.deepEqual(applyPlan({ need: 'nights', hour: null, nights: ['2026-11-19'] }, { ...stay, channel: 'direct' }),
    { kind: 'extend', arrival: '2026-11-19', departure: '2026-11-23' });
  assert.deepEqual(applyPlan({ need: 'nights', hour: null, nights: ['2026-11-24', '2026-11-23'] }, { ...stay, channel: 'homeaway' }),
    { kind: 'block', nights: ['2026-11-23', '2026-11-24'] });
  assert.deepEqual(applyPlan({ need: 'amount', hour: null, nights: [] }, { ...stay, channel: 'direct' }), { kind: 'none' });
});

test('nights in runs, one write each', () => {
  assert.deepEqual(runsOf(['2026-11-24', '2026-11-18', '2026-11-19', '2026-11-23']),
    [{ from: '2026-11-18', to: '2026-11-19' }, { from: '2026-11-23', to: '2026-11-24' }]);
});

test('the follow-up says the new day and the three things to move', () => {
  const f = followUp('P2-1406', 'Ana', { arrival: '2026-11-20', departure: '2026-11-23' }, ['2026-11-23', '2026-11-24']);
  assert.match(f.description, /leaves 2026-11-25 instead of 2026-11-23/);
  assert.match(f.description, /Door code/);
  assert.match(f.title, /P2-1406/);
});

test('the pay message carries the stay page when there is one', () => {
  assert.match(payGuestText('Pet fee', 75, 'https://x/pay', 'https://x/guest/1.a'), /stay page: https:\/\/x\/guest\/1\.a/);
  assert.doesNotMatch(payGuestText('Pet fee', 75, 'https://x/pay'), /stay page/);
});
