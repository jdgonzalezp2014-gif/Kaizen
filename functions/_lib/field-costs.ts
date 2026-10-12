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
     WHERE e.account_id = 1 AND e.status = 'approved'
    ON CONFLICT (source, external_ref) WHERE external_ref IS NOT NULL DO UPDATE SET
      amount = EXCLUDED.amount, start_date = EXCLUDED.start_date, unit_id = EXCLUDED.unit_id, shared = EXCLUDED.shared,
      label = EXCLUDED.label, notes = EXCLUDED.notes
    RETURNING id` as unknown[];
  const removed = await sql`
    DELETE FROM expenses x WHERE x.account_id = 1 AND (
      (x.source = 'cleaning' AND NOT EXISTS (SELECT 1 FROM cleanings c WHERE c.account_id = 1 AND c.key = x.external_ref
         AND c.void_reason IS NULL AND c.assignment = 'assigned' AND c.price IS NOT NULL AND c.price > 0 AND c.checkout_on <= ${today}::date))
      OR (x.source = 'cleaning_extra' AND NOT EXISTS (SELECT 1 FROM cleaning_extras e WHERE e.account_id = 1 AND e.id::text = x.external_ref
         AND e.status = 'approved')))
    RETURNING id` as unknown[];
  return { cleans: cleans.length, extras: extras.length, removed: removed.length };
}

/** A purchase someone paid in the field, waiting for the team. */
export async function addFieldExpense(sql: SqlFn, e: {
  source: 'cleaner' | 'link' | 'vendor'; by: string; amount: number; description: string; category?: string;
  cleaningKey?: string | null; todoId?: string | null; unitId?: string | null; photos?: { name: string; url: string }[]; moveId?: string | null;
}): Promise<string> {
  const [r] = await sql`INSERT INTO field_expenses (account_id, source, by_name, cleaning_key, todo_id, unit_id, category, amount, description, photos, move_id)
                        VALUES (1, ${e.source}, ${e.by}, ${e.cleaningKey ?? null}, ${e.todoId ? Number(e.todoId) : null}, ${e.unitId ?? null},
                                ${e.category ?? 'Restock'}, ${e.amount}, ${e.description.slice(0, 300)}, ${JSON.stringify(e.photos ?? [])}::jsonb,
                                ${e.moveId ? Number(e.moveId) : null})
                        RETURNING id::text` as { id: string }[];
  return r!.id;
}

/** Approve (→ an expense on its unit, today) or deny; only a pending one — a decision is never silently overwritten. */
export async function decideFieldExpense(sql: SqlFn, id: string, status: 'approved' | 'denied', note: string | null, by: string) {
  const [f] = await sql`UPDATE field_expenses SET status = ${status}, decided_by = ${by}, decided_at = now(), decision_note = ${note}
                         WHERE account_id = 1 AND id = ${Number(id) || 0} AND status = 'pending'
                         RETURNING id::text, unit_id, category, amount::float AS amount, description, by_name, cleaning_key` as
    { id: string; unit_id: string | null; category: string; amount: number; description: string; by_name: string; cleaning_key: string | null }[];
  if (!f) throw new Error('Only a pending one can be decided.');
  if (status === 'approved') {
    const [u] = f.unit_id ? await sql`SELECT id FROM units WHERE account_id = 1 AND id = ${f.unit_id}` as { id: string }[] : [];
    await sql`INSERT INTO expenses (account_id, unit_id, shared, start_date, category, frequency, amount, label, notes, source, external_ref, created_by)
              VALUES (1, ${u?.id ?? null}, ${!u}, ${todayIn(TZ)}, ${f.category}, 'One-time', ${f.amount}, ${f.description.slice(0, 120)},
                      ${`Paid by ${f.by_name}${f.cleaning_key ? ` · clean ${f.cleaning_key}` : ''} · approved by ${by}`}, 'field', ${f.id}, ${by})
              ON CONFLICT (source, external_ref) WHERE external_ref IS NOT NULL DO NOTHING`;
  }
  return f;
}

/** What waits for the team. */
export async function pendingFieldExpenses(sql: SqlFn) {
  return await sql`SELECT f.id::text, f.source, f.by_name AS "byName", f.cleaning_key AS "cleaningKey", f.todo_id::text AS "todoId",
                          u.name AS unit, f.category, f.amount::float AS amount, f.description, f.photos,
                          to_char(f.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS at
                     FROM field_expenses f LEFT JOIN units u ON u.account_id = f.account_id AND u.id = f.unit_id
                    WHERE f.account_id = 1 AND f.status = 'pending' ORDER BY f.created_at`;
}
