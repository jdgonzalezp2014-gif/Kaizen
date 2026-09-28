/**
 * The team's to-do list (§76) — one component, on Home and in Operations.
 *
 * A to-do is a sentence, with any number of listings (or none) and a
 * deadline if it has one. Add it in one line; tick it off; click it to
 * change it, in place. Everything is read from the server as it is now,
 * and every change answers with the whole list, so two people working on
 * it see each other's ticks on their next change.
 */
import { useEffect, useMemo, useState } from 'react';
import { getTodos, getUnits, todoAction, type Todo } from '../api.ts';
import { dueLabel, dueOf, sortTodos } from '../lib/todos.ts';
import type { DateStr } from '../lib/dates.ts';

type Unit = { id: string; name: string; active: boolean };

export function TodoList({ today, compact = false, onMore }: {
  today: DateStr;
  /** Home: open to-dos only, the first few, and a door to the full list. */
  compact?: boolean; onMore?: () => void;
}) {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [unitFilter, setUnitFilter] = useState('');
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    getTodos().then(r => r.ok ? setTodos(r.todos) : setErr(r.message ?? 'Could not read the list.')).catch(e => setErr(String(e)));
    // Every unit, for the names a to-do already carries; the pickers offer the active ones.
    getUnits().then(r => setUnits((r.units ?? []).map(u => ({ id: u.id, name: u.name, active: u.active }))
      .sort((a, b) => a.name.localeCompare(b.name)))).catch(() => {});
  }, []);

  const names = useMemo(() => new Map(units.map(u => [u.id, u.name])), [units]);
  const act = async (body: Record<string, unknown>) => {
    const r = await todoAction(body).catch(e => ({ ok: false as const, message: String(e) }));
    if (r.ok) { setTodos(r.todos); setErr(''); return true; }
    setErr(r.message ?? 'Not saved.'); return false;
  };

  const sorted = sortTodos(todos ?? []).filter(t => !unitFilter || t.unitIds.includes(unitFilter));
  const openList = sorted.filter(t => !t.doneAt);
  const doneList = sorted.filter(t => t.doneAt);
  const shown = compact ? openList.slice(0, 6) : openList;

  return (
    <div className={`todos ${compact ? 'compact' : ''}`}>
      <TodoForm units={units} submitLabel="Add" onSubmit={async v => act({ action: 'create', ...v })} />
      {!compact && (
        <div className="row-controls">
          <select value={unitFilter} onChange={e => setUnitFilter(e.target.value)}>
            <option value="">Every listing</option>
            {units.filter(u => u.active).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <span className="note">{openList.length} open</span>
        </div>
      )}
      {err && <p className="banner warn">▲ {err}</p>}
      {todos === null ? <p className="note loading-dot">Reading</p>
        : !openList.length ? <p className="note">{unitFilter ? 'Nothing open for this listing.' : 'Nothing open. ✓'}</p> : (
        <ul className="todo-list">
          {shown.map(t => (
            <TodoRow key={t.id} t={t} today={today} names={names} units={units} open={open === t.id}
                     onOpen={() => setOpen(open === t.id ? null : t.id)} act={act} />
          ))}
        </ul>
      )}
      {compact && openList.length > shown.length && onMore &&
        <button className="link" onClick={onMore}>{openList.length - shown.length} more in Operations →</button>}
      {!compact && doneList.length > 0 && (
        <>
          <button className="link tiny" onClick={() => setShowDone(!showDone)}>
            {showDone ? '▾' : '▸'} Done in the last 14 days ({doneList.length})</button>
          {showDone && (
            <ul className="todo-list done">
              {doneList.map(t => (
                <TodoRow key={t.id} t={t} today={today} names={names} units={units} open={open === t.id}
                         onOpen={() => setOpen(open === t.id ? null : t.id)} act={act} />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function TodoRow({ t, today, names, units, open, onOpen, act }: {
  t: Todo; today: DateStr; names: Map<string, string>; units: Unit[]; open: boolean;
  onOpen: () => void; act: (b: Record<string, unknown>) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const due = t.doneAt ? 'none' : dueOf(t, today);
  const tick = async () => { setBusy(true); await act({ action: 'done', id: t.id, done: !t.doneAt }); setBusy(false); };

  return (
    <li className={`todo due-${due} ${t.doneAt ? 'is-done' : ''}`}>
      <div className="todo-line">
        <input type="checkbox" checked={!!t.doneAt} disabled={busy} onChange={() => void tick()}
               aria-label={t.doneAt ? `Reopen: ${t.title}` : `Done: ${t.title}`} />
        <button className="todo-title" onClick={onOpen} title="Change it">{t.title}</button>
        {t.unitIds.map(id => <span key={id} className="todo-unit">{names.get(id) ?? 'unit'}</span>)}
        {!t.doneAt && t.dueOn && <span className="todo-due">{dueLabel(t, today)}</span>}
        {t.doneAt && <span className="sub-n">✓ {t.doneBy?.split('@')[0]} · {t.doneAt.slice(5, 10)}</span>}
      </div>
      {open && (
        <div className="todo-edit">
          <TodoForm units={units} initial={t} submitLabel="Save"
                    onSubmit={async v => act({ action: 'update', id: t.id, ...v })} />
          <div className="button-row">
            <span className="sub-n">added by {t.createdBy?.split('@')[0] ?? '—'} · {t.createdAt.slice(0, 10)}</span>
            {!confirmDel
              ? <button className="link tiny danger" onClick={() => setConfirmDel(true)}>Remove…</button>
              : <><span className="note">Remove this to-do?</span>
                  <button className="small danger" onClick={() => void act({ action: 'delete', id: t.id })}>Remove</button>
                  <button className="link tiny" onClick={() => setConfirmDel(false)}>Keep</button></>}
          </div>
        </div>
      )}
    </li>
  );
}

/** One line to add (or change) a to-do: the words, any listings, a deadline if there is one. */
function TodoForm({ units, initial, submitLabel, onSubmit }: {
  units: Unit[]; initial?: Todo; submitLabel: string;
  onSubmit: (v: { title: string; unitIds: string[]; dueOn: string | null }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [picked, setPicked] = useState<string[]>(initial?.unitIds ?? []);
  const [due, setDue] = useState(initial?.dueOn ?? '');
  const [busy, setBusy] = useState(false);
  const name = (id: string) => units.find(u => u.id === id)?.name ?? 'unit';

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    const ok = await onSubmit({ title: title.trim(), unitIds: picked, dueOn: due || null });
    setBusy(false);
    if (ok && !initial) { setTitle(''); setPicked([]); setDue(''); }
  };

  return (
    <form className="todo-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <input className="todo-text" value={title} placeholder={initial ? '' : 'Add a to-do…'} maxLength={300}
             onChange={e => setTitle(e.target.value)} />
      <div className="todo-meta">
        {picked.map(id => (
          <span key={id} className="todo-unit">{name(id)}
            <button type="button" aria-label={`Remove ${name(id)}`} onClick={() => setPicked(p => p.filter(x => x !== id))}>×</button>
          </span>
        ))}
        <select value="" aria-label="Add a listing" onChange={e => { const v = e.target.value; if (v) setPicked(p => [...p, v]); }}>
          <option value="">{picked.length ? '+ listing' : 'Listing (optional)'}</option>
          {units.filter(u => u.active && !picked.includes(u.id)).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input type="date" value={due} aria-label="Deadline (optional)" title="Deadline (optional)" onChange={e => setDue(e.target.value)} />
        {due && <button type="button" className="link tiny" onClick={() => setDue('')}>no deadline</button>}
        <button className="small" disabled={!title.trim() || busy}>{busy ? '…' : submitLabel}</button>
      </div>
    </form>
  );
}
