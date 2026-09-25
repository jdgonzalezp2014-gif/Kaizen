import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsGuestDocs } from './guestdocs.ts';

test('only the P2 building’s units need an ID on file', () => {
  assert.equal(needsGuestDocs('P2-1201'), true);
  assert.equal(needsGuestDocs(' p2-4308'), true);
  assert.equal(needsGuestDocs('CL1235'), false);
  assert.equal(needsGuestDocs('Amber Valley'), false);
});
