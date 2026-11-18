import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countTemplate, matchCounts, parseCountText } from './inventory-md.ts';

test('a written count: the shapes people write, headings and empty template lines skipped', () => {
  const t = `# Count — S13 storage
Date: 2026-11-17
- Paper towels (roll): 12
- Toilet paper (roll):
* **Tide pods** — 3 bags
1. [x] Trash bags 13 gal: 4
6 x Dish soap
Sponges 10
| Item | Qty |
|---|---|
| Coffee pods | 40 |`;
  assert.deepEqual(parseCountText(t).map(l => [l.name, l.qty]), [
    ['Paper towels', 12], ['Tide pods', 3], ['Trash bags 13 gal', 4], ['Dish soap', 6], ['Sponges', 10], ['Coffee pods', 40]]);
});

test('matching: same words → sure; mostly the same → close; a tie or nothing → not matched', () => {
  const items = [{ id: 'a', name: 'Paper Towel' }, { id: 'b', name: 'Toilet paper' }, { id: 'c', name: 'Trash bags 13 gal' },
                 { id: 'd', name: 'Dish soap Dawn' }, { id: 'e', name: 'Hand soap' }];
  const m = matchCounts(parseCountText('Paper towels: 12\nTrash bags 13 gal: 4\nDawn dish soap: 2\nsoap: 3\nCoffee: 9'), items);
  assert.deepEqual(m.matched.map(x => [x.itemId, x.qty, x.close]), [['a', 12, false], ['c', 4, false], ['d', 2, false]]);
  assert.deepEqual(m.unmatched.map(l => l.name), ['soap', 'Coffee']);
  assert.deepEqual(matchCounts(parseCountText('Dish soap: 5'), items).matched.map(x => [x.itemId, x.close]), [['d', true]]);
});

test('the template lists the place\'s items with what they are counted in', () => {
  assert.equal(countTemplate('S13', [{ id: 'a', name: 'Paper towel', measure: 'roll' }], '2026-11-17'),
    '# Count — S13\n\nDate: 2026-11-17\n\nWrite how many there are after each colon. Leave a line blank if you did not count it.\n\n- Paper towel (roll): \n');
});
