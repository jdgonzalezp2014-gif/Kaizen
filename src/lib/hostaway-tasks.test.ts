import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesFrom, coreOf, fromHostawayStatus, importable, matchUser, nyToUtc, stateOf, toHostawayBody, toHostawayStatus,
         utcToNyDay, type HostawayTask, type HostawayUser, type WorkForSync } from './hostaway-tasks.ts';

const users: HostawayUser[] = [
  { id: 1, email: 'hello@kaizenguestproperties.com', firstName: 'Juan', lastName: 'Gonzalez' },
  { id: 2, email: 'michelle@example.com', firstName: 'Michelle', lastName: 'Park' },
  { id: 3, email: 'm2@example.com', firstName: 'Mark', lastName: null }
];
const w = (over: Partial<WorkForSync> = {}): WorkForSync => ({
  id: '12', title: 'Fix the AC', description: 'Unit is warm', kind: 'work_order', status: 'open', priority: 'normal',
  unitIds: ['594914'], reservationId: '66853131', dueOn: '2026-10-02', scheduledOn: null, assignee: 'Michelle',
  vendor: 'CoolCo', costEstimate: 120, costActual: null, createdAt: '2026-09-30T12:00:00Z', ...over
});

test('New York days to Hostaway UTC and back, across daylight saving', () => {
  assert.equal(nyToUtc('2026-10-02', 23, 59), '2026-10-03 03:59:00');   // EDT, UTC-4
  assert.equal(nyToUtc('2026-12-02', 9), '2026-12-02 14:00:00');        // EST, UTC-5
  assert.equal(utcToNyDay('2026-10-03 03:59:00'), '2026-10-02');
  assert.equal(utcToNyDay(null), null);
});

test('status vocabularies, both ways', () => {
  assert.equal(toHostawayStatus('waiting'), 'pending');
  assert.equal(toHostawayStatus('in_progress'), 'inProgress');
  assert.equal(fromHostawayStatus('confirmed'), 'open');
  assert.equal(fromHostawayStatus('completed'), 'done');
});

test('an owner is a Hostaway user by email, full name, or an unambiguous first name', () => {
  assert.equal(matchUser('Michelle', users)?.id, 2);
  assert.equal(matchUser('juan gonzalez', users)?.id, 1);
  assert.equal(matchUser('HELLO@kaizenguestproperties.com', users)?.id, 1);
  assert.equal(matchUser('Karina', users), null);
  assert.equal(matchUser(null, users), null);
});

test('the body Hostaway gets: first listing, deadline at end of day, owner, footer', () => {
  const b = toHostawayBody(w(), users, ['P2-4212']);
  assert.equal(b.listingMapId, 594914);
  assert.equal(b.reservationId, 66853131);
  assert.equal(b.title, '🔧 Fix the AC');
  assert.equal(b.shouldEndBy, '2026-10-03 03:59:00');
  assert.equal(b.canStartFrom, '2026-10-02 13:00:00');
  assert.equal(b.assigneeUserId, 2);
  assert.equal(b.status, 'pending');
  assert.match(b.description, /^Unit is warm\n\n— Kaizen OS · Repair #12 · Vendor: CoolCo · Estimate \$120\.00$/);
  // Not a Hostaway user: named in the footer instead.
  const v = toHostawayBody(w({ assignee: 'Karina', unitIds: ['1', '2'], kind: 'task' }), users, ['A', 'B']);
  assert.equal(v.assigneeUserId, null);
  assert.equal(v.title, 'Fix the AC');
  assert.match(v.description, /To-do #12 · Listings: A, B · Owner: Karina/);
  assert.equal(toHostawayBody(w({ unitIds: [], reservationId: null, dueOn: null }), users).listingMapId, null);
});

test('the footer is Kaizen’s, never part of the description it reads back', () => {
  assert.equal(coreOf('Unit is warm\n\n— Kaizen OS · Repair #12'), 'Unit is warm');
  assert.equal(coreOf(null), '');
});

const task = (over: Partial<HostawayTask> = {}): HostawayTask => ({
  id: 99, listingMapId: 594914, reservationId: null, autoTaskId: null, assigneeUserId: 2, createdByUserId: 1,
  title: '🔧 Fix the AC', description: 'Unit is warm\n\n— Kaizen OS · Repair #12', canStartFrom: null,
  shouldEndBy: '2026-10-03 03:59:00', status: 'pending', resolutionNote: null, cost: null, costCurrency: null, completedAt: null, ...over
});

test('only what moved in Hostaway comes back', () => {
  const prev = stateOf(task());
  assert.deepEqual(prev, { title: 'Fix the AC', description: 'Unit is warm', status: 'pending', assigneeUserId: 2, due: '2026-10-02', cost: null });
  assert.deepEqual(changesFrom(prev, stateOf(task()), users), { patch: {}, said: [] });
  const c = changesFrom(prev, stateOf(task({ status: 'completed', cost: 85, assigneeUserId: 1 })), users);
  assert.deepEqual(c.patch, { status: 'done', assignee: 'Juan Gonzalez', costActual: 85 });
  assert.deepEqual(c.said, ['status completed', 'assigned to Juan Gonzalez', 'cost $85.00']);
  // pending → confirmed is the same Kaizen status: nothing to apply.
  assert.deepEqual(changesFrom(prev, stateOf(task({ status: 'confirmed' })), users).patch, {});
});

test('only hand-made, open Hostaway tasks come in', () => {
  assert.ok(importable(task()));
  assert.ok(!importable(task({ autoTaskId: 375343 })));
  assert.ok(!importable(task({ status: 'completed' })));
});
