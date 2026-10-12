import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, repoMatch, unitAccess, type RepoRow, type UnitRow } from './unit-access.ts';

const rec = (id: string, vals: Record<string, unknown>): RepoRow => ({ id, table: 't', vals });
const RECS = [rec('a', { name: 'CL-1125' }), rec('b', { name: 'LP-4308' }), rec('c', { name: 'Timbercrest' }),
              rec('d', { name: 'Bobcat' }), rec('e', { name: 'S4116 Storage (stock)' })];

test('a unit finds its Repository record by name, unit number, or a name inside the other (§136)', () => {
  assert.equal(repoMatch('CL 1125', RECS)?.id, 'a');
  assert.equal(repoMatch('P2-4308', RECS)?.id, 'b');
  assert.equal(repoMatch('Timber Crest', RECS)?.id, 'c');
  assert.equal(repoMatch('Bobcat House', RECS)?.id, 'd');
  assert.equal(repoMatch('Napa Valley', RECS), null);
});

test('the access a clean carries: the team’s cleaner code first, the guests’ only as a fallback; what is missing', () => {
  const u: UnitRow = { id: '1', name: 'X', address: '1 Main St', wifiName: 'Net', wifiPassword: 'pw', doorCode: '9999' };
  const a = unitAccess(u, rec('r', { lock_type: 'Schlage Smart Lock', cleaner_code: 1234, admin_code: 5555 }));
  assert.equal(a.kind, 'smart'); assert.equal(a.code, '1234'); assert.equal(a.codeFrom, 'repository');
  assert.deepEqual(a.missing, []);
  assert.ok(!JSON.stringify(a).includes('5555'), 'the admin code never goes to a cleaner');
  const b = unitAccess(u, null);
  assert.equal(b.code, '9999'); assert.equal(b.codeFrom, 'hostaway');
  assert.deepEqual(b.missing, ['access', 'code']);
  const fob = unitAccess({ ...u, wifiName: null }, rec('f', { lock_type: 'Access Fob', keys_fobs: 'Access Fob' }));
  assert.equal(fob.kind, 'fob'); assert.deepEqual(fob.missing, ['lockbox', 'wifi']);
  assert.equal(kindOf('Yale Smart Lock'), 'smart'); assert.equal(kindOf('keys'), 'keys'); assert.equal(kindOf(null), null);
});
