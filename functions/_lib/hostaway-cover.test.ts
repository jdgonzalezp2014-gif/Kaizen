import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverOf } from './hostaway.ts';

test('cover photo: the lowest sortOrder, https only, thumbnail as the fallback', () => {
  assert.equal(coverOf({ listingImages: [{ url: 'https://x/b.jpg', sortOrder: 2 }, { url: 'https://x/a.jpg', sortOrder: 1 }] }), 'https://x/a.jpg');
  assert.equal(coverOf({ listingImages: [{ url: 'http://x/a.jpg', sortOrder: 1 }], thumbnailUrl: 'https://x/t.jpg' }), 'https://x/t.jpg');
  assert.equal(coverOf(null), null);
});
