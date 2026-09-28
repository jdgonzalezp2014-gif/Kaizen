/**
 * Work (§76, §77) — to-dos and work orders, on Home, in Operations and
 * inside each claim. One component, so the three places cannot drift.
 *
 *   · A to-do is a sentence; a WORK ORDER is a repair or service job with a
 *     vendor, a day it is booked for and what it costs.
 *   · Both move through one set of states — To do → In progress → Waiting →
 *     Done (or Cancelled) — and both can have an owner, a priority, any
 *     number of listings, a deadline, and a claim they belong to.
 *   · Each has a timeline: every status and field change writes itself,
 *     and anyone can add an update in words.
 *
 * Add in one line; open a row to change it, in place (§22: no modals).
 * Everything is read from the server as it is now.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  getClaims, getClaimUpdates, getTaskUpdates, getTodos, getUnits, postClaimNote, saveClaim, todoAction,
  type Claim, type Todo, type WorkUpdate
} from '../api.ts';
import {
  KIND_LABEL, PRIORITY_LABEL, STATUS_LABEL, STATUSES, childrenBy, dueLabel, dueOf, isClosed, isFiltering, matchesFilter,
  progress, shortDay, sortTodos, workCost,
  type Priority, type TaskKind, type TaskStatus, type WorkFilter
} from '../lib/todos.ts';
import type { DateStr } from '../lib/dates.ts';
import { money2 } from '../lib/format.ts';
import { CLAIM_CATEGORIES, CLAIM_SEVERITY } from '../lib/claims.ts';

type Unit = { id: string; name: string; active: boolean };
type Act = (b: Record<string, unknown>) => Promise<boolean>;

const claimLabel = (c: Pick<Claim, 'unit_name' | 'category' | 'occurred_on'>) =>
  `${c.unit_name ?? 'Portfolio'} · ${c.category ?? 'claim'} · ${c.occurred_on.slice(0, 10)}`;

const claimOpen = (c: Claim) => c.status === 'Open' || c.status === 'In progress';
/** Weighted as on the Claims screen: a lockout outranks five slow-wifi complaints. */
const WEIGHT: Record<string, number> = { Low: 1, Medium: 2, High: 4, Critical: 8 };
const ageDays = (c: Claim, today: DateStr) =>
  Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(c.occurred_on.slice(0, 10) + 'T12:00:00Z')) / 864e5));

/** What Home's folded card says (§81). */
export interface WorkSum { open: number; overdue: number; today: number; urgent: number; cases: number }

export function TodoList({ today, compact = false, onMore, canClaims = false, claim, onChange, onSummary }: {
  today: DateStr;
  /** Home: open work only, the first few, and a door to the full list. */
  compact?: boolean; onMore?: () => void;
  /** Whether this person may see claims (to link work to one). */
  canClaims?: boolean;
  /** Inside a claim: only its work, and new work belongs to it. */
  claim?: { id: string; unitId: string | null };
  /** The list as it now is — the claim uses it for what its work costs. */
  onChange?: (list: Todo[]) => void;
  /** Home: the counts its card shows, folded or not. */
  onSummary?: (s: WorkSum) => void;
}) {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [unitFilter, setUnitFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<'' | TaskKind | 'claims'>('');
  const [prioFilter, setPrioFilter] = useState<'' | 'high' | 'urgent'>('');
  const [dueFilter, setDueFilter] = useState<'' | 'overdue' | 'today' | 'week' | 'none'>('');
  const [showDone, setShowDone] = useState(!!claim);
  const [openClaim, setOpenClaim] = useState<string | null>(null);
  const [adding, setAdding] = useState<null | TaskKind | 'claim'>(null);
  // Home (§81): one "+ Add", and three lines until asked for more.
  const [addMenu, setAddMenu] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // Open claims sit in the list as cases (§77), above the work — not inside a claim.
  const showClaims = canClaims && !claim;

  const take = (list: Todo[]) => { setTodos(list); onChange?.(list); };
  const loadClaims = () => getClaims().then(r => setClaims(r.claims ?? [])).catch(() => {});
  const loadTodos = () => getTodos(claim?.id).then(r => r.ok ? take(r.todos) : setErr(r.message ?? 'Could not read the list.'))
    .catch(e => setErr(String(e)));
  useEffect(() => {
    void loadTodos();
    // Every unit, for the names work already carries; the pickers offer the active ones.
    getUnits().then(r => setUnits((r.units ?? []).map(u => ({ id: u.id, name: u.name, active: u.active }))
      .sort((a, b) => a.name.localeCompare(b.name)))).catch(() => {});
    if (showClaims) void loadClaims();
  }, [claim?.id]);

  const names = useMemo(() => new Map(units.map(u => [u.id, u.name])), [units]);
  const claimNames = useMemo(() => new Map(claims.map(c => [String(c.id), claimLabel(c)])), [claims]);
  const act: Act = async body => {
    const r = await todoAction({ ...body, ...(claim ? { claimScope: claim.id } : {}) })
      .catch(e => ({ ok: false as const, message: String(e) }));
    if (r.ok) { take(r.todos); setErr(''); return true; }
    setErr(r.message ?? 'Not saved.'); return false;
  };

  const wf: WorkFilter = { kind: kindFilter === 'claims' ? '' : kindFilter, priority: prioFilter, due: dueFilter, unitId: unitFilter };
  const filtering = isFiltering(wf);
  const all = sortTodos(todos ?? []);
  const kids = useMemo(() => childrenBy(todos ?? []), [todos]);
  const byId = useMemo(() => new Map((todos ?? []).map(t => [t.id, t])), [todos]);
  // No filter: tasks at the top, their sub-tasks inside them. A filter:
  // every match, flat, each sub-task saying whose it is (§78).
  const top = kindFilter === 'claims' ? []
    : filtering ? all.filter(t => matchesFilter(t, wf, today))
    : all.filter(t => !t.parentId || !byId.has(t.parentId));
  const openList = top.filter(t => !isClosed(t.status));
  const doneList = top.filter(t => isClosed(t.status));
  // Worst first, then the oldest: the case that has waited longest at the top.
  // A claim has no deadline, so a date filter leaves claims out; urgency maps to severity.
  const sevOk = (c: Claim) => !prioFilter || (prioFilter === 'urgent' ? c.severity === 'Critical' : ['High', 'Critical'].includes(c.severity));
  const cases = !showClaims || (kindFilter !== '' && kindFilter !== 'claims') || dueFilter ? [] : claims
    .filter(c => claimOpen(c) && (!unitFilter || c.unit_id === unitFilter) && sevOk(c))
    .sort((a, b) => (WEIGHT[b.severity] ?? 1) - (WEIGHT[a.severity] ?? 1) || a.occurred_on.localeCompare(b.occurred_on));
  const openWorkBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of todos ?? []) if (t.claimId && !isClosed(t.status)) m.set(t.claimId, (m.get(t.claimId) ?? 0) + 1);
    return m;
  }, [todos]);
  // Home (§81): one list, ordered by what needs acting on — overdue or
  // urgent work, then serious claims, then what is due today, then the
  // rest — three lines, the others one tap away in place.
  type Item = { kind: 'case'; c: Claim } | { kind: 'task'; t: Todo };
  const rankOf = (i: Item) => i.kind === 'case'
    ? (['Critical', 'High'].includes(i.c.severity) ? 1 : 3)
    : (i.t.priority === 'urgent' || dueOf(i.t, today) === 'overdue' ? 0 : dueOf(i.t, today) === 'today' ? 2 : 4);
  const merged: Item[] = compact
    ? [...cases.map(c => ({ kind: 'case' as const, c })), ...openList.map(t => ({ kind: 'task' as const, t }))]
        .map((i, n) => ({ i, n })).sort((a, b) => rankOf(a.i) - rankOf(b.i) || a.n - b.n).map(x => x.i)
    : [];
  const compactShown = showAll ? merged : merged.slice(0, 3);
  const shownCases = compact ? [] : cases;
  const shown = compact ? [] : openList;
  const hidden = merged.length - compactShown.length;
  const ctx = { today, names, units, claims, claimNames, act, inClaim: !!claim, kids, byId, flat: filtering,
                canClaims: showClaims, onClaimsChanged: () => void loadClaims(), compact };

  // The counts Home's card shows, folded or not.
  useEffect(() => {
    if (!onSummary || todos === null) return;
    const live = (todos ?? []).filter(t => !isClosed(t.status));
    onSummary({
      open: live.filter(t => !t.parentId).length + (showClaims ? claims.filter(claimOpen).length : 0),
      overdue: live.filter(t => dueOf(t, today) === 'overdue').length,
      today: live.filter(t => dueOf(t, today) === 'today').length,
      urgent: live.filter(t => t.priority === 'urgent').length,
      cases: showClaims ? claims.filter(claimOpen).length : 0
    });
  }, [todos, claims]);

  const caseRow = (c: Claim) => (
    <li key={`case-${c.id}`} className={`todo case sev-${c.severity.toLowerCase()}`}>
      <div className="todo-line">
        <span className="case-flag" aria-hidden="true">⚑</span>
        <button className="todo-title" onClick={() => setOpenClaim(openClaim === String(c.id) ? null : String(c.id))}
                title="Open the claim">{c.unit_name ?? 'Portfolio'} · {c.category ?? 'Claim'}</button>
        <span className={`todo-status sev s-${c.severity.toLowerCase()}`}>{c.severity}</span>
        <span className="todo-status">{c.status === 'Open' ? '○ Open' : '◐ In progress'}</span>
        <span className="sub-n">{ageDays(c, today)}d open</span>
        {openWorkBy.get(String(c.id)) ? <span className="sub-n">· {openWorkBy.get(String(c.id))} open task{openWorkBy.get(String(c.id)) === 1 ? '' : 's'}</span>
          : <span className="todo-due">▲ no work yet</span>}
        {c.description && <span className="sub-n case-desc" title={c.description}>— {c.description}</span>}
      </div>
      {openClaim === String(c.id) && (
        <ClaimCase claim={c} canWork today={today} onSaved={() => { void loadClaims(); void loadTodos(); }} />
      )}
    </li>
  );

  return (
    <div className={`todos ${compact ? 'compact' : ''}`}>
      {/* Buttons first; the form opens only for what is being added. */}
      {!adding && compact && !addMenu ? (
        <div className="todo-add-buttons">
          <button className="small secondary" onClick={() => setAddMenu(true)}>+ Add</button>
        </div>
      ) : !adding ? (
        <div className="todo-add-buttons">
          <button className="small secondary" onClick={() => setAdding('task')}>+ To-do</button>
          <button className="small secondary" onClick={() => setAdding('work_order')}>+ 🔧 Work order</button>
          {showClaims && <button className="small secondary" onClick={() => setAdding('claim')}>+ ⚑ Claim</button>}
        </div>
      ) : adding === 'claim' ? (
        <QuickClaim units={units} today={today} onCancel={() => { setAdding(null); setAddMenu(false); }}
                    onSaved={() => { setAdding(null); setAddMenu(false); void loadClaims(); }} />
      ) : (
        <TodoForm key={adding} units={units} claims={claims} canClaims={canClaims && !claim} submitLabel="Add"
                  startKind={adding} onCancel={() => { setAdding(null); setAddMenu(false); }}
                  fixed={claim ? { claimId: claim.id, unitIds: claim.unitId ? [claim.unitId] : [] } : undefined}
                  onSubmit={async v => { const ok = await act({ action: 'create', ...v }); if (ok) { setAdding(null); setAddMenu(false); } return ok; }} />
      )}
      {!compact && !claim && (
        <div className="row-controls">
          {([['', 'Everything'], ['task', 'To-dos'], ['work_order', '🔧 Work orders'],
             ...(showClaims ? [['claims', '⚑ Claims']] : [])] as ['' | TaskKind | 'claims', string][]).map(([k, l]) => (
            <button key={k} className={kindFilter === k ? 'chip active' : 'chip'} onClick={() => setKindFilter(k)}>{l}</button>
          ))}
          <select value={prioFilter} aria-label="Urgency" onChange={e => setPrioFilter(e.target.value as '' | 'high' | 'urgent')}>
            <option value="">Any urgency</option>
            <option value="high">▲ High or urgent</option>
            <option value="urgent">▲▲ Urgent only</option>
          </select>
          <select value={dueFilter} aria-label="Deadline" onChange={e => setDueFilter(e.target.value as typeof dueFilter)}>
            <option value="">Any date</option>
            <option value="overdue">▲ Overdue</option>
            <option value="today">● Due today</option>
            <option value="week">This week</option>
            <option value="none">No deadline</option>
          </select>
          <select value={unitFilter} aria-label="Listing" onChange={e => setUnitFilter(e.target.value)}>
            <option value="">Every listing</option>
            {units.filter(u => u.active).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <span className="note">{openList.length} open</span>
          {(filtering || kindFilter === 'claims') && (
            <button className="link tiny" onClick={() => { setKindFilter(''); setPrioFilter(''); setDueFilter(''); setUnitFilter(''); }}>clear filters</button>
          )}
        </div>
      )}
      {err && <p className="banner warn">▲ {err}</p>}
      {shownCases.length > 0 && <ul className="todo-list cases">{shownCases.map(caseRow)}</ul>}
      {compact && todos !== null && (
        !merged.length ? <p className="note">Nothing open. ✓</p> : (
          <ul className="todo-list">
            {compactShown.map(i => i.kind === 'case' ? caseRow(i.c)
              : <TodoRow key={i.t.id} t={i.t} open={open === i.t.id} onOpen={() => setOpen(open === i.t.id ? null : i.t.id)} {...ctx} />)}
          </ul>
        )
      )}
      {todos === null ? <p className="note loading-dot">Reading</p>
        : compact ? null
        : kindFilter === 'claims' ? (!cases.length && <p className="note">No open claims. ✓</p>)
        : !openList.length ? (!shownCases.length && <p className="note">{claim ? 'No open work on this claim.' : filtering ? 'Nothing matches these filters.' : 'Nothing open. ✓'}</p>) : (
        <ul className="todo-list">
          {shown.map(t => <TodoRow key={t.id} t={t} open={open === t.id} onOpen={() => setOpen(open === t.id ? null : t.id)} {...ctx} />)}
        </ul>
      )}
      {compact && (hidden > 0 || showAll) && merged.length > 3 && (
        <button className="link tiny home-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show less ▴' : `Show ${hidden} more ▾`}</button>
      )}
      {!compact && doneList.length > 0 && (
        <>
          <button className="link tiny" onClick={() => setShowDone(!showDone)}>
            {showDone ? '▾' : '▸'} {claim ? 'Closed' : 'Closed in the last 14 days'} ({doneList.length})</button>
          {showDone && (
            <ul className="todo-list done">
              {doneList.map(t => <TodoRow key={t.id} t={t} open={open === t.id} onOpen={() => setOpen(open === t.id ? null : t.id)} {...ctx} />)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

type RowCtx = {
  today: DateStr; names: Map<string, string>; units: Unit[]; claims: Claim[]; claimNames: Map<string, string>;
  act: Act; inClaim: boolean;
  /** Sub-tasks by parent id, and every task by id (§78). */
  kids: Map<string, Todo[]>; byId: Map<string, Todo>;
  /** A filter is on: rows are flat, a sub-task says whose it is. */
  flat: boolean;
  /** May register a to-do as a claim. */
  canClaims: boolean; onClaimsChanged: () => void;
  /** Home: sub-tasks are summed up (☑ 1/3), not listed. */
  compact?: boolean;
};

function TodoRow(props: RowCtx & { t: Todo; open: boolean; onOpen: () => void }) {
  const { t, today, names, units, claims, claimNames, open, onOpen, act, inClaim, kids, byId, flat, canClaims, onClaimsChanged, compact } = props;
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [addingSub, setAddingSub] = useState<null | TaskKind>(null);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const closed = isClosed(t.status);
  const due = closed ? 'none' : dueOf(t, today);
  const mine = sortTodos(kids.get(t.id) ?? []);
  const prog = progress(mine);
  const parent = t.parentId ? byId.get(t.parentId) : undefined;
  const tick = async () => { setBusy(true); await act({ action: 'done', id: t.id, done: !closed }); setBusy(false); };
  const toClaim = async () => {
    setBusy(true);
    const ok = await act({ action: 'toClaim', id: t.id });
    setBusy(false);
    if (ok) { setMsg('Registered as a claim — it is in Claims, and this to-do is linked to it.'); onClaimsChanged(); }
  };

  return (
    <li className={`todo due-${due} ${closed ? 'is-done' : ''} prio-${t.priority}`}>
      <div className="todo-line">
        <input type="checkbox" checked={closed} disabled={busy} onChange={() => void tick()}
               aria-label={closed ? `Reopen: ${t.title}` : `Done: ${t.title}`} />
        {t.kind === 'work_order' && <span title="Work order">🔧</span>}
        {flat && parent && <span className="sub-n" title="Sub-task of">↳ {parent.title} ·</span>}
        <button className="todo-title" onClick={onOpen} title="Open it">{t.title}</button>
        {prog.total > 0 && <span className={`todo-prog ${prog.done === prog.total ? 'all' : ''}`} title="Sub-tasks done">
          ☑ {prog.done}/{prog.total}</span>}
        {t.priority !== 'normal' && !closed && <span className={`todo-prio ${t.priority}`}>{PRIORITY_LABEL[t.priority]}</span>}
        {(t.status === 'in_progress' || t.status === 'waiting' || t.status === 'cancelled') &&
          <span className={`todo-status s-${t.status}`}>{STATUS_LABEL[t.status]}</span>}
        {t.unitIds.map(id => <span key={id} className="todo-unit">{names.get(id) ?? 'unit'}</span>)}
        {t.claimId && !inClaim && <span className="todo-claim" title="Belongs to a claim">⚑ {claimNames.get(t.claimId) ?? 'claim'}</span>}
        {t.assignee && <span className="sub-n">→ {t.assignee}</span>}
        {t.kind === 'work_order' && t.vendor && <span className="sub-n">· {t.vendor}</span>}
        {t.kind === 'work_order' && t.scheduledOn && !closed && <span className="sub-n">· booked {shortDay(t.scheduledOn)}</span>}
        {!closed && t.dueOn && <span className="todo-due">{dueLabel(t, today)}</span>}
        {(t.costActual ?? t.costEstimate) != null &&
          <span className="sub-n">{t.costActual != null ? money2(t.costActual) : `~${money2(t.costEstimate!)}`}</span>}
        {t.updates > 1 && <span className="sub-n" title="Updates">💬 {t.updates}</span>}
        {closed && t.doneAt && <span className="sub-n">{t.status === 'cancelled' ? '✕' : '✓'} {t.doneBy?.split('@')[0]} · {t.doneAt.slice(5, 10)}</span>}
      </div>
      {t.description && !open && <div className="todo-desc" title={t.description}>{t.description}</div>}
      {/* Sub-tasks sit under their task when the list is not filtered (§78). */}
      {!flat && !open && !compact && mine.some(k => !isClosed(k.status)) && (
        <ul className="todo-list todo-kids">
          {mine.filter(k => !isClosed(k.status)).map(k => (
            <TodoRow key={k.id} {...props} t={k} open={openSub === k.id} onOpen={() => setOpenSub(openSub === k.id ? null : k.id)} />
          ))}
        </ul>
      )}
      {open && (
        <div className="todo-edit">
          <TodoForm units={units} claims={claims} canClaims={!inClaim && claims.length > 0} initial={t} submitLabel="Save changes"
                    onSubmit={v => act({ action: 'update', id: t.id, ...v })} />
          {/* A task can hold any number of sub-tasks, of any kind — or none. One level deep. */}
          {!t.parentId && (
            <div className="todo-subs">
              <div className="timeline-title">Sub-tasks {prog.total > 0 && <span className="sub-n">{prog.done}/{prog.total} done</span>}</div>
              {mine.length > 0 && (
                <ul className="todo-list todo-kids">
                  {mine.map(k => <TodoRow key={k.id} {...props} flat={false} t={k} open={openSub === k.id}
                                          onOpen={() => setOpenSub(openSub === k.id ? null : k.id)} />)}
                </ul>
              )}
              {!addingSub ? (
                <div className="todo-add-buttons">
                  <button className="link tiny" onClick={() => setAddingSub('task')}>+ sub-task</button>
                  <button className="link tiny" onClick={() => setAddingSub('work_order')}>+ 🔧 work order</button>
                </div>
              ) : (
                <TodoForm key={addingSub} units={units} claims={claims} canClaims={false} submitLabel="Add" startKind={addingSub}
                          onCancel={() => setAddingSub(null)}
                          fixed={{ parentId: t.id, claimId: t.claimId, unitIds: t.unitIds }}
                          onSubmit={async v => { const ok = await act({ action: 'create', ...v }); if (ok) setAddingSub(null); return ok; }} />
              )}
            </div>
          )}
          <Timeline load={() => getTaskUpdates(t.id)} post={body => act({ action: 'note', id: t.id, body })} version={t.updates} />
          {msg && <p className="banner ok">{msg}</p>}
          <div className="button-row">
            <span className="sub-n">added by {t.createdBy?.split('@')[0] ?? '—'} · {t.createdAt.slice(0, 10)}</span>
            {canClaims && !inClaim && !t.claimId && !t.parentId &&
              <button className="link tiny" disabled={busy} onClick={() => void toClaim()}
                      title="It is a guest case — open a claim for it, linked to this to-do">⚑ Register as a claim</button>}
            {!confirmDel
              ? <button className="link tiny danger" onClick={() => setConfirmDel(true)}>Remove…</button>
              : <><span className="note">Remove this {t.kind === 'work_order' ? 'work order' : 'to-do'}?</span>
                  <button className="small danger" onClick={() => void act({ action: 'delete', id: t.id })}>Remove</button>
                  <button className="link tiny" onClick={() => setConfirmDel(false)}>Keep</button></>}
          </div>
        </div>
      )}
    </li>
  );
}

type FormValue = {
  title: string; kind: TaskKind; unitIds: string[]; dueOn: string | null; priority: Priority; assignee: string | null;
  claimId: string | null; vendor: string | null; scheduledOn: string | null;
  costEstimate: number | null; costActual: number | null; status?: TaskStatus;
  description: string | null; parentId?: string;
};

/**
 * Add (one line, "more" for the rest) or change a piece of work. `fixed`
 * is what a claim pre-sets: the claim itself, and its unit.
 */
function TodoForm({ units, claims, canClaims, initial, fixed, submitLabel, onSubmit, startKind = 'task', onCancel }: {
  units: Unit[]; claims: Claim[]; canClaims: boolean; initial?: Todo; submitLabel: string;
  /** What the context pre-sets: a claim (and its unit), or a parent task (its listings and claim). */
  fixed?: { claimId?: string | null; unitIds: string[]; parentId?: string };
  onSubmit: (v: FormValue) => Promise<boolean>;
  /** Adding: the kind the button chose. */
  startKind?: TaskKind; onCancel?: () => void;
}) {
  const blank = (): FormValue => ({
    title: '', kind: startKind, unitIds: fixed?.unitIds ?? [], dueOn: null, priority: 'normal', assignee: null,
    claimId: fixed?.claimId ?? null, vendor: null, scheduledOn: null, costEstimate: null, costActual: null,
    description: null, ...(fixed?.parentId ? { parentId: fixed.parentId } : {})
  });
  const [v, setV] = useState<FormValue>(() => initial ? {
    title: initial.title, kind: initial.kind, unitIds: initial.unitIds, dueOn: initial.dueOn, priority: initial.priority,
    assignee: initial.assignee, claimId: initial.claimId, vendor: initial.vendor, scheduledOn: initial.scheduledOn,
    costEstimate: initial.costEstimate, costActual: initial.costActual, status: initial.status,
    description: initial.description
  } : blank());
  const [more, setMore] = useState(!!initial);
  // The description: always there when editing; one click away when adding.
  const [withDesc, setWithDesc] = useState(!!initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormValue>(k: K, x: FormValue[K]) => setV(p => ({ ...p, [k]: x }));
  const name = (id: string) => units.find(u => u.id === id)?.name ?? 'unit';
  const wo = v.kind === 'work_order';
  const openClaims = claims.filter(c => c.status === 'Open' || c.status === 'In progress' || String(c.id) === v.claimId);

  const submit = async () => {
    if (!v.title.trim() || busy) return;
    setBusy(true);
    const ok = await onSubmit({ ...v, title: v.title.trim() });
    setBusy(false);
    if (ok && !initial) { setV(blank()); setMore(false); }
  };
  const moneyIn = (x: number | null, k: 'costEstimate' | 'costActual') => (
    <input type="number" min={0} step="0.01" value={x ?? ''} placeholder="$"
           onChange={e => set(k, e.target.value === '' ? null : Number(e.target.value))} />
  );

  return (
    <form className="todo-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="todo-first">
        {/* The kind is chosen by the button when adding; it can still be changed when editing. */}
        {initial ? (
          <div className="todo-kind" role="group" aria-label="Kind">
            {(['task', 'work_order'] as TaskKind[]).map(k => (
              <button key={k} type="button" className={v.kind === k ? 'chip active' : 'chip'} onClick={() => set('kind', k)}>{KIND_LABEL[k]}</button>
            ))}
          </div>
        ) : <b className="todo-adding">{wo ? '🔧 New work order' : 'New to-do'}</b>}
        <input className="todo-text" value={v.title} maxLength={120} autoFocus={!initial}
               placeholder={initial ? '' : wo ? 'Short title — e.g. Fix the AC' : 'Short title — e.g. Text the HOA'}
               onChange={e => set('title', e.target.value)}
               onKeyDown={e => { if (e.key === 'Escape' && onCancel) onCancel(); }} />
      </div>
      {/* The title stays a title; the detail goes here (§78). */}
      {withDesc ? (
        <textarea className="todo-descin" rows={initial ? 3 : 2} value={v.description ?? ''} maxLength={4000}
                  placeholder="Details — who, what exactly, anything to remember"
                  onChange={e => set('description', e.target.value || null)} />
      ) : (
        <button type="button" className="link tiny todo-descbtn" onClick={() => setWithDesc(true)}>+ description</button>
      )}
      <div className="todo-meta">
        {v.unitIds.map(id => (
          <span key={id} className="todo-unit">{name(id)}
            <button type="button" aria-label={`Remove ${name(id)}`} onClick={() => set('unitIds', v.unitIds.filter(x => x !== id))}>×</button>
          </span>
        ))}
        <select value="" aria-label="Add a listing" onChange={e => { const x = e.target.value; if (x) set('unitIds', [...v.unitIds, x]); }}>
          <option value="">{v.unitIds.length ? '+ listing' : 'Listing (optional)'}</option>
          {units.filter(u => u.active && !v.unitIds.includes(u.id)).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <label className="todo-inline">Deadline
          <input type="date" value={v.dueOn ?? ''} onChange={e => set('dueOn', e.target.value || null)} /></label>
        {!initial && <button type="button" className="link tiny" onClick={() => setMore(!more)}>
          {more ? 'fewer options' : wo ? 'vendor, cost, owner…' : 'owner, priority…'}</button>}
        {!initial && <span className="rb-spacer" />}
        {!initial && onCancel && <button type="button" className="link tiny" onClick={onCancel}>Cancel</button>}
        {!initial && <button className="small" disabled={!v.title.trim() || busy}>{busy ? '…' : submitLabel}</button>}
      </div>
      {more && (
        <div className="todo-more">
          {initial && (
            <label>Status
              <select value={v.status} onChange={e => set('status', e.target.value as TaskStatus)}>
                {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select></label>
          )}
          <label>Priority
            <select value={v.priority} onChange={e => set('priority', e.target.value as Priority)}>
              {(['normal', 'high', 'urgent'] as Priority[]).map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select></label>
          <label>Owner
            <input value={v.assignee ?? ''} placeholder="Who is on it" onChange={e => set('assignee', e.target.value || null)} /></label>
          {canClaims && (
            <label>Part of a claim? (optional)
              <select value={v.claimId ?? ''} onChange={e => set('claimId', e.target.value || null)}>
                <option value="">No — standalone</option>
                {openClaims.map(c => <option key={c.id} value={String(c.id)}>{claimLabel(c)}</option>)}
              </select></label>
          )}
          {wo && <>
            <label>Vendor
              <input value={v.vendor ?? ''} placeholder="Plumber, handyman…" onChange={e => set('vendor', e.target.value || null)} /></label>
            <label>Booked for
              <input type="date" value={v.scheduledOn ?? ''} onChange={e => set('scheduledOn', e.target.value || null)} /></label>
            <label>Estimate {moneyIn(v.costEstimate, 'costEstimate')}</label>
            <label>Actual cost {moneyIn(v.costActual, 'costActual')}</label>
          </>}
        </div>
      )}
      {initial && (
        <div className="button-row">
          <button className="small" disabled={!v.title.trim() || busy}>{busy ? 'Saving…' : submitLabel}</button>
        </div>
      )}
    </form>
  );
}

/**
 * A timeline — every status and field change (written by the server) and
 * every update in words, oldest first, with a box to add one. Shared by a
 * task and a claim.
 */
export function Timeline({ load, post, version = 0 }: {
  load: () => Promise<{ ok: true; updates: WorkUpdate[] } | { ok: false; message?: string; error?: string }>;
  post: (body: string) => Promise<boolean>;
  /** Re-read when this changes (the parent saw a new update count). */
  version?: number;
}) {
  const [list, setList] = useState<WorkUpdate[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const read = () => load().then(r => setList(r.ok ? r.updates : [])).catch(() => setList([]));
  useEffect(() => { void read(); }, [version]);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await post(text.trim());
    setBusy(false);
    if (ok) { setText(''); await read(); }
  };

  return (
    <div className="timeline">
      <div className="timeline-title">Updates</div>
      {list === null ? <p className="note loading-dot">Reading</p> : !list.length ? <p className="note">No updates yet.</p> : (
        <ol className="timeline-list">
          {list.map(u => (
            <li key={u.id} className={`tl-${u.kind}`}>
              <span className="tl-when">{u.createdAt.slice(5, 10)} {u.createdAt.slice(11, 16)}</span>
              <span className="tl-who">{u.createdBy?.split('@')[0] ?? '—'}</span>
              <span className="tl-body">{u.kind === 'note' ? u.body : <i>{u.body}</i>}</span>
            </li>
          ))}
        </ol>
      )}
      <form className="timeline-add" onSubmit={e => { e.preventDefault(); void send(); }}>
        <textarea rows={2} value={text} placeholder="Add an update — what happened, what's next, who you're waiting on"
                  onChange={e => setText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }} />
        <button className="small" disabled={!text.trim() || busy}>{busy ? '…' : 'Post update'}</button>
      </form>
    </div>
  );
}

/**
 * Log a claim from the work list (§77). A claim stands on its own — a late
 * checkout, a noise complaint — and gets work linked to it only if there is
 * work to do. The essentials here; the rest (refund, source) on the Claims
 * screen.
 */
function QuickClaim({ units, today, onSaved, onCancel }: {
  units: Unit[]; today: DateStr; onSaved: () => void; onCancel: () => void;
}) {
  const [what, setWhat] = useState('');
  const [unitId, setUnitId] = useState('');
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('Medium');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!what.trim() || busy) return;
    setBusy(true); setErr('');
    const r = await saveClaim({ unitId: unitId || null, occurredOn: today, category: category || null, severity,
                                status: 'Open', description: what.trim(), refund: 0, repairCost: 0 })
      .catch(e => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (r.ok) onSaved(); else setErr(r.error ?? 'Not saved.');
  };

  return (
    <form className="todo-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="todo-first">
        <b className="todo-adding">⚑ New claim</b>
        <input className="todo-text" autoFocus value={what} maxLength={500} placeholder="What happened? e.g. guest asked for a 2pm late checkout"
               onChange={e => setWhat(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') onCancel(); }} />
      </div>
      <div className="todo-meta">
        <select value={unitId} onChange={e => setUnitId(e.target.value)} aria-label="Unit">
          <option value="">Unit (optional)</option>
          {units.filter(u => u.active).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Kind of claim">
          <option value="">Kind of claim</option>
          {CLAIM_CATEGORIES.map(c => <option key={c}>{c}</option>)}
        </select>
        <select value={severity} onChange={e => setSeverity(e.target.value)} aria-label="Severity">
          {CLAIM_SEVERITY.map(s => <option key={s}>{s}</option>)}
        </select>
        <span className="rb-spacer" />
        <button type="button" className="link tiny" onClick={onCancel}>Cancel</button>
        <button className="small" disabled={!what.trim() || busy}>{busy ? '…' : 'Log claim'}</button>
      </div>
      {err && <p className="banner warn">▲ {err}</p>}
    </form>
  );
}

/**
 * A claim, opened in place (§77) — on the Claims screen and in the work
 * list alike: the work that resolves it (to-dos and work orders), what that
 * work has cost, and the case's timeline.
 *
 * The claim is the CASE; the work is how it gets resolved. Its repair cost
 * stays a figure a person sets (a refund negotiated with Airbnb is not a
 * sum of invoices), but the work's total sits beside it, one click from
 * being used.
 */
export function ClaimCase({ claim, canWork, today, onSaved }: {
  claim: Claim; canWork: boolean; today?: DateStr; onSaved?: () => void;
}) {
  const [work, setWork] = useState<Todo[]>([]);
  const [msg, setMsg] = useState('');
  const cost = workCost(work);
  const total = cost.actual + cost.estimated;
  const recorded = Number(claim.repair_cost) || 0;
  const day = today ?? new Date().toISOString().slice(0, 10);

  // The claims route saves the whole case, so every field goes back as it is.
  const applyCost = async () => {
    const r = await saveClaim({
      id: claim.id, unitId: claim.unit_id, occurredOn: claim.occurred_on.slice(0, 10), category: claim.category,
      severity: claim.severity, status: claim.status, source: claim.source, description: claim.description,
      refund: Number(claim.refund) || 0, repairCost: Math.round(total * 100) / 100
    }).catch(e => ({ ok: false, error: String(e) }));
    setMsg(r.ok ? `Repair cost set to ${money2(total)}.` : r.error ?? 'Not saved.');
    if (r.ok) onSaved?.();
  };

  return (
    <div className="claim-case">
      {canWork && (
        <div className="claim-case-work">
          <div className="claim-case-head">
            <b>Work on this claim</b>
            {work.length > 0 && (
              <span className="note">
                {cost.open} open · work cost {money2(cost.actual)}{cost.estimated ? ` + ~${money2(cost.estimated)} estimated` : ''}
                {' '}· repair cost on the claim {money2(recorded)}
                {total > 0 && Math.abs(total - recorded) > 0.005 && (
                  <> · <button className="link tiny" onClick={() => void applyCost()}>use {money2(total)}</button></>
                )}
              </span>
            )}
            {msg && <span className="note">{msg}</span>}
          </div>
          <TodoList today={day} claim={{ id: String(claim.id), unitId: claim.unit_id }} onChange={setWork} />
        </div>
      )}
      <Timeline load={() => getClaimUpdates(String(claim.id))}
                post={async body => (await postClaimNote(String(claim.id), body).catch(() => ({ ok: false }))).ok}
                version={work.length} />
    </div>
  );
}
