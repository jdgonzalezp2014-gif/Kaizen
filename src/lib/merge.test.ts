import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changedKeys, merge3, resolve } from './merge.ts';

type F = { title: string; priority: string; dueOn: string | null; unitIds: string[]; costActual: number | null };
const base: F = { title: 'Fix the AC', priority: 'none', dueOn: null, unitIds: ['1'], costActual: null };

test('a save sends only what I changed', () => {
  assert.deepEqual(changedKeys(base, { ...base, priority: 'high', unitIds: ['1'] }), ['priority']);
  assert.deepEqual(changedKeys(base, base), []);
});

test('different fields merge without asking', () => {
  const m = merge3(base, { ...base, priority: 'high' }, { ...base, dueOn: '2026-10-20' });
  assert.deepEqual(m.keep, { priority: 'high' });
  assert.deepEqual(m.clashes, []);
  assert.deepEqual(m.theirs, ['dueOn']);
  assert.deepEqual(resolve({ ...base, dueOn: '2026-10-20' }, m), { ...base, priority: 'high', dueOn: '2026-10-20' });
});

test('the same field to the same value is no clash', () => {
  const m = merge3(base, { ...base, priority: 'urgent' }, { ...base, priority: 'urgent' });
  assert.deepEqual(m.keep, {});
  assert.deepEqual(m.clashes, []);
});

test('the same field to different values is a question, mine by default', () => {
  const theirs = { ...base, title: 'Fix the AC unit', costActual: 120 };
  const m = merge3(base, { ...base, title: 'Replace the AC' }, theirs);
  assert.equal(m.clashes.length, 1);
  assert.equal(m.clashes[0]!.key, 'title');
  assert.equal(resolve(theirs, m).title, 'Replace the AC');
  assert.equal(resolve(theirs, m, { title: 'theirs' }).title, 'Fix the AC unit');
  // What they changed elsewhere stays theirs either way.
  assert.equal(resolve(theirs, m).costActual, 120);
});

test('a version bump with no field moved (the Hostaway mirror writing back) keeps all of mine', () => {
  const m = merge3(base, { ...base, title: 'Replace the AC', unitIds: ['2'] }, base);
  assert.deepEqual(m.keep, { title: 'Replace the AC', unitIds: ['2'] });
  assert.deepEqual(m.clashes, []);
  assert.deepEqual(m.theirs, []);
});
