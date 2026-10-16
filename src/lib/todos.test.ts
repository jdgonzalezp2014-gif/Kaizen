import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditCsv, rowTitle, isFiltering, sourceOf, categoryOf, claimStage, stageOf, childrenBy, daysTaken, dueLabel, dueOf, matchesFilter, outcomeOf, progress, sortTodos, stayLabel, workCost,
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
  assert.equal(dueLabel({ dueOn: '2026-09-25' }, TODAY), 'Overdue 2d · Fri Sep 25');
  assert.equal(dueLabel({ dueOn: TODAY }, TODAY), 'Today');
  assert.equal(dueLabel({ dueOn: '2026-09-28' }, TODAY), 'Tomorrow · Mon Sep 28');
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
    t('d', { status: 'pending' }),
    // §162: a purchase order's purchases count; a to-do's estimate does not.
    t('e', { status: 'completed', purchaseTotal: 42.5, order: true }),
    t('f', { status: 'pending', costEstimate: 70 })
  ]);
  assert.deepEqual(c, { actual: 280, estimated: 150, bought: 42.5, open: 3, owner: 0 });
  // §167: the part charged to the owner — a work order with a listing; its cost, else its estimate
  const o = workCost([
    t('g', { kind: 'work_order', status: 'completed', costActual: 100, chargeOwner: true, unitIds: ['u1'] }),
    t('h', { kind: 'work_order', status: 'in_progress', costEstimate: 40, chargeOwner: true, unitIds: ['u1'] }),
    t('i', { kind: 'work_order', status: 'completed', costActual: 25, chargeOwner: true, unitIds: [] }),
    t('j', { kind: 'work_order', status: 'cancelled', costActual: 999, chargeOwner: true, unitIds: ['u1'] })
  ]);
  assert.equal(o.owner, 140);
});

test('a purchase order is its own category, from the server flag or the order list', () => {
  assert.equal(categoryOf(t('o', { order: true })), 'order');
  assert.equal(categoryOf(t('o'), true), 'order');
  assert.equal(categoryOf(t('w', { kind: 'work_order' })), 'work_order');
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

test('one life cycle in the same words (§159)', () => {
  assert.equal(stageOf('pending').label, 'New');
  assert.equal(stageOf('confirmed').label, 'New');
  assert.equal(stageOf('in_progress').label, 'In progress');
  assert.equal(stageOf('completed').label, 'Done');
  assert.equal(stageOf('cancelled').label, 'Cancelled');
  // A purchase order: ordered until bought, whatever Hostaway calls the step.
  assert.equal(stageOf('in_progress', true).label, 'Purchase');
  assert.equal(stageOf('completed', true).label, 'Purchased');
  assert.equal(stageOf('cancelled', true).label, 'Cancelled');
  assert.deepEqual(['Open', 'In progress', 'Resolved', 'Paid', 'Dismissed'].map(s => claimStage(s).label),
    ['New', 'In progress', 'Done', 'Done · paid', 'Cancelled']);
  assert.equal(categoryOf({ kind: 'task' }, true), 'order');
  assert.equal(categoryOf({ kind: 'work_order' }), 'work_order');
});

test('where a to-do came from, in a few words (§159)', () => {
  assert.equal(sourceOf({ cleanGroup: 'request', description: 'What Karina reported…' }), 'Request from a cleaner');
  assert.equal(sourceOf({ cleanGroup: 'inspection', description: null }), 'From an inspection');
  assert.equal(sourceOf({ description: 'Fix it — From Slack: https://x.slack.com/a' }), 'From Slack');
  assert.equal(sourceOf({ description: null, source: 'hostaway' }), 'From Hostaway');
  assert.equal(sourceOf({ description: 'BGC page' }), 'Details');
  assert.equal(sourceOf({ description: '  ' }), null);
});

test('filter by who handles it (§159)', () => {
  const t = (assignee: string | null) => ({ id: '1', title: 'x', unitIds: [], dueOn: null, createdAt: '', createdBy: null, doneAt: null, doneBy: null,
    kind: 'task', status: 'pending', priority: 'none', assignee, claimId: null, vendor: null, scheduledOn: null, costEstimate: null,
    costActual: null, updates: 0, description: null, parentId: null, reservationId: null, reservationLabel: null }) as Todo;
  assert.equal(matchesFilter(t('Juan'), { assignee: 'Juan' }, '2026-10-14'), true);
  assert.equal(matchesFilter(t(null), { assignee: 'Juan' }, '2026-10-14'), false);
  assert.equal(isFiltering({ assignee: 'Juan' }), true);
});

test('a row does not repeat its listing in the title (§159)', () => {
  assert.equal(rowTitle('Supplies requested — clean of Amber Valley on 2026-10-14', ['Amber Valley']), 'Supplies requested — clean on Oct 14');
  assert.equal(rowTitle('Buy for Napa Valley: 3 items', ['Napa Valley']), 'Buy: 3 items');
  assert.equal(rowTitle('Repairs at Napa Valley: 3 items', ['Napa Valley']), 'Repairs: 3 items');
  assert.equal(rowTitle('CL2260: fix the door', ['CL2260']), 'fix the door');
  assert.equal(rowTitle('Fix the door', ['CL2260']), 'Fix the door');
  // A name that is the whole title is kept — something has to be said.
  assert.equal(rowTitle('Amber Valley', ['Amber Valley']), 'Amber Valley');
});

test('§164: urgent is due today; high on the checkout of the stay in the unit now or next — never the one leaving today', async () => {
  const { urgencyDue } = await import('./todos.ts');
  const stays = [
    { id: 'leaving', guest: 'A', arrival: '2026-10-12', departure: '2026-10-15' },
    { id: 'next', guest: 'B', arrival: '2026-10-15', departure: '2026-10-19' },
    { id: 'later', guest: 'C', arrival: '2026-10-20', departure: '2026-10-22' }
  ];
  assert.deepEqual(urgencyDue('urgent', '2026-10-15', stays), { dueOn: '2026-10-15', stay: stays[1] });
  assert.deepEqual(urgencyDue('high', '2026-10-15', stays), { dueOn: '2026-10-19', stay: stays[1] });
  // No check-in within five days: five days from today, no stay (owner, 2026-10-15).
  assert.deepEqual(urgencyDue('high', '2026-10-15', []), { dueOn: '2026-10-20', stay: null });
  assert.deepEqual(urgencyDue('high', '2026-10-15', [stays[0]!, stays[2]!].map(s => ({ ...s, arrival: '2026-10-25', departure: '2026-10-28' }))),
    { dueOn: '2026-10-20', stay: null });
  assert.deepEqual(urgencyDue('medium', '2026-10-15', stays), { dueOn: null, stay: null });
});
