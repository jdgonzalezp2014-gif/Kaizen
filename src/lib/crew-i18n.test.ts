import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayLabel, movementFor, payNote, periodLabel, TX, voidReasonText, workText } from './crew-i18n.ts';
import { periodOf } from './crew.ts';

test('English reads exactly as before; Spanish dates, periods and paydays', () => {
  const w = periodOf('2026-10-11', 'weekly'), m = periodOf('2026-10-11', 'monthly');
  assert.equal(dayLabel('en', '2026-10-11'), 'Sun, Oct 11');
  assert.equal(dayLabel('es', '2026-10-11'), 'dom 11 oct');
  assert.equal(periodLabel('en', w, 'weekly'), w.label);
  assert.equal(periodLabel('en', m, 'monthly'), m.label);
  assert.equal(payNote('en', w, 'weekly'), w.payNote);
  assert.equal(payNote('en', m, 'monthly'), m.payNote);
  assert.equal(periodLabel('es', w, 'weekly'), '10 oct – 16 oct 2026');
  assert.equal(periodLabel('es', m, 'monthly'), 'octubre 2026');
  assert.equal(payNote('es', w, 'weekly'), 'el sábado 17 oct');
  assert.equal(payNote('es', m, 'monthly'), 'los primeros días de noviembre');
});

test('reasons Kaizen wrote go into Spanish; a person\'s words stay', () => {
  assert.equal(voidReasonText('es', 'booking cancelled in Hostaway'), 'reserva cancelada en Hostaway');
  assert.equal(voidReasonText('es', 'same unit and day as reservation 123 — one clean'), 'misma unidad y día que la reserva 123 — una sola limpieza');
  assert.equal(voidReasonText('es', 'towels missing'), 'towels missing');
  assert.equal(voidReasonText('en', 'booking cancelled in Hostaway'), 'booking cancelled in Hostaway');
});

test('the work on an invoice line, and what moved, in either language', () => {
  assert.equal(workText('en', { beds: 2, deep: true, kind: 'early_departure' }), '2BR deep clean (early departure)');
  assert.equal(workText('es', { beds: 2, deep: true, kind: 'early_departure' }), '2 hab. limpieza profunda (salida anticipada)');
  const moved = { kind: 'moved' as const, key: 'a', unit: 'P2-1304', from: '2026-10-14', to: '2026-10-16', later: true };
  assert.equal(movementFor('es', moved), 'P2-1304: la salida pasó del mié 14 oct al vie 16 oct (estancia extendida)');
  assert.match(movementFor('en', moved), /stay extended/);
});

test('every sentence exists in both languages', () => {
  assert.deepEqual(Object.keys(TX.es).sort(), Object.keys(TX.en).sort());
});
