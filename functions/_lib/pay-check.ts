/**
 * The pay check (owner, 2026-10-28): "when a job is completed, a new sub-task inside the same job to validate and
 * confirm the pay — so it goes on the invoice; nothing closes by itself, we know it was fixed, we look at the price,
 * we validate it."
 *
 * A handyman's job done (from their page, the link, the team, Slack or Hostaway) with charges waiting — or with no
 * price at all — gets ONE open sub-task "Validate pay — <vendor>: …" under its top-level work (a repair's items share
 * their repair's; sub-tasks are one level deep). Completing it (`validatePay`, from /api/todos) approves every charge
 * still waiting: the job's cost is then the approved charges (decideFieldExpense), on the vendor's invoice and — the
 * job being completed — in Costs (settleRepair). Never approved by itself: a flagged job, or one with no price, holds it.
 *
 * `syncPayCheck` is called after any change that can move what is waiting (a job done or reopened, a charge sent or
 * decided, a pay corrected or taken off). It makes the sub-task match: made when something waits, its title and lines
 * refreshed, and closed by itself once nothing is left — charges decided one by one in Operations → Handymen or
 * Cleaners are not validated twice.
 */
import type { SqlFn } from './accounts.ts';
import type { HostawayCredentials } from './hostaway.ts';
import { decideFieldExpense } from './field-costs.ts';
import { settleRepair } from './repair-costs.ts';
import { payCheckBlock, payCheckText, payCheckTitle, type PayCheckJob } from '../../src/lib/vendor-pay.ts';

async function log(sql: SqlFn, id: string, kind: 'status' | 'change', body: string, by: string) {
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by) VALUES (1, 'task', ${id}, ${kind}, ${body.slice(0, 4000)}, ${by})`;
}

/** The top-level work a to-do belongs to — where its pay check lives. */
async function rootOf(sql: SqlFn, id: string): Promise<string | null> {
  const [r] = await sql`SELECT coalesce(parent_id, id)::text AS root FROM todos WHERE account_id = 1 AND id = ${Number(id) || 0}` as { root: string }[];
  return r?.root ?? null;
}

/**
 * The jobs under `root` (itself and its items) waiting for the team: completed, with a vendor, on the pay, and with
 * charges waiting or no price. A repair that holds items is their folder, not a job — unless it carries charges.
 */
export async function payCheckJobs(sql: SqlFn, root: string): Promise<PayCheckJob[]> {
  return await sql`
    SELECT t.id::text, t.title, btrim(t.vendor) AS vendor, t.cost_actual::float AS cost, t.pay_flag_note AS flag,
           coalesce(c.pending, 0)::int AS pending, coalesce(c.pending_sum, 0)::float AS "pendingSum", coalesce(c.n, 0)::int AS charges
      FROM todos t
      LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE f.status = 'pending') AS pending,
                                sum(f.amount) FILTER (WHERE f.status = 'pending') AS pending_sum, count(*) AS n
                           FROM field_expenses f WHERE f.account_id = 1 AND f.source = 'vendor' AND f.todo_id = t.id) c ON true
     WHERE t.account_id = 1 AND (t.id = ${Number(root)} OR t.parent_id = ${Number(root)}) AND t.kind = 'work_order'
       AND t.status = 'completed' AND t.deleted_at IS NULL AND t.pay_void IS NULL AND NOT t.pay_check
       AND btrim(coalesce(t.vendor, '')) <> ''
       AND (coalesce(c.pending, 0) > 0
            OR (t.cost_actual IS NULL AND NOT EXISTS (SELECT 1 FROM todos k WHERE k.account_id = 1 AND k.parent_id = t.id
                                                         AND k.kind = 'work_order' AND k.deleted_at IS NULL)))
     ORDER BY t.id` as PayCheckJob[];
}

/** Make the pay check of `id`'s work match what waits. Safe to call after any change; quiet when nothing moves. */
export async function syncPayCheck(sql: SqlFn, id: string, by: string): Promise<void> {
  const root = await rootOf(sql, id);
  if (!root) return;
  const [jobs, [open]] = await Promise.all([
    payCheckJobs(sql, root),
    sql`SELECT id::text, title, description FROM todos WHERE account_id = 1 AND parent_id = ${Number(root)} AND pay_check
           AND deleted_at IS NULL AND status NOT IN ('completed', 'cancelled')` as Promise<{ id: string; title: string; description: string | null }[]>
  ]);
  if (!jobs.length) {
    if (!open) return;
    await sql`UPDATE todos SET status = 'completed', done_at = now(), done_by = ${by}, updated_at = now(),
                               resolution_note = 'Nothing left to validate — every job''s pay was decided.'
               WHERE account_id = 1 AND id = ${Number(open.id)} AND status NOT IN ('completed', 'cancelled')`;
    await log(sql, open.id, 'status', 'New → Done — nothing left to validate (every job’s pay was decided).', by);
    return;
  }
  const title = payCheckTitle(jobs), text = payCheckText(jobs);
  if (open) {
    if (open.title !== title || open.description !== text)
      await sql`UPDATE todos SET title = ${title}, description = ${text}, updated_at = now() WHERE account_id = 1 AND id = ${Number(open.id)}`;
    return;
  }
  // The unique index keeps it to one open pay check per parent, whoever gets here first.
  const [made] = await sql`INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority, parent_id, pay_check)
                           SELECT 1, ${title}, ${text}, p.unit_ids, 'Kaizen', 'task', 'pending', 'medium', p.id, true
                             FROM todos p WHERE p.account_id = 1 AND p.id = ${Number(root)}
                           ON CONFLICT DO NOTHING RETURNING id::text` as { id: string }[];
  if (!made) return;
  await log(sql, made.id, 'status', `Made by Kaizen: ${jobs.length === 1 ? 'a job was' : `${jobs.length} jobs were`} done — check the photos and the price, then ✓ Done approves the charges waiting.`, by);
  await log(sql, root, 'change', `Pay check added: ${title}`, by);
}

/**
 * The team completes a pay check: every charge waiting on its jobs is approved, and each job settles (its cost, the
 * invoice, Costs). Returns the refusal instead when a job holds it (flagged, or no price).
 */
export async function validatePay(sql: SqlFn, checkId: string, by: string, creds: () => Promise<HostawayCredentials>):
  Promise<{ approved: number; total: number } | { refuse: string }> {
  const root = (await sql`SELECT parent_id::text AS root FROM todos WHERE account_id = 1 AND id = ${Number(checkId) || 0} AND pay_check` as { root: string | null }[])[0]?.root;
  if (!root) return { approved: 0, total: 0 };
  const jobs = await payCheckJobs(sql, root);
  const why = payCheckBlock(jobs);
  if (why) return { refuse: why };
  let approved = 0, total = 0;
  for (const j of jobs.filter(x => x.pending)) {
    const ids = await sql`SELECT id::text FROM field_expenses WHERE account_id = 1 AND source = 'vendor' AND todo_id = ${Number(j.id)} AND status = 'pending' ORDER BY id` as { id: string }[];
    for (const c of ids) {
      const f = await decideFieldExpense(sql, c.id, 'approved', `Validated with the pay check #${checkId}`, by).catch(() => null);
      if (f) { approved++; total += f.amount; }
    }
    await settleRepair(sql, j.id, by, creds).catch(() => {});
  }
  if (approved) await log(sql, checkId, 'change', `Validated: ${approved} charge${approved === 1 ? '' : 's'} approved, $${total.toFixed(2)} — the jobs' cost, on the invoice.`, by);
  return { approved, total };
}

export interface ProofJob {
  id: string; title: string; status: string; vendor: string; cost: number | null; estimate: number | null; flag: string | null;
  resolution: string | null; photos: { stage: 'before' | 'after'; name: string; url: string }[];
  charges: { id: string; amount: number; description: string; status: string; decisionNote: string | null; photos: { name: string; url: string }[] }[];
}

/**
 * What the team audits on a to-do (owner, 2026-10-28: "the photos, from the task and from Handymen"): the handyman's
 * jobs it holds — a work order itself and its items, or, on a pay check, the done jobs of its work — each with its
 * photos before/after and its charges with their receipts.
 */
export async function workProof(sql: SqlFn, id: string): Promise<ProofJob[]> {
  const [t] = await sql`SELECT kind, pay_check, parent_id::text AS parent FROM todos WHERE account_id = 1 AND id = ${Number(id) || 0}` as
    { kind: string; pay_check: boolean; parent: string | null }[];
  if (!t || (!t.pay_check && t.kind !== 'work_order')) return [];
  const root = t.pay_check ? t.parent : id;
  if (!root) return [];
  const jobs = await sql`
    SELECT t.id::text, t.title, t.status, btrim(t.vendor) AS vendor, t.cost_actual::float AS cost, t.cost_estimate::float AS estimate,
           t.pay_flag_note AS flag, t.resolution_note AS resolution
      FROM todos t
     WHERE t.account_id = 1 AND (t.id = ${Number(root)} OR t.parent_id = ${Number(root)}) AND t.kind = 'work_order' AND t.deleted_at IS NULL
       AND btrim(coalesce(t.vendor, '')) <> '' AND (${!t.pay_check} OR t.status = 'completed')
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
    .filter(j => j.id === id || j.photos.length || j.charges.length || t.pay_check);
}
