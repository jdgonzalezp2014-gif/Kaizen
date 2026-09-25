import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessType, parseCsv, proposeColumns, readBoard } from './repo-import.ts';

// The shape of this account's own Monday exports (values invented).
const SERVICES = `Log Ins,,,,
Services,,,,
Name,Subitems,Details,Username,Password
Netflix,,,a@example.com,xyz
Instacart,,"https://www.instacart.com/store
",b@example.com,abc
,,,,
Streaming,,,,
Name,Subitems,Details,Username,Password
Hulu,,,c@example.com,def
`;

test('CSV with quoted newlines, as Drive exports a Monday sheet', () => {
  const rows = parseCsv(SERVICES);
  assert.equal(rows[4]![2], 'https://www.instacart.com/store\n');
  assert.equal(rows.length, 9);   // the trailing newline adds no empty row
});

test('a Monday board: its name, its groups, and the header repeated per group dropped', () => {
  const b = readBoard(parseCsv(SERVICES));
  assert.equal(b.title, 'Log Ins');
  assert.deepEqual(b.groups, ['Services', 'Streaming']);
  assert.deepEqual(b.items.map(i => `${i.group}:${i.cells[0]}`), ['Services:Netflix', 'Services:Instacart', 'Streaming:Hulu']);
});

test('a long line above the header is a description, not a group', () => {
  const b = readBoard(parseCsv(`SF Key Situation,,,
All the mailbox keys and any backup keys for all units are in this bag in the storage closet.,,,
Name,Front Door Key,Closet Key,Lockbox
Unit 1,Yes,Yes,
Unit 2,Yes,No,0
`));
  assert.equal(b.title, 'SF Key Situation');
  assert.deepEqual(b.groups, []);
  assert.match(b.note, /mailbox keys/);
  assert.equal(b.items.length, 2);
});

test('passwords are proposed encrypted, and their samples never shown', () => {
  const cols = proposeColumns(readBoard(parseCsv(SERVICES)));
  const pw = cols.find(c => c.title === 'Password')!;
  assert.equal(pw.type, 'secret');
  assert.ok(pw.samples.every(s => s === '••••••••'));
  assert.equal(cols.find(c => c.title === 'Username')!.type, 'email');
  assert.equal(cols.find(c => c.title === 'Subitems')!.include, false);   // never filled
  assert.deepEqual(cols.find(c => c.index === -1)!.options, ['Services', 'Streaming']);
});

test('types are guessed from what a column holds', () => {
  assert.equal(guessType('Move out', ['2026-08-14', '2026-09-01']), 'date');
  assert.equal(guessType('Lockbox', ['3611', '1,220']), 'number');
  assert.equal(guessType('Floor', ['First', 'Second', 'First', 'Third', 'Second']), 'select');
  assert.equal(guessType('Wifi PIN', ['1234']), 'secret');
});
