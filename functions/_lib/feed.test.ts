import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFive } from './feed.ts';

test('a ten-point score is halved before it is stored', () => {
  // Booking.com and Expedia print out of 10. Stored raw, an 8.6 sits
  // beside an Airbnb 4.8 in the same column and reads as the better
  // property — which is the opposite of the truth.
  assert.equal(toFive(8.6, 10), 4.3);
  assert.equal(toFive(9.2, 10), 4.6);
});

test('a five-point score is left alone', () => {
  assert.equal(toFive(4.87, 5), 4.87);
});

test('the number wins over the declared scale when they disagree', () => {
  // A 9.2 in a column labelled /5 is a ten-point score in the wrong
  // column. Halving it keeps a real reading; rejecting it loses one.
  assert.equal(toFive(9.2, 5), 4.6);
});

test('nothing and nonsense come back as null, never zero', () => {
  // A zero would be charted, averaged and acted on as a terrible rating.
  assert.equal(toFive(null, 5), null);
  assert.equal(toFive(0, 5), null);
  assert.equal(toFive(NaN, 5), null);
  assert.equal(toFive(-3, 5), null);
});
