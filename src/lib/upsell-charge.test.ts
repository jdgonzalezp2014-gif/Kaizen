import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airbnbLinks, chargeLabel, extraNights, freeAround, hourLabel, hourOptions, hourPrice, isAirbnb, itemOf, needOf,
  nightsPrice } from './upsell-charge.ts';

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
