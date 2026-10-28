/**
 * A line of Costs, audited (owner, 2026-10-28: "click any line — a repair or a purchase — and a pop-up with its
 * details; the same task that came from the to-do"). A repair or a to-do opens its own card (TodoList `task`);
 * anything else shows what it was — who, when, the receipt — and the to-do it was for, one click away.
 */
import { useEffect, useState } from 'react';
import { getExpenseAudit, type ExpenseAudit } from '../api.ts';
import { money2 } from '../lib/format.ts';
import { todayIn } from '../lib/dates.ts';
import { Modal } from './Modal.tsx';
import { Icon, ic } from './Icon.tsx';
import { TodoList } from './Todos.tsx';
import { PhotoStrip } from './WorkProof.tsx';

/** What each automatic source is, in a word and an icon — the Costs table says it on every line. */
export const SOURCE: Record<string, { icon: string; word: string }> = {
  repair: { icon: 'wrench', word: 'Repair' }, inventory: { icon: 'cart', word: 'Purchase' }, field: { icon: 'receipt', word: 'Paid in the field' },
  cleaning: { icon: 'brush', word: 'Clean' }, cleaning_extra: { icon: 'brush', word: 'Cleaner extra' }, 'store-order': { icon: 'box', word: 'Store order' }
};

export function ExpenseAuditPop({ id, source, todoRef, onClose }: { id: string; source: string | null; todoRef: string | null; onClose: () => void }) {
  const today = todayIn('America/New_York');
  // A repair's line IS its to-do: open the card straight away.
  const [task, setTask] = useState<string | null>(source === 'repair' ? todoRef : null);
  const [a, setA] = useState<ExpenseAudit | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (source === 'repair') return;
    void getExpenseAudit(id).then(r => r.ok ? setA(r) : setErr(r.message ?? 'Could not read it.')).catch(e => setErr(String(e)));
  }, [id]);
  if (task) return <TodoList today={today} task={task} onClose={() => source === 'repair' ? onClose() : setTask(null)} />;
  const s = a?.expense.source ? SOURCE[a.expense.source] : undefined;
  return (
    <Modal title={a ? a.origin.title : 'Cost'} onClose={onClose}>
      {err && <p className="breach">{ic(err)}</p>}
      {!a && !err && <p className="note">Loading…</p>}
      {a && (
        <div className="audit">
          <p className="audit-money"><b>{money2(a.expense.amount)}</b>
            <span className="sub-n"> · {ic(a.expense.category)} · {ic(a.expense.date)} · {ic(a.expense.unit ?? 'Shared')}</span>
            {s && <span className="sheet-chip"><Icon n={s.icon as never} />{s.word}</span>}</p>
          {a.origin.facts.length > 0 && (
            <dl className="audit-facts">{a.origin.facts.map(([k, v]) => <div key={k}><dt>{ic(k)}</dt><dd>{ic(v)}</dd></div>)}</dl>
          )}
          {a.origin.text && <pre className="audit-text">{a.origin.text}</pre>}
          <PhotoStrip photos={a.origin.photos} />
          {a.origin.todoId && <button className="link tiny" onClick={() => setTask(a.origin.todoId)}>Open the to-do #{a.origin.todoId} ›</button>}
        </div>
      )}
    </Modal>
  );
}
