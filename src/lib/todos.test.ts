import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditCsv, childrenBy, daysTaken, dueLabel, dueOf, matchesFilter, outcomeOf, progress, sortTodos, stayLabel, workCost,
         type AuditRow, type Todo } from './todos.ts';

test('a stay is named by its guest and dates', () => {
  assert.equal(stayLabel('Jason Smith', '2026-09-25', '2026-10-02'), 'Jason Smith · Sep 25 → Oct 2');
  assert.equal(stayLabel('  ', '2026-12-30', '2027-01-03'), 'Guest · Dec 30 → Jan 3');
});

const t = (id: string, over: Partial<Todo> = {}): Todo => ({
  id, title: id, unitIds: [], dueOn: null, createdAt: `2026-09-01T00:00:0${id.length % 10}Z`, createdBy: null,
  doneAt: null, doneBy: null, kind: 'task', status: 'pending', priority: 'none', assignee: null, claimId: null,
  vendor: null, scheduledOn: null, costEstimate: null, costActual: null, updates: 0,
  description: null, parentId: null, reservationId: null, reservationLabel: null, ...over
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
  const kids = childrenBy([t('p'), t('a', { parentId: 'p', status: 'completed' }), t('b', { parentId: 'p' }),
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

test('open before closed; urgent on top; by deadline; high before none on the same day', () => {
  const list = [
    t('undated'), t('late', { dueOn: '2026-09-20' }), t('next', { dueOn: '2026-10-01' }),
    t('nextHigh', { dueOn: '2026-10-01', priority: 'high' }), t('urgentUndated', { priority: 'urgent' }),
    t('doneOld', { status: 'completed', doneAt: '2026-09-20T10:00:00Z' }),
    t('cancelledNew', { status: 'cancelled', doneAt: '2026-09-26T10:00:00Z' })
  ];
  assert.deepEqual(sortTodos(list).map(x => x.id),
    ['urgentUndated', 'late', 'nextHigh', 'next', 'undated', 'cancelledNew', 'doneOld']);
});

test('what a claim’s work costs: actual where known, the estimate otherwise, cancelled not at all', () => {
  const c = workCost([
    t('a', { kind: 'work_order', status: 'completed', costEstimate: 300, costActual: 280 }),
    t('b', { kind: 'work_order', status: 'in_progress', costEstimate: 150 }),
    t('c', { kind: 'work_order', status: 'cancelled', costEstimate: 999 }),
    t('d', { status: 'pending' })
  ]);
  assert.deepEqual(c, { actual: 280, estimated: 150, open: 2 });
});

test('the done log: how it ended, how long it took, and a CSV an auditor can open', () => {
  const base = t('x', { title: 'Fix "AC", unit 2', createdAt: '2026-09-20T10:00:00Z', createdBy: 'ana@x.com',
                       status: 'completed', doneAt: '2026-09-23T09:00:00Z', doneBy: 'luis@x.com', unitIds: ['u1'], kind: 'work_order', costActual: 120 });
  const row: AuditRow = { ...base, deletedAt: null, deletedBy: null };
  assert.equal(outcomeOf(row), 'completed');
  assert.equal(daysTaken(row), 2);
  assert.equal(outcomeOf({ ...row, status: 'cancelled' }), 'cancelled');
  assert.equal(outcomeOf({ ...row, deletedAt: '2026-09-24T00:00:00Z', deletedBy: 'ana@x.com' }), 'removed');
  const csv = auditCsv([row], () => 'CL1250', () => '');
  const [head, line] = csv.split('\n');
  assert.match(head!, /^Closed \(New York\),Outcome,Closed by,Title/);
  // 09:00 UTC is 05:00 in New York (EDT) — the audit reads the team's clock.
  assert.match(line!, /^2026-09-23 05:00,completed,luis@x.com,"Fix ""AC"", unit 2",Repair,CL1250,/);
});
