import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountIn, guessCategory } from './costs.ts';

test('a cost from a few words: the amount and a category to confirm', () => {
  assert.equal(amountIn('45 towels P2-4308'), 45);
  assert.equal(amountIn('towels $45.50 for P2-4308'), 45.5);
  assert.equal(amountIn('pool service 1,200'), 1200);
  assert.equal(amountIn('towels for P2-4308'), null);   // the unit number is not money
  assert.equal(guessCategory('towels and soap', null), 'Restock');
  assert.equal(guessCategory('pool guy', null), 'Handyman');
  assert.equal(guessCategory('something', null), null);
  assert.equal(guessCategory('something'), 'General');
});
