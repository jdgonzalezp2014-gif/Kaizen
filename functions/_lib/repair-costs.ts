/**
 * A repair's money (§95): its expense in Costs, and — when it is charged
 * to the owner — its expense on the listing in Hostaway.
 *
 * `settleRepair` is called after every change to a task, from Kaizen or
 * from Hostaway, and makes both match the repair as it now is:
 *   · a repair (work order) completed with a cost → an expense in Costs,
 *     category Repairs, on its listing (portfolio-wide without one), dated
 *     the New York day it was completed;
 *   · anything else (reopened, cancelled, removed, no cost) → no expense.
 * Idempotent: the Costs row is keyed by the task (source 'repair',
 * external_ref = id) and the Hostaway expense id is kept on the task.
 */
import type { SqlFn } from './accounts.ts';
import { getAccessToken, type HostawayCredentials } from './hostaway.ts';

const TZ = 'America/New_York';
const nyDay = (d: string | Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d));
const money = (n: number) => `$${n.toFixed(2)}`;

interface Row {
  id: string; kind: string; status: string; cost_actual: string | null; unit_ids: string[]; title: string; vendor: string | null;
  done_at: string | Date | null; deleted_at: string | Date | null; charge_owner: boolean; hostaway_expense_id: string | null;
  hostaway_task_id: string | null; reservation_id: string | null;
}

async function note(sql: SqlFn, id: string, body: string, by: string) {
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by) VALUES (1, 'task', ${id}, 'change', ${body}, ${by})`;
}

async function hostaway<T>(creds: HostawayCredentials, method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.hostaway.com/v1${path}`, {
    method, headers: { Authorization: `Bearer ${await getAccessToken(creds)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const j = await res.json().catch(() => null) as { result?: T; message?: string } | null;
  if (!res.ok && !(method === 'DELETE' && res.status === 404)) throw new Error(j?.message ?? `HTTP ${res.status}`);
  return j?.result ?? null;
}

export async function settleRepair(sql: SqlFn, id: string, by: string, creds: () => Promise<HostawayCredentials>): Promise<void> {
  const [r] = await sql`SELECT id::text, kind, status, cost_actual, unit_ids, title, vendor, done_at, deleted_at, charge_owner,
                               hostaway_expense_id, hostaway_task_id, reservation_id
                          FROM todos WHERE account_id = 1 AND id = ${id}` as Row[];
  if (!r) return;
  const cost = r.cost_actual == null ? 0 : Number(r.cost_actual);
  const counts = r.kind === 'work_order' && r.status === 'completed' && !r.deleted_at && cost > 0;
  const unit = r.unit_ids?.[0] ?? null;
  const day = nyDay(r.done_at ?? new Date());
  const what = `🔧 ${r.title}${r.vendor ? ` — ${r.vendor}` : ''}`;

  // ── Costs ──
  const [e] = await sql`SELECT id, amount::float AS amount, start_date::text AS day, unit_id, label
                          FROM expenses WHERE account_id = 1 AND source = 'repair' AND external_ref = ${id}` as
    { id: string; amount: number; day: string; unit_id: string | null; label: string | null }[];
  if (counts && !e) {
    await sql`INSERT INTO expenses (account_id, unit_id, shared, start_date, category, frequency, amount, label, notes, source, external_ref, created_by)
              VALUES (1, ${unit}, ${!unit}, ${day}, 'Repairs', 'One-time', ${cost}, ${r.title.slice(0, 120)},
                      ${`Repair #${id}${r.vendor ? ` · ${r.vendor}` : ''}`}, 'repair', ${id}, ${by})`;
    await note(sql, id, `Recorded in Costs: ${money(cost)} · Repairs · ${day}${unit ? '' : ' · portfolio-wide'}`, by);
  } else if (counts && e && (e.amount !== cost || e.day !== day || (e.unit_id ?? null) !== unit || e.label !== r.title.slice(0, 120))) {
    await sql`UPDATE expenses SET amount = ${cost}, start_date = ${day}, unit_id = ${unit}, shared = ${!unit}, label = ${r.title.slice(0, 120)},
                                  notes = ${`Repair #${id}${r.vendor ? ` · ${r.vendor}` : ''}`}
               WHERE account_id = 1 AND id = ${e.id}`;
    if (e.amount !== cost) await note(sql, id, `Costs updated: ${money(e.amount)} → ${money(cost)}`, by);
  } else if (!counts && e) {
    await sql`DELETE FROM expenses WHERE account_id = 1 AND id = ${e.id}`;
    await note(sql, id, `Removed from Costs (${money(e.amount)}) — no longer a completed repair with a cost.`, by);
  }

  // ── The owner's charge, in Hostaway ──
  const charge = counts && r.charge_owner && !!unit;
  if (!charge && !r.hostaway_expense_id) return;
  try {
    const c = await creds();
    if (charge) {
      const body = { listingMapId: Number(unit), expenseDate: day, concept: what.slice(0, 200), amount: -cost,
                     ...(r.reservation_id ? { reservationId: Number(r.reservation_id) } : {}),
                     ...(r.hostaway_task_id ? { generatedFromTaskId: Number(r.hostaway_task_id) } : {}) };
      if (!r.hostaway_expense_id) {
        const x = await hostaway<{ id: number }>(c, 'POST', '/expenses', body);
        if (!x?.id) throw new Error('Hostaway did not return the expense');
        await sql`UPDATE todos SET hostaway_expense_id = ${String(x.id)} WHERE account_id = 1 AND id = ${id}`;
        await note(sql, id, `Charged to the owner: expense of ${money(cost)} on the listing in Hostaway (#${x.id}).`, by);
      } else {
        await hostaway(c, 'PUT', `/expenses/${r.hostaway_expense_id}`, body);
      }
    } else {
      await hostaway(c, 'DELETE', `/expenses/${r.hostaway_expense_id}`);
      await sql`UPDATE todos SET hostaway_expense_id = NULL WHERE account_id = 1 AND id = ${id}`;
      await note(sql, id, 'Owner charge removed: its expense in Hostaway was deleted.', by);
    }
  } catch (err) {
    await note(sql, id, `⚠ The owner charge could not be updated in Hostaway: ${err instanceof Error ? err.message : String(err)}. Save the repair again to retry.`, by);
  }
}
