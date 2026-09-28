import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childrenBy, dueLabel, dueOf, matchesFilter, progress, sortTodos, workCost, type Todo } from './todos.ts';

const t = (id: string, over: Partial<Todo> = {}): Todo => ({
  id, title: id, unitIds: [], dueOn: null, createdAt: `2026-09-01T00:00:0${id.length % 10}Z`, createdBy: null,
  doneAt: null, doneBy: null, kind: 'task', status: 'open', priority: 'normal', assignee: null, claimId: null,
  vendor: null, scheduledOn: null, costEstimate: null, costActual: null, updates: 0,
  description: null, parentId: null, ...over
});

test('filters: kind, urgency, date and listing', () => {
  const T = '2026-09-27';
  const late = t('late', { dueOn: '2026-09-20', priority: 'high' });
  const wo = t('wo', { kind: 'work_order', dueOn: '2026-10-01', unitIds: ['u1'] });
  const undated = t('undated', { priority: 'urgent' });
  const all = [late, wo, undated];
  const pick = (f: Parameters<typeof matchesFilter>[1]) => all.filter(x => matchesFilter(x, f, T)).map(x => x.id);
  assert.deepEqual(pick({ kind: 'work_order' }), ['wo']);
  assert.deepEqual(pick({ priority: 'high' }), ['late', 'undated']);
  assert.deepEqual(pick({ priority: 'urgent' }), ['undated']);
  assert.deepEqual(pick({ due: 'overdue' }), ['late']);
  assert.deepEqual(pick({ due: 'week' }), ['late', 'wo']);
  assert.deepEqual(pick({ due: 'none' }), ['undated']);
  assert.deepEqual(pick({ unitId: 'u1' }), ['wo']);
});

test('sub-tasks: grouped by parent; progress ignores the cancelled', () => {
  const kids = childrenBy([t('p'), t('a', { parentId: 'p', status: 'done' }), t('b', { parentId: 'p' }),
                           t('c', { parentId: 'p', status: 'cancelled' })]);
  assert.deepEqual(kids.get('p')!.map(x => x.id), ['a', 'b', 'c']);
  assert.deepEqual(progress(kids.get('p')), { done: 1, total: 2 });
  assert.deepEqual(progress(undefined), { done: 0, total: 0 });
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

test('open before closed; urgent on top; by deadline; high before normal on the same day', () => {
  const list = [
    t('undated'), t('late', { dueOn: '2026-09-20' }), t('next', { dueOn: '2026-10-01' }),
    t('nextHigh', { dueOn: '2026-10-01', priority: 'high' }), t('urgentUndated', { priority: 'urgent' }),
    t('doneOld', { status: 'done', doneAt: '2026-09-20T10:00:00Z' }),
    t('cancelledNew', { status: 'cancelled', doneAt: '2026-09-26T10:00:00Z' })
  ];
  assert.deepEqual(sortTodos(list).map(x => x.id),
    ['urgentUndated', 'late', 'nextHigh', 'next', 'undated', 'cancelledNew', 'doneOld']);
});

test('what a claim’s work costs: actual where known, the estimate otherwise, cancelled not at all', () => {
  const c = workCost([
    t('a', { kind: 'work_order', status: 'done', costEstimate: 300, costActual: 280 }),
    t('b', { kind: 'work_order', status: 'in_progress', costEstimate: 150 }),
    t('c', { kind: 'work_order', status: 'cancelled', costEstimate: 999 }),
    t('d', { status: 'open' })
  ]);
  assert.deepEqual(c, { actual: 280, estimated: 150, open: 2 });
});
