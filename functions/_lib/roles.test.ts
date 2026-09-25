import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayAccess, tabsFor } from './roles.ts';

test('ops can record costs and claims', () => {
  assert.equal(mayAccess('ops', '/api/expenses', 'POST'), true);
  assert.equal(mayAccess('ops', '/api/claims', 'DELETE'), true);
  assert.equal(mayAccess('ops', '/api/units', 'GET'), true);
});

test('ops cannot reach anything that shows what the portfolio earns', () => {
  // The point of the role. Hiding the tab is a convenience; this is the
  // control, because the endpoint is reachable with a URL.
  assert.equal(mayAccess('ops', '/api/portfolio', 'GET'), false);
  assert.equal(mayAccess('ops', '/api/forward', 'GET'), false);
  assert.equal(mayAccess('ops', '/api/market', 'GET'), false);
});

test('ops cannot change prices, settings or credentials', () => {
  assert.equal(mayAccess('ops', '/api/pricing', 'POST'), false);
  assert.equal(mayAccess('ops', '/api/settings', 'POST'), false);
  assert.equal(mayAccess('ops', '/api/sync-units', 'POST'), false);
  assert.equal(mayAccess('ops', '/api/cron', 'POST'), false);
});

test('a route nobody listed is closed, not open', () => {
  // The reason this is an allow-list. With a deny-list, a route added
  // next month would be reachable by everyone until somebody remembered.
  assert.equal(mayAccess('ops', '/api/something-new', 'GET'), false);
});

test('an admin is not restricted', () => {
  assert.equal(mayAccess('admin', '/api/portfolio', 'GET'), true);
  assert.equal(mayAccess('admin', '/api/anything', 'POST'), true);
});

test('the tabs match what the routes allow', () => {
  // If these drift apart, someone sees a tab that answers 403 — which
  // reads as the app being broken rather than as a permission.
  assert.deepEqual(tabsFor('ops'), ['operations', 'repository', 'costs', 'claims']);
  assert.ok(tabsFor('admin').includes('revenue'));
  for (const [tab, path] of [['operations', '/api/operations'], ['repository', '/api/repository']]) {
    assert.ok(tabsFor('ops').includes(tab!));
    assert.equal(mayAccess('ops', path!, 'GET'), true);
  }
});

test('ops can read the repository but never reveal a secret from it', () => {
  assert.equal(mayAccess('ops', '/api/repository', 'GET'), true);
  assert.equal(mayAccess('ops', '/api/repository', 'POST'), false);
  assert.equal(mayAccess('ops', '/api/repository-reveal', 'POST'), false);
  assert.equal(mayAccess('admin', '/api/repository-reveal', 'POST'), true);
});
