import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleRepair } from './repair-costs.ts';
import type { SqlFn } from './accounts.ts';

/** A database that answers settleRepair's two reads and records every statement. */
function fakeDb(task: Record<string, unknown>, expense: Record<string, unknown> | null) {
  const ran: string[] = [];
  const sql = ((strings: TemplateStringsArray) => {
    const q = strings.join('?').replace(/\s+/g, ' ').trim();
    ran.push(q);
    if (q.startsWith('SELECT id::text, kind, status')) return Promise.resolve([task]);
    if (q.startsWith('SELECT id, amount::float')) return Promise.resolve(expense ? [expense] : []);
    return Promise.resolve([]);
  }) as unknown as SqlFn;
  return { sql, ran };
}
const task = (over: Record<string, unknown>) => ({
  id: '99', kind: 'work_order', status: 'completed', cost_actual: '100', unit_ids: ['595629'], title: 'Fix the door', vendor: null,
  done_at: '2026-10-15T15:00:00Z', deleted_at: null, charge_owner: false, hostaway_expense_id: null, hostaway_task_id: null,
  reservation_id: null, ...over
});
// Never reach Hostaway from a test: the owner's charge fails here and is noted, which is all these tests need.
const noHostaway = () => Promise.reject(new Error('no Hostaway in tests'));

test('a completed repair with a cost is in Costs (§95)', async () => {
  const { sql, ran } = fakeDb(task({}), null);
  await settleRepair(sql, '99', 'test', noHostaway);
  assert.ok(ran.some(q => q.startsWith('INSERT INTO expenses')));
});

test('a repair charged to the owner stays out of Kaizen\'s Costs (owner, §167)', async () => {
  const { sql, ran } = fakeDb(task({ charge_owner: true }), null);
  await settleRepair(sql, '99', 'test', noHostaway);
  assert.ok(!ran.some(q => q.startsWith('INSERT INTO expenses')), 'no expense written');
  // its Hostaway charge is still attempted (here it fails and says so on the timeline)
  assert.ok(ran.some(q => q.includes('INSERT INTO work_updates')));
});

test('ticking "Charge to owner" on a repair already in Costs takes it out, and says why', async () => {
  const { sql, ran } = fakeDb(task({ charge_owner: true }), { id: 7, amount: 100, day: '2026-10-15', unit_id: '595629', label: 'Fix the door' });
  await settleRepair(sql, '99', 'test', noHostaway);
  assert.ok(ran.some(q => q.startsWith('DELETE FROM expenses')));
});

test('a to-do (not a work order) with "charge to owner" still counts — only a work order is charged (§95)', async () => {
  const { sql, ran } = fakeDb(task({ kind: 'task', charge_owner: true }), null);
  await settleRepair(sql, '99', 'test', noHostaway);
  assert.ok(ran.some(q => q.startsWith('INSERT INTO expenses')));
});
