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
import { Modal } from './Modal.tsx';
import { TaskPurchase } from '../screens/Inventory.tsx';
import { vendorLink, getVendors, getInventory, getTodoFiles, uploadTodoFiles, removeTodoFile, type TodoFile } from '../api.ts';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  deleteClaim, getClaims, getClaimUpdates, getDoneLog, getStaysOnDay, getTaskUpdates, getTodos, getUnits, postClaimNote, restoreClaim, saveClaim, todoAction,
  type Claim, type StayOnDay, type Todo, type WorkUpdate, syncHostawayTasks, getPeople, type Person } from '../api.ts';
import {
  KIND_LABEL, PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, STATUSES, CATEGORY_LABEL, categoryOf, sourceOf, rowTitle, stageOf, claimStage, auditCsv, childrenBy, daysTaken, nyParts, outcomeOf, stayLabel,
  type AuditRow, dueLabel, dueOf, isClosed, isFiltering, matchesFilter,
  progress, shortDay, sortTodos, workCost,
  type Priority, type TaskKind, type TaskStatus, type WorkFilter
} from '../lib/todos.ts';
import { addDays, type DateStr } from '../lib/dates.ts';
import { money2 } from '../lib/format.ts';
import { CASE_CATEGORIES, CLAIM_SEVERITY, CLAIM_SOURCES, CLAIM_STATUS, UPSELL_CATEGORIES, caseHost, cleanCaseUrl } from '../lib/claims.ts';
import { Hint, Peek } from './Hint.tsx';
import { SlideOver, NoDock, useDock } from './SlideOver.tsx';
import { createPortal } from 'react-dom';
import { Popover } from './Popover.tsx';
import { Icon, ic } from './Icon.tsx';

/** The claim's case on the platform, one tap away (§88). */
const CaseLink = ({ url }: { url: string | null }) => url
  ? <a className="case-link" href={url} target="_blank" rel="noreferrer" title={url}>↗ {caseHost(url)} case</a> : null;

/** owner, Oct 2026: a pasted link (a Slack thread) is a 🔗, not 80 characters of URL. */
export const Linked = ({ text }: { text: string }) => <>{text.split(/(https?:\/\/\S+)/).map((p, i) => i % 2
  ? <a key={i} className="desc-link" href={p} target="_blank" rel="noreferrer" title={p} onClick={e => e.stopPropagation()}
       aria-label={`Open the link (${p.includes('slack.com') ? 'Slack' : p.replace(/^https?:\/\/([^/]+).*/, '$1')})`}><Icon n="link" /></a>
  : p)}</>;

/** §162: a file posted with a comment — "📷 name: <Drive url>" (a photo, shown in the comment) or "📎 name: <url>". */
const FILE_LINE = /^(📷|📎) (.+?): (https:\/\/drive\.google\.com\/file\/d\/([\w-]+)\S*)$/;
const NoteBody = ({ text }: { text: string }) => {
  const lines = text.split('\n');
  const files = lines.filter(l => FILE_LINE.test(l));
  if (!files.length) return <Linked text={text} />;
  return <>
    <Linked text={lines.filter(l => !FILE_LINE.test(l)).join('\n')} />
    <span className="note-files">{files.map((l, i) => {
      const [, kind, name, url, id] = FILE_LINE.exec(l)!;
      return kind === '📷'
        ? <a key={i} className="note-photo" href={url} target="_blank" rel="noreferrer" title={`${name} — open in Drive`} onClick={e => e.stopPropagation()}>
            <img src={`/api/comment-image?id=${id}`} alt={name} loading="lazy" /></a>
        : <a key={i} className="desc-link" href={url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}><Icon n="clip" /> {name}</a>;
    })}</span>
  </>;
};

/** A comment from Slack ends "— From Slack: <url>": shown as a short "↗ Slack" link, not the URL (owner, 2026-10-14: noise). */
const NoteText = ({ text }: { text: string }) => {
  const m = /\n?— From Slack: (https?:\/\/\S+)\s*$/.exec(text);
  return m ? <><NoteBody text={text.slice(0, m.index)} />{' '}
    <a className="desc-link" href={m[1]} target="_blank" rel="noreferrer" title={m[1]} onClick={e => e.stopPropagation()}>↗ Slack</a></>
    : <NoteBody text={text} />;
};

/** §162: a case's kinds, claims and upsells apart. */
export const CategoryOptions = () => <>
  <optgroup label="Claim">{CASE_CATEGORIES.map(c => <option key={c}>{c}</option>)}</optgroup>
  <optgroup label="Upselling">{UPSELL_CATEGORIES.map(c => <option key={c}>{c}</option>)}</optgroup>
</>;

type Unit = { id: string; name: string; active: boolean };
type Act = (b: Record<string, unknown>) => Promise<boolean>;

/** What a claim is called: its unit and what happened — the words someone wrote, not the word "claim". */
const claimWhat = (c: Pick<Claim, 'category' | 'description'>) => {
  const d = (c.description ?? '').trim();
  return d ? (d.length > 48 ? `${d.slice(0, 46)}…` : d) : c.category ?? 'Claim';
};
const claimLabel = (c: Pick<Claim, 'unit_name' | 'category' | 'description'>) => `${c.unit_name ?? 'Portfolio'} · ${claimWhat(c)}`;

const claimOpen = (c: Claim) => c.status === 'Open' || c.status === 'In progress';
/** Weighted as on the Claims screen: a lockout outranks five slow-wifi complaints. */
const WEIGHT: Record<string, number> = { Low: 1, Medium: 2, High: 4, Critical: 8 };
const ageDays = (c: Claim, today: DateStr) =>
  Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(c.occurred_on.slice(0, 10) + 'T12:00:00Z')) / 864e5));

/** What Home's folded card says (§81). */
export interface WorkSum { open: number; overdue: number; today: number; urgent: number; cases: number }

/** Home's own tabs beside the work (owner, Oct 2026): approvals waiting, built by Home. */
export interface WorkTab { key: string; label: string; count: number; alert?: boolean; body: ReactNode }

/** owner, Oct 2026: Home's buckets — what needs someone now, this week, later. Three chunks, the first one open. */
type Bucket = 'now' | 'week' | 'later' | 'scheduled';
const BUCKETS: [Bucket, string, string][] = [
  ['now', 'Now', 'overdue, due today or urgent'], ['week', 'This week', 'due in 7 days or high priority'], ['later', 'Later', 'no rush, or no date'],
  // §159: not "Scheduled" — that is a stage now; this group is only further out in time.
  ['scheduled', 'Further out', 'dated more than a week out']];
/** Owner, Oct 2026: work with a date far ahead (the landscaping) is planned, not pending — its own folded bucket, so it is not noise. */
const farOff = (t: Todo, today: DateStr) => dueOf(t, today) === 'later' || (!t.dueOn && !!t.scheduledOn && t.scheduledOn > addDays(today, 7));
const bucketOf = (t: Todo, today: DateStr): Bucket => {
  const d = dueOf(t, today);
  return d === 'overdue' || d === 'today' || t.priority === 'urgent' ? 'now' : farOff(t, today) ? 'scheduled'
    : d === 'soon' || t.priority === 'high' ? 'week' : 'later';
};

export function TodoList({ today, compact = false, head, lead, canClaims = false, claim, onChange, onSummary, extraTabs = [], orderIds, unit, focus, doneLog = false }: {
  today: DateStr;
  /** §163: Operations → To-do — the closed section also opens the full done log (audit, CSV). */
  doneLog?: boolean;
  /** §162: open this one as soon as it is loaded (a link from Slack). */
  focus?: { todo?: string; claim?: string };
  /** Opened from a unit (the board's "2 to-dos", §159): that listing's work, filter on. */
  unit?: string;
  /** Home: open work only, in a scrolling feed. `head` puts the card's title, count, "?" and + Add above the pills. */
  compact?: boolean; head?: { title: string; hint: string; onAll?: () => void };
  /** The full list's filter row starts with this. */
  lead?: ReactNode;
  /** Whether this person may see claims (to link work to one). */
  canClaims?: boolean;
  /** Inside a claim: only its work, and new work belongs to it (and to its stay, §84). */
  claim?: { id: string; unitId: string | null; reservationId?: string | null; reservationLabel?: string | null };
  /** The list as it now is — the claim uses it for what its work costs. */
  onChange?: (list: Todo[]) => void;
  /** Home: the counts its card shows, folded or not. */
  onSummary?: (s: WorkSum) => void;
  /** Home (owner, Oct 2026): tabs it adds after Claims, and the to-dos that are purchase orders (their own tab). */
  extraTabs?: WorkTab[]; orderIds?: Set<string>;
}) {
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [unitFilter, setUnitFilter] = useState(unit ?? '');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [kindFilter, setKindFilter] = useState<'' | TaskKind | 'claims'>('');
  const [prioFilter, setPrioFilter] = useState<'' | 'high' | 'urgent'>('');
  const [dueFilter, setDueFilter] = useState<'' | 'overdue' | 'today' | 'week' | 'none'>('');
  const [showDone, setShowDone] = useState(!!claim);
  const [closedLog, setClosedLog] = useState(false);
  const [openClaim, setOpenClaim] = useState<string | null>(null);
  const [adding, setAdding] = useState<'order' | null | TaskKind | 'claim'>(null);
  // owner, Oct 2026: Home shows one kind at a time, and inside it the buckets folded but the first.
  const [tab, setTab] = useState('task');
  const [bucketOpen, setBucketOpen] = useState<Record<string, boolean>>({});
  // Open claims sit in the list as cases (§77), above the work — not inside a claim.
  const showClaims = canClaims && !claim;

  const take = (list: Todo[]) => { setTodos(list); onChange?.(list); };
  const loadClaims = () => getClaims().then(r => setClaims(r.claims ?? [])).catch(() => {});
  const loadTodos = () => getTodos(claim?.id).then(r => r.ok ? take(r.todos) : setErr(r.message ?? 'Could not read the list.'))
    .catch(e => setErr(String(e)));
  // §93: then whatever the team changed in Hostaway — in the background, so the list never waits on it.
  useEffect(() => {
    if (claim) return;
    void syncHostawayTasks().then(r => {
      if (r.ok && (r.sync.changed || r.sync.imported || r.sync.unlinked)) take(r.todos);
    }).catch(() => { /* the list stands without it */ });
  }, []);
  useEffect(() => {
    void loadTodos();
    // Every unit, for the names work already carries; the pickers offer the active ones.
    getUnits().then(r => setUnits((r.units ?? []).map(u => ({ id: u.id, name: u.name, active: u.active }))
      .sort((a, b) => a.name.localeCompare(b.name)))).catch(() => {});
    if (showClaims) void loadClaims();
  }, [claim?.id]);

  const names = useMemo(() => new Map(units.map(u => [u.id, u.name])), [units]);
  const claimNames = useMemo(() => new Map(claims.map(c => [String(c.id), claimLabel(c)])), [claims]);
  // The last removal, for Undo (§82): what went, and how many sub-tasks with it.
  const [removed, setRemoved] = useState<{ id: string; title: string; kids: number } | null>(null);
  const [removedClaim, setRemovedClaim] = useState<Claim | null>(null);
  const act: Act = async body => {
    const gone = body.action === 'delete' ? (todos ?? []).find(t => t.id === body.id) : undefined;
    const r = await todoAction({ ...body, ...(claim ? { claimScope: claim.id } : {}) })
      .catch(e => ({ ok: false as const, message: String(e) }));
    if (r.ok) {
      take(r.todos); setErr('');
      if (gone) setRemoved({ id: gone.id, title: gone.title,
                             kids: (todos ?? []).filter(t => t.parentId === gone.id && !isClosed(t.status)).length });
      if (body.action === 'restore') setRemoved(null);
      return true;
    }
    setErr(r.message ?? 'Not saved.'); return false;
  };

  const wf: WorkFilter = { kind: kindFilter === 'claims' ? '' : kindFilter, priority: prioFilter, due: dueFilter, unitId: unitFilter, assignee: ownerFilter };
  const filtering = isFiltering(wf);
  const nFilters = [prioFilter, dueFilter, unitFilter, ownerFilter].filter(Boolean).length;
  const all = sortTodos(todos ?? []);
  const kids = useMemo(() => childrenBy(todos ?? []), [todos]);
  const byId = useMemo(() => new Map((todos ?? []).map(t => [t.id, t])), [todos]);
  // §159: a child of another kind (a work order inside a to-do, an order inside a repair) is also listed in
  // its own section, saying what it is part of; one of the same kind lives only inside its parent.
  const catOf = (t: Todo) => categoryOf(t, !!orderIds?.has(t.id));
  // Owner, same day: sub-tasks are born inside their parent and stay there; only a work order or an order inside
  // something of another kind is also listed in its own section.
  const crossCat = (t: Todo) => { const p = t.parentId ? byId.get(t.parentId) : undefined; return !!p && catOf(t) !== 'task' && catOf(p) !== catOf(t); };
  const [pop, setPop] = useState<{ todo?: string; claim?: string } | null>(null);
  // §162: a link from Slack opens the item where it lives — its tab, its side panel (a claim: opened in its tab).
  // A closed one is not in an open list: it opens in the pop-up instead.
  useEffect(() => {
    if (focus?.claim && claims.some(c => String(c.id) === focus.claim)) { setTab('claims'); setOpenClaim(focus.claim); return; }
    const t = focus?.todo ? todos?.find(x => x.id === focus.todo) : undefined;
    if (!t) return;
    if (isClosed(t.status)) { setPop({ todo: t.id }); return; }
    const p = t.parentId ? todos?.find(x => x.id === t.parentId) : undefined;
    const top = p && categoryOf(p, !!allOrders?.has(p.id)) === categoryOf(t, !!allOrders?.has(t.id)) ? p : t;
    const c = categoryOf(top, !!allOrders?.has(top.id));
    setTab(c === 'order' ? 'orders' : c); setOpen(top.id);
  }, [focus, todos === null, claims.length]);
  // §159: orders made from here this session (the order list is read by the screen above, once).
  const [madeOrders, setMadeOrders] = useState<Set<string>>(new Set());
  const allOrders = useMemo(() => orderIds ? new Set([...orderIds, ...madeOrders]) : undefined, [orderIds, madeOrders]);
  const newOrder = async (text: string, unitId: string) => {
    const said = text.trim();
    const title = `Purchase order: ${said.split(/[\n.,;]/)[0]!.trim().slice(0, 60)}`;
    // §162: inside a claim, the order is the claim's work (its purchases are the claim's repair work).
    const r = await todoAction({ action: 'create', asOrder: true, title, description: said, kind: 'task', unitIds: unitId ? [unitId] : [],
                                 ...(claim ? { claimId: claim.id, claimScope: claim.id, reservationId: claim.reservationId ?? null,
                                               reservationLabel: claim.reservationLabel ?? null } : {}) })
      .catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setErr(r.message ?? 'Not saved.'); return false; }
    take(r.todos);
    const id = r.todos.filter(t => t.title === title).map(t => t.id).sort((a, b) => Number(b) - Number(a))[0];
    if (id) { setMadeOrders(m => new Set(m).add(id)); setTab('orders'); setPop({ todo: id }); }
    return true;
  };
  // No filter: tasks at the top, their sub-tasks inside them. A filter:
  // every match, flat, each sub-task saying whose it is (§78).
  const top = kindFilter === 'claims' ? []
    : filtering ? all.filter(t => matchesFilter(t, wf, today))
    : all.filter(t => !t.parentId || !byId.has(t.parentId) || crossCat(t));
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
  const ctx = { today, names, units, claims, claimNames, act, inClaim: !!claim, kids, byId, flat: filtering,
                canClaims: showClaims, onClaimsChanged: () => void loadClaims(), reload: () => void loadTodos(), compact,
                orderIds: allOrders, openPop: setPop,
                // §159: a listing or an owner on a row is a link that filters the list by it.
                filterBy: (x: { unit?: string; owner?: string }) => { if (x.unit) setUnitFilter(x.unit); if (x.owner) setOwnerFilter(x.owner); } };

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
    <li key={`case-${c.id}`} className={`todo case cat-claim sev-${c.severity.toLowerCase()}`}>
      <div className="todo-line">
        <button className="todo-title" onClick={() => setOpenClaim(openClaim === String(c.id) ? null : String(c.id))}
                aria-expanded={openClaim === String(c.id)} title="Open the claim">
          <span className="todo-caret" aria-hidden="true">{openClaim === String(c.id) ? '▾' : '▸'}</span>{c.unit_name ?? 'Portfolio'} · {claimWhat(c)}</button>
        <CaseLink url={c.case_url} />
      </div>
      {/* §159: the same quiet line as a to-do — stage, what matters, how long, what is inside. */}
      <div className="todo-meta">
        <span className={`m m-stage st-${claimStage(c.status).key}`}>{claimStage(c.status).label}</span>
        {['High', 'Critical'].includes(c.severity) && <span className="m m-attn">{c.severity}</span>}
        {c.category && c.description && <span className="m">{c.category}</span>}
        <span className="m"><Icon n="clock" />{ageDays(c, today) ? `${ageDays(c, today)}d open` : 'new today'}</span>
        {openWorkBy.get(String(c.id)) ? <span className="m"><Icon n="list" />{openWorkBy.get(String(c.id))} open inside</span>
          : <span className="m m-attn">No work yet</span>}
      </div>
      {openClaim === String(c.id) && (
        <ClaimCase claim={c} canWork today={today} onSaved={() => { void loadClaims(); void loadTodos(); }}
                   onRemoved={x => { setRemovedClaim(x); setOpenClaim(null); }} />
      )}
    </li>
  );

  // Lanes (§85): one per kind of work — to-dos first, then repairs, then
  // claims — each with its count, what needs attention, and its own "+".
  // Everything is in exactly one lane, by what it is; links show as chips
  // (⚑ its claim, 🛏 its stay). A kind filter, or a claim's own list,
  // stays a single list.
  const openTotal = (todos ?? []).filter(t => !isClosed(t.status) && !t.parentId).length + (showClaims ? claims.filter(claimOpen).length : 0);
  const lanesOn = !claim && kindFilter === '';
  const taskItems = openList.filter(t => t.kind === 'task');
  const repairItems = openList.filter(t => t.kind === 'work_order');
  const late = (list: Todo[]) => list.filter(t => dueOf(t, today) === 'overdue').length;
  const dueToday = (list: Todo[]) => list.filter(t => dueOf(t, today) === 'today').length;
  const noWork = cases.filter(c => !openWorkBy.get(String(c.id))).length;
  const serious = cases.filter(c => ['High', 'Critical'].includes(c.severity)).length;
  const workAlert = (list: Todo[]) => late(list) ? <span className="breach">▲ {late(list)} overdue</span>
    : dueToday(list) ? <span className="home-today">● {dueToday(list)} today</span> : null;

  const addForm = (kind: TaskKind | 'claim' | 'order') => adding !== kind ? null : kind === 'order' ? (
    <NewOrderForm units={units} onCancel={() => setAdding(null)} onSave={async (text, unitId) => { const ok = await newOrder(text, unitId); if (ok) setAdding(null); return ok; }} />
  ) : kind === 'claim' ? (
    <QuickClaim units={units} today={today} onCancel={() => setAdding(null)}
                onSaved={() => { setAdding(null); void loadClaims(); }} />
  ) : (
    <TodoForm key={kind} units={units} claims={claims} canClaims={canClaims} submitLabel="Add" startKind={kind}
              onCancel={() => setAdding(null)}
              onSubmit={async v => { const ok = await act({ action: 'create', ...v }); if (ok) setAdding(null); return ok; }} />
  );
  const taskRow = (t: Todo) => <TodoRow key={t.id} t={t} related={crossCat(t)} open={open === t.id} onOpen={() => setOpen(open === t.id ? null : t.id)} {...ctx} />;

  const lane = (key: 'task' | 'work_order' | 'claims', title: string, rows: ReactNode[], alert: ReactNode, empty: string) => {
    const kind = key === 'claims' ? 'claim' : key;
  return (
      <section key={key} className={`todo-lane lane-${key} ${rows.length ? '' : 'is-empty'}`}>
        <div className="lane-head">
          <h4>{title}</h4>
          <span className="count">{rows.length}</span>
          {alert && <span className="lane-alert">{alert}</span>}
          <span className="rb-spacer" />
          {adding !== kind && <button className="link tiny lane-add" onClick={() => setAdding(kind)}>+ Add</button>}
        </div>
        {addForm(kind)}
        {rows.length > 0 && <ul className="todo-list">{rows}</ul>}
        {!rows.length && !compact && adding !== kind && <p className="note lane-empty">{empty}</p>}
      </section>
    );
  };

  const isOrder = (t: Todo) => !!allOrders?.has(t.id) || !!t.order;
  // Purchase orders and work orders (owner, Oct 2026): their comments unfold on the row.
  const chatRow = (t: Todo) => <TodoRow key={t.id} t={t} chat related={crossCat(t)} open={open === t.id} onOpen={() => setOpen(open === t.id ? null : t.id)} {...ctx} />;
  const bucketed = (key: string, list: Todo[], chat = false) => {
    const by: Record<Bucket, Todo[]> = { now: [], week: [], later: [], scheduled: [] };
    for (const t of list) by[bucketOf(t, today)].push(t);
    const first = BUCKETS.find(([b]) => by[b].length)?.[0];
    return BUCKETS.filter(([b]) => by[b].length).map(([b, label, hint]) => {
      const k = `${key}:${b}`, on = bucketOpen[k] ?? b === first;
      return (
        <section key={b} className={`todo-bucket bucket-${b}`}>
          <button type="button" className="bucket-head" aria-expanded={on} onClick={() => setBucketOpen(m => ({ ...m, [k]: !on }))}>
            <span aria-hidden="true">{on ? '▾' : '▸'}</span> <b>{label}</b> <span className="count">{by[b].length}</span>
            <span className="bucket-hint">{hint}</span>
          </button>
          {on && <ul className="todo-list">{by[b].map(t => chat ? chatRow(t) : taskRow(t))}</ul>}
        </section>
      );
    });
  };
  // Owner, Oct 2026: Operations → To-do looks the same as Home — tabs and buckets. Home's feed scrolls inside its card instead of folding.
  const homeTabs: (WorkTab & { add?: TaskKind | 'claim' | 'order' })[] = lanesOn ? [
    { key: 'task', label: 'Tasks', count: taskItems.filter(t => !isOrder(t)).length, alert: late(taskItems) > 0, add: 'task',
      body: taskItems.some(t => !isOrder(t)) ? bucketed('task', taskItems.filter(t => !isOrder(t))) : <p className="note">Nothing to do. ✓</p> },
    { key: 'work_order', label: '🔧 Repairs', count: repairItems.length, alert: late(repairItems) > 0, add: 'work_order',
      body: repairItems.length ? bucketed('work_order', repairItems, true) : <p className="note">No repairs open. ✓</p> },
    ...(showClaims ? [{ key: 'claims', label: '⚑ Claims & upselling', count: cases.length, alert: noWork > 0, add: 'claim' as const,
      body: cases.length ? <>
        {noWork > 0 && <p className="note"><span className="breach">▲ {noWork} with no work yet</span></p>}
        <ul className="todo-list cases">{cases.map(caseRow)}</ul>
      </> : <p className="note">No open claims. ✓</p> }] : []),
    ...extraTabs,
    ...(orderIds ? [{ key: 'orders', label: '🛒 Purchase orders', count: openList.filter(isOrder).length, add: 'order' as const,
      body: openList.some(isOrder) ? <ul className="todo-list">{openList.filter(isOrder).map(chatRow)}</ul>
        : <p className="note">No purchase order open. ✓</p> }] : [])
  ] : [];
  const cur = homeTabs.find(x => x.key === tab) ?? homeTabs[0];
  const filtersPop = (
    <Popover label="Filters" align="right" className="filters-pop"
             button={<><Icon n="filter" /> Filters{nFilters > 0 && <span className="count">{nFilters}</span>}</>}>
      <div className="filter-fields">
        <label>Urgency
          <select value={prioFilter} onChange={e => setPrioFilter(e.target.value as '' | 'high' | 'urgent')}>
            <option value="">Any urgency</option>
            <option value="high">▲ High or urgent</option>
            <option value="urgent">▲▲ Urgent only</option>
          </select></label>
        <label>Deadline
          <select value={dueFilter} onChange={e => setDueFilter(e.target.value as typeof dueFilter)}>
            <option value="">Any date</option>
            <option value="overdue">▲ Overdue</option>
            <option value="today">● Due today</option>
            <option value="week">This week</option>
            <option value="none">No deadline</option>
          </select></label>
        <label>Listing
          <select value={unitFilter} onChange={e => setUnitFilter(e.target.value)}>
            <option value="">Every listing</option>
            {units.filter(u => u.active).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></label>
        <label>Owner
          <select value={ownerFilter} onChange={e => setOwnerFilter(e.target.value)}>
            <option value="">Anyone</option>
            {[...new Set((todos ?? []).map(t => t.assignee).filter((x): x is string => !!x))].sort().map(n => <option key={n} value={n}>{n}</option>)}
          </select></label>
        {(filtering || kindFilter !== '') && (
          <button className="link tiny" onClick={() => { setKindFilter(''); setPrioFilter(''); setDueFilter(''); setUnitFilter(''); setOwnerFilter(''); }}>Clear filters</button>
        )}
      </div>
    </Popover>
  );

  return (
    <div className={`todos ${compact ? 'compact' : ''}`}>
      {head && (
        <div className="home-card-head todos-head">
          <h3><span className="todos-title">{head.title}</span>{todos !== null && <span className="count">{openTotal}</span>}<Hint>{head.hint}</Hint></h3>
          {head.onAll && <button className="link tiny todos-all" onClick={head.onAll} title="Open the full list in Operations → To-dos">All ↗</button>}
          {cur?.add && <button className="link lane-add" onClick={() => { setAdding(cur.add!); }}>+ Add</button>}
        </div>
      )}
      {/* Outside the lanes (a claim's own list, a kind filter): one row of adds. */}
      {!lanesOn && (!adding ? (
        <div className="todo-add-buttons">
          {kindFilter !== 'work_order' && kindFilter !== 'claims' && <button className="small secondary" onClick={() => setAdding('task')}>+ To-do</button>}
          {kindFilter !== 'task' && kindFilter !== 'claims' && <button className="small secondary" onClick={() => setAdding('work_order')}>+ <Icon n="wrench" /> Repair</button>}
          {claim && <button className="small secondary" onClick={() => setAdding('order')}>+ <Icon n="cart" /> Purchase order</button>}
          {showClaims && kindFilter === 'claims' && <button className="small secondary" onClick={() => setAdding('claim')}>+ ⚑ Claim</button>}
        </div>
      ) : adding === 'claim' ? (
        <QuickClaim units={units} today={today} onCancel={() => setAdding(null)}
                    onSaved={() => { setAdding(null); void loadClaims(); }} />
      ) : adding === 'order' ? (claim ? (
        <NewOrderForm units={units} unitId={claim.unitId ?? ''} onCancel={() => setAdding(null)}
                      onSave={async (text, unitId) => { const ok = await newOrder(text, unitId); if (ok) setAdding(null); return ok; }} />
      ) : null) : (
        <TodoForm key={adding} units={units} claims={claims} canClaims={canClaims && !claim} submitLabel="Add"
                  startKind={adding} onCancel={() => setAdding(null)}
                  fixed={claim ? { claimId: claim.id, unitIds: claim.unitId ? [claim.unitId] : [],
                                   reservationId: claim.reservationId ?? null, reservationLabel: claim.reservationLabel ?? null } : undefined}
                  onSubmit={async v => { const ok = await act({ action: 'create', ...v }); if (ok) setAdding(null); return ok; }} />
      ))}
      {/* §160: one quiet row — the mode on the left, every secondary filter behind one button. §163: with nothing
          to lead it, the button joins the tabs' line instead of taking a row of its own. */}
      {!compact && !claim && (lead || !cur) && (
        <div className="row-controls work-bar">
          {lead}
          <span className="rb-spacer" />
          {filtersPop}
        </div>
      )}
      {/* §159: what a tap on a listing or an owner filtered by — visible everywhere (Home has no filter bar), with its way out. */}
      {(unitFilter || ownerFilter) && (
        <div className="filter-chips">
          {unitFilter && <button className="fchip on" onClick={() => setUnitFilter('')}>{names.get(unitFilter) ?? 'Listing'} <span aria-hidden="true">✕</span><span className="sr-only"> — clear</span></button>}
          {ownerFilter && <button className="fchip on" onClick={() => setOwnerFilter('')}>{ownerFilter} <span aria-hidden="true">✕</span><span className="sr-only"> — clear</span></button>}
        </div>
      )}
      {err && <p className="banner warn">▲ {err}</p>}
      {removed && (
        <p className="banner ok todo-undo">
          Removed “{removed.title}”{removed.kids ? ` and its ${removed.kids} sub-task${removed.kids === 1 ? '' : 's'}` : ''}.
          <button className="link" onClick={() => void act({ action: 'restore', id: removed.id })}>Undo</button>
          <button className="link tiny" aria-label="Dismiss" onClick={() => setRemoved(null)}>✕</button>
        </p>
      )}
      {removedClaim && (
        <p className="banner ok todo-undo">
          Removed the claim “{claimLabel(removedClaim)}”.
          <button className="link" onClick={() => void restoreClaim(String(removedClaim.id)).then(() => { setRemovedClaim(null); void loadClaims(); })}>Undo</button>
          <button className="link tiny" aria-label="Dismiss" onClick={() => setRemovedClaim(null)}>✕</button>
        </p>
      )}
      {todos === null ? <p className="note loading-dot">Reading</p>
        : cur ? (
          <div className="work-tabs-wrap">
            <div className="work-tabs" role="tablist">
              {homeTabs.map(x => (
                <button key={x.key} type="button" role="tab" aria-selected={x === cur}
                        className={`work-tab ${x === cur ? 'active' : ''} ${x.count ? '' : 'is-zero'}`}
                        onClick={() => { setTab(x.key); setAdding(null); }}>
                  {x.label} <span className="count">{x.count}</span>
                  {x.alert && <span className="work-tab-alert" title="Needs attention">▲</span>}
                </button>
              ))}
              {!head && <span className="rb-spacer" />}
              {!head && cur.add && adding !== cur.add && <button className="link tiny lane-add" onClick={() => setAdding(cur.add!)}>+ Add</button>}
              {!compact && !claim && !lead && filtersPop}
            </div>
            {cur.add && addForm(cur.add)}
            <div role="tabpanel" className="work-tab-body">{cur.body}</div>
          </div>
        )
        : lanesOn ? (
          <div className="todo-lanes">
            {lane('task', 'To-dos', taskItems.map(taskRow), workAlert(taskItems), filtering ? 'None match.' : 'Nothing to do. ✓')}
            {lane('work_order', '🔧 Repairs', repairItems.map(taskRow), workAlert(repairItems), filtering ? 'None match.' : 'No repairs open. ✓')}
            {showClaims && lane('claims', '⚑ Claims & upselling', cases.map(caseRow),
              noWork ? <span className="breach">▲ {noWork} with no work yet</span>
                : serious ? <span className="breach">{serious} high or critical</span> : null,
              'No open claims. ✓')}
          </div>
        )
        : kindFilter === 'claims' ? (cases.length ? <ul className="todo-list cases">{cases.map(caseRow)}</ul> : <p className="note">No open claims. ✓</p>)
        : !openList.length ? <p className="note">{claim ? 'No open work on this claim.' : filtering ? 'Nothing matches these filters.' : 'Nothing open. ✓'}</p>
        : <ul className="todo-list">{openList.map(taskRow)}</ul>}
      {/* §163 (owner): the done log is for auditing, not daily work — it lives here, folded, with its own filters,
          instead of a switch on top of the open work. */}
      {!compact && (doneList.length > 0 || doneLog) && (
        <>
          <div className="closed-head">
            <button className="link tiny" onClick={() => setShowDone(!showDone)}>
              {showDone ? '▾' : '▸'} {claim ? 'Closed' : 'Closed in the last 14 days'} ({doneList.length})</button>
            {doneLog && showDone && (
              <span className="closed-modes">
                <button className={closedLog ? 'chip' : 'chip active'} onClick={() => setClosedLog(false)}>Last 14 days</button>
                <button className={closedLog ? 'chip active' : 'chip'} onClick={() => setClosedLog(true)}><Icon n="done" /> Done log</button>
              </span>
            )}
          </div>
          {showDone && (doneLog && closedLog ? <DoneLog today={today} canClaims={canClaims} />
            : doneList.length ? <ul className="todo-list done">{doneList.map(taskRow)}</ul> : <p className="note">Nothing closed in the last 14 days.</p>)}
        </>
      )}
      {/* §159: a related item opens over the list, whole — the same card as in its own section. */}
      {pop?.todo && byId.get(pop.todo) && (() => { const x = byId.get(pop.todo!)!; return (
        <Modal wide title={`${CATEGORY_LABEL[catOf(x)]} · ${x.title}`} onClose={() => setPop(null)}>
          <ul className="todo-list"><TodoRow {...ctx} flat={false} t={x} chat={false} open onOpen={() => setPop(null)} /></ul>
        </Modal>
      ); })()}
      {pop?.claim && (() => { const c = claims.find(x => String(x.id) === pop.claim); return c ? (
        <Modal wide title={`Claim · ${claimLabel(c)}`} onClose={() => setPop(null)}>
          <ClaimCase claim={c} canWork today={today} onSaved={() => { void loadClaims(); void loadTodos(); }}
                     onRemoved={x => { setRemovedClaim(x); setPop(null); }} />
        </Modal>
      ) : null; })()}
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
  /** Read the list again (§150: a purchase made from a to-do adds its sub-tasks). */
  reload: () => void;
  /** Home: sub-tasks are summed up (☑ 1/3), not listed. */
  compact?: boolean;
  /** §159: which to-dos carry a purchase order, and the pop-up a related item opens in. */
  orderIds?: Set<string>;
  openPop?: (x: { todo?: string; claim?: string }) => void;
  filterBy?: (x: { unit?: string; owner?: string }) => void;
  /** Shown in its own section although it is inside another: it says what it is part of. */
  related?: boolean;
  /** Inside an open panel: a sub-task opens in place there, not in a second panel (§160). */
  inPanel?: boolean;
};

function TodoRow(props: RowCtx & { t: Todo; open: boolean; onOpen: () => void; chat?: boolean }) {
  // Owner, Oct 2026: a purchase order's comments unfold on its row — what changed, what was out of stock —
  // without opening the whole to-do.
  const [talk, setTalk] = useState(false);
  const { t, today, names, units, claims, claimNames, open, onOpen, act, inClaim, kids, byId, flat, canClaims, onClaimsChanged, reload, compact } = props;
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [addingSub, setAddingSub] = useState<null | TaskKind>(null);
  // §150: the to-do's own purchase — its order, or what was bought (stock + Costs), then closed.
  // §159: a purchase order opens on its form — that is what there is to do with it.
  const [buying, setBuying] = useState(() => (!!props.orderIds?.has(t.id) || !!t.order) && !isClosed(t.status));
  // §104: sub-tasks open while some are still to do; folded once all are done.
  const [subsOpen, setSubsOpen] = useState(() => (kids.get(t.id) ?? []).some(k => !isClosed(k.status)));
  const [lineDel, setLineDel] = useState(false);
  const [openSub, setOpenSub] = useState<string | null>(null);
  const [kidsShown, setKidsShown] = useState(false);
  const [msg, setMsg] = useState('');
  const [merging, setMerging] = useState<string | null>(null);
  const closed = isClosed(t.status);
  const due = closed ? 'none' : dueOf(t, today);
  const mine = sortTodos(kids.get(t.id) ?? []);
  const prog = progress(mine);
  const parent = t.parentId ? byId.get(t.parentId) : undefined;
  const isOrder = !!props.orderIds?.has(t.id) || !!t.order;
  // The order list can arrive after the row: opening an order still lands on its form.
  useEffect(() => { if (open && isOrder && !isClosed(t.status)) setBuying(true); }, [open, isOrder]);
  // §159: the listing is on the context line — the title does not say it again (the stored title stays whole).
  const shown = rowTitle(t.title, t.unitIds.map(id => names.get(id) ?? '').concat(parent ? parent.unitIds.map(id => names.get(id) ?? '') : []));
  const cat = categoryOf(t, isOrder);
  const stage = stageOf(t.status, isOrder);
  const openPop = props.openPop;
  // §159: inside a parent, one of the same kind is a row; one of another kind is a line that opens in a pop-up.
  const kidCat = (k: Todo) => categoryOf(k, !!props.orderIds?.has(k.id));
  const relLine = (k: Todo) => (
    <li key={k.id} className={`rel-line cat-${kidCat(k)} ${isClosed(k.status) ? 'is-done' : ''}`}>
      <button type="button" onClick={() => openPop?.({ todo: k.id })} title="Open it">
        <span className="rel-cat">{CATEGORY_LABEL[kidCat(k)]}</span>
        <span className="rel-title">{rowTitle(k.title, k.unitIds.map(id => names.get(id) ?? ''))}</span>
        <span className={`rel-stage st-${stageOf(k.status, (!!props.orderIds?.has(k.id) || !!k.order)).key}`}>{stageOf(k.status, (!!props.orderIds?.has(k.id) || !!k.order)).label}</span>
      </button>
    </li>
  );
  const kidRow = (k: Todo, o: boolean, onO: () => void, inPanel = false) => kidCat(k) !== 'task' && kidCat(k) !== cat ? relLine(k)
    : <TodoRow key={k.id} {...props} flat={false} related={false} inPanel={inPanel} t={k} open={o} onOpen={onO} />;
  const doTick = async () => { setBusy(true); await act({ action: 'done', id: t.id, done: !closed }); setBusy(false); };
  // §105: the row's own actions — done, cancel, reopen — and renaming in place.
  const doCancel = async () => { setBusy(true); await act({ action: 'update', id: t.id, status: 'cancelled' }); setBusy(false); };
  // §150, owner: closing a cleaner's supplies request with nothing bought for it reads as dismissing it — asked first.
  const [dismiss, setDismiss] = useState<null | 'done' | 'cancel'>(null);
  const [why, setWhy] = useState('');
  const unbought = !closed && !t.parentId && (t.cleanGroup === 'request' || t.cleanGroup === 'inspection') && !t.purchases;
  const tick = async () => { if (unbought) setDismiss('done'); else await doTick(); };
  const cancel = async () => { if (unbought) setDismiss('cancel'); else await doCancel(); };
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(t.title);
  const rename = async () => {
    const n = name.trim();
    setRenaming(false);
    if (!n || n === t.title) { setName(t.title); return; }
    setBusy(true); const ok = await act({ action: 'update', id: t.id, title: n }); setBusy(false);
    if (!ok) setName(t.title);
  };
  const toClaim = async () => {
    setBusy(true);
    const ok = await act({ action: 'toClaim', id: t.id });
    setBusy(false);
    if (ok) { setMsg('Registered as a claim — it is in Claims, and this to-do is linked to it.'); onClaimsChanged(); }
  };

  const canClaim = canClaims && !inClaim && !t.claimId && !t.parentId;
  const openKids = mine.filter(k => !isClosed(k.status)).length;
  const mergeUi = merging === null ? null : (
    <span className="todo-merge">
      <select value={merging} aria-label="Merge into" onChange={e => setMerging(e.target.value)}>
        <option value="">Merge into…</option>
        {[...byId.values()].filter(x => x.id !== t.id && x.parentId !== t.id && !isClosed(x.status))
          .sort((a, b) => Number(!a.unitIds.some(u => t.unitIds.includes(u))) - Number(!b.unitIds.some(u => t.unitIds.includes(u))) || a.title.localeCompare(b.title))
          .map(x => <option key={x.id} value={x.id}>{x.unitIds.map(id => names.get(id)).filter(Boolean).join(', ') || 'No listing'} · {x.title.slice(0, 70)}</option>)}
      </select>
      <button className="small" disabled={!merging || busy} onClick={async () => { setBusy(true); const ok = await act({ action: 'merge', id: t.id, into: merging }); setBusy(false); if (ok) setMerging(null); }}>Merge</button>
      <button className="link tiny" onClick={() => setMerging(null)}>Cancel</button>
    </span>);
  const removeUi = !confirmDel ? null : (
    <><span className="note">Remove “{t.title}”{openKids ? <b> and its {openKids} sub-task{openKids === 1 ? '' : 's'}</b> : ''}?</span>
      <button className="small danger" onClick={() => void act({ action: 'delete', id: t.id })}>Remove</button>
      <button className="link tiny" onClick={() => setConfirmDel(false)}>Keep</button></>);
  const panelRows = mergeUi || removeUi ? <div className="slide-confirm">{mergeUi}{removeUi}</div> : null;
  // Inside a panel the sub-task keeps the old footer; the panel itself has these in its ⋯ menu.
  const editForm = (
    <TodoForm units={units} claims={claims} canClaims={!inClaim && claims.length > 0} initial={t} submitLabel="Save changes" startEditing={!!props.inPanel}
                    onSubmit={v => act({ action: 'update', id: t.id, ...v })}
                    middle={<><TodoFiles todoId={t.id} />
                      <Timeline title={t.title} defaultOpen load={() => getTaskUpdates(t.id)} post={body => act({ action: 'note', id: t.id, body })} version={t.updates} /></>}
                    after={t.parentId ? null : (
                      <section className={`task-fold ${subsOpen ? 'open' : ''}`}>
                        {mine.length > 0 && (
                          <button type="button" className="task-fold-head" aria-expanded={subsOpen} onClick={() => setSubsOpen(!subsOpen)}>
                            <span className="task-fold-caret" aria-hidden="true">{subsOpen ? '▾' : '▸'}</span><b>Inside</b>
                            <span className="task-fold-sum">{prog.done}/{prog.total} done</span>
                          </button>
                        )}
                        {(subsOpen || !mine.length) && (
                          <div className={mine.length ? 'task-fold-body' : ''}>
                            {mine.length > 0 && (
                              <ul className="todo-list todo-kids">
                                {mine.map(k => kidRow(k, openSub === k.id, () => setOpenSub(openSub === k.id ? null : k.id), true))}
                              </ul>
                            )}
                            {buying && (
                              <TaskPurchase todoId={t.id} unitIds={t.unitIds} onClose={() => setBuying(false)}
                                            // What was asked: the description, and — on requests from before §159 — the open sub-tasks it was split into.
                                            asked={[t.description, ...mine.filter(k => !isClosed(k.status)).map(k => k.title)].filter(Boolean).join('\n')}
                                            onBought={async closeIt => { setBuying(false); if (closeIt && !closed) await doTick(); else reload(); }} />
                            )}
                            {/* §162 (owner, 2026-10-15): a purchase order takes sub-tasks too — what is bought may need installing. */}
                            {!addingSub ? (
                              <div className="todo-add-buttons">
                                <button className="link tiny" onClick={() => setAddingSub('task')}>+ sub-task{isOrder ? ' (e.g. install it)' : ''}</button>
                                <button className="link tiny" onClick={() => setAddingSub('work_order')}>+ <Icon n="wrench" /> work order</button>
                                {!closed && !buying && <button className="link tiny" onClick={() => setBuying(true)}>+ <Icon n="cart" /> purchase order</button>}
                              </div>
                            ) : (
                              <TodoForm key={addingSub} units={units} claims={claims} canClaims={false} submitLabel="Add" startKind={addingSub}
                                        onCancel={() => setAddingSub(null)}
                                        fixed={{ parentId: t.id, claimId: t.claimId, unitIds: t.unitIds, reservationId: t.reservationId, reservationLabel: t.reservationLabel }}
                                        onSubmit={async v => { const ok = await act({ action: 'create', ...v }); if (ok) setAddingSub(null); return ok; }} />
                            )}
                          </div>
                        )}
                      </section>
                    )} />
  );
  const editBox = (
    <div className="todo-edit">
      {editForm}
      {msg && <p className="banner ok">{msg}</p>}
      <div className="button-row">
        <span className="sub-n">added by {t.createdBy?.split('@')[0] ?? '—'} · {t.createdAt.slice(0, 10)}</span>
        {canClaim && <button className="link tiny" disabled={busy} onClick={() => void toClaim()}
                             title="It is a guest case — open a claim for it, linked to this to-do">⚑ Register as a claim</button>}
        {!closed && (merging === null
          ? <button className="link tiny" onClick={() => setMerging('')} title="The same job written twice? Keep the other one and bring this one's comments, files and items into it">Merge into…</button>
          : mergeUi)}
        <span className="rb-spacer" />
        {!confirmDel
          ? <button className="link tiny danger" onClick={() => setConfirmDel(true)}>Remove this {t.parentId ? 'sub-task' : t.kind === 'work_order' ? 'work order' : 'to-do'}…</button>
          : removeUi}
      </div>
    </div>
  );

  return (
    <li className={`todo cat-${cat} stage-${stage.key} due-${due} ${closed ? 'is-done' : ''} prio-${t.priority} ${open && !props.inPanel ? 'is-open' : ''}`}>
      {/* Owner, 2026-10-14: opening a task was not obvious — a ▸ before the title, and a click anywhere on
          the row opens it (its own buttons, links and fields keep their job). §159: the title alone on the
          first line; what describes it is one quiet line under it, always in the same order. */}
      <div className="todo-line todo-opener" onClick={e => { if (!props.inPanel && !renaming && !(e.target as HTMLElement).closest('button, a, input, select, textarea, label')) onOpen(); }}>
        {renaming ? (
          <input className="todo-rename" value={name} autoFocus maxLength={120} aria-label="Title"
                 onChange={e => setName(e.target.value)} onBlur={() => void rename()}
                 onKeyDown={e => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') { setName(t.title); setRenaming(false); } }} />
        ) : <>
          <button className={`todo-title ${props.inPanel ? 'is-static' : ''}`} onClick={props.inPanel ? undefined : onOpen} aria-expanded={props.inPanel ? undefined : open}
                  aria-haspopup={props.inPanel ? undefined : 'dialog'} title={props.inPanel ? undefined : 'Open it'}>{shown}</button>
          <button type="button" className="todo-pencil" title="Rename" aria-label={`Rename ${t.title}`} onClick={() => { setName(t.title); setRenaming(true); }}>✎</button>
        </>}
        {/* §105: how a task ends, on its own row, at the right — faint until the row is pointed at. */}
        <span className="todo-quick">
          {/* §161: a sub-task is one line; its fields open only with its own Edit. */}
          {props.inPanel && <button type="button" className="q-edit" aria-expanded={open} onClick={onOpen}>{open ? '▴ Hide' : '✎ Edit'}</button>}
          {closed
            ? <button type="button" className="q-reopen" disabled={busy} onClick={() => void tick()} title="Reopen">↺ Reopen</button>
            : <>
                <button type="button" className="q-cancel" disabled={busy} onClick={() => void cancel()} title="Cancel it — kept, closed as cancelled"
                        aria-label={`Cancel: ${t.title}`}>✕</button>
                <button type="button" className="q-done" disabled={busy} onClick={() => void tick()} title={isOrder ? 'Mark as purchased' : 'Mark as done'}
                        aria-label={`Done: ${t.title}`}>✓</button>
              </>}
        </span>
        {/* A sub-task is removed from its own line, naming itself — never
            through the parent's Remove, which takes the whole task (§82). */}
        {t.parentId && !open && (
          <button className="todo-x" title={`Remove the sub-task “${t.title}”`} aria-label={`Remove the sub-task ${t.title}`}
                  onClick={() => setLineDel(true)}>✕</button>
        )}
      </div>
      <div className="todo-meta">
        {!compact && cat !== 'task' && <span className="m m-cat">{CATEGORY_LABEL[cat]}</span>}
        <span className={`m m-stage st-${stage.key}`}>{stage.label}
          {!closed && stage.key === 'new' && t.scheduledOn && t.scheduledOn > today ? ` · ${shortDay(t.scheduledOn)}${t.startTime ? ` ${t.startTime}` : ''}` : ''}
          {closed && t.doneAt ? ` · ${t.doneBy?.split('@')[0] ?? ''} ${t.doneAt.slice(5, 10)}` : ''}</span>
        {!closed && (t.priority === 'urgent' || t.priority === 'high') && <span className="m m-attn">{PRIORITY_LABEL[t.priority]}</span>}
        {!closed && t.dueOn && <span className={`m ${due === 'overdue' || due === 'today' ? 'm-attn' : ''}`}><Icon n="calendar" />{dueLabel(t, today)}{t.dueTime ? ` · ${t.dueTime}` : ''}</span>}
        {/* A sub-task says only what differs from its parent: the same unit under the same parent is noise. */}
        {t.unitIds.filter(id => !(parent && !flat && parent.unitIds.includes(id))).map(id => (
          <button key={id} type="button" className="m m-btn m-link" title={`Show only the work on ${names.get(id) ?? 'this listing'}`}
                  onClick={() => props.filterBy?.({ unit: id })}><Icon n="home" />{names.get(id) ?? 'unit'}</button>))}
        {t.assignee && <button type="button" className="m m-btn m-link" title={`Show only what ${t.assignee} handles`}
                               onClick={() => props.filterBy?.({ owner: t.assignee! })}><Icon n="user" />{t.assignee}</button>}
        {t.kind === 'work_order' && t.vendor && <span className="m"><Icon n="wrench" />{t.vendor}</span>}
        {prog.total > 0 && (!flat && !open && !compact && mine.some(k => !isClosed(k.status))
          ? <button type="button" className="m m-btn" aria-expanded={kidsShown} title={kidsShown ? 'Hide what is inside' : 'Show what is inside'}
                    onClick={() => setKidsShown(v => !v)}><Icon n="list" />{prog.done}/{prog.total} inside</button>
          : <span className="m" title="Done inside"><Icon n="list" />{prog.done}/{prog.total}</span>)}
        {props.chat && !open
          ? <button type="button" className="m m-btn" aria-expanded={talk} onClick={() => setTalk(v => !v)}
                    title={talk ? 'Hide the comments' : 'Comments — read or leave one'}><Icon n="message" />{t.updates > 1 ? t.updates : 'Comment'}</button>
          : t.updates > 1 && <span className="m" title="Comments and updates"><Icon n="message" />{t.updates}</span>}
        {!!t.files && <button type="button" className="m m-btn" title="Files — open it to see them" onClick={onOpen}><Icon n="clip" />{t.files}</button>}
        {!open && sourceOf(t) && <span className="m">{t.description?.trim()
          ? <Peek label={<><Icon n="note" />{sourceOf(t)}</>}><Linked text={t.description} /></Peek>
          : <><Icon n="note" />{sourceOf(t)}</>}</span>}
        {/* §159: what it belongs to opens in a pop-up — the list stays where it is. */}
        {parent && (flat || props.related) && <button type="button" className="m m-btn m-rel" title="Open what this is part of" onClick={() => openPop?.({ todo: parent.id })}>Part of › {rowTitle(parent.title, parent.unitIds.map(id => names.get(id) ?? ''))}</button>}
        {t.claimId && !inClaim && !(parent && !flat && parent.claimId === t.claimId) && (!claims.length || claimNames.has(t.claimId)) &&
          <button type="button" className="m m-btn m-rel" title="Open the claim" onClick={() => openPop?.({ claim: t.claimId! })}>Claim › {claimNames.get(t.claimId) ?? 'claim'}</button>}
        {t.hostawayError && <span className="m m-attn" title={`Not yet in Hostaway: ${t.hostawayError} — retried on the next sync`}><Icon n="warning" />Not in Hostaway yet</span>}
        {closed && t.resolutionNote && <span className="m todo-resolution" title="Resolution">— {t.resolutionNote}</span>}
      </div>
      {dismiss && (
        <Modal title="Close this purchase order with nothing bought?" onClose={() => { setDismiss(null); setWhy(''); }}>
          <p>No purchase is recorded for it{t.cleanGroup === 'inspection' ? ' (an inspector asked for it)' : ''}. Closing it now reads as
            <b> the order was dismissed</b> — fine if it was not needed or the stock had it; say why.</p>
          <div className="button-row">
            <button onClick={() => { setDismiss(null); if (!open) onOpen(); setSubsOpen(true); setBuying(true); }}><Icon n="cart" /> Record the purchase</button>
            <button className="secondary" onClick={() => { setDismiss(null); setWhy(''); }}>Keep it open</button>
          </div>
          <label>Or close it without buying — why? <span className="sub-n">(kept on the to-do)</span>
            <input value={why} maxLength={300} placeholder="e.g. there was enough in the closet; already bought by …" onChange={e => setWhy(e.target.value)} /></label>
          <div className="button-row">
            <button className="danger" disabled={busy || !why.trim()} onClick={async () => {
              const how = dismiss, reason = why.trim();
              setDismiss(null); setWhy(''); setBusy(true);
              // The server keeps the reason on the to-do (§150) — and refuses the close without one.
              await act(how === 'done' ? { action: 'done', id: t.id, done: true, closeReason: reason }
                                       : { action: 'update', id: t.id, status: 'cancelled', closeReason: reason });
              setBusy(false);
            }}>{dismiss === 'done' ? 'Mark done without buying' : 'Cancel the request'}</button>
          </div>
        </Modal>
      )}
      {lineDel && (
        <div className="todo-confirm">
          <span className="note">Remove the sub-task “{t.title}”?</span>
          <button className="small danger" disabled={busy} onClick={() => void act({ action: 'delete', id: t.id })}>Remove</button>
          <button className="link tiny" onClick={() => setLineDel(false)}>Keep</button>
        </div>
      )}
      {props.chat && talk && !open && (
        <div className="todo-talk">
          <Timeline title={t.title} defaultOpen load={() => getTaskUpdates(t.id)} post={body => act({ action: 'note', id: t.id, body })} version={t.updates} />
        </div>
      )}
      {/* §159: the description is behind a short "where it came from" on the context line, not a paragraph on the row. */}
      {/* Sub-tasks sit under their task when the list is not filtered (§78) — folded until asked (owner, §150:
          a clean's five reports open under it were noise); ▸ ☑ n/m on the row shows them. */}
      {!flat && !open && !compact && kidsShown && mine.some(k => !isClosed(k.status)) && (
        <ul className="todo-list todo-kids">
          {mine.filter(k => !isClosed(k.status)).map(k => kidRow(k, openSub === k.id, () => setOpenSub(openSub === k.id ? null : k.id)))}
        </ul>
      )}
      {open && (props.inPanel ? <NoDock>{editBox}</NoDock> : (
        <SlideOver title={shown} onClose={onOpen} below={panelRows}
          actions={<>
            {closed
              ? <button type="button" className="slide-btn wide" disabled={busy} onClick={() => void tick()}>↺ Reopen</button>
              : <>
                  <button type="button" className="slide-btn done" disabled={busy} onClick={() => void tick()} title={isOrder ? 'Mark as purchased' : 'Mark as done'}
                          aria-label={`Done: ${t.title}`}>✓</button>
                </>}
            {(
              <Popover label="More actions" align="right" button={<Icon n="dots" />} className="slide-more">
                {close => <>
                  {!closed && <>
                    <button type="button" role="menuitem" disabled={busy} onClick={() => { close(); void tick(); }}><Icon n="done" /> {isOrder ? 'Mark as purchased' : 'Mark as done'}</button>
                    <button type="button" role="menuitem" disabled={busy} onClick={() => { close(); void cancel(); }} title="Kept, closed as cancelled"><Icon n="ban" /> Cancel it</button>
                  </>}
                  {canClaim && <button type="button" role="menuitem" disabled={busy} onClick={() => { close(); void toClaim(); }}
                                       title="It is a guest case — open a claim for it, linked to this to-do"><Icon n="warning" /> Register as a claim</button>}
                  {!closed && <button type="button" role="menuitem" onClick={() => { close(); setMerging(''); }}
                                      title="The same job written twice? Keep the other one and bring this one's comments, files and items into it"><Icon n="layers" /> Merge into…</button>}
                  <button type="button" role="menuitem" className="danger" onClick={() => { close(); setConfirmDel(true); }}><Icon n="trash" /> Remove this {t.parentId ? 'sub-task' : t.kind === 'work_order' ? 'work order' : 'to-do'}…</button>
                </>}
              </Popover>
            )}
          </>}>
          <div className="todo-edit">
            {editForm}
            {msg && <p className="banner ok">{msg}</p>}
            <p className="sub-n slide-added">added by {t.createdBy?.split('@')[0] ?? '—'} · {t.createdAt.slice(0, 10)}</p>
          </div>
        </SlideOver>
      ))}
    </li>
  );
}

type FormValue = {
  title: string; kind: TaskKind; unitIds: string[]; priority: Priority;
  /** §94: Start from / Finish by, each a day with an optional time. */
  scheduledOn: string | null; startTime: string | null; dueOn: string | null; dueTime: string | null;
  /** §94: Hostaway users. */
  assigneeUserId: number | null; supervisorUserId: number | null;
  claimId: string | null; vendor: string | null;
  costEstimate: number | null; costActual: number | null; status?: TaskStatus; resolutionNote: string | null;
  /** §95: the repair's cost also charged to the owner, in Hostaway. */
  chargeOwner: boolean;
  description: string | null; parentId?: string;
  reservationId: string | null; reservationLabel: string | null;
};

/** Hostaway's users (§94), read once per page — every form on it shares them. */
let peopleOnce: Promise<Person[]> | null = null;
function usePeople(): Person[] {
  const [list, setList] = useState<Person[]>([]);
  useEffect(() => {
    peopleOnce ??= getPeople().then(r => r.people ?? []).catch(() => { peopleOnce = null; return []; });
    void peopleOnce.then(setList);
  }, []);
  return list;
}

/** Owner or supervisor: one of Hostaway's users, or nobody. A name no longer there still shows. */
function PersonPick({ label, value, name, people, onChange }: {
  label: string; value: number | null; name?: string | null; people: Person[]; onChange: (id: number | null) => void;
}) {
  const gone = value != null && !people.some(p => p.id === value);
  return (
    <label>{label}
      <select value={value ?? ''} onChange={e => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">Nobody</option>
        {people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        {gone && <option value={value!}>{name ?? `User ${value}`}</option>}
      </select></label>
  );
}

/**
 * The vendor's link for a work order (§137): no account — the handyman
 * accepts the day (or can't: a "Reschedule" sub-task), sends photos before /
 * after, charges and materials with receipts (waiting for approval) and marks
 * it done. Uses the SAVED vendor and day.
 */
function VendorLink({ id }: { id: string }) {
  const [l, setL] = useState<null | { link: string; vendor: string; phone: string | null; title: string; unit: string | null; day: string; expires: string }>(null);
  const [msg, setMsg] = useState('');
  const get = async () => {
    setMsg('');
    const r = await vendorLink(id).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Not made.'); return; }
    setL(r);
  };
  if (!l) return (
    <div className="button-row">
      <button type="button" className="small secondary" onClick={() => void get()}><Icon n="share" /> Send to vendor</button>
      <span className="note">A link for the vendor — no account. Save first if you changed the vendor or the day.</span>
      {msg && <span className="breach">{msg}</span>}
    </div>
  );
  const text = `Kaizen — ${l.unit ? `${l.unit}: ` : ''}${l.title} · ${l.day}. Open / Abre: ${l.link}`;
  const digits = (l.phone ?? '').replace(/[^\d+]/g, '');
  return (
    <div className="vendor-link">
      <p className="note">For <b>{l.vendor}</b> — the day {l.day}; the link works until {l.expires} or until the work order closes or goes to another vendor.</p>
      <div className="button-row">
        <a className="chip" href={`https://wa.me/${digits.replace(/^\+/, '')}?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer"><Icon n="message" /> WhatsApp</a>
        {digits && <a className="chip" href={`sms:${digits}?&body=${encodeURIComponent(text)}`}><Icon n="mail" /> SMS</a>}
        <button type="button" className="chip" onClick={() => void navigator.clipboard.writeText(text).then(() => setMsg('Copied.'), () => setMsg(l.link))}><Icon n="clipboard" /> Copy</button>
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}

/**
 * Add (one line, "more" for the rest) or change a piece of work. `fixed`
 * is what a claim pre-sets: the claim itself, and its unit. The fields are
 * Hostaway's task, field for field (§94); the kind, vendor, estimate, claim
 * and sub-tasks are Kaizen's own.
 */
function TodoForm({ units, claims, canClaims, initial, fixed, submitLabel, onSubmit, startKind = 'task', onCancel, middle, after, startEditing = false }: {
  units: Unit[]; claims: Claim[]; canClaims: boolean; initial?: Todo; submitLabel: string;
  /** Editing (§104): what goes between the description and the details — the comments. */
  middle?: ReactNode;
  /** Editing: what goes after the details — the sub-tasks. */
  after?: ReactNode;
  /** Editing: open on the full fields, not the one-line summary (a sub-task opened with its own Edit, §161). */
  startEditing?: boolean;
  /** What the context pre-sets: a claim (and its unit), or a parent task (its listings and claim). */
  fixed?: { claimId?: string | null; unitIds: string[]; parentId?: string; reservationId?: string | null; reservationLabel?: string | null };
  onSubmit: (v: FormValue) => Promise<boolean>;
  /** Adding: the kind the button chose. */
  startKind?: TaskKind; onCancel?: () => void;
}) {
  const people = usePeople();
  const blank = (): FormValue => ({
    title: '', kind: startKind, unitIds: fixed?.unitIds ?? [], priority: 'none',
    scheduledOn: null, startTime: null, dueOn: null, dueTime: null, assigneeUserId: null, supervisorUserId: null,
    claimId: fixed?.claimId ?? null, vendor: null, costEstimate: null, costActual: null, resolutionNote: null, chargeOwner: false,
    description: null, ...(fixed?.parentId ? { parentId: fixed.parentId } : {}),
    reservationId: fixed?.reservationId ?? null, reservationLabel: fixed?.reservationLabel ?? null
  });
  const [v, setV] = useState<FormValue>(() => initial ? {
    title: initial.title, kind: initial.kind, unitIds: initial.unitIds, priority: initial.priority,
    scheduledOn: initial.scheduledOn, startTime: initial.startTime ?? null, dueOn: initial.dueOn, dueTime: initial.dueTime ?? null,
    assigneeUserId: initial.assigneeUserId ?? null, supervisorUserId: initial.supervisorUserId ?? null,
    claimId: initial.claimId, vendor: initial.vendor, costEstimate: initial.costEstimate, costActual: initial.costActual,
    status: initial.status, resolutionNote: initial.resolutionNote ?? null, chargeOwner: initial.chargeOwner ?? false,
    description: initial.description, reservationId: initial.reservationId, reservationLabel: initial.reservationLabel
  } : blank());
  const [more, setMore] = useState(!!initial);
  // Editing (§104): what was saved, to know what is not — and the details, folded.
  const [base, setBase] = useState<FormValue>(v);
  const [details, setDetails] = useState(false);
  // §161: an item reads as one line — status • urgency • listing • dates • owner — and its fields open with ✎ Edit.
  const [fields, setFields] = useState(startEditing);
  const dirty = !!initial && JSON.stringify(v) !== JSON.stringify(base);
  // The description: always there when editing; one click away when adding.
  const [withDesc, setWithDesc] = useState(!!initial);
  const [editDesc, setEditDesc] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormValue>(k: K, x: FormValue[K]) => setV(p => ({ ...p, [k]: x }));
  const name = (id: string) => units.find(u => u.id === id)?.name ?? 'unit';
  const wo = v.kind === 'work_order';
  const openClaims = claims.filter(c => c.status === 'Open' || c.status === 'In progress' || String(c.id) === v.claimId);
  // One listing per task (§94). Adding may pick several — each becomes its own task.
  const manyListings = !initial && v.unitIds.length > 1;
  const closing = v.status === 'completed' || v.status === 'cancelled';

  const submit = async () => {
    if (!v.title.trim() || busy) return;
    setBusy(true);
    const ok = await onSubmit({ ...v, title: v.title.trim() });
    setBusy(false);
    if (ok && !initial) { setV(blank()); setMore(false); }
    if (ok && initial) setBase(v);
  };
  const moneyIn = (x: number | null, k: 'costEstimate' | 'costActual') => (
    <input type="number" min={0} step="0.01" value={x ?? ''} placeholder="$"
           onChange={e => set(k, e.target.value === '' ? null : Number(e.target.value))} />
  );

  const detailGrid = (
        <div className="todo-more">
          {initial && (
            <label>Status
              <select value={v.status} onChange={e => set('status', e.target.value as TaskStatus)}>
                {STATUSES.map(x => <option key={x} value={x}>{STATUS_LABEL[x]}</option>)}
              </select></label>
          )}
          <label>Priority
            <select value={v.priority} onChange={e => set('priority', e.target.value as Priority)}>
              {PRIORITIES.map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
            </select></label>
          <PersonPick label="Owner" value={v.assigneeUserId} name={initial?.assignee} people={people} onChange={x => set('assigneeUserId', x)} />
          <PersonPick label="Supervisor" value={v.supervisorUserId} name={initial?.supervisor} people={people} onChange={x => set('supervisorUserId', x)} />
          <label>Start from
            <span className="todo-when">
              <input type="date" value={v.scheduledOn ?? ''} onChange={e => set('scheduledOn', e.target.value || null)} />
              <input type="time" value={v.startTime ?? ''} disabled={!v.scheduledOn} aria-label="Start time"
                     onChange={e => set('startTime', e.target.value || null)} />
            </span></label>
          <label>Finish by — time
            <input type="time" value={v.dueTime ?? ''} disabled={!v.dueOn} onChange={e => set('dueTime', e.target.value || null)} /></label>
          {canClaims && (
            <label>Part of a claim? (optional)
              <select value={v.claimId ?? ''} onChange={e => set('claimId', e.target.value || null)}>
                <option value="">No — standalone</option>
                {openClaims.map(c => <option key={c.id} value={String(c.id)}>{claimLabel(c)}</option>)}
              </select></label>
          )}
          {!manyListings && (
            <div className="todo-stay-pick">
              <StayPicker unitId={v.unitIds[0] ?? null} value={v.reservationId ? { id: v.reservationId, label: v.reservationLabel ?? '' } : null}
                          onChange={x => setV(p => ({ ...p, reservationId: x?.id ?? null, reservationLabel: x?.label ?? null }))} />
            </div>
          )}
          {wo && <>
            <label>Vendor
              <input value={v.vendor ?? ''} placeholder="Plumber, handyman…" list="kaizen-vendors" onChange={e => set('vendor', e.target.value || null)} /></label>
            <VendorOptions />
            <label>Estimate {moneyIn(v.costEstimate, 'costEstimate')}</label>
            {initial?.id && <VendorLink id={initial.id} />}
            <label>Cost {moneyIn(v.costActual, 'costActual')}</label>
          </>}
          {wo && (
            <label className="check todo-charge" title={v.unitIds.length ? '' : 'Needs a listing — the expense goes on it'}>
              <input type="checkbox" checked={v.chargeOwner} disabled={!v.unitIds.length} onChange={e => set('chargeOwner', e.target.checked)} />
              Charge to owner <span className="sub-n">— when completed, the cost is also an expense on the listing in Hostaway (owner statements)</span>
            </label>
          )}
          {wo && <p className="note todo-costnote">A completed repair's cost is recorded in Costs → Repairs, with or without a claim.</p>}
          {initial && closing && (
            <label className="todo-resolution-in">Resolution — how it was resolved
              <textarea rows={2} value={v.resolutionNote ?? ''} maxLength={2000} onChange={e => set('resolutionNote', e.target.value || null)} /></label>
          )}
        </div>
  );

  // Editing (§104): the content first — title, description, the conversation —
  // and everything else folded under one line that says where it stands.
  if (initial) {
    // §159 (owner, 2026-10-14: the edit menu and the description were hard to read): an open item reads like an
    // iOS settings sheet — what it is about first, then short grouped lists (label left, value right), each field
    // editable where it sits; the rarely used ones under "More". One "Unsaved changes" bar saves them all.
    const src = sourceOf({ ...initial, description: v.description });
    return (
      <div className="task-edit task-sheet">
        <section className="sheet-about">
          {src && src !== 'Details' && <div className="sheet-eyebrow"><Icon n="note" />{src}</div>}
          {editDesc || !(v.description ?? '').trim() ? (
            <textarea className="task-desc" value={v.description ?? ''} maxLength={4000} aria-label="Description"
                      rows={Math.min(8, Math.max(2, (v.description ?? '').split('\n').length + 1))}
                      placeholder="Add a description — who, what exactly, anything to remember"
                      onChange={e => set('description', e.target.value || null)} />
          ) : (
            <div className="sheet-desc">
              <div className="todo-desc-full is-editable" title="Click to edit" onClick={e => { if (!(e.target as HTMLElement).closest('a, button')) setEditDesc(true); }}><Linked text={v.description!} /></div>
            </div>
          )}
        </section>
        <div className="sheet-summary">
          <span className="sheet-sum-text">{[
            v.status ? STATUS_LABEL[v.status] : '', v.priority !== 'none' ? PRIORITY_LABEL[v.priority] : '',
            v.unitIds.map(id => units.find(u => u.id === id)?.name).filter(Boolean).join(', '),
            v.scheduledOn || v.dueOn ? [v.scheduledOn, v.dueOn].map(d => d ? shortDay(d) : '').filter(Boolean).join(' – ') : '',
            initial.assignee ?? '',
            // §162: a work order says who does it and what it costs on the same line.
            wo ? (v.vendor ? `Vendor ${v.vendor}` : 'No vendor yet') : '',
            wo && (v.costActual ?? v.costEstimate) != null ? `${v.costActual != null ? '' : '~'}${money2((v.costActual ?? v.costEstimate)!)}` : ''
          ].filter(Boolean).join(' • ')}</span>
          <button type="button" className="link tiny" aria-expanded={fields} onClick={() => setFields(f => !f)}>{fields ? '▴ Hide fields' : '✎ Edit'}</button>
        </div>
        <div className="sheet-groups" hidden={!fields}>
          <div className="fl-group" role="group" aria-label="Status and people">
            <label>Status
              <select value={v.status} onChange={e => set('status', e.target.value as TaskStatus)}>
                {STATUSES.map(x => <option key={x} value={x}>{STATUS_LABEL[x]}</option>)}
              </select></label>
            <label>Priority
              <select value={v.priority} onChange={e => set('priority', e.target.value as Priority)}>
                {PRIORITIES.map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </select></label>
            <PersonPick label="Owner" value={v.assigneeUserId} name={initial.assignee} people={people} onChange={x => set('assigneeUserId', x)} />
            <PersonPick label="Supervisor" value={v.supervisorUserId} name={initial.supervisor} people={people} onChange={x => set('supervisorUserId', x)} />
          </div>
          <div className="fl-group" role="group" aria-label="When and where">
            <label>Listing
              <select value={v.unitIds[0] ?? ''} onChange={e => set('unitIds', e.target.value ? [e.target.value] : [])}>
                <option value="">None</option>
                {units.filter(u => u.active || v.unitIds.includes(u.id)).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select></label>
            <label>Start from
              <span className="todo-when">
                <input type="date" value={v.scheduledOn ?? ''} onChange={e => set('scheduledOn', e.target.value || null)} />
                <input type="time" value={v.startTime ?? ''} disabled={!v.scheduledOn} aria-label="Start time"
                       onChange={e => set('startTime', e.target.value || null)} />
              </span></label>
            <label>Finish by
              <span className="todo-when">
                <input type="date" value={v.dueOn ?? ''} onChange={e => set('dueOn', e.target.value || null)} />
                <input type="time" value={v.dueTime ?? ''} disabled={!v.dueOn} aria-label="Finish time"
                       onChange={e => set('dueTime', e.target.value || null)} />
              </span></label>
            {v.unitIds.length <= 1 && (
              <div className="fl-row">
                <StayPicker unitId={v.unitIds[0] ?? null} value={v.reservationId ? { id: v.reservationId, label: v.reservationLabel ?? '' } : null}
                            onChange={x => setV(p => ({ ...p, reservationId: x?.id ?? null, reservationLabel: x?.label ?? null }))} />
              </div>
            )}
          </div>
          {/* §162 (owner, 2026-10-15): a work order shows what makes it one — who does it, what it costs — in sight,
              not under "More". The vendor is a registered one or any name typed. */}
          {wo && (
            <div className="fl-group" role="group" aria-label="Work order">
              <label>Vendor
                <input value={v.vendor ?? ''} placeholder="A registered vendor, or any name" list="kaizen-vendors" onChange={e => set('vendor', e.target.value || null)} /></label>
              <VendorOptions />
              <label>Estimate {moneyIn(v.costEstimate, 'costEstimate')}</label>
              <label>Cost {moneyIn(v.costActual, 'costActual')}</label>
              <label className="check todo-charge" title={v.unitIds.length ? 'When completed, the cost is also an expense on the listing in Hostaway (owner statements)' : 'Needs a listing — the expense goes on it'}>
                <input type="checkbox" checked={v.chargeOwner} disabled={!v.unitIds.length} onChange={e => set('chargeOwner', e.target.checked)} />
                Charge to owner
              </label>
            </div>
          )}
          {wo && <VendorLink id={initial.id} />}
          {/* §162: a to-do has no kind to switch and no cost of its own (work orders and purchase orders carry the money). */}
          {(canClaims || initial.hostawayTaskId) && (
            <details className="fl-more" open={details} onToggle={e => setDetails((e.target as HTMLDetailsElement).open)}>
              <summary>More <span className="sub-n">{[canClaims && 'claim', initial.hostawayTaskId && 'Hostaway'].filter(Boolean).join(', ')}</span></summary>
              <div className="fl-group" role="group" aria-label="More">
                {canClaims && (
                  <label>Claim
                    <select value={v.claimId ?? ''} onChange={e => set('claimId', e.target.value || null)}>
                      <option value="">None</option>
                      {openClaims.map(c => <option key={c.id} value={String(c.id)}>{claimLabel(c)}</option>)}
                    </select></label>
                )}
                {initial.hostawayTaskId && <div className="fl-row"><span className="fl-k">Hostaway</span><span className="sub-n">Task #{initial.hostawayTaskId}</span></div>}
              </div>
            </details>
          )}
          {closing && (
            <label className="todo-resolution-in">How it was resolved
              <textarea rows={2} value={v.resolutionNote ?? ''} maxLength={2000} onChange={e => set('resolutionNote', e.target.value || null)} /></label>
          )}
        </div>
        {middle}
        {after}
        {dirty && (
          <div className="task-savebar" role="status">
            <span>Unsaved changes</span>
            <span className="rb-spacer" />
            <button type="button" className="link" onClick={() => setV(base)}>Discard</button>
            <button type="button" className="small" disabled={!v.title.trim() || busy} onClick={() => void submit()}>{busy ? 'Saving…' : submitLabel}</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <form className="todo-form" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="todo-first">
        {/* The kind is chosen by the button when adding (§162: and not changed after). */}
        <b className="todo-adding">{ic(wo ? '🔧 New work order' : 'New to-do')}</b>
        <input className="todo-text" value={v.title} maxLength={120} autoFocus={!initial}
               placeholder={initial ? '' : wo ? 'Short title — e.g. Fix the AC' : 'Short title — e.g. Text the HOA'}
               onChange={e => set('title', e.target.value)}
               onKeyDown={e => { if (e.key === 'Escape' && onCancel) onCancel(); }} />
      </div>
      {/* The title stays a title; the detail goes here (§78). */}
      {/* Owner, Oct 2026: an open to-do reads its description (links as 🔗) until ✎ Edit. */}
      {initial && withDesc && !editDesc && (v.description ?? '').trim() ? (
        <div className="todo-desc-read">
          <div className="todo-desc-full"><Linked text={v.description!} /></div>
          <button type="button" className="link tiny" onClick={() => setEditDesc(true)}>✎ Edit</button>
        </div>
      ) : withDesc ? (
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
        {(!initial || !v.unitIds.length) && (
          <select value="" aria-label="Add a listing" onChange={e => { const x = e.target.value; if (x) set('unitIds', initial ? [x] : [...v.unitIds, x]); }}>
            <option value="">{v.unitIds.length ? '+ listing' : 'Listing (optional)'}</option>
            {units.filter(u => u.active && !v.unitIds.includes(u.id)).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        )}
        <label className="todo-inline">Finish by
          <input type="date" value={v.dueOn ?? ''} onChange={e => set('dueOn', e.target.value || null)} /></label>
        {!initial && <button type="button" className="link tiny" onClick={() => setMore(!more)}>
          {more ? 'fewer options' : wo ? 'owner, vendor, cost…' : 'owner, priority, start…'}</button>}
        {!initial && <span className="rb-spacer" />}
        {!initial && onCancel && <button type="button" className="link tiny" onClick={onCancel}>Cancel</button>}
        {!initial && <button className="small" disabled={!v.title.trim() || busy}>{busy ? '…' : manyListings ? `${submitLabel} ${v.unitIds.length}` : submitLabel}</button>}
      </div>
      {manyListings && <p className="note todo-many">One task per listing, as in Hostaway: this adds {v.unitIds.length} tasks, one on each.</p>}
      {more && detailGrid}
    </form>
  );
}

/**
 * What happened to a task or a claim, as two things (§103):
 *   · 💬 Comments — what people wrote: a fold (open from the start in a
 *     task, §104), the last five and the box to add one.
 *   · Activity log — what the system recorded (status and field changes,
 *     "Sent to Hostaway…", "Recorded in Costs…"): a pop-up, newest first.
 * Shown together in the page, the system's lines buried the comments and
 * the task they belong to.
 */
export function Timeline({ load, post, version = 0, readOnly = false, title, defaultOpen = false }: {
  load: () => Promise<{ ok: true; updates: WorkUpdate[] } | { ok: false; message?: string; error?: string }>;
  post: (body: string) => Promise<boolean>;
  /** The done log reads a timeline; it does not add to it. */
  readOnly?: boolean;
  /** Re-read when this changes (the parent saw a new update count). */
  version?: number;
  /** What it is the activity of, for the pop-up's title. */
  title?: string;
  /** Comments open from the start — in a task, the conversation comes first (§104). */
  defaultOpen?: boolean;
}) {
  const [list, setList] = useState<WorkUpdate[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [comments, setComments] = useState(defaultOpen);
  const [earlier, setEarlier] = useState(false);
  const [log, setLog] = useState(false);
  const read = () => load().then(r => setList(r.ok ? r.updates : [])).catch(() => setList([]));
  useEffect(() => { void read(); }, [version]);

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await post(text.trim());
    setBusy(false);
    if (ok) { setText(''); await read(); }
  };
  // In a slide-over the comment box is docked at the panel's foot, always in reach (§160).
  const dock = useDock();
  const notes = (list ?? []).filter(u => u.kind === 'note');
  const changes = (list ?? []).filter(u => u.kind !== 'note');

  return (
    <div className="timeline compact">
      <div className="tl-summary">
        <button type="button" className="tl-toggle" aria-expanded={comments} onClick={() => setComments(!comments)}>
          <Icon n="message" /> Comments{list === null ? '' : ` · ${notes.length}`} <span aria-hidden="true">{comments ? '▾' : '▸'}</span>
        </button>
        <span className="rb-spacer" />
        {changes.length > 0 && <button type="button" className="link" onClick={() => setLog(true)}>Activity log · {changes.length}</button>}
      </div>
      {comments && (
        <div className="tl-comments">
          {list === null ? <p className="note loading-dot">Reading</p> : !notes.length ? <p className="note">No comments yet.</p> : (
            <ol className="tl-notes">
              {notes.length > 5 && !earlier && (
                <li className="tl-more"><button type="button" className="link tiny" onClick={() => setEarlier(true)}>
                  {notes.length - 5} earlier comment{notes.length - 5 === 1 ? '' : 's'}</button></li>
              )}
              {(earlier ? notes : notes.slice(-5)).map(u => (
                <li key={u.id}>
                  <span className="tl-note-head"><b>{u.createdBy?.split('@')[0] ?? '—'}</b> · {nyParts(u.createdAt).short}</span>
                  <span className="tl-note-body"><NoteText text={u.body} /></span>
                </li>
              ))}
            </ol>
          )}
          {!readOnly && (() => { const f = (
            <form className="timeline-add" onSubmit={e => { e.preventDefault(); void send(); }}>
              <textarea rows={2} value={text} placeholder="Add a comment — what happened, what's next, who you're waiting on"
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }} />
              <button className="small" disabled={!text.trim() || busy}>{busy ? '…' : 'Comment'}</button>
            </form>
          ); return dock ? createPortal(f, dock) : f; })()}
        </div>
      )}
      {log && (
        <Modal title={`Activity log${title ? ` — ${title}` : ''}`} onClose={() => setLog(false)}>
          {!changes.length ? <p className="note">Nothing recorded yet.</p> : (
            <ol className="timeline-list tl-modal">
              {[...changes].reverse().map(u => (
                <li key={u.id} className={`tl-${u.kind}`}>
                  <span className="tl-when" title="New York time">{nyParts(u.createdAt).short}</span>
                  <span className="tl-who">{u.createdBy?.split('@')[0] ?? '—'}</span>
                  <span className="tl-body"><NoteText text={u.body} /></span>
                </li>
              ))}
            </ol>
          )}
        </Modal>
      )}
    </div>
  );
}

/**
 * Which stay this is about (§84) — the same picker as a manual clean
 * (§79): the unit (the first listing), a day, and the stays Hostaway has
 * in it that day. Optional everywhere; a stay once chosen shows as its
 * guest and dates, and can be cleared.
 */
export function StayPicker({ unitId, value, onChange, today }: {
  unitId: string | null; value: { id: string; label: string } | null;
  onChange: (v: { id: string; label: string } | null) => void; today?: DateStr;
}) {
  const [day, setDay] = useState<string>(today ?? new Date().toISOString().slice(0, 10));
  const [stays, setStays] = useState<StayOnDay[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!unitId || !picking) return;
    setStays(null); setErr('');
    void getStaysOnDay(unitId, day).then(r => { if (r.ok) setStays(r.stays); else { setErr(r.message ?? 'Hostaway did not answer.'); setStays([]); } })
      .catch(e => { setErr(String(e)); setStays([]); });
  }, [unitId, day, picking]);

  if (value && !picking) {
    return (
      <span className="stay-pick">
        <span className="sub-n">Stay</span> <span className="todo-stay"><Icon n="bed" /> {value.label || value.id}</span>
        <button type="button" className="link tiny" onClick={() => setPicking(true)}>change</button>
        <button type="button" className="link tiny" onClick={() => onChange(null)}>clear</button>
      </span>
    );
  }
  if (!picking) {
    return (
      <span className="stay-pick">
        <button type="button" className="link tiny" disabled={!unitId} onClick={() => setPicking(true)}
                title={unitId ? 'Tie it to a reservation' : 'Pick a listing first'}><Icon n="bed" /> + stay{unitId ? '' : ' (pick a listing first)'}</button>
      </span>
    );
  }
  return (
    <span className="stay-pick">
      <label className="todo-inline">Day <input type="date" value={day} onChange={e => setDay(e.target.value)} /></label>
      <select value="" disabled={stays === null} onChange={e => {
        const st = (stays ?? []).find(x => x.resId === e.target.value);
        if (st) { onChange({ id: st.resId, label: stayLabel(st.guest, st.arrival, st.departure) }); setPicking(false); }
      }}>
        <option value="">{stays === null ? 'Asking Hostaway…' : stays.length ? 'Which stay?' : 'No stay that day'}</option>
        {(stays ?? []).map(st => <option key={st.resId} value={st.resId}>{stayLabel(st.guest, st.arrival, st.departure)}</option>)}
      </select>
      <button type="button" className="link tiny" onClick={() => setPicking(false)}>cancel</button>
      {err && <span className="breach">▲ {err}</span>}
    </span>
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
  const [stay, setStay] = useState<{ id: string; label: string } | null>(null);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    if (!what.trim() || busy) return;
    if (link.trim() && !cleanCaseUrl(link)) { setErr('The case link is the https:// address of the case.'); return; }
    setBusy(true); setErr('');
    const r = await saveClaim({ unitId: unitId || null, occurredOn: today, category: category || null, severity,
                                status: 'Open', description: what.trim(),
                                reservationId: stay?.id ?? null, reservationLabel: stay?.label ?? null,
                                caseUrl: cleanCaseUrl(link) ?? '' })
      .catch(e => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (r.ok) onSaved(); else setErr(r.error ?? 'Not saved.');
  };

  return (
    <form className="todo-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      <div className="todo-first">
        <b className="todo-adding">⚑ New claim or upsell</b>
        <input className="todo-text" autoFocus value={what} maxLength={500} placeholder="What happened? e.g. guest asked for a 2pm late checkout"
               onChange={e => setWhat(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') onCancel(); }} />
      </div>
      <div className="todo-meta">
        <select value={unitId} onChange={e => { setUnitId(e.target.value); setStay(null); }} aria-label="Unit">
          <option value="">Unit (optional)</option>
          {units.filter(u => u.active).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Kind">
          <option value="">Kind</option>
          <CategoryOptions />
        </select>
        <select value={severity} onChange={e => setSeverity(e.target.value)} aria-label="Severity">
          {CLAIM_SEVERITY.map(s => <option key={s}>{s}</option>)}
        </select>
        <StayPicker unitId={unitId || null} value={stay} onChange={setStay} today={today} />
        <input type="url" className="quick-caselink" value={link} placeholder="Case link (optional) — https://…"
               onChange={e => setLink(e.target.value)} aria-label="Case link" />
        <span className="rb-spacer" />
        <button type="button" className="link tiny" onClick={onCancel}>Cancel</button>
        <button className="small" disabled={!what.trim() || busy}>{busy ? '…' : 'Log claim'}</button>
      </div>
      {err && <p className="banner warn">▲ {err}</p>}
    </form>
  );
}

/**
 * Every field of a claim, changed in place (§86) — what the Claims screen's
 * form does, where the claim is being looked at.
 */
function ClaimEdit({ claim, onDone }: { claim: Claim; onDone: (saved: boolean) => void }) {
  const [c, setC] = useState(claim);
  const [units, setUnits] = useState<Unit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { void getUnits().then(r => setUnits((r.units ?? []).map(u => ({ id: u.id, name: u.name, active: u.active })))); }, []);
  const set = (p: Partial<Claim>) => setC(x => ({ ...x, ...p }));
  const save = async () => {
    if (c.case_url && !cleanCaseUrl(c.case_url)) { setErr('The case link is the https:// address of the case.'); return; }
    setBusy(true); setErr('');
    const r = await saveClaim({ id: c.id, unitId: c.unit_id, occurredOn: c.occurred_on.slice(0, 10), category: c.category,
      severity: c.severity, status: c.status, source: c.source, description: c.description,
      reservationId: c.reservation_id, reservationLabel: c.reservation_label,
      caseUrl: c.case_url ?? '' }).catch(e => ({ ok: false, error: String(e) }));
    setBusy(false);
    if (r.ok) onDone(true); else setErr(r.error ?? 'Not saved.');
  };
  return (
    <div className="claim-edit">
      <label>What happened
        <textarea rows={2} value={c.description ?? ''} onChange={e => set({ description: e.target.value })} /></label>
      <div className="todo-more">
        <label>Unit
          <select value={c.unit_id ?? ''} onChange={e => set({ unit_id: e.target.value || null, reservation_id: null, reservation_label: null })}>
            <option value="">Portfolio-wide</option>
            {units.filter(u => u.active || u.id === c.unit_id).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></label>
        <label>Raised on <input type="date" value={c.occurred_on.slice(0, 10)} onChange={e => set({ occurred_on: e.target.value })} /></label>
        <label>Kind
          <select value={c.category ?? ''} onChange={e => set({ category: e.target.value || null })}>
            <option value="">—</option><CategoryOptions />
          </select></label>
        <label>Severity
          <select value={c.severity} onChange={e => set({ severity: e.target.value })}>{CLAIM_SEVERITY.map(x => <option key={x}>{x}</option>)}</select></label>
        <label>Status
          <select value={c.status} onChange={e => set({ status: e.target.value })}>{CLAIM_STATUS.map(x => <option key={x}>{x}</option>)}</select></label>
        <label>Source
          <select value={c.source ?? ''} onChange={e => set({ source: e.target.value || null })}>
            <option value="">—</option>{CLAIM_SOURCES.map(x => <option key={x}>{x}</option>)}
          </select></label>
        <label className="claim-caselink">Case link (Airbnb, Booking.com, Vrbo…)
          <input type="url" value={c.case_url ?? ''} placeholder="https://www.airbnb.com/mediation/…"
                 onChange={e => set({ case_url: e.target.value || null })} /></label>
        <div className="todo-stay-pick">
          <StayPicker unitId={c.unit_id} today={c.occurred_on.slice(0, 10)}
                      value={c.reservation_id ? { id: c.reservation_id, label: c.reservation_label ?? '' } : null}
                      onChange={x => set({ reservation_id: x?.id ?? null, reservation_label: x?.label ?? null })} />
        </div>
      </div>
      {err && <p className="banner warn">▲ {err}</p>}
      <div className="button-row">
        <button className="small" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save claim'}</button>
        <button className="link tiny" onClick={() => onDone(false)}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * A claim, opened in place (§77) — on the Claims screen and in the work
 * list alike: the work that resolves it (to-dos, work orders, purchase
 * orders), what that work has cost, and the case's timeline.
 *
 * The claim is the CASE; the work is how it gets resolved. §162: what was
 * requested and what was received are typed; the repair work is not — it is
 * the sum of its work orders' and purchase orders' costs.
 */
export function ClaimCase({ claim, canWork, today, onSaved, onRemoved }: {
  claim: Claim; canWork: boolean; today?: DateStr; onSaved?: () => void;
  /** After a removal, so the list can offer Undo (§86). */
  onRemoved?: (c: Claim) => void;
}) {
  const [work, setWork] = useState<Todo[]>([]);
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const remove = async () => {
    const r = await deleteClaim(String(claim.id)).catch(() => ({ ok: false }));
    if (r.ok) { onRemoved?.(claim); onSaved?.(); } else setMsg('Not removed.');
  };
  // Read from the list as it is now, so it moves as work is costed; the server sums the same way (/api/claims).
  const cost = workCost(work);
  const repairWork = work.length ? cost.actual + cost.estimated + cost.bought : Number(claim.repair_work) || 0;
  const day = today ?? new Date().toISOString().slice(0, 10);

  return (
    <div className="claim-case">
      {/* The case itself: edit every field in place, or remove it — named, undoable (§86). */}
      <div className="claim-case-actions">
        {!editing && <button className="link tiny lane-add" onClick={() => setEditing(true)}>✎ Edit claim</button>}
        {claim.case_url ? <CaseLink url={claim.case_url} />
          : !editing && <span className="note">No case link yet — add it in ✎ Edit claim</span>}
        <span className="rb-spacer" />
        {!confirmDel
          ? <button className="link tiny danger" onClick={() => setConfirmDel(true)}>Remove this claim…</button>
          : <><span className="note">Remove the claim “{claimLabel(claim)}”? Its work stays.</span>
              <button className="small danger" onClick={() => void remove()}>Remove</button>
              <button className="link tiny" onClick={() => setConfirmDel(false)}>Keep</button></>}
      </div>
      {editing && <ClaimEdit claim={claim} onDone={saved => { setEditing(false); if (saved) onSaved?.(); }} />}
      {/* §162: Operations sees what the maintenance costs — what was requested and received is Finance's. */}
      <dl className="claim-money">
        <div><dt>Repair work<Hint>Not typed: the sum of this case's work orders (their cost, or the estimate until there is one)
          and what was bought on its purchase orders. Cancelled work counts nothing. Each already reaches Costs on its own.
          What was requested and received is kept by Finance (Revenue → Claims &amp; upselling).</Hint></dt>
          <dd>{money2(repairWork)}{cost.estimated > 0 && <small> incl. ~{money2(cost.estimated)} estimated</small>}</dd></div>
      </dl>
      {canWork && (
        <div className="claim-case-work">
          <div className="claim-case-head">
            <b>Work on this claim</b>
            {work.length > 0 && <span className="note">{cost.open} open</span>}
            {msg && <span className="note">{msg}</span>}
          </div>
          <TodoList today={day} claim={{ id: String(claim.id), unitId: claim.unit_id, reservationId: claim.reservation_id,
                                         reservationLabel: claim.reservation_label }} onChange={setWork} />
        </div>
      )}
      <Timeline defaultOpen title={`${claim.unit_name ?? 'Portfolio'} · ${claim.description || claim.category || 'claim'}`} load={() => getClaimUpdates(String(claim.id))}
                post={async body => (await postClaimNote(String(claim.id), body).catch(() => ({ ok: false }))).ok}
                version={work.length} />
    </div>
  );
}

/**
 * A to-do's files (owner, Oct 2026): photos, PDFs, documents — several at once, kept in Drive. Files sent
 * with the Slack message @Kaizen made the to-do from (or later in its thread) land here too.
 */
function TodoFiles({ todoId }: { todoId: string }) {
  const [files, setFiles] = useState<TodoFile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const take = (r: { ok: true; files: TodoFile[] } | { ok: false; message?: string; error?: string }) =>
    r.ok ? (setFiles(r.files), setMsg('')) : setMsg(r.message ?? r.error ?? 'Not saved.');
  useEffect(() => { void getTodoFiles(todoId).then(take).catch(e => setMsg(String(e))); }, [todoId]);
  const add = async (list: File[]) => {
    if (!list.length) return;
    setBusy(true);
    try { take(await uploadTodoFiles(todoId, list.slice(0, 10))); } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };
  return (
    <section className="todo-files">
      <div className="todo-files-head">
        <b><Icon n="clip" /> Files</b> <span className="sub-n">{files ? files.length : '…'}</span>
        <label className={`chip ${busy ? 'is-busy' : ''}`}>{busy ? 'Uploading…' : '+ Add files'}
          <input type="file" multiple hidden disabled={busy} onChange={e => { void add([...(e.target.files ?? [])]); e.target.value = ''; }} /></label>
        <span className="info-tip" tabIndex={0} role="img" aria-label="Up to 10 at a time, 15 MB each — photos, PDFs, documents"
              title="Up to 10 at a time, 15 MB each — photos, PDFs, documents">ⓘ</span>
      </div>
      {msg && <p className="breach" role="status">{msg}</p>}
      {files && files.length > 0 && (
        <ul className="todo-files-list">
          {files.map(f => (
            <li key={f.id}>
              <a href={f.url} target="_blank" rel="noreferrer" title={`Added by ${f.by.split('@')[0]}${f.source === 'slack' ? ', from Slack' : ''}`}>{ic(f.mime?.startsWith('image/') ? '🖼' : f.mime === 'application/pdf' ? '📄' : '📎')} {f.name}</a>
              <button type="button" className="link tiny" aria-label={`Remove ${f.name}`} title="Take it off the to-do (the Drive copy stays)"
                      onClick={() => void removeTodoFile(f.id).then(take)}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── the done log (§87) ─────────────────────────────────────────────── */

/**
 * Operations → To-do: the open work; the done log is folded into its closed section (§163).
 */
export function WorkView({ today, canClaims, unit, focus }: { today: DateStr; canClaims: boolean; unit?: string; focus?: { todo?: string; claim?: string } }) {
  // The open purchase orders: their own tab, as on Home (owner, Oct 2026).
  const [orderIds, setOrderIds] = useState<Set<string>>(new Set());
  useEffect(() => { getInventory().then(r => { if (r.ok) setOrderIds(new Set(r.orders.map(o => o.todoId))); }).catch(() => {}); }, []);
  return <TodoList key={unit ?? ''} today={today} canClaims={canClaims} orderIds={orderIds} unit={unit} focus={focus} doneLog />;
}

const OUTCOME_WORD = { completed: '✓ Completed', cancelled: '✕ Cancelled', removed: '🗑 Removed' } as const;

/**
 * Every task closed in a range — who closed it, when, how long it took,
 * what it cost — and, if asked, what was removed and by whom. Read from
 * the database as it is; each row opens its whole timeline, read-only.
 * Exports as CSV for whoever audits it.
 */
function DoneLog({ today, canClaims }: { today: DateStr; canClaims: boolean }) {
  const [from, setFrom] = useState(() => {
    const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 30); return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(today);
  const [withRemoved, setWithRemoved] = useState(false);
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [err, setErr] = useState('');
  const [units, setUnits] = useState<Unit[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [who, setWho] = useState('');
  const [kind, setKind] = useState<'' | TaskKind>('');
  const [unit, setUnit] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void getUnits().then(r => setUnits((r.units ?? []).map(u => ({ id: u.id, name: u.name, active: u.active }))
      .sort((a, b) => a.name.localeCompare(b.name))));
    if (canClaims) void getClaims().then(r => setClaims(r.claims ?? []));
  }, []);
  useEffect(() => {
    if (!from || !to || from > to) return;
    setRows(null); setErr('');
    void getDoneLog(from, to, withRemoved).then(r => r.ok ? setRows(r.rows) : (setErr(r.message ?? 'Could not read the log.'), setRows([])))
      .catch(e => { setErr(String(e)); setRows([]); });
  }, [from, to, withRemoved]);

  const names = new Map(units.map(u => [u.id, u.name]));
  const claimNames = new Map(claims.map(c => [String(c.id), claimLabel(c)]));
  const closer = (t: AuditRow) => (t.deletedBy ?? t.doneBy ?? '').split('@')[0] ?? '';
  const people = [...new Set((rows ?? []).map(t => t.deletedBy ?? t.doneBy ?? '').filter(Boolean))].sort();
  const shown = (rows ?? []).filter(t => (!who || (t.deletedBy ?? t.doneBy) === who) && (!kind || t.kind === kind)
    && (!unit || t.unitIds.includes(unit)));
  const nLog = [who, kind, unit, withRemoved ? 'x' : ''].filter(Boolean).length;
  const count = (o: string) => shown.filter(t => outcomeOf(t) === o).length;
  const taken = shown.filter(t => outcomeOf(t) === 'completed').map(t => daysTaken(t) ?? 0).sort((a, b) => a - b);
  const median = taken.length ? taken[Math.floor(taken.length / 2)] : null;
  const repairCost = shown.filter(t => outcomeOf(t) === 'completed').reduce((a, t) => a + (t.costActual ?? 0), 0);

  const exportCsv = () => {
    const csv = auditCsv(shown, id => names.get(id) ?? id, id => claimNames.get(id) ?? `claim ${id}`);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `kaizen-done-log-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="done-log">
      {/* §163: the range stays in sight (it is what the summary counts); who, what, where and removed go behind one button. */}
      <div className="done-bar">
        <label className="todo-inline">From <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
        <label className="todo-inline">to <input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
        <span className="rb-spacer" />
        <Popover label="Log filters" align="right" className="filters-pop"
                 button={<><Icon n="filter" /> Filters{nLog > 0 && <span className="count">{nLog}</span>}</>}>
          <div className="filter-fields">
            <label>Kind
              <select value={kind} onChange={e => setKind(e.target.value as '' | TaskKind)}>
                <option value="">To-dos and repairs</option><option value="task">To-dos</option><option value="work_order">Repairs</option>
              </select></label>
            <label>Closed by
              <select value={who} onChange={e => setWho(e.target.value)}>
                <option value="">Anyone</option>{people.map(p => <option key={p} value={p}>{p.split('@')[0]}</option>)}
              </select></label>
            <label>Listing
              <select value={unit} onChange={e => setUnit(e.target.value)}>
                <option value="">Every listing</option>{units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select></label>
            <label className="check done-removed"><input type="checkbox" checked={withRemoved} onChange={e => setWithRemoved(e.target.checked)} /> Include removed</label>
          </div>
        </Popover>
        <button className="small secondary" disabled={!shown.length} onClick={exportCsv}>Export CSV</button>
      </div>
      {err && <p className="banner warn">▲ {err}</p>}
      {rows === null ? <p className="note loading-dot">Reading the log</p> : (
        <>
          <p className="note done-summary">
            <b>{shown.length}</b> closed · {count('completed')} completed · {count('cancelled')} cancelled
            {withRemoved && <> · {count('removed')} removed</>}
            {median !== null && <> · median {median === 0 ? 'same day' : `${median} day${median === 1 ? '' : 's'}`} to done</>}
            {repairCost > 0 && <> · repairs {money2(repairCost)}</>}
          </p>
          {!shown.length ? <p className="note">Nothing closed in this range.</p> : (
            <ul className="todo-list done-rows">
              {shown.map(t => {
                const o = outcomeOf(t);
                const d = daysTaken(t);
                return (
                  <li key={t.id} className={`todo done-row o-${o}`}>
                    <div className="todo-line">
                      <span className="done-when" title="New York time">{nyParts(t.deletedAt ?? t.doneAt ?? t.createdAt).short}</span>
                      <span className={`done-outcome o-${o}`}>{ic(OUTCOME_WORD[o])}</span>
                      {t.kind === 'work_order' && <span title="Repair"><Icon n="wrench" /></span>}
                      <button className="todo-title" onClick={() => setOpen(open === t.id ? null : t.id)}>{t.title}</button>
                      {t.unitIds.map(id => <span key={id} className="todo-unit">{names.get(id) ?? 'unit'}</span>)}
                      {t.reservationLabel && <span className="todo-stay"><Icon n="bed" /> {t.reservationLabel}</span>}
                      {t.claimId && claimNames.has(t.claimId) && <span className="todo-claim">⚑ {claimNames.get(t.claimId)}</span>}
                      <span className="sub-n">by {closer(t) || '—'}</span>
                      {d !== null && <span className="sub-n">· took {d === 0 ? 'same day' : `${d}d`}</span>}
                      {t.costActual != null && <span className="sub-n">· {money2(t.costActual)}</span>}
                    </div>
                    {open === t.id && (
                      <div className="todo-edit">
                        <p className="note">Written by {t.createdBy?.split('@')[0] ?? '—'} on {nyParts(t.createdAt).short}
                          {t.assignee ? ` · owner ${t.assignee}` : ''}{t.vendor ? ` · vendor ${t.vendor}` : ''}</p>
                        {t.description && <p className="todo-desc-full">{t.description}</p>}
                        <Timeline readOnly title={t.title} load={() => getTaskUpdates(t.id)} post={async () => false} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * §133: the vendor directory as suggestions for a repair's vendor — the field
 * stays free text, for someone not in the list yet. Read once per page.
 */
let vendorCache: Promise<{ name: string; trade: string | null }[]> | null = null;
function VendorOptions() {
  const [list, setList] = useState<{ name: string; trade: string | null }[]>([]);
  useEffect(() => {
    vendorCache ??= getVendors().then(r => r.ok ? r.vendors.filter(x => x.active).map(x => ({ name: x.name, trade: x.trade })) : []).catch(() => []);
    void vendorCache.then(setList);
  }, []);
  return <datalist id="kaizen-vendors">{list.map(x => <option key={x.name} value={x.name}>{x.trade ?? ''}</option>)}</datalist>;
}

/**
 * "+ Purchase order" (owner, 2026-10-14 — §159): what is needed, in anyone's words, and where. It is created as
 * an order and opens on its form, where ✨ Build the cart turns the words into supplies.
 */
function NewOrderForm({ units, onSave, onCancel, unitId: start = '' }: {
  units: Unit[]; onSave: (text: string, unitId: string) => Promise<boolean>; onCancel: () => void;
  /** A claim's listing, pre-set (§162). */ unitId?: string;
}) {
  const [text, setText] = useState('');
  const [unitId, setUnitId] = useState(start);
  const [busy, setBusy] = useState(false);
  return (
    <form className="todo-form new-order" onSubmit={async e => { e.preventDefault(); if (!text.trim() || busy) return; setBusy(true); await onSave(text, unitId); setBusy(false); }}>
      <b className="todo-adding"><Icon n="cart" /> New purchase order</b>
      <textarea className="todo-descin" rows={3} value={text} autoFocus maxLength={4000} aria-label="What is needed"
                placeholder="What is needed — e.g. 2 boxes of trash bags, toilet paper, coffee pods for Napa" onChange={e => setText(e.target.value)} />
      <div className="row">
        <select value={unitId} aria-label="Listing" onChange={e => setUnitId(e.target.value)}>
          <option value="">No listing (stock)</option>
          {units.filter(u => u.active).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <span className="rb-spacer" />
        <button type="button" className="link tiny" onClick={onCancel}>Cancel</button>
        <button className="small" disabled={!text.trim() || busy}>{busy ? 'Creating…' : 'Create and build the cart'}</button>
      </div>
    </form>
  );
}
