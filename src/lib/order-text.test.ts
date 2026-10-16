import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_PLACE, clashes, draftIdFromBlocks, draftProblem, guessKind, guessMeasure, itemName, lineQty, matchOrderLine, mergeOrder, newItemsModal, orderDraftMessage, orderSavedMessage, parseOrderText, type OrderDraft } from './order-text.ts';

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
  assert.deepEqual(lineQty('2sets of bowls'), { text: 'sets of bowls', qty: 2 });
  assert.deepEqual(lineQty('2 (18 pack) of hangers white'), { text: '(18 pack) of hangers white', qty: 2 });
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
  // Never a guess from a shared word (2026-10-15, a new unit's list): packing words, a size, or the thing it holds.
  const more = [...ITEMS, { id: '7', name: 'Sheet sets', measure: 'set' }, { id: '8', name: 'Pots and pans', measure: 'set' }, { id: '9', name: 'Dish soap', measure: 'bottle' }];
  for (const t of ['knife sets', 'queen mattresses', 'paper towel holders', 'dish drying racks', 'sets of curtains'])
    assert.equal(matchOrderLine(t, more).i, null, t);
  assert.equal(matchOrderLine('sets of pots and pans', more).i, '8');
  assert.equal(matchOrderLine('queen sheet set', more).i, '7');
  assert.equal(matchOrderLine('case of paper towels', more).i, '1');
});

test('clashes, draftProblem and mergeOrder: add or replace what the to-do already orders', () => {
  const existing = [{ itemId: '1', place: 'storages/1', qty: 3 }, { itemId: '2', place: 'units/9', qty: 1 }];
  const d = draft({ todo: '7', place: 'storages/1', lines: [{ t: 'paper towels', q: 2, i: '1', c: [] }, { t: 'tp', q: 1, i: '2', c: [] }] });
  assert.deepEqual([...clashes(d, existing)], [[0, 3]]);
  assert.match(draftProblem(d, existing)!, /already on this order/);
  assert.equal(draftProblem({ ...d, lines: [{ ...d.lines[0]!, m: 'sum' }, d.lines[1]!] }, existing), null);
  assert.match(draftProblem(draft({ lines: [{ t: 'x', q: 1, i: null, c: [] }] }), [])!, /still open/);
  assert.match(draftProblem(draft({ lines: [{ t: 'x', q: 1, i: '1', c: [] }] }), [])!, /where it goes/);
  assert.deepEqual(mergeOrder(existing, [{ itemId: '1', place: 'storages/1', qty: 2, m: 'sum' }, { itemId: '3', place: 'storages/1', qty: 1 }]),
    [{ itemId: '2', place: 'units/9', qty: 1 }, { itemId: '1', place: 'storages/1', qty: 5 }, { itemId: '3', place: 'storages/1', qty: 1 }]);
  assert.deepEqual(mergeOrder(existing, [{ itemId: '1', place: 'storages/1', qty: 2, m: 'replace' }]).find(l => l.itemId === '1')!.qty, 2);
});

test('parseOrderText: a pasted list — one item per line, prose skipped, "and" kept inside a line', () => {
  const text = `Based on our standard 2 queen/ 2 bedroom and 1 queen/1 bedroom PGA setup here is the order list for the new units. Art and wall decor are Not included.
New unit setup:
6 nights stands
2 sets of drinking glasses (large and small)
2sets of bowls
18 bath towles
1 case of toilet paper`;
  const p = parseOrderText(text, PLACES, UNITS);
  assert.equal(p.skipped, 2);
  assert.deepEqual(p.lines.map(l => [l.qty, l.text]), [[6, 'nights stands'], [2, 'sets of drinking glasses (large and small)'], [2, 'sets of bowls'], [18, 'bath towles'], [1, 'case of toilet paper']]);
});

test('new items: name, measure and type guessed from the words', () => {
  assert.equal(itemName('sets of large plates'), 'Large plates');
  assert.equal(itemName('(18 pack) of hangers white'), 'Hangers white');
  assert.equal(guessMeasure('sets of large plates'), 'set');
  assert.equal(guessMeasure('(18 pack) of hangers white'), 'pack');
  assert.equal(guessMeasure('queen mattresses'), 'unit');
  for (const t of ['body wash', 'tresemes conditioners', 'packs of laundry pods', 'box of trash bags', 'lamp light bulbs', 'case of toilet paper', 'multipurpose cleaners'])
    assert.equal(guessKind(t), 'supply', t);
  for (const t of ['nights stands', 'soap dispensers', 'paper towel holders', 'coffee tubs', 'sets of salt and pepper shakers', 'bath towles', 'queen comforters'])
    assert.equal(guessKind(t), 'furniture', t);
  const m = newItemsModal('{}', Array.from({ length: 60 }, (_, i) => ({ idx: i, t: `thing ${i}`, q: 1 })));
  assert.ok((m.blocks as unknown[]).length <= 100);
});

test('orderDraftMessage: a 58-line list stays within Slack\'s 50 blocks', () => {
  const lines = Array.from({ length: 58 }, (_, i) => ({ t: `thing ${i}`, q: 1, i: i % 4 === 0 ? '1' : null, c: i % 4 === 1 || i % 4 === 2 ? ['4', '5'] : [] }));
  const m = orderDraftMessage(draft({ lines }), '9', { items: ITEMS, places: [{ value: 'storages/1', label: 'Frisco storage' }], existing: [] });
  assert.ok(m.blocks.length <= 50, String(m.blocks.length));
  assert.match(JSON.stringify(m.blocks), /more to answer/);
  assert.match(JSON.stringify(m.blocks), /Add all 14 as new items/);
});

test('orderDraftMessage: questions, place, cart, and the draft id back from Confirm', () => {
  const d = draft({ said: 'LP-4212', lines: [{ t: 'paper towels', q: 2, i: '1', c: ['1', '2'] }, { t: 'comforter', q: 1, i: null, c: ['4', '5'] }] });
  const m = orderDraftMessage(d, '42', { items: ITEMS, places: [{ value: 'storages/1', label: 'Frisco storage' }], existing: [] });
  const s = JSON.stringify(m.blocks);
  assert.match(s, /order_pick/);
  assert.match(s, /\+ New item/);
  assert.match(s, /you wrote “LP-4212”/);
  assert.match(s, /addToCart\?items=123456\|2/);
  assert.ok(!s.includes('Old broom'), 'an inactive item is not offered');
  assert.equal(draftIdFromBlocks(m.blocks), '42');
  const saved = orderSavedMessage({ ...d, place: 'storages/1', lines: [d.lines[0]!] }, { items: ITEMS, placeLabel: 'Frisco storage', todoId: '7', todoTitle: 'Buy supplies: Paper towels × 2', fresh: true, by: 'U1', appUrl: 'https://k.dev' });
  assert.match(JSON.stringify(saved.blocks), /\?todo=7/);
});

test('draftLinesFromRead: the AI\'s supply when sure, its own picks as the question, nothing named = not in Kaizen with its suggestion', async () => {
  const { draftLinesFromRead } = await import('./order-text.ts');
  const base = { qty: 2, unitPrice: null, amount: null, kind: 'item' as const, itemQty: null, orderId: null, size: null, newName: null };
  const d = draftLinesFromRead([
    { ...base, text: 'paper towels', itemId: '1', candidates: [] },
    { ...base, text: 'queen comforters', itemId: null, candidates: ['4', '5', '7'], suggested: ['4'] },
    { ...base, text: 'sofa beds', itemId: null, candidates: ['8'], suggested: [], newName: 'Sofa bed', newKind: 'furniture', newMeasure: 'unit' },
    { ...base, text: 'washcloths 18 pack', itemQty: 18, itemId: '9', candidates: [] },
    { ...base, text: 'tax', kind: 'tax', itemId: null, candidates: [] }]);
  assert.deepEqual(d.map(l => [l.t, l.q, l.i, l.c]), [['paper towels', 2, '1', []], ['queen comforters', 2, null, ['4']], ['sofa beds', 2, null, []], ['washcloths 18 pack', 18, '9', []]]);
  assert.deepEqual(d[2]!.s, { name: 'Sofa bed', kind: 'furniture', measure: 'unit' });
});

test('rowsToRaw and lineTarget: the model\'s short rows by line number; supplies sent to a house go where it keeps them', async () => {
  const { rowsToRaw, lineTarget } = await import('./order-text.ts');
  const raw = rowsToRaw([[2, 0, 0, [], 'Sofa bed', 'unit', 1, 0], ['1: tide', '3', 1, [], 'Detergent', 'bottle', 0, 0], [9, '1', 1], 'junk', [1, '2', 1]],
    [{ text: 'tide', qty: 2 }, { text: 'sofa beds', qty: 1 }, { text: 'lamp', qty: 1 }]);
  assert.deepEqual(raw.map(r => r && [r.text, r.qty, r.itemId, r.sure, r.furniture]), [['tide', 2, '3', true, false], ['sofa beds', 1, null, false, true], null]);
  const house = { key: 'r/1#house', house: true, supplies: 'r/1' };
  assert.equal(lineTarget(house, 'furniture'), 'r/1#house');
  assert.equal(lineTarget(house, 'supply'), 'r/1');
  assert.equal(lineTarget({ ...house, supplies: null }, 'supply'), null);
  assert.equal(lineTarget({ key: 'storages/1' }, 'supply'), 'storages/1');
});

test('no place yet: clashes only with lines saved without a place; mergeOrder keeps where a line is bought', () => {
  const existing = [{ itemId: '1', place: '', qty: 2, at: 'Home Depot' }, { itemId: '2', place: 'storages/1', qty: 1 }];
  const d = { place: NO_PLACE, lines: [{ t: 'a', q: 1, i: '1', c: [] }, { t: 'b', q: 1, i: '2', c: [] }] };
  assert.deepEqual([...clashes(d, existing)], [[0, 2]]);
  assert.deepEqual(mergeOrder(existing, [{ itemId: '1', place: '', qty: 3, m: 'sum' }]).find(l => l.itemId === '1'), { itemId: '1', place: '', qty: 5, at: 'Home Depot' });
});
