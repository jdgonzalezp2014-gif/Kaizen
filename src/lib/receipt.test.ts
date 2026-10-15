import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasKey, linesTotal, orderFor, receiptSum, wrongSize, readReceipt, similarItems, splitTotal, words, type ReceiptItem } from './receipt.ts';

const ITEMS: ReceiptItem[] = [
  { id: '1', name: 'Toilet paper', measure: 'roll' }, { id: '2', name: 'Paper towels', measure: 'roll' },
  { id: '3', name: 'Trash bags 13 gal', measure: 'bag' }, { id: '4', name: 'Dish soap', measure: 'bottle' },
  { id: '5', name: 'Hand soap', measure: 'bottle' }, { id: '6', name: 'Old sponge', measure: 'unit', active: false },
];

test('words: lower case, no punctuation, plural s dropped', () => {
  assert.deepEqual(words('Paper Towels, 6-PK'), ['paper', 'towel', 'pk']);
  assert.deepEqual(words('Glass'), ['glass']);
});

test('similarItems: shared words first, prefixes count, inactive never', () => {
  assert.deepEqual(similarItems('BOUNTY PAPER TOWELS', ITEMS).slice(0, 2), ['2', '1']);
  assert.deepEqual(similarItems('DAWN DISH SOAP 19OZ', ITEMS)[0], '4');
  assert.ok(similarItems('SOAP', ITEMS).includes('5'));
  assert.deepEqual(similarItems('SPONGE', ITEMS), []);
  assert.deepEqual(similarItems('zzz', ITEMS), []);
});

test('readReceipt: a sure, existing supply is matched; anything else is a doubt with candidates', () => {
  const r = readReceipt({ store: ' Costco ', date: '2026-10-12', total: '$54.30', tax: 3.1, lines: [
    { text: 'KS TOILET PAPER 30', qty: 1, amount: 22.99, itemId: '1', sure: true, itemQty: 30 },
    { text: 'BOUNTY TOWELS', qty: 1, amount: 19.99, itemId: '2', sure: false, alternatives: ['1'] },
    { text: 'SPONGE', qty: 1, amount: 4, itemId: '6', sure: true },      // inactive → not matched
    { text: 'MYSTERY', qty: 1, amount: 1, itemId: '99', sure: true },   // not on the list
    { text: 'SALES TAX', amount: 3.1 },
    { text: '' },
  ] }, ITEMS);
  assert.equal(r.store, 'Costco'); assert.equal(r.date, '2026-10-12'); assert.equal(r.total, 54.3); assert.equal(r.tax, 3.1);
  assert.equal(r.lines.length, 5);
  assert.equal(r.lines[0]!.itemId, '1'); assert.equal(r.lines[0]!.itemQty, 30); assert.deepEqual(r.lines[0]!.candidates, []);
  assert.equal(r.lines[1]!.itemId, null); assert.deepEqual(r.lines[1]!.candidates.slice(0, 2), ['2', '1']);
  assert.equal(r.lines[2]!.itemId, null);
  assert.equal(r.lines[3]!.itemId, null);
  assert.equal(r.lines[4]!.kind, 'other'); assert.deepEqual(r.lines[4]!.candidates, []);
});

test('readReceipt: never sure unless the model says so; junk in → empty receipt', () => {
  assert.equal(readReceipt({ lines: [{ text: 'TP', itemId: '1' }] }, ITEMS).lines[0]!.itemId, null);
  assert.deepEqual(readReceipt(null, ITEMS), { store: null, date: null, total: null, tax: null, lines: [] });
  assert.equal(readReceipt({ date: '10/12/2026' }, ITEMS).date, null);
});

test('orderFor: the one open order that asks for it, or the one the model named among those', () => {
  const orders = [{ todoId: 'a', lines: [{ itemId: '1' }] }, { todoId: 'b', lines: [{ itemId: '1' }, { itemId: '2' }] }];
  assert.equal(orderFor('2', orders), 'b');
  assert.equal(orderFor('1', orders), null);
  assert.equal(orderFor('1', orders, 'a'), 'a');
  assert.equal(orderFor('2', orders, 'a'), 'b');
  assert.equal(orderFor('3', orders), null);
  assert.equal(orderFor(null, orders), null);
  const r = readReceipt({ lines: [{ text: 'TP', itemId: '1', sure: true, orderId: 'a' }, { text: 'Towels', itemId: '2', sure: true }] }, ITEMS, orders);
  assert.deepEqual(r.lines.map(l => l.orderId), ['a', 'b']);
});

test('linesTotal: items and discounts, not tax', () => {
  assert.equal(linesTotal([{ amount: 10.1, kind: 'item' }, { amount: 0.2, kind: 'item' }, { amount: -1, kind: 'discount' }, { amount: 3, kind: 'tax' }]), 9.3);
});

test('splitTotal: proportional, exact to the cent, remainder to the biggest', () => {
  assert.deepEqual(splitTotal(100, [{ key: 'a', amount: 30 }, { key: 'b', amount: 60 }]), [{ key: 'a', share: 33.33 }, { key: 'b', share: 66.67 }]);
  const s = splitTotal(10, [{ key: 'a', amount: 1 }, { key: 'b', amount: 1 }, { key: 'c', amount: 1 }]);
  assert.equal(Math.round(s.reduce((a, x) => a + x.share, 0) * 100), 1000);
  assert.deepEqual(splitTotal(9, [{ key: 'a', amount: 0 }, { key: 'b', amount: 0 }]), [{ key: 'a', share: 4.5 }, { key: 'b', share: 4.5 }]);
  assert.deepEqual(splitTotal(5, []), []);
});

test('receiptSum: every line, plus the tax when no line carries it', () => {
  const l = (amount: number, kind: 'item' | 'tax' | 'fee' = 'item') => ({ amount, kind });
  assert.equal(receiptSum({ tax: 1.5, lines: [l(10), l(0.1, 'fee')] as never }), 11.6);
  assert.equal(receiptSum({ tax: 1.5, lines: [l(10), l(1.5, 'tax')] as never }), 11.5);
  assert.equal(receiptSum({ tax: null, lines: [] }), 0);
});

const BED: ReceiptItem[] = [
  { id: 'p', name: 'Mattress protector', baseName: 'Mattress protector', size: null, measure: 'unit' },
  { id: 'pk', name: 'Mattress protector — King', baseName: 'Mattress protector', size: 'King', measure: 'unit' },
  { id: 'pq', name: 'Mattress protector — Queen', baseName: 'Mattress protector', size: 'Queen', measure: 'unit' },
];

test('wrongSize: another size, or no size when a sized twin exists', () => {
  assert.equal(wrongSize(BED[2]!, 'King size', BED), true);
  assert.equal(wrongSize(BED[1]!, 'king', BED), false);
  assert.equal(wrongSize(BED[0]!, 'King', BED), true);
  assert.equal(wrongSize(BED[0]!, 'Twin', BED), false);
  assert.equal(wrongSize(BED[2]!, null, BED), false);
});

test('readReceipt: the size decides — a wrong-size match is a doubt with the right size first', () => {
  const r = readReceipt({ lines: [{ text: 'King Size Mattress Protector', size: 'King', itemId: 'pq', sure: true, name: 'Mattress protector' }] }, BED);
  assert.equal(r.lines[0]!.itemId, null);
  assert.equal(r.lines[0]!.candidates[0], 'pk');
  assert.ok(!r.lines[0]!.candidates.includes('pq'));
  assert.equal(r.lines[0]!.size, 'King'); assert.equal(r.lines[0]!.newName, 'Mattress protector');
  assert.equal(readReceipt({ lines: [{ text: 'KING PROTECTOR', size: 'King', itemId: 'pk', sure: true }] }, BED).lines[0]!.itemId, 'pk');
});

test('readReceipt: a learned alias wins over the model and needs no "sure"', () => {
  const aliases = new Map([[aliasKey('UTOPIA DUVET SET  $89.24'), 'pq']]);
  assert.equal(aliasKey('UTOPIA DUVET SET  $89.24'), 'utopia duvet set');
  const r = readReceipt({ lines: [{ text: 'Utopia duvet set', itemId: 'p', sure: false }] }, BED, [], aliases);
  assert.equal(r.lines[0]!.itemId, 'pq');
});
