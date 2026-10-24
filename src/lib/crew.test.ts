import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInvoice, customPeriod, periodOf, recentPeriods, scheduleMovements, visibleAhead, type CrewClean, type CrewExtra, type ScheduleItem } from './crew.ts';

const clean = (key: string, date: string, extra: Partial<CrewClean> = {}): CrewClean =>
  ({ key, unit: 'CL1250', date, beds: 1, deep: false, kind: 'checkout', price: 50, assignment: 'assigned',
     voidReason: null, flagNote: null, ...extra });
const extra = (id: string, key: string, status: CrewExtra['status'], amount = 20): CrewExtra =>
  ({ id, key, amount, description: 'laundry', status, decisionNote: null, decidedBy: null, createdAt: '2026-10-01' });

test('a week runs Saturday to Friday and is paid the Saturday after; a month, in the first days of the next', () => {
  // 2026-10-11 is a Sunday; 2026-10-10 a Saturday; 2026-10-16 a Friday.
  const week = { from: '2026-10-10', to: '2026-10-16', label: 'Oct 10 – Oct 16, 2026', payday: '2026-10-17', payNote: 'Saturday, Oct 17' };
  assert.deepEqual(periodOf('2026-10-11', 'weekly'), week);
  assert.deepEqual(periodOf('2026-10-10', 'weekly'), week);          // Saturday opens the week
  assert.deepEqual(periodOf('2026-10-16', 'weekly'), week);          // Friday closes it
  assert.equal(periodOf('2026-10-17', 'weekly').from, '2026-10-17');  // payday is the next week's first day
  assert.deepEqual(periodOf('2026-10-11', 'monthly'),
    { from: '2026-10-01', to: '2026-10-31', label: 'Oct 2026', payday: '2026-11-01', payNote: 'the first days of November' });
  assert.equal(periodOf('2026-12-15', 'monthly').payNote, 'the first days of January');
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

test('movements since the snapshot: extended, cancelled, reassigned, new, time — and nothing past or unconfirmed', () => {
  const it = (key: string, date: string, cleaner = 'Irene', time = '10:00 AM'): ScheduleItem => ({ key, cleaner, date, unit: `U${key}`, time });
  const confirmed = [it('a', '2026-10-14'), it('b', '2026-10-15'), it('c', '2026-10-16'), it('d', '2026-10-17'),
                     it('e', '2026-10-18'), it('old', '2026-10-10'), it('x', '2026-10-14', 'Michelle')];
  const now = [it('a', '2026-10-16'), it('d', '2026-10-17', 'Irene', '11:00 AM'), it('e', '2026-10-18'),
               it('n', '2026-10-19'), it('late', '2026-10-24')];
  const fate = (k: string) => k === 'b' ? { status: 'cancelled' as const } : k === 'c' ? { status: 'reassigned' as const } : { status: 'unassigned' as const };
  const all = { published: true, autoDays: 0 };
  const m = scheduleMovements('Irene', { items: confirmed, day: '2026-10-11', through: '2026-10-20', vis: all },
                              now, '2026-10-11', all, fate);
  assert.deepEqual(m.map(x => `${x.kind}:${x.key}`), ['moved:a', 'removed:b', 'removed:c', 'time:d', 'added:n']);
  const moved = m[0] as Extract<typeof m[number], { kind: 'moved' }>;
  assert.equal(moved.later, true);
});

test('unpublished: hand-assigned always seen, the rule\'s picks only 4 days ahead (§127)', () => {
  const v = { published: false, autoDays: 4 };
  assert.equal(visibleAhead({ date: '2026-10-15' }, '2026-10-11', v), true);
  assert.equal(visibleAhead({ date: '2026-10-16' }, '2026-10-11', v), false);
  assert.equal(visibleAhead({ date: '2026-10-25', byHand: true }, '2026-10-11', v), true);
  assert.equal(visibleAhead({ date: '2026-10-25' }, '2026-10-11', { published: true, autoDays: 4 }), true);
});

test('a clean coming into view as the days pass is not "new"; one newly given in view is', () => {
  const it = (key: string, date: string, cleaner = 'Irene'): ScheduleItem => ({ key, cleaner, date, unit: `U${key}`, time: '10:00 AM' });
  const v = { published: false, autoDays: 4 };
  // Yesterday's snapshot: f (Oct 16) was 6 days out — out of view. Today it is 5… still out; g (Oct 15) newly in view.
  const snap = { items: [it('f', '2026-10-16'), it('g', '2026-10-15'), it('h', '2026-10-13', 'Veronica')],
                 day: '2026-10-10', through: '2026-10-20', vis: v };
  const now = [it('f', '2026-10-16'), it('g', '2026-10-15'), it('h', '2026-10-13')];
  const m = scheduleMovements('Irene', snap, now, '2026-10-11', v, () => ({ status: 'unassigned' }));
  assert.deepEqual(m.map(x => `${x.kind}:${x.key}`), ['added:h']);   // h was Veronica's and in view: newly Irene's
});

test('a span the team picks: its own dates, the invoice counts only the cleans in it', () => {
  const p = customPeriod('2026-10-02', '2026-10-20');
  assert.equal(p.custom, true);
  assert.equal(p.label, 'Oct 2 – Oct 20, 2026');
  const c = (key: string, date: string): CrewClean => ({ key, unit: 'U', date, beds: 2, deep: false, kind: 'checkout', price: 50,
    assignment: 'assigned', voidReason: null, flagNote: null, editNote: null });
  const inv = buildInvoice('Irene', p, [c('a', '2026-10-01'), c('b', '2026-10-02'), c('d', '2026-10-20')], [], '2026-10-24');
  assert.deepEqual(inv.lines.map(l => l.key), ['b', 'd']);
});
