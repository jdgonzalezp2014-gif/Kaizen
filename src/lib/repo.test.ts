import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coerce, formatId, idNumber, matches, slug, validate, type RepoCol } from './repo.ts';

const col = (over: Partial<RepoCol>): RepoCol => ({
  key: 'k', title: 'K', type: 'text', required: false, uniq: false, options: null, refTable: null, refColumn: null, ...over
});

test('IDs continue the series with the table prefix, as the original did', () => {
  assert.equal(formatId('UNI', 7), 'UNI-0007');
  assert.equal(formatId('', 12), '12');
  assert.equal(idNumber('ROW-0021'), 21);
  assert.equal(idNumber('LOG-7'), 7);
});

test('keys come from titles, readable and unique', () => {
  assert.equal(slug('Wi-Fi password'), 'wi_fi_password');
  assert.equal(slug('Año de contrato'), 'ano_de_contrato');
  assert.equal(slug('Status', ['status']), 'status_2');
  assert.equal(slug('2nd code'), 'f_2nd_code');
});

test('a type change converts what fits and clears what does not', () => {
  assert.equal(coerce(col({ type: 'date' }), '2027-04-11T05:00:00.000Z'), '2027-04-11');
  assert.equal(coerce(col({ type: 'date' }), '4/11/2027'), '2027-04-11');
  assert.equal(coerce(col({ type: 'date' }), 'next spring'), '');
  assert.equal(coerce(col({ type: 'number' }), '$1,250.50'), 1250.5);
  assert.equal(coerce(col({ type: 'number' }), 'none'), '');
  assert.equal(coerce(col({ type: 'select', options: ['Active', 'Parked'] }), 'active'), 'Active');
  assert.equal(coerce(col({ type: 'select', options: ['Active'] }), 'Gone'), '');
  assert.equal(coerce(col({ type: 'checkbox' }), 'sí'), true);
});

test('validation says every problem, in words', () => {
  const cols = [col({ key: 'name', title: 'Name', required: true }), col({ key: 'status', title: 'Status', type: 'select', options: ['Active'] }),
                col({ key: 'mail', title: 'E-mail', type: 'email' }), col({ key: 'code', title: 'Code', uniq: true })];
  const errs = validate(cols, { name: '', status: 'Gone', mail: 'nope', code: 'A1' }, [{ code: 'A1' }]);
  assert.deepEqual(errs, ['Name is required.', 'Status must be one of: Active.', 'E-mail must be an e-mail address.', 'Code "A1" is already used.']);
});

test('an edit is checked on what it changes, not on the old data around it', () => {
  const cols = [col({ key: 'status', title: 'Status', type: 'select', options: ['Active'] }), col({ key: 'note', title: 'Note' })];
  assert.deepEqual(validate(cols, { status: 'legacy value', note: 'x' }, [], undefined, new Set(['note'])), []);
  assert.equal(validate(cols, { status: 'legacy value' }, [], undefined, new Set(['status'])).length, 1);
});

test('a secret is never validated against its value, and never searched', () => {
  assert.deepEqual(validate([col({ key: 'pw', title: 'Password', type: 'secret' })], { pw: 'x' }, [{ pw: 'x' }]), []);
  assert.equal(matches({ name: 'Hostaway', pw: 'hunter2' }, 'hunter', new Set(['pw'])), false);
  assert.equal(matches({ name: 'Hostaway', pw: 'hunter2' }, 'host', new Set(['pw'])), true);
});
