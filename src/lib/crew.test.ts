import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoice, periodOf, recentPeriods, scheduleMovements, type CrewClean, type CrewExtra, type ScheduleItem } from './crew.ts';

const clean = (key: string, date: string, extra: Partial<CrewClean> = {}): CrewClean =>
  ({ key, unit: 'CL1250', date, beds: 1, deep: false, kind: 'checkout', price: 50, assignment: 'assigned',
     voidReason: null, flagNote: null, ...extra });
const extra = (id: string, key: string, status: CrewExtra['status'], amount = 20): CrewExtra =>
  ({ id, key, amount, description: 'laundry', status, decisionNote: null, decidedBy: null, createdAt: '2026-10-01' });

test('a week runs Saturday to Friday and is paid the Saturday after; a month, the first Saturday after it', () => {
  // 2026-10-11 is a Sunday; 2026-10-10 a Saturday; 2026-10-16 a Friday.
  const week = { from: '2026-10-10', to: '2026-10-16', label: 'Oct 10 – Oct 16, 2026', payday: '2026-10-17' };
  assert.deepEqual(periodOf('2026-10-11', 'weekly'), week);
  assert.deepEqual(periodOf('2026-10-10', 'weekly'), week);          // Saturday opens the week
  assert.deepEqual(periodOf('2026-10-16', 'weekly'), week);          // Friday closes it
  assert.equal(periodOf('2026-10-17', 'weekly').from, '2026-10-17');  // payday is the next week's first day
  assert.deepEqual(periodOf('2026-10-11', 'monthly'), { from: '2026-10-01', to: '2026-10-31', label: 'Oct 2026', payday: '2026-11-07' });
  assert.equal(periodOf('2026-01-15', 'monthly').payday, '2026-02-07');
  assert.equal(periodOf('2026-02-15', 'monthly').payday, '2026-03-07');  // Feb 28 2026 is a Saturday → the next one
});

test('recent periods go back without gaps, newest first', () => {
  assert.deepEqual(recentPeriods('2026-10-11', 'weekly', 3).map(p => p.from), ['2026-10-10', '2026-10-03', '2026-09-26']);
  assert.deepEqual(recentPeriods('2026-01-15', 'monthly', 2).map(p => p.from), ['2026-01-01', '2025-12-01']);
});

test('the invoice pays done, assigned, not-excluded cleans plus approved extras on them', () => {
  const p = periodOf('2026-10-11', 'monthly');
  const inv = buildInvoice('Karina and Marvin', p, [
    clean('a', '2026-10-02'),
    clean('b', '2026-10-05', { voidReason: 'booking cancelled in Hostaway' }),
    clean('c', '2026-10-09', { price: null }),
    clean('d', '2026-10-15'),                           // not done yet
    clean('e', '2026-09-30'),                           // last month
    clean('f', '2026-10-10', { flagNote: 'towels missing' })
  ], [extra('1', 'a', 'approved'), extra('2', 'a', 'pending'), extra('3', 'b', 'approved'), extra('4', 'f', 'denied')],
  '2026-10-11');
  assert.equal(inv.number, 'KZ-KARINAANDM-20261001');
  assert.deepEqual(inv.lines.map(l => l.key), ['a', 'c', 'f']);
  assert.equal(inv.unpriced, 1);
  assert.equal(inv.cleansTotal, 100);
  assert.deepEqual(inv.extras.map(e => e.id), ['1']);     // the extra on an excluded clean is not paid
  assert.equal(inv.total, 120);
  assert.deepEqual(inv.excluded.map(x => x.key), ['b']);
  assert.equal(inv.pendingExtras, 1);
  assert.equal(inv.lines.find(l => l.key === 'f')?.flag, 'towels missing');
  assert.equal(inv.open, true);
});

test('a manual clean says what it was', () => {
  const inv = buildInvoice('Irene', periodOf('2026-10-06', 'weekly'),
    [clean('MAN-1', '2026-10-06', { kind: 'early_departure', deep: true, beds: 2 })], [], '2026-10-20');
  assert.equal(inv.lines[0]!.what, '2BR deep clean (early departure)');
  assert.equal(inv.open, false);
});

test('movements since the confirmed schedule: extended, cancelled, reassigned, new, time — and nothing past or unconfirmed', () => {
  const it = (key: string, date: string, cleaner = 'Irene', time = '10:00 AM'): ScheduleItem => ({ key, cleaner, date, unit: `U${key}`, time });
  const confirmed = [it('a', '2026-10-14'), it('b', '2026-10-15'), it('c', '2026-10-16'), it('d', '2026-10-17'),
                     it('e', '2026-10-18'), it('old', '2026-10-10'), it('x', '2026-10-14', 'Michelle')];
  const now = [it('a', '2026-10-16'), it('d', '2026-10-17', 'Irene', '11:00 AM'), it('e', '2026-10-18'),
               it('n', '2026-10-19'), it('late', '2026-10-24')];
  const fate = (k: string) => k === 'b' ? { status: 'cancelled' as const } : k === 'c' ? { status: 'reassigned' as const } : { status: 'unassigned' as const };
  const m = scheduleMovements('Irene', confirmed, now, '2026-10-20', '2026-10-11', fate);
  assert.deepEqual(m.map(x => `${x.kind}:${x.key}`), ['moved:a', 'removed:b', 'removed:c', 'time:d', 'added:n']);
  const moved = m[0] as Extract<typeof m[number], { kind: 'moved' }>;
  assert.equal(moved.later, true);
});
