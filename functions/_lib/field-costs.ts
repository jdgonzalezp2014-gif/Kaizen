/**
 * Everything spent reaches Costs (§137) — the profit is revenue minus what is
 * in `expenses`, and until now the cleaners' pay, their approved extras and
 * the purchases never got there.
 *
 *  - `syncCleaningCosts`: every clean done and priced (the record: assigned,
 *    not voided, on or before today) is an expense "Cleaning" on its unit and
 *    day (source 'cleaning', external_ref = the clean's key); every approved
 *    extra too ('cleaning_extra'). Idempotent: rows follow the record — a
 *    price corrected, a clean voided, an extra denied later — and a row whose
 *    clean no longer counts is removed. Run nightly and after decisions.
 *  - Field expenses: money paid in the field (a purchase with its receipt)
 *    waits for approval; `decideFieldExpense` turns an approved one into an
 *    expense (source 'field').
 */
import type { SqlFn } from './accounts.ts';
import { todayIn } from '../../src/lib/dates.ts';
import { recordPurchase } from './inventory.ts';

const TZ = 'America/New_York';

export async function syncCleaningCosts(sql: SqlFn, by = 'Kaizen'): Promise<{ cleans: number; extras: number; removed: number }> {
  const today = todayIn(TZ);
  // Cleans: upsert every one that counts, then drop the rows of those that stopped counting.
  const cleans = await sql`
    INSERT INTO expenses (account_id, unit_id, shared, start_date, category, frequency, amount, label, notes, source, external_ref, created_by)
    SELECT 1, u.id, u.id IS NULL, c.checkout_on, 'Cleaning', 'One-time', c.price,
           left('Clean ' || c.unit_name || CASE WHEN c.deep THEN ' (deep)' ELSE '' END, 120),
           'Cleaner: ' || coalesce(c.cleaner, '—') || ' · clean ' || c.key, 'cleaning', c.key, ${by}
      FROM cleanings c LEFT JOIN units u ON u.account_id = c.account_id AND u.id = c.unit_id
     WHERE c.account_id = 1 AND c.void_reason IS NULL AND c.assignment = 'assigned' AND c.price IS NOT NULL AND c.price > 0
       AND c.checkout_on <= ${today}::date
    ON CONFLICT (source, external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET
      amount = EXCLUDED.amount, start_date = EXCLUDED.start_date, unit_id = EXCLUDED.unit_id, shared = EXCLUDED.shared,
      label = EXCLUDED.label, notes = EXCLUDED.notes
    RETURNING id` as unknown[];
  const extras = await sql`
    INSERT INTO expenses (account_id, unit_id, shared, start_date, category, frequency, amount, label, notes, source, external_ref, created_by)
    SELECT 1, u.id, u.id IS NULL, c.checkout_on, 'Cleaning', 'One-time', e.amount,
           left('Extra — ' || e.description, 120), 'Cleaner: ' || e.cleaner || ' · clean ' || e.cleaning_key, 'cleaning_extra', e.id::text, ${by}
      FROM cleaning_extras e JOIN cleanings c ON c.account_id = e.account_id AND c.key = e.cleaning_key
      LEFT JOIN units u ON u.account_id = c.account_id AND u.id = c.unit_id
     -- An extra is paid with its clean (buildInvoice): a clean not paid takes its extras out of Costs too.
     -- A purchase paid back (field_expense_id) is already in Costs as the purchase itself.
     WHERE e.account_id = 1 AND e.status = 'approved' AND c.void_reason IS NULL AND e.field_expense_id IS NULL
    ON CONFLICT (source, external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET
      amount = EXCLUDED.amount, start_date = EXCLUDED.start_date, unit_id = EXCLUDED.unit_id, shared = EXCLUDED.shared,
      label = EXCLUDED.label, notes = EXCLUDED.notes
    RETURNING id` as unknown[];
  const removed = await sql`
    DELETE FROM expenses x WHERE x.account_id = 1 AND (
      (x.source = 'cleaning' AND NOT EXISTS (SELECT 1 FROM cleanings c WHERE c.account_id = 1 AND c.key = x.external_ref
         AND c.void_reason IS NULL AND c.assignment = 'assigned' AND c.price IS NOT NULL AND c.price > 0 AND c.checkout_on <= ${today}::date))
      OR (x.source = 'cleaning_extra' AND NOT EXISTS (SELECT 1 FROM cleaning_extras e WHERE e.account_id = 1 AND e.id::text = x.external_ref
         AND e.status = 'approved' AND e.field_expense_id IS NULL AND NOT EXISTS (SELECT 1 FROM cleanings c WHERE c.account_id = 1 AND c.key = e.cleaning_key
           AND c.void_reason IS NOT NULL))))
    RETURNING id` as unknown[];
  return { cleans: cleans.length, extras: extras.length, removed: removed.length };
}

/** A purchase someone paid in the field, waiting for the team. */
export async function addFieldExpense(sql: SqlFn, e: {
  source: 'cleaner' | 'link' | 'vendor'; by: string; amount: number; description: string; category?: string;
  cleaningKey?: string | null; todoId?: string | null; unitId?: string | null; photos?: { name: string; url: string }[]; moveId?: string | null;
}): Promise<string> {
  const before = e.source === 'vendor' && e.todoId ? await chargesSum(sql, e.todoId) : null;
  const [r] = await sql`INSERT INTO field_expenses (account_id, source, by_name, cleaning_key, todo_id, unit_id, category, amount, description, photos, move_id)
                        VALUES (1, ${e.source}, ${e.by}, ${e.cleaningKey ?? null}, ${e.todoId ? Number(e.todoId) : null}, ${e.unitId ?? null},
                                ${e.category ?? 'Restock'}, ${e.amount}, ${e.description.slice(0, 300)}, ${JSON.stringify(e.photos ?? [])}::jsonb,
                                ${e.moveId ? Number(e.moveId) : null})
                        RETURNING id::text` as { id: string }[];
  if (before !== null) await followEstimate(sql, e.todoId!, before);
  return r!.id;
}

/** What a work order's handyman charged and the team has not denied. */
async function chargesSum(sql: SqlFn, todoId: string): Promise<number> {
  const [s] = await sql`SELECT coalesce(sum(amount), 0)::float AS n FROM field_expenses
                         WHERE account_id = 1 AND source = 'vendor' AND todo_id = ${Number(todoId)} AND status <> 'denied'` as { n: number }[];
  return s!.n;
}

/**
 * Owner, 2026-10-28: the handyman's price is the job's estimate — it was only in the approvals, and the work order said
 * nothing. It follows the charges (not denied) while it still says what they said before; an estimate the team typed,
 * or the handyman's own when asking to approve the work, is theirs and stays.
 */
async function followEstimate(sql: SqlFn, todoId: string, before: number) {
  await sql`UPDATE todos SET cost_estimate = nullif(${await chargesSum(sql, todoId)}::numeric, 0), updated_at = now()
             WHERE account_id = 1 AND id = ${Number(todoId)} AND (cost_estimate IS NULL OR cost_estimate = ${before}::numeric)`;
}

/**
 * Approve or deny; only a pending one — a decision is never silently overwritten.
 * A cleaner's purchase (§150) is approved only by recording it in the
 * inventory — `lines`: which items, to which place — and that purchase is its
 * stock and its cost (one Restock expense, with the receipt). A handyman's
 * charge stays part of its repair.
 */
export async function decideFieldExpense(sql: SqlFn, id: string, status: 'approved' | 'denied', note: string | null, by: string, lines?: unknown) {
  const [p] = await sql`SELECT source, amount::float AS amount, description, by_name, photos, cleaning_key FROM field_expenses
                         WHERE account_id = 1 AND id = ${Number(id) || 0} AND status = 'pending'` as
    { source: string; amount: number; description: string; by_name: string; photos: { name: string; url: string }[]; cleaning_key: string | null }[];
  let payBack: { cleaner: string; key: string } | null = null;
  if (!p) throw new Error('Only a pending one can be decided.');
  const [mine] = await sql`SELECT todo_id::text AS todo FROM field_expenses WHERE account_id = 1 AND id = ${Number(id) || 0} AND source = 'vendor'` as { todo: string | null }[];
  const estBefore = mine?.todo ? await chargesSum(sql, mine.todo) : null;
  if (status === 'approved' && p.source !== 'vendor') {
    if (!Array.isArray(lines) || !lines.length) throw new Error('Record what was bought in the inventory first: the items and where each went.');
    // Checked and saved first: a wrong line leaves it pending, never approved without its purchase.
    // Owner, 2026-10-24: approving it pays the cleaner back — an approved extra on the invoice of the clean it was
    // bought for (a helper's purchase: their cleaner's, who pays them). Never also on "To pay back" (§150): twice.
    // No clean with a cleaner to put it on → "To pay back", so it is never left unpaid.
    const [clean] = p.cleaning_key ? await sql`SELECT cleaner FROM cleanings WHERE account_id = 1 AND key = ${p.cleaning_key} AND cleaner IS NOT NULL` as
      { cleaner: string }[] : [];
    await recordPurchase(sql, by, { lines, total: p.amount, note: `Bought by ${p.by_name} — ${p.description}`.slice(0, 500),
                                    ...(clean ? {} : { paidBy: p.by_name }) }, p.photos ?? [], id);
    payBack = clean ? { cleaner: clean.cleaner, key: p.cleaning_key! } : null;
  }
  const [f] = await sql`UPDATE field_expenses SET status = ${status}, decided_by = ${by}, decided_at = now(), decision_note = ${note}
                         WHERE account_id = 1 AND id = ${Number(id) || 0} AND status = 'pending'
                         RETURNING id::text, amount::float AS amount, description, source, todo_id::text AS todo_id` as
    { id: string; amount: number; description: string; source: string; todo_id: string | null }[];
  if (!f) throw new Error('Only a pending one can be decided.');
  if (payBack) {
    await sql`INSERT INTO cleaning_extras (account_id, cleaning_key, cleaner, amount, description, status, decision_note, decided_by, decided_at, created_by, field_expense_id)
              VALUES (1, ${payBack.key}, ${payBack.cleaner}, ${p.amount}, ${p.description.slice(0, 300)}, 'approved',
                      'Paid back: the purchase was approved into the inventory', ${by}, now(), 'Kaizen', ${Number(id)})
              ON CONFLICT DO NOTHING`;
  }
  // A handyman's charge is part of the repair: the approved ones ARE its cost, and the repair — once
  // completed — is the one expense in Costs (settleRepair, by the caller). Never a second row here.
  if (f.source === 'vendor' && f.todo_id) {
    // A pay the team set by hand (Operations → Handymen: a correction or a flag's deduction) stays until they put it back.
    await sql`UPDATE todos SET cost_actual = coalesce(pay_fixed, (SELECT sum(amount) FROM field_expenses WHERE account_id = 1 AND todo_id = ${Number(f.todo_id)}
                                                AND source = 'vendor' AND status = 'approved')), updated_at = now()
               WHERE account_id = 1 AND id = ${Number(f.todo_id)}`;
    if (estBefore !== null) await followEstimate(sql, f.todo_id, estBefore);
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'task', ${f.todo_id}, 'change', ${`${status === 'approved' ? 'Approved' : 'Denied'}: $${f.amount.toFixed(2)} — ${f.description}${note ? ` · “${note}”` : ''}`.slice(0, 4000)}, ${by})`;
  }
  return f;
}

/** What waits for the team. */
export async function pendingFieldExpenses(sql: SqlFn) {
  return await sql`SELECT f.id::text, f.source, f.by_name AS "byName", f.cleaning_key AS "cleaningKey", f.todo_id::text AS "todoId",
                          f.unit_id AS "unitId", u.name AS unit, f.category, f.amount::float AS amount, f.description, f.photos,
                          to_char(f.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS at
                     FROM field_expenses f LEFT JOIN units u ON u.account_id = f.account_id AND u.id = f.unit_id
                    WHERE f.account_id = 1 AND f.status = 'pending' ORDER BY f.created_at`;
}
