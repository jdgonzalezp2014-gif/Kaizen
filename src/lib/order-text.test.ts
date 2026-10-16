import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clashes, draftFromBlocks, draftProblem, lineQty, matchOrderLine, mergeOrder, orderDraftMessage, orderSavedMessage, parseOrderText, type OrderDraft } from './order-text.ts';

const ITEMS = [
  { id: '1', name: 'Paper towels', measure: 'roll', buyOptions: [{ label: 'Walmart', url: 'https://www.walmart.com/ip/Bounty/123456' }] },
  { id: '2', name: 'Toilet paper', measure: 'roll' },
  { id: '3', name: 'Laundry detergent', measure: 'bottle' },
  { id: '4', name: 'Comforter — Queen', measure: 'unit' },
  { id: '5', name: 'Comforter — Twin', measure: 'unit' },
  { id: '6', name: 'Old broom', measure: 'unit', active: false }
];
const PLACES = [{ key: 'storages/1', name: 'Frisco storage' }, { key: 'units/9', name: 'Napa closet' }];
const UNITS = [{ value: 'u1', label: 'LP-4212' }, { value: 'u2', label: 'Napa' }];
const draft = (over: Partial<OrderDraft> = {}): OrderDraft => ({ by: 'U1', ch: 'C1', root: '1.0', msg: '1.0', todo: null, claim: null, place: null, said: null, unit: null, lines: [], ...over });

test('lineQty: digits, words, x-suffix, default 1', () => {
  assert.deepEqual(lineQty('2 paper towels'), { text: 'paper towels', qty: 2 });
  assert.deepEqual(lineQty('paper towels x3'), { text: 'paper towels', qty: 3 });
  assert.deepEqual(lineQty('two boxes of trash bags'), { text: 'boxes of trash bags', qty: 2 });
  assert.deepEqual(lineQty('una escoba'), { text: 'escoba', qty: 1 });
  assert.deepEqual(lineQty('Tide'), { text: 'Tide', qty: 1 });
  assert.deepEqual(lineQty('- 1.5 bleach'), { text: 'bleach', qty: 2 });
});

test('parseOrderText: lines split, a unit is said back (place still asked), a place is taken', () => {
  const a = parseOrderText('2 paper towels y 1 Tide para LP-4212', PLACES, UNITS);
  assert.deepEqual(a.lines, [{ text: 'paper towels', qty: 2 }, { text: 'Tide', qty: 1 }]);
  assert.equal(a.place, null);
  assert.equal(a.said, 'LP-4212');
  assert.equal(a.unit, 'u1');
  const b = parseOrderText('3 toilet paper, 1 detergent for Frisco storage', PLACES, UNITS);
  assert.equal(b.place, 'storages/1');
  assert.equal(b.lines.length, 2);
  // "for" that is neither a place nor a listing stays in the words.
  const c = parseOrderText('2 covers for pillows', PLACES, UNITS);
  assert.deepEqual(c.lines, [{ text: 'covers for pillows', qty: 2 }]);
  assert.equal(c.said, null);
  // The Repository's name for a listing (LP-4212 where Hostaway says P2-4212): said back, its listing known.
  const d = parseOrderText('1 Tide para LP-4212', [{ key: 'units/3', name: 'LP-4212 closet', unit: 'u9' }], []);
  assert.deepEqual([d.said, d.place, d.unit, d.lines[0]!.text], ['LP-4212', null, 'u9', 'Tide']);
  // Slack's links are their labels.
  assert.equal(parseOrderText('1 tide to <#C1|Napa closet>', PLACES, UNITS).place, 'units/9');
});

test('matchOrderLine: sure, doubtful (never guessed), taught alias, inactive left out', () => {
  assert.equal(matchOrderLine('paper towels', ITEMS).i, '1');
  const q = matchOrderLine('comforter', ITEMS);
  assert.equal(q.i, null);
  assert.deepEqual(q.c.sort(), ['4', '5']);
  assert.deepEqual(matchOrderLine('Tide', ITEMS), { i: null, c: [] });
  assert.equal(matchOrderLine('Tide', ITEMS, new Map([['tide', '3']])).i, '3');
  assert.equal(matchOrderLine('broom', ITEMS).i, null);
});

test('clashes, draftProblem and mergeOrder: add or replace what the to-do already orders', () => {
  const existing = [{ itemId: '1', place: 'storages/1', qty: 3 }, { itemId: '2', place: 'units/9', qty: 1 }];
  const d = draft({ todo: '7', place: 'storages/1', lines: [{ t: 'paper towels', q: 2, i: '1', c: [] }, { t: 'tp', q: 1, i: '2', c: [] }] });
  assert.deepEqual([...clashes(d, existing)], [[0, 3]]);
  assert.match(draftProblem(d, existing)!, /already on this order/);
  assert.equal(draftProblem({ ...d, lines: [{ ...d.lines[0]!, m: 'sum' }, d.lines[1]!] }, existing), null);
  assert.match(draftProblem(draft({ lines: [{ t: 'x', q: 1, i: null, c: [] }] }), [])!, /Pick the item/);
  assert.match(draftProblem(draft({ lines: [{ t: 'x', q: 1, i: '1', c: [] }] }), [])!, /where it goes/);
  assert.deepEqual(mergeOrder(existing, [{ itemId: '1', place: 'storages/1', qty: 2, m: 'sum' }, { itemId: '3', place: 'storages/1', qty: 1 }]),
    [{ itemId: '2', place: 'units/9', qty: 1 }, { itemId: '1', place: 'storages/1', qty: 5 }, { itemId: '3', place: 'storages/1', qty: 1 }]);
  assert.deepEqual(mergeOrder(existing, [{ itemId: '1', place: 'storages/1', qty: 2, m: 'replace' }]).find(l => l.itemId === '1')!.qty, 2);
});

test('orderDraftMessage: questions, place, cart, and the draft back from Confirm', () => {
  const d = draft({ said: 'LP-4212', lines: [{ t: 'paper towels', q: 2, i: '1', c: ['1', '2'] }, { t: 'comforter', q: 1, i: null, c: ['4', '5'] }] });
  const m = orderDraftMessage(d, { items: ITEMS, places: [{ value: 'storages/1', label: 'Frisco storage' }], existing: [] });
  const s = JSON.stringify(m.blocks);
  assert.match(s, /order_pick/);
  assert.match(s, /\+ Add as new item/);
  assert.match(s, /You wrote “LP-4212”/);
  assert.match(s, /addToCart\?items=123456\|2/);
  assert.ok(!s.includes('Old broom'), 'an inactive item is not offered');
  assert.deepEqual(draftFromBlocks(m.blocks), d);
  assert.ok(JSON.stringify(d).length < 2000);
  const saved = orderSavedMessage({ ...d, place: 'storages/1', lines: [d.lines[0]!] }, { items: ITEMS, placeLabel: 'Frisco storage', todoId: '7', todoTitle: 'Buy supplies: Paper towels × 2', fresh: true, by: 'U1', appUrl: 'https://k.dev' });
  assert.match(JSON.stringify(saved.blocks), /\?todo=7/);
});
