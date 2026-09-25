import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docNameOf, reservationFolderName, reservationPath, slug } from './guest-docs.ts';

test('the folder name is the daily file’s, to the letter — a real one from Drive', () => {
  assert.equal(reservationFolderName('2026-09-24', 'Maximilien Taïno Pailler'), 'Sep 24 & Maximilien Taïno Pailler');
  assert.equal(reservationFolderName('2026-10-03', 'A/B Guest'), 'Oct 3 & A-B Guest');
  assert.deepEqual(reservationPath('2026-09-24', 'Gary Myers'), ['2026', '2026-09', '2026-09-24', 'Sep 24 & Gary Myers']);
});

test('the guest name follows the daily file: first + last, else guestName, else Guest', () => {
  assert.equal(docNameOf({ guestFirstName: 'Rolando', guestLastName: 'Benite', guestName: 'Rolando Benitez' }), 'Rolando Benite');
  assert.equal(docNameOf({ guestName: ' James Carter ' }), 'James Carter');
  assert.equal(docNameOf({}), 'Guest');
});

test('a pulled agreement is named after the unit', () => {
  assert.equal(slug('CL Sunset #102'), 'cl-sunset-102');
  assert.equal(slug(''), 'unknown');
});
