import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODULES, PLANNED_TABS, barLinks, isActive, moduleOf, navFor, whereLabel } from './modules.ts';

const ALL_TABS = ['home', 'units', 'revenue', 'operations', 'repository', 'costs', 'inbox', 'sops', 'settings'];

test('an admin sees every module, the planned ones included', () => {
  const nav = navFor(ALL_TABS, ['*']);
  assert.deepEqual(nav.map(m => m.key), MODULES.map(m => m.key));
  assert.deepEqual(PLANNED_TABS, ['experience', 'sales', 'schedules']);
});

test('an operations role sees its doors only — no planned modules, no Setup, no claims shortcut', () => {
  const nav = navFor(['home', 'operations', 'repository', 'costs', 'sops'], ['operations', 'operations.edit', 'todos', 'repository', 'costs', 'sops']);
  assert.deepEqual(nav.map(m => m.key), ['leadership', 'operations', 'finance', 'shared', 'vendors', 'portal', 'core']);
  assert.deepEqual(nav.find(m => m.key === 'operations')!.links.map(l => l.key), ['board', 'todos', 'inspections', 'inventory', 'notes', 'blocks', 'rates']);
  assert.deepEqual(nav.find(m => m.key === 'finance')!.links.map(l => l.key), ['costs']);
  assert.deepEqual(nav.find(m => m.key === 'core')!.links.map(l => l.key), ['repository']);
});

test('the module that lights up is the one that owns the screen', () => {
  const nav = navFor(ALL_TABS, ['*']);
  assert.equal(moduleOf(nav, 'operations', 'todos')!.key, 'operations');
  assert.equal(moduleOf(nav, 'operations', undefined)!.key, 'operations');
  assert.equal(moduleOf(nav, 'operations', 'crew')!.key, 'vendors');
  assert.equal(moduleOf(nav, 'operations', 'calendar')!.key, 'vendors');
  assert.equal(moduleOf(nav, 'inbox')!.key, 'guests');
  assert.equal(moduleOf(nav, 'repository')!.key, 'core');
  // The portal preview is a door, not a place; Guest Services is the CRM alone (the claims shortcut went, 2026-11-17).
  assert.deepEqual(nav.find(m => m.key === 'guests')!.links.map(l => l.label), ['CRM']);
});

test('the phone bar is the first screen of the first modules, one per tab', () => {
  assert.deepEqual(barLinks(navFor(ALL_TABS, ['*'])).map(l => l.key), ['home', 'inbox', 'board', 'units']);
  assert.deepEqual(barLinks(navFor(['home', 'operations', 'repository'], ['operations', 'repository'])).map(l => l.key), ['home', 'board', 'repository']);
});

test('where someone is, in words', () => {
  const nav = navFor(ALL_TABS, ['*']);
  assert.equal(whereLabel(nav, 'operations', 'inventory'), 'Operations › Inventory');
  assert.equal(whereLabel(nav, 'home'), 'Home');
  assert.equal(whereLabel(nav, 'experience'), 'Guest Experience');
});
