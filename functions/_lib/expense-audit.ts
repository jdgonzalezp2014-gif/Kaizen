/**
 * Where a line in Costs comes from (owner, 2026-10-28: "click any line to audit it — a repair or a purchase opens
 * its details, the same task that came from the to-do"). Every automatic line is keyed (source, external_ref)
 * (§137); this reads what that key names and says it as plain facts, the receipts, and the to-do behind it, which
 * the screen opens as the to-do's own card.
 */
import type { SqlFn } from './accounts.ts';

const TZ = 'America/New_York';
type Fact = [string, string];
export interface ExpenseAudit {
  expense: { id: string; date: string; category: string; amount: number; unit: string | null; label: string | null; notes: string | null;
             source: string | null; by: string | null; at: string };
  origin: { kind: 'repair' | 'todo' | 'purchase' | 'field' | 'clean' | 'extra' | 'store' | 'manual' | 'other'; title: string;
            facts: Fact[]; photos: { name: string; url: string }[]; todoId: string | null; text: string | null };
}

const money = (n: unknown) => n == null ? '—' : `$${Number(n).toFixed(2)}`;
const day = (d: unknown) => d == null ? '—' : String(d).slice(0, 16).replace('T', ' ');
const keep = (f: (Fact | false | null | undefined)[]) => f.filter((x): x is Fact => !!x && x[1] !== '' && x[1] != null);
const pics = (v: unknown) => Array.isArray(v) ? v.filter((p): p is { name: string; url: string } => !!p && typeof p.url === 'string') : [];

export async function auditExpense(sql: SqlFn, id: string): Promise<ExpenseAudit | null> {
  const [e] = await sql`SELECT e.id::text, e.start_date::text AS date, e.category, e.amount::float AS amount, u.name AS unit, e.label, e.notes,
                               e.source, e.external_ref AS ref, e.created_by AS by,
                               to_char(e.created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS at
                          FROM expenses e LEFT JOIN units u ON u.account_id = e.account_id AND u.id = e.unit_id
                         WHERE e.account_id = 1 AND e.id = ${Number(id) || 0}` as (ExpenseAudit['expense'] & { ref: string | null })[];
  if (!e) return null;
  const { ref, ...expense } = e;
  const none = { photos: [], todoId: null, text: null };

  if (e.source === 'repair' && ref) {
    const [t] = await sql`SELECT kind, title, vendor, status, charge_owner, to_char(done_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS done
                            FROM todos WHERE account_id = 1 AND id = ${Number(ref) || 0}` as { kind: string; title: string; vendor: string | null; status: string; charge_owner: boolean; done: string | null }[];
    return { expense, origin: { ...none, kind: t?.kind === 'work_order' ? 'repair' : 'todo', todoId: t ? ref : null,
      title: t ? `${t.kind === 'work_order' ? 'Repair' : 'To-do'} #${ref} — ${t.title}` : `To-do #${ref} (removed)`,
      facts: keep([t?.vendor ? ['Vendor', t.vendor] : null, t ? ['Done', day(t.done)] : null]) } };
  }
  if (e.source === 'inventory' && ref?.startsWith('purchase-')) {
    const [p] = await sql`SELECT todo_id::text AS todo, total, note, photos, by_name, paid_by, to_char(created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS at
                            FROM inventory_purchases WHERE account_id = 1 AND id = ${Number(ref.slice(9)) || 0}` as
      { todo: string | null; total: number; note: string | null; photos: unknown; by_name: string | null; paid_by: string | null; at: string }[];
    return { expense, origin: { kind: 'purchase', title: `Purchase #${ref.slice(9)}`, todoId: p?.todo ?? null, text: p?.note ?? null, photos: pics(p?.photos),
      facts: keep([['Recorded by', p?.by_name ?? '—'], ['On', day(p?.at)], ['Total', money(p?.total)], p?.paid_by ? ['Paid by', p.paid_by] : null]) } };
  }
  if (e.source === 'field' && ref) {
    const [f] = await sql`SELECT source, by_name, description, amount, photos, status, decided_by, decision_note, todo_id::text AS todo, cleaning_key,
                                 to_char(decided_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS decided
                            FROM field_expenses WHERE account_id = 1 AND id = ${Number(ref) || 0}` as Record<string, any>[];
    return { expense, origin: { kind: 'field', title: `Paid in the field — ${f?.by_name ?? '?'}`, todoId: f?.todo ?? null, text: f?.description ?? null,
      photos: pics(f?.photos), facts: keep([['Approved by', `${f?.decided_by ?? '—'} · ${day(f?.decided)}`], f?.decision_note ? ['Note', f.decision_note] : null,
                                           f?.cleaning_key ? ['Clean', f.cleaning_key] : null]) } };
  }
  if ((e.source === 'cleaning' || e.source === 'cleaning_extra') && ref) {
    const [x] = e.source === 'cleaning_extra'
      ? await sql`SELECT description, amount, status, decided_by, decision_note, cleaning_key, to_char(decided_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS decided
                    FROM cleaning_extras WHERE account_id = 1 AND id = ${Number(ref) || 0}` as Record<string, any>[] : [null];
    const key = x?.cleaning_key ?? ref;
    const [c] = await sql`SELECT unit_name, checkout_on::text AS day, cleaner, price, deep, guest FROM cleanings WHERE account_id = 1 AND key = ${key}` as Record<string, any>[];
    const clean: Fact[] = keep([['House', c?.unit_name ?? '—'], ['Checkout', c?.day ?? '—'], ['Cleaner', c?.cleaner ?? '—'],
                               ['Clean price', money(c?.price)], c?.deep ? ['Kind', 'Deep clean'] : null, c?.guest ? ['Guest', c.guest] : null]);
    return e.source === 'cleaning'
      ? { expense, origin: { ...none, kind: 'clean', title: `Clean ${key}`, facts: clean } }
      : { expense, origin: { ...none, kind: 'extra', title: `Cleaner's extra — ${x?.description ?? ''}`.slice(0, 200), text: x?.description ?? null,
          facts: keep([['Approved by', `${x?.decided_by ?? '—'} · ${day(x?.decided)}`], x?.decision_note ? ['Note', x.decision_note] : null, ...clean]) } };
  }
  if (e.source === 'store-order') return { expense, origin: { ...none, kind: 'store', title: `Store order ${ref ?? ''}`.trim(), text: e.notes, facts: [] } };
  return { expense, origin: { ...none, kind: e.source ? 'other' : 'manual', title: e.source ? `From ${e.source}` : 'Typed in Costs', text: e.notes,
                              facts: keep([['Added by', `${e.by ?? '—'} · ${e.at}`]]) } };
}
