import { test } from 'node:test';
import assert from 'node:assert/strict';
import { destFor, findPlace, fitsPlace, inventoryPlaces, isHouseKey, kindOf, placeWord, placeLabel, repoMatch, supplyPlace, unitAccess, type RepoRow, type UnitRow } from './unit-access.ts';

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

test('a unit draws supplies from the record its Storage names: a storage, or the house itself (§150)', () => {
  const r = (table: string, id: string, vals: Record<string, unknown>): RepoRow => ({ id, table, vals });
  const recs = [
    r('the_links', 'S1', { name: 'S1105 Storage (stock)', property_type: 'Storage', lockbox: '3611' }),
    r('the_links', 'S4', { name: 'S4116 Storage (stock)', property_type: 'Storage' }),
    r('cortland', 'S13', { name: 'CORTLAND STORAGE S13', property_type: 'Storage' }),
    r('the_links', 'L1', { name: 'LP-4315', storage: 'S1105 Storage (stock)' }),
    r('the_links', 'L2', { name: 'LP-1201', storage: '' }),
    r('the_links', 'L3', { name: 'LP-4212', storage: 'CORTLAND STORAGE S13' }),   // a storage of another building
    r('houses', 'H1', { name: 'Preston Vineyard', storage: 'Preston Vineyard', closet_code: '1234#', lockbox: '3611' }),
    r('houses', 'H2', { name: 'Bobcat', storage: 'Gone storage' })
  ];
  assert.deepEqual(supplyPlace(recs[3]!, recs), { key: 'the_links/S1', name: 'S1105 Storage (stock)', self: false, code: '3611' });
  assert.equal(supplyPlace(recs[4]!, recs), null);
  assert.equal(supplyPlace(recs[5]!, recs)?.key, 'cortland/S13');
  // The house's own closet: its closet code, never its door lockbox.
  assert.deepEqual(supplyPlace(recs[6]!, recs), { key: 'houses/H1', name: 'Preston Vineyard', self: true, code: '1234#' });
  assert.equal(supplyPlace(recs[7]!, recs), null);
  assert.equal(placeLabel('S1105 Storage (stock)'), 'S1105');
  assert.equal(placeLabel('CORTLAND STORAGE S13'), 'S13');
  assert.equal(placeLabel('Main warehouse'), 'Main warehouse');

  const units = [{ id: '1', name: 'P2-4315', active: true }, { id: '2', name: 'P2-1201', active: true }, { id: '3', name: 'Preston Vineyard', active: true },
                 { id: '4', name: 'P2-4212', active: false }];
  const m = inventoryPlaces(units, recs);
  assert.deepEqual(m.places.map(p => [p.name, p.units.map(u => u.name)]),
    [['CORTLAND STORAGE S13', []], ['S1105 Storage (stock)', ['P2-4315']], ['S4116 Storage (stock)', []], ['Preston Vineyard', ['Preston Vineyard']]]);
  assert.deepEqual(m.unassigned.map(u => u.name), ['P2-1201']);
  assert.equal(m.byUnit.get('4')?.key, 'cortland/S13');   // inactive: not listed, still resolved for its past
  // Owner, 2026-10-15: every active unit with a record has a house place of its own, apart from its closet.
  const preston = m.houses.find(h => h.name === 'Preston Vineyard')!;
  assert.equal(preston.key, 'houses/H1#house');
  assert.equal(preston.supplies, 'houses/H1');
  assert.ok(isHouseKey(preston.key) && !isHouseKey('houses/H1'));
  const h1 = m.houses.find(h => h.units[0]!.id === '1')!;
  assert.equal(h1.supplies, 'the_links/S1');
  assert.ok(!m.houses.some(h => h.units[0]!.id === '4'));   // inactive: no house
  assert.equal(findPlace(m, 'houses/H1')?.house, undefined);   // the closet
  assert.equal(findPlace(m, 'houses/H1#house')?.house, true);  // the house
  assert.equal(findPlace(m, 'nowhere/X'), null);
  // Furniture goes to the house; a supply to where the house draws from — never into the house.
  assert.equal(destFor(h1.key, 'furniture', m.houses), h1.key);
  assert.equal(destFor(h1.key, 'supply', m.houses), 'the_links/S1');
  assert.equal(destFor('cortland/S13', 'furniture', m.houses), 'cortland/S13');
  assert.equal(fitsPlace(preston, 'supply'), false);
  assert.equal(fitsPlace(preston, 'furniture'), true);
  assert.equal(fitsPlace({}, 'furniture'), true);   // furniture can sit in a storage
  assert.equal(placeWord({ name: 'Preston Vineyard', self: true }), 'Preston Vineyard closet');
  assert.equal(placeWord(preston), 'Preston Vineyard (house)');
});
