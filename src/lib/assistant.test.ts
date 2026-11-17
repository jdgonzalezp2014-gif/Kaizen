import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookup, recName, type RepoRec } from './assistant.ts';

const cols = [{ key: 'name', title: 'Name' }, { key: 'wifi_name', title: 'WiFi network' }, { key: 'address', title: 'Address' }, { key: 'admin_code', title: 'Admin code' }, { key: 'password', title: 'WiFi password' }];
const rec = (o: Partial<RepoRec>): RepoRec => ({ table: 'houses', tableTitle: 'Houses', id: 'H1', name: 'Amber Valley', columns: cols, secrets: ['admin_code', 'password'],
  vals: { name: 'Amber Valley', wifi_name: 'Kaizen-AV', address: '11304 Amber Valley Dr' }, ...o });
const all = [rec({}), rec({ id: 'H2', name: 'Napa Valley', vals: { name: 'Napa Valley', wifi_name: 'Napa' } }),
  rec({ table: 'tools', tableTitle: 'Tools', id: 'T1', name: 'Airbnb', columns: [{ key: 'user', title: 'User / email' }, { key: 'password', title: 'Password' }], secrets: ['password'], vals: { user: 'ops@x.co' } })];

test('a record is meant when every telling word of its name is in the question', () => {
  assert.deepEqual(lookup('what is the wifi of amber valley?', all).map(h => h.id), ['H1']);
  assert.deepEqual(lookup('valley wifi', all).map(h => h.id), ['H1', 'H2']);   // half a name: both, to pick from
  assert.deepEqual(lookup('cl 1125 code', [rec({ id: 'C1', name: 'CL-1125' }), rec({ id: 'C2', name: 'CL-2250' })]).map(h => h.id), ['C1']);
  assert.deepEqual(lookup('password airbnb', [rec({ id: 'B1', name: 'Airbnb SuperHost Account' })]).map(h => h.id), ['B1']);
  assert.deepEqual(lookup('how do we refund an early checkout', all), []);
});

test('only the fields asked for; a secret is a button, never a value', () => {
  const [h] = lookup('wifi amber valley', all);
  assert.deepEqual(h!.fields, [{ label: 'WiFi network', value: 'Kaizen-AV' }]);
  assert.deepEqual(h!.secrets, [{ column: 'password', label: 'WiFi password' }]);
  const [t] = lookup('contraseña de Airbnb', all);
  assert.deepEqual(t!.secrets, [{ column: 'password', label: 'Password' }]);
  assert.deepEqual(t!.fields, []);
});

test('nothing asked shows the record; an unknown ask shows what there is', () => {
  assert.equal(lookup('amber valley', all)[0]!.fields.length, 3);
  assert.equal(lookup('amber valley parking', all)[0]!.fields.length, 3);
});

test('a record is named by its table\'s name fields', () => {
  assert.equal(recName({ building: 'P2', unit: '1406' }, ['building', 'unit'], 'X'), 'P2 1406');
  assert.equal(recName({}, ['building'], 'X9'), 'X9');
});
