import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crewDayMessage, crewHelperMessage, dueCrewReminders, readyBy } from './crew-slack.ts';

test('cleaners’ reminders (§134): off unless on; today from 9 until 1 PM, tomorrow from 6 PM until 11:30 PM', () => {
  assert.deepEqual(dueCrewReminders({ day: '2026-10-12', hm: '09:05' }, {}), []);
  const on = { reminders: true };
  assert.deepEqual(dueCrewReminders({ day: '2026-10-12', hm: '08:55' }, on), []);
  assert.deepEqual(dueCrewReminders({ day: '2026-10-12', hm: '09:00' }, on), [{ kind: 'today', day: '2026-10-12' }]);
  assert.deepEqual(dueCrewReminders({ day: '2026-10-12', hm: '13:00' }, on), []);
  assert.deepEqual(dueCrewReminders({ day: '2026-10-31', hm: '18:10' }, on), [{ kind: 'tomorrow', day: '2026-11-01' }]);
  assert.deepEqual(dueCrewReminders({ day: '2026-10-12', hm: '23:45' }, on), []);
  assert.deepEqual(dueCrewReminders({ day: '2026-10-12', hm: '07:00' }, { reminders: true, morning: '07:00' }), [{ kind: 'today', day: '2026-10-12' }]);
  // A cleared time is that reminder off: only tomorrow's.
  assert.deepEqual(dueCrewReminders({ day: '2026-10-12', hm: '09:30' }, { reminders: true, morning: '' }), []);
  assert.deepEqual(dueCrewReminders({ day: '2026-10-12', hm: '18:00' }, { reminders: true, morning: '' }), [{ kind: 'tomorrow', day: '2026-10-13' }]);
});

test('cleaners’ messages speak their language', () => {
  const es = crewDayMessage('es', 'tomorrow', '2026-10-13', [{ unit: 'Timber Crest', time: '10:00 AM', beds: 5, sameDay: true, checkin: '2:00 PM' }], 'https://k');
  assert.match(es.text, /🌙 Mañana, mar 13 oct — 1 limpieza/);
  assert.match(JSON.stringify(es.blocks), /Timber Crest\* · 5 hab\. · salida 10:00 AM · ⏰ lista a las 2:00 PM \(entra el siguiente huésped\)/);
  assert.match(JSON.stringify(es.blocks), /2 🧴 lo que tomaste del storage/);
  assert.match(crewDayMessage('en', 'today', '2026-10-12', [{ unit: 'A', time: '10:00 AM' }, { unit: 'B', time: '11:00 AM' }]).text, /☀️ Today, Mon, Oct 12 — 2 cleans/);
  // A manual mid-stay clean has no checkout to name (owner, 2026-10-14).
  const mid = JSON.stringify(crewDayMessage('es', 'today', '2026-10-14', [{ unit: 'CL2450', time: '', midStay: true }]).blocks);
  assert.match(mid, /CL2450\* · 🧹 limpieza durante la estadía/);
  assert.doesNotMatch(mid, /salida|lista a las/);
});

test('ready by: the next check-in that day, else 4 PM, nothing after a late checkout (owner, 2026-10-14)', () => {
  assert.deepEqual(readyBy({ unit: 'A', time: '10:00 AM', checkin: '1:00 PM' }), { time: '1:00 PM', checkin: true });
  assert.deepEqual(readyBy({ unit: 'A', time: '10:00 AM' }), { time: '4:00 PM', checkin: false });
  assert.deepEqual(readyBy({ unit: 'A', time: '12:00 PM' }), { time: '4:00 PM', checkin: false });
  assert.equal(readyBy({ unit: 'A', time: '1:00 PM' }), null);
  assert.deepEqual(readyBy({ unit: 'A', time: '2:00 PM', checkin: '6:00 PM' }), { time: '6:00 PM', checkin: true });
  assert.equal(readyBy({ unit: 'A', time: '', midStay: true }), null);
  assert.match(crewDayMessage('en', 'today', '2026-10-14', [{ unit: 'A', time: '11:00 AM' }]).text + JSON.stringify(crewDayMessage('en', 'today', '2026-10-14', [{ unit: 'A', time: '11:00 AM' }]).blocks), /⏰ ready by 4:00 PM/);
  assert.match(crewHelperMessage('es', { by: 'Luz', unit: 'Timber Crest', kind: 'photos', stage: 'after', n: 4 }).text, /Luz · Timber Crest: 4 fotos DESPUÉS/);
  assert.match(crewHelperMessage('es', { by: 'Luz', unit: 'T', kind: 'taken', lines: [{ name: 'Toilet paper', qty: 4 }] }).text, /tomó del storage: Toilet paper × 4/);
  assert.match(crewHelperMessage('en', { by: 'Luz', unit: 'T', kind: 'report', what: 'problem', text: 'Leak <sink>', priority: 'urgent' }).text,
    /⚠️ Something is wrong \(🔴 urgent\) — Luz · T: Leak &lt;sink&gt;/);
});
