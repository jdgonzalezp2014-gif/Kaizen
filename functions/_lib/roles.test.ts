import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL, PERMISSIONS, SEED_ROLES, can, mayAccess, tabsFor } from './roles.ts';

const perms = (key: string) => SEED_ROLES.find(r => r.key === key)!.permissions;
const OPS = perms('ops');
const MANAGER = perms('manager');

test('ops run the day: board, edits, inspections, costs, claims, the repository', () => {
  assert.equal(mayAccess(OPS, '/api/operations', 'GET'), true);
  assert.equal(mayAccess(OPS, '/api/turnover', 'POST'), true);
  assert.equal(mayAccess(OPS, '/api/inspections', 'DELETE'), true);
  assert.equal(mayAccess(OPS, '/api/expenses', 'POST'), true);
  assert.equal(mayAccess(OPS, '/api/claims', 'DELETE'), true);
  assert.equal(mayAccess(OPS, '/api/repository', 'GET'), true);
});

test('almost everyone reads the repository\'s passwords — ops included', () => {
  assert.equal(mayAccess(OPS, '/api/repository-reveal', 'POST'), true);
});

test('ops cannot reach anything that shows what the portfolio earns', () => {
  assert.equal(mayAccess(OPS, '/api/portfolio', 'GET'), false);
  assert.equal(mayAccess(OPS, '/api/forward', 'GET'), false);
  assert.equal(mayAccess(OPS, '/api/market', 'GET'), false);
  assert.equal(can(OPS, 'money'), false);
});

test('ops cannot change prices, pay, settings, roles or credentials', () => {
  assert.equal(mayAccess(OPS, '/api/pricing', 'POST'), false);
  assert.equal(mayAccess(OPS, '/api/ops-settings', 'POST'), false);
  assert.equal(mayAccess(OPS, '/api/settings', 'POST'), false);
  assert.equal(mayAccess(OPS, '/api/roles', 'POST'), false);
  assert.equal(mayAccess(OPS, '/api/cron', 'POST'), false);
});

test('ops keep unit records current; only managers change the repository\'s structure', () => {
  assert.equal(mayAccess(OPS, '/api/repository-edit', 'POST'), true);
  assert.equal(mayAccess(OPS, '/api/repository-structure', 'POST'), false);
  assert.equal(mayAccess(MANAGER, '/api/repository-structure', 'POST'), true);
});

test('a manager sees more than ops and still cannot touch settings', () => {
  assert.equal(mayAccess(MANAGER, '/api/portfolio', 'GET'), true);
  assert.equal(mayAccess(MANAGER, '/api/ops-settings', 'POST'), true);
  assert.equal(mayAccess(MANAGER, '/api/settings', 'POST'), false);
  assert.equal(mayAccess(MANAGER, '/api/roles', 'GET'), false);
});

test('everyone signed in can read who they are and the unit names — nothing more by default', () => {
  assert.equal(mayAccess([], '/api/settings', 'GET'), true);
  assert.equal(mayAccess([], '/api/units', 'GET'), true);
  assert.equal(mayAccess([], '/api/operations', 'GET'), false);
});

test('a route nobody listed is closed to everyone but admin', () => {
  // The reason this is an allow-list: a route added next month is not
  // reachable until somebody deliberately puts it under a permission.
  assert.equal(mayAccess(MANAGER, '/api/something-new', 'GET'), false);
  assert.equal(mayAccess([ALL], '/api/something-new', 'POST'), true);
});

test('a method not listed is closed even on a listed path', () => {
  assert.equal(mayAccess(OPS, '/api/repository', 'POST'), false);
  assert.equal(mayAccess(OPS, '/api/operations', 'DELETE'), false);
});

test('the tabs come from the same permissions as the routes', () => {
  // If these drift apart, someone sees a tab that answers 403 — which
  // reads as the app being broken rather than as a permission.
  assert.deepEqual(tabsFor(OPS), ['operations', 'repository', 'costs', 'claims']);
  assert.ok(tabsFor([ALL]).includes('settings'));
  for (const p of PERMISSIONS.filter(p => p.tab)) {
    assert.ok(p.routes.length > 0, `${p.key} draws a tab but opens no route`);
  }
});
