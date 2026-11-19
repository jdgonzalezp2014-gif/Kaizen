import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amenitiesOf, amenityLine, areaOf, listingFacts, portfolioFacts, scrubCodes, stayFacts, workFacts } from './guest-knowledge.ts';

test('digits after a code word are withheld, wherever they sit', () => {
  // Both seen in real records' Elevator field (2026-11-19).
  assert.equal(scrubCodes('Front door code: 33889054'), 'Front door code: [withheld]');
  assert.equal(scrubCodes('Lockbox with back up key on front door code is 2000'), 'Lockbox with back up key on front door code is [withheld]');
  assert.equal(scrubCodes('Gate 1234#, then the keypad *5566'), 'Gate [withheld]#, then the keypad *[withheld]');
  assert.equal(scrubCodes('Sleeps 6 · 2 bedrooms · pool'), 'Sleeps 6 · 2 bedrooms · pool');
});

test('listing facts: guest-safe fields only, money as dollars, internal fields never', () => {
  const vals = { max_guests: '10', hw_beds: 5, pet_fee: '150', insurance_fee: 12, description: 'Big house', cleaner_code: '9999',
    lease_notes: 'renew in May', password: 'x', storage: 'garage', utilities: 'Atmos gas', hw_cancellation: 'strict', elevator: 'None' };
  const booked = listingFacts(vals, true);
  assert.ok(booked.includes('Max guests: 10') && booked.includes('Pet fee: $150') && booked.includes('Damage waiver per night: $12'));
  assert.ok(booked.includes('Cancellation policy: strict') && booked.includes('Description: Big house') && booked.includes('Utilities: Atmos gas'));
  assert.ok(!booked.some(l => /9999|renew|garage|Elevator/.test(l)));
  assert.ok(!listingFacts(vals, false).some(l => l.startsWith('Utilities')));   // before booking: not the house's accounts
  assert.deepEqual(listingFacts(null, true), []);
});

test('amenities: the present ones, once', () => {
  assert.deepEqual(amenitiesOf({ listingAmenities: [{ amenityName: 'TV', isPresent: 1 }, { amenityName: 'Pool', isPresent: 0 }, { amenityName: 'Towels' }] }), ['TV', 'Towels']);
  assert.deepEqual(amenitiesOf(null), []);
  assert.equal(amenityLine(['TV', 'TV', 'Towels']), 'Amenities (Hostaway): TV, Towels');
  assert.equal(amenityLine([]), '');
});

test('this booking: party, pets, own hours, total, what is pending', () => {
  const L = stayFacts({ adults: 2, children: 1, infants: 0, pets: 0, numberOfGuests: 3, nights: 21, checkInTime: 16, checkOutTime: 10, totalPrice: 2934.98,
    currency: 'USD', remainingBalance: 0, guestNote: 'Softball  tournament' }, { channel: 'Airbnb', agreement: 'not_signed', idVerified: false, checkinDone: false });
  assert.deepEqual(L, ['Booked through: Airbnb', 'Party: 2 adults, 1 child (3 guests) · no pets booked', 'Nights: 21', "This booking's hours: check-in 4 PM, check-out 10 AM",
    'Booking total: 2934.98 USD', "Guest's note at booking (the guest speaking): Softball tournament", 'Rental agreement: not_signed', 'ID verified: no', 'Online check-in: not done']);
  assert.ok(stayFacts({ pets: 2, adults: 4, numberOfGuests: 4 })[0]!.startsWith('Party: 4 adults, 2 pets (4 guests)'));
  assert.deepEqual(stayFacts(null), []);
});

test('open work and the other listings', () => {
  assert.deepEqual(workFacts([{ title: 'No hot water', status: 'open', kind: 'repair', dueOn: '2026-11-18' }]), ['Repair: No hot water — open, planned 2026-11-18']);
  assert.deepEqual(portfolioFacts([{ name: 'A', title: 'Lux 1B1B w/ Pool', area: 'Plano, TX', bedrooms: '1', guests: 4 }, { name: 'B' }], 'B'),
    ['Lux 1B1B w/ Pool — Plano, TX · 1 bd · up to 4 guests']);
});

test('the area keeps the city, never the street', () => {
  assert.equal(areaOf('15201Pleasant Ridge Way, Frisco, Texas, United States, 75033'), 'Frisco, Texas, 75033');
  assert.equal(areaOf('Plano, TX'), 'Plano, TX');
  assert.ok(listingFacts({ hw_public_address: '1 Main St, Celina, TX' }, false).includes('Area: Celina, TX'));
});
