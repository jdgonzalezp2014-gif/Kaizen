import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueLabel, dueOf, sortTodos, type Todo } from './todos.ts';

const t = (id: string, over: Partial<Todo> = {}): Todo => ({
  id, title: id, unitIds: [], dueOn: null, createdAt: `2026-09-01T00:00:0${id.length}Z`, createdBy: null,
  doneAt: null, doneBy: null, ...over
});
const TODAY = '2026-09-27';

test('due, in words, with a shape as well as a colour', () => {
  assert.equal(dueOf({ dueOn: '2026-09-25' }, TODAY), 'overdue');
  assert.equal(dueLabel({ dueOn: '2026-09-25' }, TODAY), '▲ overdue 2d · Fri Sep 25');
  assert.equal(dueLabel({ dueOn: TODAY }, TODAY), '● today');
  assert.equal(dueLabel({ dueOn: '2026-09-28' }, TODAY), '○ tomorrow · Mon Sep 28');
  assert.equal(dueOf({ dueOn: '2026-10-04' }, TODAY), 'soon');
  assert.equal(dueOf({ dueOn: '2026-10-05' }, TODAY), 'later');
  assert.equal(dueOf({ dueOn: null }, TODAY), 'none');
  assert.equal(dueLabel({ dueOn: null }, TODAY), '');
});

test('open before done; by deadline; undated after dated; done newest first', () => {
  const list = [
    t('undated'), t('late', { dueOn: '2026-09-20' }), t('next', { dueOn: '2026-10-01' }),
    t('doneOld', { doneAt: '2026-09-20T10:00:00Z' }), t('doneNew', { doneAt: '2026-09-26T10:00:00Z' })
  ];
  assert.deepEqual(sortTodos(list).map(x => x.id), ['late', 'next', 'undated', 'doneNew', 'doneOld']);
});
