import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readRating, ratingFromJsonLd, ratingFromStateJson,
  normalizeRating, readNightlyPrice
} from './scrape.ts';

test('JSON-LD is preferred, and it is a published contract', () => {
  const html = `<script type="application/ld+json">
    {"@type":"Product","name":"A place","aggregateRating":
      {"@type":"AggregateRating","ratingValue":"4.87","reviewCount":"213","bestRating":"5"}}
  </script>`;
  const r = readRating(html);
  assert.equal(r.rating, 4.87);
  assert.equal(r.count, 213);
  assert.equal(r.source, 'json-ld');
});

test('a malformed JSON-LD block does not stop the others', () => {
  const html = `<script type="application/ld+json">{ this is not json </script>
    <script type="application/ld+json">{"aggregateRating":{"ratingValue":4.5,"reviewCount":9}}</script>`;
  assert.equal(readRating(html).rating, 4.5);
});

test('falls through to embedded state JSON when there is no JSON-LD', () => {
  const html = `<script>window.__DATA={"guestSatisfactionOverall":4.92,"visibleReviewCount":57}</script>`;
  const r = readRating(html);
  assert.equal(r.rating, 4.92);
  assert.equal(r.count, 57);
  assert.equal(r.source, 'state-json');
});

test('a ten-point score is normalised to five, not reported raw', () => {
  // Booking.com prints out of 10. Left alone it would sit beside an
  // Airbnb 4.8 and read as a far better property.
  assert.equal(normalizeRating(8.6, 10), 4.3);
  assert.equal(normalizeRating(4.3, 5), 4.3);
});

test('an impossible rating is refused rather than reported', () => {
  assert.equal(normalizeRating(97, 5), null);
  assert.equal(normalizeRating(0, 5), null);
  assert.equal(normalizeRating(null, 5), null);
});

test('generic key names are not trusted for a rating', () => {
  // "score" and bare "value" match all sorts of unrelated numbers in a
  // page this size. Only names a platform actually uses are read.
  const html = `<script>{"score":3.1,"value":2,"someOtherRating":4.4}</script>`;
  assert.equal(ratingFromStateJson(html), null);
});

test('no rating anywhere returns null, never a zero', () => {
  const r = readRating('<html><body>nothing here</body></html>');
  assert.equal(r.rating, null);
  assert.equal(r.source, null);
  // Zero would be charted, averaged and acted on as a terrible rating.
});

test('a price outside the plausible band is a different field', () => {
  // These key names are reused for ids, counts and totals. A "price" of
  // 3 or of 90,000 is not a nightly rate, and a wrong price is worse
  // than no price — it is wrong by a factor, not by a margin.
  assert.equal(readNightlyPrice('{"price":3}').nightly, null);
  assert.equal(readNightlyPrice('{"price":90000}').nightly, null);
  assert.equal(readNightlyPrice('{"price":"$1,240"}').nightly, 1240);
  assert.equal(readNightlyPrice('{"nightlyPrice":237}').nightly, 237);
});

test('empty input is handled, not thrown on', () => {
  assert.equal(readRating('').rating, null);
  assert.equal(readNightlyPrice('').nightly, null);
});
