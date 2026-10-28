/**
 * A handyman's charges on a repair (owner, 2026-10-28). They wait in Approvals, as a cleaner's do (Operations →
 * Cleaners, Home's $ Approvals), and inside the repair beside the photos they came with (`workProof`). Closing a repair
 * with charges still waiting asks first — /api/todos answers 409 `charges_pending` with `closeAsk`'s words, and the team
 * approves them all and closes (`approveWaiting`), or cancels. A ⚑ flagged job's charges are never approved in bulk.
 *
 * (Owner, same day: the "Validate pay" sub-task that came first was redundant with Approvals — removed before deploy.)
 */
import type { SqlFn } from './accounts.ts';
import type { HostawayCredentials } from './hostaway.ts';
import { decideFieldExpense } from './field-costs.ts';
import { settleRepair } from './repair-costs.ts';
import type { WaitingCharge } from '../../src/lib/vendor-pay.ts';

/** The charges waiting on `id` and on the work-order items it holds. */
export async function chargesWaiting(sql: SqlFn, id: string): Promise<WaitingCharge[]> {
  return await sql`
    SELECT f.id::text, t.id::text AS "todoId", t.title AS job, coalesce(btrim(t.vendor), f.by_name) AS vendor, f.amount::float AS amount,
           f.description, t.pay_flag_note AS flag
      FROM field_expenses f JOIN todos t ON t.account_id = f.account_id AND t.id = f.todo_id
     WHERE f.account_id = 1 AND f.source = 'vendor' AND f.status = 'pending' AND t.deleted_at IS NULL
       AND (t.id = ${Number(id) || 0} OR (t.parent_id = ${Number(id) || 0} AND t.kind = 'work_order'))
     ORDER BY t.id, f.id` as WaitingCharge[];
}

/** Approve every charge in `list` (the caller leaves the flagged ones out), then settle each job: cost, invoice, Costs. */
export async function approveWaiting(sql: SqlFn, list: WaitingCharge[], closing: string, by: string, creds: () => Promise<HostawayCredentials>) {
  for (const c of list) await decideFieldExpense(sql, c.id, 'approved', `Approved when #${closing} was closed`, by).catch(() => null);
  for (const job of new Set(list.map(c => c.todoId))) await settleRepair(sql, job, by, creds).catch(() => {});
}

export interface ProofJob {
  id: string; title: string; status: string; vendor: string; cost: number | null; estimate: number | null; flag: string | null;
  resolution: string | null; photos: { stage: 'before' | 'after'; name: string; url: string }[];
  charges: { id: string; amount: number; description: string; status: string; decisionNote: string | null; photos: { name: string; url: string }[] }[];
}

/**
 * What the team audits on a repair (owner, 2026-10-28: "the photos, from the task and from Handymen"): the handyman's
 * jobs it holds — the work order itself and its items — each with its photos before/after and its charges with receipts.
 */
export async function workProof(sql: SqlFn, id: string): Promise<ProofJob[]> {
  const [t] = await sql`SELECT kind FROM todos WHERE account_id = 1 AND id = ${Number(id) || 0}` as { kind: string }[];
  if (t?.kind !== 'work_order') return [];
  const root = id;
  const jobs = await sql`
    SELECT t.id::text, t.title, t.status, btrim(t.vendor) AS vendor, t.cost_actual::float AS cost, t.cost_estimate::float AS estimate,
           t.pay_flag_note AS flag, t.resolution_note AS resolution
      FROM todos t
     WHERE t.account_id = 1 AND (t.id = ${Number(root)} OR t.parent_id = ${Number(root)}) AND t.kind = 'work_order' AND t.deleted_at IS NULL
       AND btrim(coalesce(t.vendor, '')) <> ''
     ORDER BY t.id = ${Number(root)} DESC, t.id` as Omit<ProofJob, 'photos' | 'charges'>[];
  if (!jobs.length) return [];
  const nums = jobs.map(j => Number(j.id));
  const [photos, charges] = await Promise.all([
    sql`SELECT todo_id::text AS "todoId", stage, name, url FROM work_photos WHERE account_id = 1 AND todo_id = ANY(${nums}::bigint[]) ORDER BY id`,
    sql`SELECT todo_id::text AS "todoId", id::text, amount::float AS amount, description, status, decision_note AS "decisionNote", photos
          FROM field_expenses WHERE account_id = 1 AND source = 'vendor' AND todo_id = ANY(${nums}::bigint[]) ORDER BY id`
  ]) as [({ todoId: string } & ProofJob['photos'][number])[], ({ todoId: string } & ProofJob['charges'][number])[]];
  // Without photos or charges a job has nothing to audit yet — unless it is the work order itself.
  return jobs.map(j => ({ ...j, photos: photos.filter(p => p.todoId === j.id).map(({ todoId: _, ...p }) => p),
                                charges: charges.filter(c => c.todoId === j.id).map(({ todoId: _, ...c }) => c) }))
    .filter(j => j.id === id || j.photos.length || j.charges.length);
}
