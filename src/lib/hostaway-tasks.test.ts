import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesFrom, coreOf, fromHostawayStatus, importable, nyToUtc, priorityOf, PRIORITY_NUMBER, stateOf, toHostawayBody,
         toHostawayStatus, utcToNy, workFromState, type HostawayTask, type HostawayUser, type WorkForSync } from './hostaway-tasks.ts';

const users: HostawayUser[] = [
  { id: 1, email: 'hello@kaizenguestproperties.com', firstName: 'Juan', lastName: 'Gonzalez' },
  { id: 2, email: 'michelle@example.com', firstName: 'Michelle', lastName: 'Park' }
];
const w = (over: Partial<WorkForSync> = {}): WorkForSync => ({
  id: '12', title: 'Fix the AC', description: 'Unit is warm', kind: 'work_order', status: 'pending', priority: 'high',
  unitIds: ['594914'], reservationId: '66853131', scheduledOn: '2026-10-01', startTime: '10:30', dueOn: '2026-10-02', dueTime: null,
  assigneeUserId: 2, supervisorUserId: 1, vendor: 'CoolCo', costEstimate: 120, costActual: null, resolutionNote: null, ...over
});

test('New York to Hostaway UTC and back, across daylight saving', () => {
  assert.equal(nyToUtc('2026-10-02', '23:59'), '2026-10-03 03:59:00');   // EDT, UTC-4
  assert.equal(nyToUtc('2026-12-02', '09:00'), '2026-12-02 14:00:00');   // EST, UTC-5
  assert.equal(utcToNy('2026-10-03 03:59:00'), '2026-10-02 23:59');
  assert.equal(utcToNy(null), null);
});

test('statuses are Hostaway’s, word for word; priority is 1–4', () => {
  assert.equal(toHostawayStatus('in_progress'), 'inProgress');
  assert.equal(toHostawayStatus('confirmed'), 'confirmed');
  assert.equal(fromHostawayStatus('completed'), 'completed');
  assert.equal(fromHostawayStatus('something new'), 'pending');
  assert.equal(PRIORITY_NUMBER.none, null);
  assert.equal(PRIORITY_NUMBER.urgent, 4);
  assert.equal(priorityOf(3), 'high');
  assert.equal(priorityOf(0), 'none');
});

test('the body Hostaway gets is the same task, field for field', () => {
  const b = toHostawayBody(w());
  assert.deepEqual({ ...b, description: undefined }, {
    listingMapId: 594914, reservationId: 66853131, title: '🔧 Fix the AC', description: undefined,
    canStartFrom: '2026-10-01 14:30:00', shouldEndBy: '2026-10-03 03:59:00', status: 'pending', priority: 3,
    assigneeUserId: 2, supervisorUserId: 1, cost: null, costCurrency: null, resolutionNote: null
  });
  // Only Kaizen's extras go in the footer.
  assert.equal(b.description, 'Unit is warm\n\n— Kaizen OS · Repair #12 · Vendor: CoolCo · Estimate $120.00');
  const t = toHostawayBody(w({ kind: 'task', unitIds: [], reservationId: null, scheduledOn: null, dueOn: null, vendor: null, costEstimate: null }));
  assert.equal(t.title, 'Fix the AC');
  assert.equal(t.listingMapId, null);
  assert.equal(t.canStartFrom, null);
  assert.equal(t.description, 'Unit is warm\n\n— Kaizen OS · To-do #12');
});

test('the footer is Kaizen’s, never part of the description it reads back', () => {
  assert.equal(coreOf('Unit is warm\n\n— Kaizen OS · Repair #12'), 'Unit is warm');
  assert.equal(coreOf(null), '');
});

const task = (over: Partial<HostawayTask> = {}): HostawayTask => ({
  id: 99, listingMapId: 594914, reservationId: 66853131, autoTaskId: null, assigneeUserId: 2, supervisorUserId: 1, createdByUserId: 1,
  title: '🔧 Fix the AC', description: 'Unit is warm\n\n— Kaizen OS · Repair #12', canStartFrom: '2026-10-01 14:30:00',
  shouldEndBy: '2026-10-03 03:59:00', status: 'pending', priority: 3, resolutionNote: null, cost: null, costCurrency: null,
  completedAt: null, ...over
});

test('a Hostaway task reads back as the Kaizen task it came from', () => {
  const k = workFromState(stateOf(task()), users);
  assert.deepEqual(k, {
    title: 'Fix the AC', description: 'Unit is warm', status: 'pending', priority: 'high',
    assigneeUserId: 2, assignee: 'Michelle Park', supervisorUserId: 1, supervisor: 'Juan Gonzalez',
    unitIds: ['594914'], reservationId: '66853131', scheduledOn: '2026-10-01', startTime: '10:30',
    // 23:59 is "end of the day": no time of its own.
    dueOn: '2026-10-02', dueTime: null, costActual: null, resolutionNote: null
  });
});

test('only what moved in Hostaway comes back', () => {
  const prev = stateOf(task());
  assert.deepEqual(changesFrom(prev, stateOf(task()), users), { patch: {}, said: [] });
  const c = changesFrom(prev, stateOf(task({ status: 'completed', cost: 85, assigneeUserId: 1, resolutionNote: 'Replaced the filter' })), users);
  assert.deepEqual(c.patch, { status: 'completed', assigneeUserId: 1, assignee: 'Juan Gonzalez', costActual: 85, resolutionNote: 'Replaced the filter' });
  assert.deepEqual(c.said, ['status completed', 'assigned to Juan Gonzalez', 'cost $85.00', 'resolution “Replaced the filter”']);
  assert.deepEqual(changesFrom(prev, stateOf(task({ status: 'confirmed' })), users).patch, { status: 'confirmed' });
});

test('only hand-made, open Hostaway tasks come in — never the automatic cleans', () => {
  assert.ok(importable(task()));
  assert.ok(!importable(task({ autoTaskId: 375343 })));
  assert.ok(!importable(task({ status: 'completed' })));
});
