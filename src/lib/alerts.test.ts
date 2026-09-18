import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edges, compose, type AlertCondition } from './alerts.ts';

const cond = (id: string, active: boolean, detail = 'x'): AlertCondition =>
  ({ unitId: id, unitName: id, kind: 'red-listing', active, detail });

test('a condition that is still true says nothing', () => {
  // "Still 0%, tenth straight day" is true, useless, and trains people
  // to mute the channel — so that the message that mattered arrives to
  // an audience that stopped reading.
  const known = [{ unitId: 'A', kind: 'red-listing', status: 'open' }];
  assert.deepEqual(edges([cond('A', true)], known), []);
});

test('a condition that has just begun is news', () => {
  const out = edges([cond('A', true, '0% booked')], []);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.edge, 'begin');
});

test('a condition that has just ended is also news', () => {
  const known = [{ unitId: 'A', kind: 'red-listing', status: 'open' }];
  const out = edges([cond('A', false)], known);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.edge, 'resolve');
});

test('a resolved condition does not re-resolve', () => {
  // Otherwise a unit hovering at the line announces itself every run.
  const known = [{ unitId: 'A', kind: 'red-listing', status: 'resolved' }];
  assert.deepEqual(edges([cond('A', false)], known), []);
});

test('a unit that was never red and is not red now is silence', () => {
  assert.deepEqual(edges([cond('A', false)], []), []);
});

test('the message leads with the unit, because that is read first', () => {
  const msg = compose({ unitId: 'A', unitName: 'CL1339', kind: 'red-listing',
                        edge: 'begin', detail: '0% booked, $5,400 open' });
  assert.ok(msg.startsWith('CL1339:'));
  assert.ok(msg.length < 160, 'one segment');
});
