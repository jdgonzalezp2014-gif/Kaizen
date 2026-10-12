/**
 * Operations — the day's work, run from here.
 *
 * Kaizen decides who cleans each turnover and what it pays (the daily
 * file's rule, ported in src/lib/operations.ts), people override it per
 * stay, inspections are logged and scheduled here, and in live mode the
 * result is pushed to the Host Note in Hostaway — what the sheet did.
 *
 * Until live, the mode is SHADOW: every row carries the sheet's own
 * decision beside Kaizen's, and nothing leaves Kaizen. That is how the
 * port is trusted before it is relied on.
 *
 * Rows open in place, never in a dialog (§22): the list is what a
 * decision is compared against.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { CleaningCalendar } from '../components/CleaningCalendar.tsx';
import { WorkView } from '../components/Todos.tsx';
import { CrewAdmin } from './Crew.tsx';
import { InventoryView } from './Inventory.tsx';
import { InspectionRun } from '../components/InspectionRun.tsx';
import { visibleAhead } from '../lib/crew.ts';
import { AREAS, type Area, type InspectionItem } from '../lib/inspection.ts';
import { addDays, daysBetween, isDateStr, todayIn } from '../lib/dates.ts';
import { stayLabel } from '../lib/todos.ts';
import {
  getCleanings, type Cleaning, type ExcludedCleaning,
  getOperations, saveTurnover, logInspection, scheduleInspections, cancelInspection,
  getOpsSettings, saveOpsSettings, cutoverImport, can, getGuestDocs, syncAgreement, uploadGuestDoc, getUnits, getTodos,
  type Todo, type HostawayTasksState,
  type StayDocs, type OperationsResponse, type ManualClean, type ManualCleanKind, type StayOnDay,
  getStaysOnDay, manualClean, todoAction, saveClaim, type TurnoverSet, type OpsSettings, type CutoverPreview, type InspectionEntry,
  previewAssign, type AssignPreview, crewLink, crewAdminAction, runAction, inspectionLinkFor, type InspectionLink,
  getInspectionItems, saveInspectionItem, getVendors, saveVendor, type Vendor
} from '../api.ts';
import {
  BEDROOM_SIZES, DEFAULT_CHECKIN_TIME, DEFAULT_CHECKOUT_TIME, INSPECTION_RESULTS,
  HOUSES_ZONE, LEVELS, eligibleInspectors, levelOf, rateFor, summarize, withDefaults,
  type BoardRow, type Cleaner, type InspectionTier, type OpsRules
} from '../lib/operations.ts';
import { money, money2 } from '../lib/format.ts';
import { hostawayReservationUrl } from '../lib/operations.ts';
import { channelLabel } from '../lib/breakdown.ts';
import { Loading } from '../components/Loading.tsx';
import { recallTiming, rememberTiming } from '../lib/progress.ts';

type View = 'board' | 'todos' | 'calendar' | 'cleaners' | 'crew' | 'inspections' | 'inventory' | 'notes' | 'rates' | 'setup';
const VIEWS: View[] = ['board', 'todos', 'calendar', 'cleaners', 'crew', 'inspections', 'inventory', 'notes', 'rates', 'setup'];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Wed, Sep 24" — computed in UTC from the ISO date, so no browser zone can shift it. */
const dayLabel = (d: string) => {
  const t = new Date(`${d}T12:00:00Z`);
  return `${DOW[t.getUTCDay()]}, ${MON[t.getUTCMonth()]} ${t.getUTCDate()}`;
};
const short = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${MON[t.getUTCMonth()]} ${t.getUTCDate()}`; };
const isWeekend = (d: string) => [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());
const URGENCY: Record<string, string> = { turnover: '⚡ same-day', same_guest: '🔁 same guest again' };
const sheetText = (s: { assignment: string; cleaner: string | null }) =>
  s.assignment === 'assigned' ? (s.cleaner ?? '—') : s.assignment === 'not_needed' ? 'no clean needed' : 'unassigned';

/**
 * The row after an edit, recomputed here with the same pure rules the
 * server uses — so a change shows at once instead of after a ten-second
 * trip back through Hostaway.
 */
function applyEdit(r: BoardRow, set: TurnoverSet, roster: Cleaner[], rules: OpsRules): BoardRow {
  const n: BoardRow = { ...r, manual: { ...r.manual } };
  if (set.assignment !== undefined) {
    if (set.assignment === null) {
      // Back to the rule — which, for a second departure the same day,
      // is "no clean needed".
      n.assignment = r.sameDayOf ? 'not_needed' : r.auto.cleaner ? 'assigned' : 'tbd';
      n.cleaner = r.sameDayOf ? null : r.auto.cleaner; n.manual.cleaner = false;
    } else {
      n.assignment = set.assignment;
      n.cleaner = set.assignment === 'assigned' ? (set.cleaner ?? null) : null;
      n.manual.cleaner = true;
    }
  }
  if (set.deep !== undefined) {
    // Regular unless a person says deep (§126).
    n.deep = set.deep ?? false;
    n.manual.deep = set.deep !== null;
  }
  const t = r.kind === 'out' ? set.checkoutTime : set.checkinTime;
  if (t !== undefined) {
    n.time = t || (r.kind === 'out' ? DEFAULT_CHECKOUT_TIME : DEFAULT_CHECKIN_TIME);
    n.manual.time = !!t;
  }
  if (n.kind === 'out') {
    n.price = n.assignment === 'assigned' ? rateFor(roster, n.cleaner, n.beds, n.deep) : null;
    if (n.sheet) {
      const s = n.sheet;
      n.differs = [];
      if (s.assignment !== n.assignment || (n.assignment === 'assigned' && s.cleaner !== n.cleaner)) n.differs.push('cleaner');
      if (n.assignment === 'assigned' && s.assignment === 'assigned' && (s.price ?? null) !== n.price) n.differs.push('price');
      if (s.deep !== n.deep) n.differs.push('deep');
    }
  }
  return n;
}

/**
 * Movements' window (§124): today and the ten days after it unless someone
 * picks other dates. The live board reaches at most 30 days ahead (the
 * server's cap); days before today come from the cleanings record.
 */
const DEFAULT_DAYS = 10;
const MAX_AHEAD = 30;
interface Range { from: string; to: string }
const defaultRange = (today: string): Range => ({ from: today, to: addDays(today, DEFAULT_DAYS) });

export function Operations({ permissions, initialView, onView }: {
  permissions: string[]; initialView?: string;
  /** Told which view is showing, so the top bar's SOPs button can follow it (§92). */
  onView?: (view: string) => void;
}) {
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(true);
  const [view, setView] = useState<View>(VIEWS.includes(initialView as View) ? initialView as View : 'board');
  useEffect(() => { onView?.(view); }, [view]);
  const canTodos = can(permissions, 'todos');
  const nyToday = todayIn('America/New_York');
  const [range, setRange] = useState<Range>(() => defaultRange(nyToday));
  // The live part is loaded from today to the range's end — never fewer than
  // the default days, so the other views keep the window they describe.
  const liveDays = Math.min(MAX_AHEAD, Math.max(DEFAULT_DAYS, daysBetween(nyToday, range.to)));

  // Picking dates can start a load while another is out: only the latest is shown.
  const latest = useRef(0);
  const load = (refresh = false) => {
    const n = ++latest.current;
    setBusy(true); setErr('');
    const started = Date.now();
    getOperations(liveDays, refresh)
      .then(r => {
        if (n !== latest.current) return;
        if (!r.ok) { setErr(r.message ?? r.error ?? 'Could not load.'); return; }
        rememberTiming('operations', Date.now() - started);
        setData(r);
      })
      .catch(e => { if (n === latest.current) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (n === latest.current) setBusy(false); });
  };
  useEffect(() => load(), [liveDays]);

  /** Apply a saved edit to the rows on screen and re-total. */
  const patch = (resId: string, kind: 'in' | 'out', f: (r: BoardRow) => BoardRow) =>
    setData(d => {
      if (!d) return d;
      const rows = d.rows.map(r => r.resId === resId && r.kind === kind ? f(r) : r);
      return { ...d, rows, summary: summarize(rows) };
    });

  const views: [View, string][] = [
    ['board', 'Movements'], ...(canTodos ? [['todos', 'To-do'] as [View, string]] : []), ['calendar', 'Calendar'], ['cleaners', 'By cleaner'], ['crew', 'Crew'], ['inspections', 'Inspections'], ['inventory', 'Inventory'],
    ['notes', 'Notes log'], ['rates', 'Rates & rules'],
    ...(can(data?.permissions, 'operations.setup') ? [['setup', 'Setup'] as [View, string]] : [])
  ];

  return (
    <section>
      <nav className="subtabs">
        {views.map(([k, label]) => (
          <button key={k} className={view === k ? 'tab active' : 'tab'} onClick={() => setView(k)}>{label}</button>
        ))}
      </nav>

      <div className="row-controls">
        {view === 'board'
          ? <MovementsRange range={range} today={nyToday} onChange={setRange} />
          : data && <span className="note">{dayLabel(data.today)} → {dayLabel(data.end)} · New York time</span>}
        <button className="chip" disabled={busy} onClick={() => load(true)}>
          {busy && data ? 'Refreshing…' : 'Refresh'}
        </button>
        {data?.sheetUrl && data.mode === 'shadow' && (
          <a className="chip" href={data.sheetUrl} target="_blank" rel="noreferrer">Open the daily file ↗</a>
        )}
      </div>

      {err && <p className="banner error">{err}</p>}
      {!data && !err && (
        <Loading estimateMs={recallTiming('operations', 10000)}
                 stages={['Fetching reservations from Hostaway…', 'Applying the cleaner rules…',
                          'Checking inspections…', 'Building the board…']} />
      )}
      {data && <ModeBanner data={data} onSetup={() => setView('setup')} />}

      <div className={busy && data ? 'is-stale' : undefined}>
        {data && view === 'board' && <Board data={data} range={range} patch={patch} reload={() => load()} />}
        {view === 'todos' && canTodos && <WorkView today={data?.today ?? todayIn('America/New_York')} canClaims={can(permissions, 'claims')} />}
        {view === 'calendar' && <CleaningsMonth />}
        {data && view === 'cleaners' && <ByCleaner data={data} />}
        {data && view === 'crew' && <CrewAdmin roster={data.roster} canEdit={can(data.permissions, 'operations.edit')} />}
        {data && view === 'inspections' && <Inspections data={data} reload={() => load()} />}
        {data && view === 'inventory' && <InventoryView canEdit={can(data.permissions, 'operations.edit')} canSetup={can(data.permissions, 'operations.setup')} />}
        {data && view === 'notes' && <Notes data={data} />}
        {data && view === 'rates' && <Rates data={data} />}
        {data && view === 'setup' && <Setup data={data} reload={() => load(true)} />}
      </div>
    </section>
  );
}

/**
 * Which system is deciding, said at the top of every view. In shadow
 * mode it also says how often the two agree — the number that decides
 * whether going live is safe.
 */
function ModeBanner({ data, onSetup }: { data: OperationsResponse; onSetup: () => void }) {
  const s = data.summary;
  if (data.mode === 'live') {
    // A refusal because the listing is archived is not a fault to retry —
    // Kaizen no longer asks — so it is not counted as one.
    const failed = data.pushes.filter(p => p.outcome === 'failed' && !/archived listing/i.test(p.detail ?? '')).length;
    return (
      <p className={`banner ${failed ? 'warn' : 'ok'}`}>
        ● <b>Live.</b> Kaizen decides the cleans and writes the Host Note in Hostaway.
        {failed > 0 && <> ▲ {failed} of the last {data.pushes.length} Host Note writes failed — the
          next scheduled pass retries them.</>}
      </p>
    );
  }
  const compared = s.departures - s.notInDailyFile;
  return (
    <div className="banner warn">
      ○ <b>Shadow mode.</b> The daily file still decides and still writes to Hostaway; Kaizen works
      alongside it and writes nothing outside itself. Of {compared} checkout(s) both have seen,{' '}
      <b>{compared - s.differing} agree</b>{s.differing > 0 && <> and <b>{s.differing} differ</b></>}.
      {can(data.permissions, 'operations.setup') && <> <button className="link" onClick={onSetup}>Setup →</button></>}
      {data.sheet?.problem && <div>▲ Daily file: {data.sheet.problem}</div>}
      {data.sheet?.warning && <div>▲ Daily file: {data.sheet.warning}</div>}
    </div>
  );
}

/* ── Movements ───────────────────────────────────────────────────── */

/** Shortcuts for the window; the two dates are for any other. */
const RANGE_PRESETS: [string, (today: string) => Range][] = [
  ['Next 10 days', defaultRange],
  ['Last 7 days', t => ({ from: addDays(t, -7), to: t })],
  ['Next 30 days', t => ({ from: t, to: addDays(t, MAX_AHEAD) })]
];

function MovementsRange({ range, today, onChange }: { range: Range; today: string; onChange: (r: Range) => void }) {
  const last = addDays(today, MAX_AHEAD);
  // A date typed after the other end moves that end along rather than making an empty window.
  const setFrom = (v: string) => { if (isDateStr(v)) { const from = v > last ? last : v; onChange({ from, to: from > range.to ? from : range.to }); } };
  const setTo = (v: string) => { if (isDateStr(v)) { const to = v > last ? last : v; onChange({ from: to < range.from ? to : range.from, to }); } };
  return (
    <>
      {RANGE_PRESETS.map(([label, f]) => {
        const r = f(today);
        return <button key={label} className={r.from === range.from && r.to === range.to ? 'chip active' : 'chip'}
                       onClick={() => onChange(r)}>{label}</button>;
      })}
      <input type="date" className="date-in" value={range.from} max={range.to} onChange={e => setFrom(e.target.value)} />
      <span className="note">to</span>
      <input type="date" className="date-in" value={range.to} min={range.from} max={last} onChange={e => setTo(e.target.value)} />
      <span className="note">New York time · up to {MAX_AHEAD} days ahead</span>
    </>
  );
}

type Filter = 'all' | 'out' | 'in' | 'attention' | 'differs';

/** Everything on a departure that someone has to act on. */
function needsAttention(r: BoardRow, today: string): boolean {
  if (r.kind !== 'out') return false;
  // A clean waiting for a booking (§125) is not the team's problem until the day before.
  const waiting = r.assignment === 'tbd' && !r.manual.cleaner && r.levels?.waiting && r.date > addDays(today, 1);
  return (r.assignment === 'tbd' && !waiting) || (r.assignment === 'assigned' && r.price == null) ||
    r.inspection.key === 'req' || r.inspection.key === 'due' || r.urgency === 'turnover';
}

/**
 * The cleaner already sees this clean on their crew page (§127): assigned,
 * ahead, in view (by hand, close enough, or the schedule published) — and
 * the cleaner can actually sign in or has a link, or nobody sees anything.
 */
function cleanerSees(r: BoardRow, data: OperationsResponse): boolean {
  if (r.kind !== 'out' || r.assignment !== 'assigned' || !r.cleaner || r.date < data.today || !data.crewView) return false;
  const c = data.roster.find(x => x.name === r.cleaner);
  if (!c?.email && !c?.hasLink) return false;
  return visibleAhead({ date: r.date, byHand: r.manual.cleaner }, data.today, data.crewView);
}

const LEVEL_LABEL: Record<string, string> = { high: 'high level', standard: 'standard', manual: 'manual only' };

function Board({ data, range, patch, reload }: {
  data: OperationsResponse; range: Range;
  patch: (id: string, k: 'in' | 'out', f: (r: BoardRow) => BoardRow) => void; reload: () => void;
}) {
  const canEdit = can(data.permissions, 'operations.edit');
  // A manual clean being added (§79): empty, or started from a stay's own row.
  const [addingClean, setAddingClean] = useState<null | { unitId?: string; resId?: string; kind?: ManualCleanKind }>(null);
  const manualBy = useMemo(() => {
    const m = new Map<string, ManualClean[]>();
    for (const c of data.manualCleans ?? []) m.set(c.date, [...(m.get(c.date) ?? []), c]);
    return m;
  }, [data.manualCleans]);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  // The live rows inside the chosen dates; the figures above the table count these.
  const live = useMemo(() => data.rows.filter(r => r.date >= range.from && r.date <= range.to), [data.rows, range]);
  const s = useMemo(() => summarize(live), [live]);

  // Flags by hand (§124), by record key — kept here so a flag shows at once.
  const [flags, setFlags] = useState<Record<string, string>>({});
  useEffect(() => setFlags(Object.fromEntries(Object.entries(data.flags ?? {}).map(([k, f]) => [k, f.note]))), [data.flags]);
  const setFlag = (key: string, note: string | null) => setFlags(f => {
    const n = { ...f };
    if (note === null) delete n[key]; else n[key] = note;
    return n;
  });

  // Days before today are the cleanings record — frozen, what was cleaned and paid —
  // not the live board, which only reaches from today on.
  const hasPast = range.from < data.today;
  const pastTo = range.to < data.today ? range.to : addDays(data.today, -1);
  const [past, setPast] = useState<{ rows: Cleaning[]; excluded: ExcludedCleaning[] } | null>(null);
  const [pastErr, setPastErr] = useState('');
  useEffect(() => {
    setPast(null); setPastErr('');
    if (!hasPast) return;
    let current = true;
    getCleanings(range.from, 'all', [], pastTo, ['tbd', 'not_needed'])
      .then(r => { if (!current) return; if (r.ok) setPast({ rows: r.cleanings, excluded: r.excluded }); else setPastErr('The cleanings record could not be read.'); })
      .catch(e => { if (current) setPastErr(String(e)); });
    return () => { current = false; };
  }, [hasPast, range.from, pastTo]);
  const pastBy = useMemo(() => {
    const m = new Map<string, { rows: Cleaning[]; excluded: ExcludedCleaning[] }>();
    const at = (d: string) => { const k = d.slice(0, 10); if (!m.has(k)) m.set(k, { rows: [], excluded: [] }); return m.get(k)!; };
    for (const c of past?.rows ?? []) at(c.checkout_on).rows.push(c);
    for (const c of past?.excluded ?? []) at(c.checkout_on).excluded.push(c);
    return m;
  }, [past]);
  const pastShown = (c: Cleaning) => {
    const needle = q.trim().toLowerCase();
    if (needle && !`${c.unit_name} ${c.guest ?? ''} ${c.cleaner ?? ''}`.toLowerCase().includes(needle)) return false;
    // A recorded day is departures and manual cleans: no arrivals, nothing to compare with the sheet.
    return filter === 'all' || filter === 'out' || (filter === 'attention' && (c.assignment === 'tbd' || !!c.needs_confirm));
  };
  const pastCleans = (past?.rows ?? []).filter(c => c.assignment === 'assigned');

  // Guest documents (§73): what each arrival has filed, read from Drive
  // when the board loads. Only for roles that may see IDs.
  const canDocs = can(data.permissions, 'guests.documents');
  const [docs, setDocs] = useState<Record<string, StayDocs>>({});
  const [docsErr, setDocsErr] = useState('');
  // Only the units set up to ask for them (Setup → Guest documents) are checked on the board.
  const docUnits = new Set(data.guestDocUnits ?? []);

  // Open to-dos per listing (§76), flagged on the unit's rows.
  const [todos, setTodos] = useState<Todo[]>([]);
  useEffect(() => {
    if (!can(data.permissions, 'todos')) return;
    getTodos().then(r => { if (r.ok) setTodos(r.todos.filter(t => !t.doneAt)); }).catch(() => {});
  }, []);
  const todosBy = useMemo(() => {
    const m = new Map<string, Todo[]>();
    for (const t of todos) for (const u of t.unitIds) m.set(u, [...(m.get(u) ?? []), t]);
    return m;
  }, [todos]);
  const docRows = data.rows.filter(r => r.kind === 'in' && docUnits.has(r.unitId));
  const arrivalsKey = docRows.map(r => `${r.resId}|${r.date}|${r.docName}`).join(',');
  useEffect(() => {
    if (!canDocs || !arrivalsKey) return;
    const stays = docRows.map(r => ({ resId: r.resId, arrival: r.date, name: r.docName }));
    getGuestDocs(stays)
      .then(r => { if (r.ok) { setDocs(r.docs); setDocsErr(''); } else setDocsErr(r.message ?? 'Guest documents could not be read.'); })
      .catch(e => setDocsErr(String(e)));
  }, [canDocs, arrivalsKey]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return live.filter(r =>
      (filter === 'all' || (filter === 'attention' ? needsAttention(r, data.today)
        : filter === 'differs' ? r.differs.length > 0 : r.kind === filter)) &&
      (!needle || `${r.unit} ${r.guest} ${r.cleaner ?? ''}`.toLowerCase().includes(needle)));
  }, [live, filter, q]);

  const days = useMemo(() => {
    // Not past what is loaded: a longer window shows once its load arrives.
    const out: string[] = [];
    const last = range.to < data.end ? range.to : data.end;
    for (let d = range.from; d <= last; d = addDays(d, 1)) out.push(d);
    return out;
  }, [range, data.end]);

  const filters: [Filter, string][] = [
    ['all', 'Everything'], ['out', 'Departures'], ['in', 'Arrivals'],
    ['attention', `Needs attention ${live.filter(r => needsAttention(r, data.today)).length}`],
    ...(data.mode === 'shadow' ? [['differs', `Differs from the sheet ${s.differing}`] as [Filter, string]] : [])
  ];

  return (
    <>
      <dl className="strip">
        <div><dt>Arrivals</dt><dd>{s.arrivals}</dd></div>
        <div><dt>Departures</dt><dd>{s.departures}</dd></div>
        <div><dt>Cleans</dt><dd>{s.cleanings}<small>{s.departures - s.cleanings} not needed</small></dd></div>
        <div><dt>Same-day turnovers</dt><dd>{s.turnovers}</dd></div>
        <div><dt>Inspections due</dt><dd>{s.inspections}</dd></div>
        <div><dt>Cleaner pay</dt><dd>{money(s.cleaningCost)}
          {s.unpriced > 0 && <small>+{s.unpriced} not priced</small>}</dd></div>
        {data.showMoney && <div><dt>Arriving</dt><dd>{money(s.arriving)}</dd></div>}
        {hasPast && past && <div><dt>Before today</dt><dd>{pastCleans.length}
          <small>cleans recorded · {money2(pastCleans.reduce((a, c) => a + Number(c.price ?? 0), 0))}
            {(past.rows.filter(c => c.flag_note).length > 0) && ` · ⚑ ${past.rows.filter(c => c.flag_note).length} flagged`}</small></dd></div>}
      </dl>

      {hasPast && <p className="note">Days before today show the cleanings record — who cleaned, what it paid, what
        was flagged. Arrivals are not kept there, so those days list departures and manual cleans only.
        {range.from < data.today && range.to >= data.today && ' From today on, the live board.'}</p>}
      {hasPast && pastErr && <p className="banner error">▲ {pastErr}</p>}

      {canDocs && docsErr && <p className="banner warn">▲ Guest documents: {docsErr}</p>}

      {data.roster.length === 0 && (
        <p className="banner warn">▲ No cleaners on the roster yet, so every clean reads unassigned.
          {can(data.permissions, 'operations.setup') ? ' Setup → import from the daily file, or add them by hand.' : ' Someone with Operations setup sets it up.'}</p>
      )}

      <div className="row-controls">
        {filters.map(([k, label]) => (
          <button key={k} className={filter === k ? 'chip active' : 'chip'} onClick={() => setFilter(k)}>{label}</button>
        ))}
        <input className="date-in" placeholder="Unit, guest or cleaner" value={q} onChange={e => setQ(e.target.value)} />
        {canEdit && <button className="small secondary" onClick={() => setAddingClean({})}>+ Manual clean</button>}
        {canEdit && <span className="note right">click or tap a row to change it</span>}
        {data.crewView && <span className="note">👁 the cleaner already sees it on their page{data.crewView.published ? '' :
          ` (set by hand, or within ${data.crewView.autoDays} days)`}</span>}
      </div>

      {addingClean && (
        <ManualCleanForm data={data} initial={addingClean} onCancel={() => setAddingClean(null)}
                         onDone={() => { setAddingClean(null); reload(); }} />
      )}

      <div className="grid-scroll">
        <table className="units compact ops-board">
          <thead>
            <tr><th></th><th>Unit</th><th>Guest</th><th>Time</th><th>Next stay</th>
                <th>Cleaner</th><th className="n">Pays</th><th>Flags</th><th>Notes</th></tr>
          </thead>
          {days.map(d => {
            if (d < data.today) {
              const rec = pastBy.get(d);
              const shown = (rec?.rows ?? []).filter(pastShown);
              const voided = filter === 'all' && !q ? rec?.excluded ?? [] : [];
              if (!shown.length && !voided.length && (filter !== 'all' || q)) return null;
              return (
                <tbody key={d}>
                  <tr className="ops-day">
                    <td colSpan={9}>
                      {dayLabel(d)}{isWeekend(d) ? ' · weekend' : ''}
                      <span className="sub-n"> {past ? `${shown.length} recorded${voided.length ? ` · ${voided.length} not paid` : ''}` : '…'}</span>
                    </td>
                  </tr>
                  {past && !shown.length && !voided.length && <tr><td colSpan={9} className="note ops-quiet">no cleans recorded</td></tr>}
                  {shown.map(c => {
                    const key = `rec-${c.key}`;
                    return (
                      <Fragment key={key}>
                        <PastLine c={c} open={open === key} onToggle={() => { if (canEdit) setOpen(open === key ? null : key); }} />
                        {open === key && (
                          <tr className="ops-edit-row"><td colSpan={9}>
                            <div className="ops-editor" onClick={e => e.stopPropagation()}>
                              <FlagControl cleanKey={c.key} flag={c.flag_note ?? null} onChanged={note =>
                                setPast(p => p && { ...p, rows: p.rows.map(x => x.key === c.key ? { ...x, flag_note: note } : x) })}
                                date={c.checkout_on.slice(0, 10)} today={data.today} price={c.price == null ? null : Number(c.price)}
                                onPrice={v => setPast(p => p && { ...p, rows: p.rows.map(x => x.key === c.key ? { ...x, price: String(v) } : x) })} />
                              <div className="note">To switch deep / regular on a clean already done: Operations → Crew → the cleaner → ✎ Correct.</div>
                            </div>
                          </td></tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {voided.map(c => (
                    <tr key={`void-${c.key}`} className="ops-line">
                      <td><span className="ops-kind out">OUT</span></td>
                      <td><b>{c.unit_name}</b></td>
                      <td colSpan={3} className="note">○ not paid — {c.void_reason}</td>
                      <td className="note">{c.cleaner ?? ''}</td>
                      <td></td><td></td><td></td>
                    </tr>
                  ))}
                </tbody>
              );
            }
            const dayRows = rows.filter(r => r.date === d);
            const manual = (manualBy.get(d) ?? []).filter(c => !q || `${c.unit} ${c.guest ?? ''} ${c.cleaner ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
            if (!dayRows.length && !manual.length && (filter !== 'all' || q)) return null;
            return (
              <tbody key={d}>
                <tr className="ops-day">
                  <td colSpan={9}>
                    {dayLabel(d)}{d === data.today ? ' · today' : ''}{isWeekend(d) ? ' · weekend' : ''}
                    <span className="sub-n"> {dayRows.filter(r => r.kind === 'out').length} out · {dayRows.filter(r => r.kind === 'in').length} in
                      {manual.length > 0 && ` · ${manual.length} manual clean${manual.length === 1 ? '' : 's'}`}</span>
                  </td>
                </tr>
                {!dayRows.length && !manual.length && <tr><td colSpan={9} className="note ops-quiet">no arrivals or departures</td></tr>}
                {manual.map(c => <ManualLine key={c.key} c={c} canEdit={canEdit} onChanged={reload} cleanTasks={data.cleanTasks?.[c.key]}
                                             flag={flags[c.key] ?? null} onFlag={note => setFlag(c.key, note)} />)}
                {dayRows.map(r => {
                  const key = `${r.resId}-${r.kind}`;
                  return (
                    <Fragment key={key}>
                      <BoardLine r={r} showMoney={data.showMoney} shadow={data.mode === 'shadow'} through={short(data.lookaheadTo)}
                                 byLevels={data.assignRule === 'levels'} today={data.today}
                                 seen={cleanerSees(r, data)}
                                 docs={canDocs && r.kind === 'in' && docUnits.has(r.unitId) ? docs[r.resId] ?? null : undefined}
                                 todos={todosBy.get(r.unitId)} flag={r.kind === 'out' ? flags[r.resId] : undefined}
                                 cleanTasks={r.kind === 'out' ? data.cleanTasks?.[r.resId] : undefined}
                                 open={open === key} onToggle={() => {
                                   // Read-only roles see the board; the editor is not offered.
                                   if (can(data.permissions, 'operations.edit')) setOpen(open === key ? null : key);
                                 }} />
                      {open === key && (
                        <tr className="ops-edit-row"><td colSpan={9}>
                          <Editor r={r} data={data} docs={canDocs && r.kind === 'in' ? docs[r.resId] : undefined}
                                  flag={flags[r.resId] ?? null} onFlag={note => setFlag(r.resId, note)}
                                  onManualClean={kind => setAddingClean({ unitId: r.unitId, resId: r.resId, kind })}
                                  onDocs={d => setDocs(m => ({ ...m, [r.resId]: d }))} onSaved={(set, note) => {
                            patch(r.resId, r.kind, row => {
                              const n = set ? applyEdit(row, set, data.roster, data.rules) : row;
                              return note !== undefined ? { ...n, note } : n;
                            });
                          }} />
                        </td></tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      </div>
    </>
  );
}

function BoardLine({ r, showMoney, shadow, open, onToggle, through, docs, todos, byLevels, today, flag, seen, cleanTasks }: {
  /** §133: what an inspection asked this clean to do. */
  cleanTasks?: string[];
  r: BoardRow; showMoney: boolean; shadow: boolean; open: boolean; onToggle: () => void;
  /** Flagged by hand (§124): the note the cleaner reads. */
  flag?: string;
  /** Whether the levels rule decides (§125), or rides along beside the rule in charge. */
  byLevels: boolean; today: string;
  /** The cleaner can already see this clean on their page (§127). */
  seen?: boolean;
  /** An arrival's filed documents: undefined = not shown to this role, null = still reading. */
  docs?: StayDocs | null;
  /** Open to-dos about this unit. */
  todos?: Todo[];
  /** How far ahead the next booking was looked for — "nothing" means nothing up to here. */
  through: string;
}) {
  const out = r.kind === 'out';
  return (
    <tr className={`ops-line ${open ? 'open' : ''}`} onClick={onToggle}>
      <td><span className={`ops-kind ${r.kind}`}>{out ? 'OUT' : 'IN'}</span></td>
      <td><b>{r.unit}</b>{r.beds ? <span className="sub-n"> {r.beds}BR</span> : null}</td>
      <td>
        {r.guest || <span className="note">—</span>}
        {' '}<a className="ops-hostaway" href={hostawayReservationUrl(r.resId)} target="_blank" rel="noreferrer"
                onClick={e => e.stopPropagation()} title="Open the reservation in Hostaway">↗</a>
        <div className="sub-n">
          {r.nights} night{r.nights === 1 ? '' : 's'}{r.guests ? ` · ${r.guests} guests` : ''}
          {r.channel ? ` · ${channelLabel(r.channel)}` : ''}
          {showMoney && r.total > 0 ? ` · ${money(r.total)}` : ''}
        </div>
      </td>
      <td className={r.manual.time ? 'ops-manual' : undefined}>{r.time}</td>
      <td data-label={out ? 'Next stay' : undefined}>
        {!out ? (r.preppedBy ? <span className="sub-n">prepped by {r.preppedBy}</span> : null)
          : !r.next ? <span className="breach">▲ nothing booked through {through}</span>
          : (<>
              {short(r.next.arrival)}{' '}
              {r.next.gapDays === 0 ? <b className="breach">same day</b>
                : <span className={r.next.longVacancy ? 'breach' : 'sub-n'}>+{r.next.gapDays}d</span>}
              {showMoney && r.next.total != null && <div className="sub-n">{money(r.next.total)}</div>}
            </>)}
      </td>
      <td data-label={out ? 'Cleaner' : undefined}>
        {out && (
          <>
            <span className={r.assignment === 'tbd' ? 'breach' : r.assignment === 'not_needed' ? 'note' : undefined}>
              {r.assignment === 'tbd' ? '▲ ' : ''}{r.assignment === 'assigned' ? r.cleaner : r.assignment === 'not_needed' ? 'no clean needed' : 'unassigned'}
            </span>
            {seen && <span title={`${r.cleaner} sees this on their crew page`}> 👁</span>}
            {r.manual.cleaner && <span className="sub-n"> · set by hand</span>}
            {r.carried && <div className="sub-n" title={r.auto.reason}>↪ kept from the {short(r.carried.fromDate)} checkout — a booking came in between</div>}
            {/* "★4 · Veronica ★5 ✓": what the clean needs against what the cleaner has. */}
            {/* The level the clean needs, or why it waits (§125). */}
            {byLevels && r.levels && r.assignment !== 'not_needed' && !r.manual.cleaner && (
              r.levels.required ? <div className="sub-n" title={r.levels.why}>{LEVEL_LABEL[r.levels.required]}</div>
              : r.date <= addDays(today, 1) ? <div className="breach" title={r.levels.why}>▲ assign by hand — {r.levels.why}</div>
              : <div className="sub-n" title={r.levels.why}>○ waiting for a booking — TBD until {short(addDays(r.date, -1))}</div>
            )}
            {!byLevels && r.levels && r.assignment !== 'not_needed' && r.levels.cleaner !== r.cleaner && (
              <div className="ops-diff" title={`${r.levels.why} — ${r.levels.reason}`}>by levels: {r.levels.cleaner ?? (r.levels.waiting ? 'TBD (waiting)' : 'TBD')}</div>
            )}
            {r.sameDayOf && !r.manual.cleaner && <div className="sub-n">another stay leaves today — one clean</div>}
            {r.declined.length > 0 && (
              <div className={r.assignment === 'tbd' ? 'breach' : 'sub-n'}>
                {r.declined.map(d => `▲ declined by ${d.cleaner}${d.reason ? ` — “${d.reason}”` : ''}`).join(' · ')}
              </div>
            )}
            {shadow && r.differs.includes('cleaner') && r.sheet && <div className="ops-diff">sheet: {sheetText(r.sheet)}</div>}
            {shadow && !r.inDailyFile && <div className="sub-n">not in the daily file yet</div>}
          </>
        )}
      </td>
      <td className="n">
        {out && r.assignment === 'assigned' && (r.price == null ? <span className="note">not priced</span> : money2(r.price))}
        {shadow && r.differs.includes('price') && r.sheet?.price != null && <div className="ops-diff">sheet: {money2(r.sheet.price)}</div>}
      </td>
      <td>
        {r.cancelled && <span className="ops-flag urgent" title={r.auto.reason}>▲ cancelled {r.cancelled} — {r.manual.cleaner ? 'confirmed' : 'confirm who cleaned'}</span>}
        {cleanTasks?.length ? <span className="ops-flag due" title={cleanTasks.map(t => `🧾 ${t}`).join('\n')}>🧾 {cleanTasks.length} from the inspection</span> : null}
        {r.deep && <span className="ops-flag deep">🧽 deep · confirmed</span>}
        {r.kind === 'out' && !r.deep && r.deepSuggested && !r.manual.deep &&
          <span className="sub-n" title="A long stay — confirm it in the row if it will be cleaned as deep">○ deep suggested ({r.nights} nights)</span>}
        {shadow && r.differs.includes('deep') && <span className="ops-diff">sheet: {r.sheet?.deep ? 'deep' : 'not deep'}</span>}
        {r.urgency && URGENCY[r.urgency] && <span className="ops-flag urgent">{URGENCY[r.urgency]}</span>}
        {r.inspection.key === 'req' && <span className="ops-flag req" title={r.inspection.reason}>🔍 required</span>}
        {r.inspection.key === 'due' && <span className="ops-flag due" title={r.inspection.reason}>🔍 monthly</span>}
        {r.inspection.key === 'ok' && <span className="ops-flag ok" title={r.inspection.reason}>✓ inspected</span>}
        {(() => {
          // Open work on this unit: repairs said apart from to-dos, the titles on hover.
          const wo = (todos ?? []).filter(t => t.kind === 'work_order');
          const td = (todos ?? []).filter(t => t.kind !== 'work_order');
          return <>
            {wo.length > 0 && <span className="ops-flag urgent" title={wo.map(t => `🔧 ${t.title}`).join('\n')}>
              🔧 {wo.length} work order{wo.length === 1 ? '' : 's'}</span>}
            {td.length > 0 && <span className="ops-flag due" title={td.map(t => `☐ ${t.title}`).join('\n')}>
              ☐ {td.length} to-do{td.length === 1 ? '' : 's'}</span>}
          </>;
        })()}
        {/* The agreement: signed in Hostaway's guest portal, or its PDF filed in Drive (§89). */}
        {r.kind === 'in' && (r.agreement || docs) && (() => {
          const signed = r.agreement === 'signed' || !!docs?.agreement.length;
          return <span className={`ops-flag ${signed ? 'ok' : 'urgent'}`} title={signed ? 'Rental agreement signed' : 'Rental agreement not signed yet'}>
            {signed ? '✓ signed' : '▲ not signed'}</span>;
        })()}
        {/* The ID: verified in Hostaway for every guest; a copy in Drive where the building needs one (§89). */}
        {r.kind === 'in' && r.idVerified && <span className="ops-flag ok" title="ID verified in Hostaway">✓ ID verified</span>}
        {docs !== undefined && (docs === null ? <span className="ops-flag ok">… Drive</span>
          : <span className={`ops-flag ${docs.id.length ? 'ok' : 'missing'}`} title="A copy of the ID in the reservation's Drive folder">
              {docs.id.length ? '✓' : '○'} ID in Drive</span>)}
      </td>
      <td className="ops-note">
        {r.note}
        {flag && <div className="breach">⚑ Flagged: {flag}</div>}
      </td>
    </tr>
  );
}

/**
 * Flag a clean by hand (§122; from Movements, §124): a note the cleaner
 * reads on their crew page — and, for a clean already due, the pay
 * corrected in the same step (§128), with the note as the reason.
 */
function FlagControl({ cleanKey, flag, onChanged, date, today, price, onPrice }: {
  cleanKey: string; flag: string | null; onChanged: (note: string | null) => void;
  /** When given and due (today or before), the flag can also correct the pay. */
  date?: string; today?: string; price?: number | null; onPrice?: (price: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [pay, setPay] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const canPay = !!date && !!today && date <= today;
  const send = async (note: string | null) => {
    setBusy(true); setMsg('');
    const r = await crewAdminAction(note === null ? { action: 'unflag', key: cleanKey }
      : { action: 'flag', key: cleanKey, note, ...(canPay && pay !== '' ? { price: Number(pay) } : {}) })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
    if (note !== null && canPay && pay !== '') onPrice?.(Number(pay));
    setEditing(false); setText(''); setPay(''); onChanged(note);
  };
  return (
    <div className="button-row ops-manual-actions" onClick={e => e.stopPropagation()}>
      {flag
        ? <><span className="breach">⚑ Flagged: {flag}</span>
            <button className="link tiny" disabled={busy} onClick={() => void send(null)}>Remove flag</button></>
        : !editing && <><button className="link tiny" onClick={() => setEditing(true)}>⚑ Flag this clean…</button>
            <span className="note">the cleaner reads it on their crew page{canPay ? '; you can correct the pay with it' : ''}</span></>}
      {editing && (
        <form className="stay-work" onSubmit={e => { e.preventDefault(); if (text.trim()) void send(text.trim()); }}>
          <input autoFocus value={text} maxLength={500} placeholder="What the cleaner should know (they read this)"
                 onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setEditing(false); }} />
          {canPay && <input className="amt" inputMode="decimal" value={pay} onChange={e => setPay(e.target.value)}
                            placeholder={price != null ? `pays ${price}` : 'pay'} title="Leave blank to keep the pay as it is" />}
          <button className="small" disabled={!text.trim() || busy || (pay !== '' && !(Number(pay) >= 0))}>
            {busy ? '…' : pay !== '' ? 'Flag and correct pay' : 'Flag'}</button>
          <button type="button" className="link tiny" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      )}
      {msg && <span className="breach">▲ {msg}</span>}
    </div>
  );
}

/** A day before today, as the cleanings record has it (§124): who cleaned, what it paid, what was flagged. */
function PastLine({ c, open, onToggle }: { c: Cleaning; open: boolean; onToggle: () => void }) {
  const manual = !!c.kind && c.kind !== 'checkout';
  return (
    <tr className={`ops-line ${open ? 'open' : ''}`} onClick={onToggle}>
      <td><span className={`ops-kind ${manual ? 'clean' : 'out'}`}>{manual ? 'CLEAN' : 'OUT'}</span></td>
      <td><b>{c.unit_name}</b></td>
      <td>
        {manual ? (MANUAL_WORD[c.kind as ManualCleanKind] ?? 'Manual clean') : (c.guest || <span className="note">—</span>)}
        {manual && c.guest && <div className="sub-n">{c.guest}</div>}
        {!manual && /^\d+$/.test(c.key) && <>{' '}<a className="ops-hostaway" href={hostawayReservationUrl(c.key)} target="_blank" rel="noreferrer"
            onClick={e => e.stopPropagation()} title="Open the reservation in Hostaway">↗</a></>}
      </td>
      <td>{c.checkout_time ?? ''}</td>
      <td></td>
      <td data-label="Cleaner">
        {c.assignment === 'assigned' ? c.cleaner
          : c.assignment === 'tbd' ? <span className="breach">▲ unassigned</span>
          : <span className="note">no clean needed</span>}
        {c.needs_confirm && <div className="breach">▲ {c.needs_confirm}</div>}
      </td>
      <td className="n">{c.assignment === 'assigned' && (c.price == null ? <span className="note">not priced</span> : money2(Number(c.price)))}</td>
      <td>
        {c.deep && <span className="ops-flag deep">🧽 deep</span>}
        {c.edit_note && <span className="ops-flag due" title={c.edit_note}>✎ corrected</span>}
      </td>
      <td className="ops-note">
        {c.reservation_note}
        {c.flag_note && <div className="breach">⚑ Flagged: {c.flag_note}</div>}
      </td>
    </tr>
  );
}

/** One stay's controls, opened in place under its row. */
function Editor({ r, data, onSaved, docs, onDocs, onManualClean, flag, onFlag }: {
  r: BoardRow; data: OperationsResponse; onSaved: (set: TurnoverSet | null, note?: string) => void;
  /** The clean's flag by hand (§124), and what to do when it changes. */
  flag: string | null; onFlag: (note: string | null) => void;
  /** Start a manual clean for this stay (§79): the guest left early, or a mid-stay clean. */
  onManualClean: (kind: ManualCleanKind) => void;
  /** Present only for an arrival, for a role with guests.documents. */
  docs: StayDocs | undefined; onDocs: (d: StayDocs) => void;
}) {
  const out = r.kind === 'out';
  const [time, setTime] = useState(r.manual.time ? r.time : '');
  const [note, setNote] = useState(r.note);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const active = data.roster.filter(c => c.active);

  const send = async (set: TurnoverSet | null, text?: string) => {
    setBusy(true); setMsg('');
    const r2 = await saveTurnover({
      resId: r.resId, set: set ?? undefined,
      note: text !== undefined ? { kind: out ? 'checkout' : 'checkin', text } : undefined,
      unitId: r.unitId, unit: r.unit, guest: r.guest,
      checkIn: r.kind === 'in' ? r.date : undefined
    }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r2.ok) { setMsg(r2.message ?? 'Could not save.'); return; }
    onSaved(set, text);
    setMsg(!r.listed ? 'Saved in Kaizen. This listing is archived in Hostaway, which refuses notes on it — nothing was sent.'
      : r2.push === 'queued' ? 'Saved — the Host Note is being updated in Hostaway.'
      : 'Saved in Kaizen. Shadow mode: nothing is written to Hostaway.');
  };

  const cleanerValue = !r.manual.cleaner ? '__rule'
    : r.assignment === 'assigned' ? `c:${r.cleaner}` : r.assignment;

  return (
    <div className="ops-editor" onClick={e => e.stopPropagation()}>
      {!r.listed && <div className="note">○ This listing is archived in Hostaway. Changes are kept in Kaizen; Hostaway refuses notes on an archived listing, so none is sent.</div>}
      {out && (
        <div className="ops-editor-why">
          <b>The rule says {r.auto.cleaner ?? 'nobody'}</b> — {r.auto.reason}.
          {r.sheet && <> The daily file has <b>{sheetText(r.sheet)}</b>{r.sheet.price != null ? ` at ${money2(r.sheet.price)}` : ''}.</>}
          {data.assignRule !== 'levels' && r.levels && (
            <div>By levels (not deciding yet): <b>{r.levels.cleaner ?? 'TBD'}</b> — {r.levels.required ? LEVEL_LABEL[r.levels.required] : 'no level yet'}
              ({r.levels.why}) — {r.levels.reason}.</div>
          )}
        </div>
      )}
      <div className="row">
        {out && (
          <label>Cleaner
            <select disabled={busy} value={cleanerValue} onChange={e => {
              const v = e.target.value;
              void send(v === '__rule' ? { assignment: null }
                : v.startsWith('c:') ? { assignment: 'assigned', cleaner: v.slice(2) }
                : { assignment: v as 'tbd' | 'not_needed' });
            }}>
              <option value="__rule">By the rule{r.auto.cleaner ? ` (${r.auto.cleaner})` : ''}</option>
              {active.map(c => <option key={c.name} value={`c:${c.name}`}>{c.name} — {LEVEL_LABEL[levelOf(c)]}</option>)}
              <option value="tbd">Unassigned (TBD)</option>
              <option value="not_needed">No clean needed</option>
            </select>
          </label>
        )}
        {out && (
          <label>Deep clean
            <select disabled={busy} value={r.deep ? 'yes' : 'rule'}
                    onChange={e => void send({ deep: e.target.value === 'yes' ? true : null })}>
              <option value="rule">Regular (default){r.deepSuggested ? ` — deep suggested: ${r.nights}-night stay` : ''}</option>
              <option value="yes">Deep — confirmed</option>
            </select>
            <span className="sub-n">A deep clean is paid only once someone confirms it here.</span>
          </label>
        )}
        <label>{out ? 'Checkout time' : 'Check-in time'}
          <input disabled={busy} value={time} placeholder={out ? DEFAULT_CHECKOUT_TIME : DEFAULT_CHECKIN_TIME}
                 onChange={e => setTime(e.target.value)}
                 onBlur={() => {
                   if (time === (r.manual.time ? r.time : '')) return;
                   void send(out ? { checkoutTime: time || null } : { checkinTime: time || null });
                 }} />
        </label>
      </div>
      <label>{out ? 'Check-out note' : 'Check-in note'}
        <textarea rows={2} disabled={busy} value={note} onChange={e => setNote(e.target.value)} />
      </label>
      <div className="button-row">
        <button className="small" disabled={busy || note === r.note} onClick={() => void send(null, note)}>Save note</button>
        {msg && <span className="note">{msg}</span>}
      </div>
      {out && r.assignment !== 'not_needed' && <FlagControl cleanKey={r.resId} flag={flag} onChanged={onFlag}
                                                             date={r.date} today={data.today} price={r.price} />}
      {(can(data.permissions, 'todos') || can(data.permissions, 'claims')) && <StayWork r={r} data={data} />}
      {out && (
        <div className="button-row ops-manual-actions">
          <span className="note">Cleaned outside the checkout?</span>
          <button className="link tiny" onClick={() => onManualClean('early_departure')}
                  title="The unit is cleaned now; this checkout's clean becomes “no clean needed”">Guest left early…</button>
          <button className="link tiny" onClick={() => onManualClean('mid_stay')}>+ Mid-stay clean</button>
        </div>
      )}
      {!out && can(data.permissions, 'guests.documents') && <GuestDocs r={r} docs={docs} onDocs={onDocs} required={(data.guestDocUnits ?? []).includes(r.unitId)} />}
    </div>
  );
}

/* ── work for a stay (§84) ────────────────────────────────────────── */

/**
 * A to-do or a claim about THIS stay, started from its row — tied to the
 * reservation, its unit and its guest, the way a manual clean is.
 */
function StayWork({ r, data }: { r: BoardRow; data: OperationsResponse }) {
  const [mode, setMode] = useState<null | 'todo' | 'claim'>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const arrival = r.kind === 'in' ? r.date : addDays(r.date, -r.nights);
  const departure = r.kind === 'in' ? addDays(r.date, r.nights) : r.date;
  const label = stayLabel(r.guest, arrival, departure);

  const save = async () => {
    if (!text.trim() || busy) return;
    setBusy(true); setMsg('');
    const res = mode === 'todo'
      ? await todoAction({ action: 'create', title: text.trim(), unitIds: [r.unitId], reservationId: r.resId, reservationLabel: label })
          .catch(e => ({ ok: false as const, message: String(e) }))
      : await saveClaim({ unitId: r.unitId, occurredOn: data.today, severity: 'Medium', status: 'Open', description: text.trim(),
                          refund: 0, repairCost: 0, reservationId: r.resId, reservationLabel: label })
          .then(x => x.ok ? { ok: true as const } : { ok: false as const, message: x.error })
          .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (res.ok) { setMsg(mode === 'todo' ? '✓ Added — it is in To-do, tied to this stay.' : '✓ Claim logged — it is in Claims, tied to this stay.');
                  setText(''); setMode(null); }
    else setMsg(('message' in res && res.message) || 'Not saved.');
  };

  return (
    <div className="button-row ops-manual-actions">
      <span className="note">🛏 {label}</span>
      {!mode && can(data.permissions, 'todos') && <button className="link tiny" onClick={() => setMode('todo')}>+ To-do for this stay</button>}
      {!mode && can(data.permissions, 'claims') && <button className="link tiny" onClick={() => setMode('claim')}>+ Claim for this stay</button>}
      {mode && (
        <form className="stay-work" onSubmit={e => { e.preventDefault(); void save(); }}>
          <input autoFocus value={text} maxLength={mode === 'todo' ? 120 : 500}
                 placeholder={mode === 'todo' ? 'What needs doing? e.g. Return the parking pass' : 'What happened? e.g. Guest reports no hot water'}
                 onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setMode(null); }} />
          <button className="small" disabled={!text.trim() || busy}>{busy ? '…' : mode === 'todo' ? 'Add to-do' : 'Log claim'}</button>
          <button type="button" className="link tiny" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {msg && <span className="note">{msg}</span>}
    </div>
  );
}

/* ── manual cleans (§79) ──────────────────────────────────────────── */

const MANUAL_WORD: Record<ManualCleanKind, string> = {
  early_departure: 'Guest left early', mid_stay: 'Mid-stay clean', extra: 'Extra clean'
};

/** A manual clean on its day: what, who, what it pays — and a way to undo it. */
function ManualLine({ c, canEdit, onChanged, flag, onFlag, cleanTasks }: {
  c: ManualClean; canEdit: boolean; onChanged: () => void;
  /** §133: what an inspection asked this clean to do. */
  cleanTasks?: string[];
  /** Flagged by hand (§124): the note the cleaner reads. */
  flag: string | null; onFlag: (note: string | null) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const cancel = async () => {
    setBusy(true); setErr('');
    const r = await manualClean({ action: 'cancel', key: c.key }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (r.ok) onChanged(); else setErr(r.message ?? 'Not cancelled.');
  };
  return (
    <tr className="ops-line ops-manual">
      <td><span className="ops-kind clean">CLEAN</span></td>
      <td><b>{c.unit}</b></td>
      <td>{MANUAL_WORD[c.kind]}{c.guest ? <div className="sub-n">{c.guest}</div> : null}</td>
      <td></td>
      <td className="sub-n">{c.kind === 'early_departure' ? 'checkout clean → not needed' : ''}</td>
      <td>{c.cleaner ?? <span className="breach">▲ unassigned</span>}</td>
      <td className="n">{c.price != null ? money2(c.price) : c.cleaner ? <span className="note">not priced</span> : null}</td>
      <td>{c.deep && <span className="ops-flag deep">🧽 deep</span>}
        {cleanTasks?.length ? <span className="ops-flag due" title={cleanTasks.map(t => `🧾 ${t}`).join('\n')}>🧾 {cleanTasks.length} from the inspection</span> : null}</td>
      <td className="ops-note">
        {c.note}
        {canEdit && c.cleaner ? <FlagControl cleanKey={c.key} flag={flag} onChanged={onFlag} />
          : flag && <div className="breach">⚑ Flagged: {flag}</div>}
        {canEdit && (!confirm
          ? <div><button className="link tiny danger" onClick={() => setConfirm(true)}>cancel…</button></div>
          : <div><span className="note">Cancel this clean{c.kind === 'early_departure' ? ' (the checkout clean comes back)' : ''}? </span>
              <button className="small danger" disabled={busy} onClick={() => void cancel()}>Cancel it</button>{' '}
              <button className="link tiny" onClick={() => setConfirm(false)}>keep</button></div>)}
        {err && <div className="breach">▲ {err}</div>}
      </td>
    </tr>
  );
}

/**
 * Add a manual clean: a unit, a day, why, which stay, who. For "guest left
 * early" the stay is required — its checkout clean is what becomes "no
 * clean needed"; for a mid-stay clean it is optional; an extra clean has
 * none. The stays are asked of Hostaway for that unit and day.
 */
function ManualCleanForm({ data, initial, onDone, onCancel }: {
  data: OperationsResponse; initial: { unitId?: string; resId?: string; kind?: ManualCleanKind };
  onDone: () => void; onCancel: () => void;
}) {
  const [units, setUnits] = useState<{ id: string; name: string }[]>([]);
  const [unitId, setUnitId] = useState(initial.unitId ?? '');
  const [date, setDate] = useState(data.today);
  const [kind, setKind] = useState<ManualCleanKind>(initial.kind ?? 'mid_stay');
  const [stays, setStays] = useState<StayOnDay[] | null>(null);
  const [resId, setResId] = useState(initial.resId ?? '');
  const [cleaner, setCleaner] = useState('');
  const [deep, setDeep] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const active = data.roster.filter(c => c.active);

  useEffect(() => {
    void getUnits().then(r => setUnits((r.units ?? []).filter(u => u.active).map(u => ({ id: u.id, name: u.name }))
      .sort((a, b) => a.name.localeCompare(b.name))));
  }, []);
  // Who was staying in that unit that day — asked of Hostaway, now.
  useEffect(() => {
    if (!unitId || kind === 'extra') { setStays(null); return; }
    setStays(null);
    void getStaysOnDay(unitId, date).then(r => {
      if (!r.ok) { setErr(r.message ?? 'Could not ask Hostaway.'); setStays([]); return; }
      setStays(r.stays);
      setResId(prev => r.stays.some(s => s.resId === prev) ? prev : r.stays.length === 1 ? r.stays[0]!.resId : '');
    });
  }, [unitId, date, kind]);

  const needsStay = kind === 'early_departure';
  const save = async () => {
    setBusy(true); setErr('');
    const r = await manualClean({ action: 'create', unitId, date, kind, reservationId: kind === 'extra' ? null : resId || null,
                                  cleaner: cleaner || null, deep, note: note || null })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (r.ok) onDone(); else setErr(r.message ?? 'Not saved.');
  };

  return (
    <div className="card ops-manual-form">
      <h3>Manual clean</h3>
      <div className="todo-kind" role="group" aria-label="Why">
        {(['early_departure', 'mid_stay', 'extra'] as ManualCleanKind[]).map(k => (
          <button key={k} type="button" className={kind === k ? 'chip active' : 'chip'} onClick={() => setKind(k)}>{MANUAL_WORD[k]}</button>
        ))}
      </div>
      {kind === 'early_departure' && <p className="note">The unit is cleaned on this day, and the stay's checkout clean becomes
        “no clean needed” — it is not cleaned twice. Cancelling this puts the checkout clean back.</p>}
      <div className="row">
        <label>Unit
          <select value={unitId} onChange={e => { setUnitId(e.target.value); setResId(''); }}>
            <option value="">Choose…</option>
            {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></label>
        <label>Day cleaned
          <input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        {kind !== 'extra' && (
          <label>Stay {needsStay ? '' : '(optional)'}
            <select value={resId} disabled={!unitId || stays === null} onChange={e => setResId(e.target.value)}>
              <option value="">{!unitId ? 'Choose a unit first' : stays === null ? 'Asking Hostaway…' : stays.length ? (needsStay ? 'Which stay?' : 'None') : 'No stay that day'}</option>
              {(stays ?? []).map(s => <option key={s.resId} value={s.resId}>{s.guest || 'Guest'} · {short(s.arrival)} → {short(s.departure)}</option>)}
            </select></label>
        )}
        <label>Cleaner
          <select value={cleaner} onChange={e => setCleaner(e.target.value)}>
            <option value="">Not assigned yet</option>
            {active.map(c => <option key={c.name} value={c.name}>{c.name} — {LEVEL_LABEL[levelOf(c)]}</option>)}
          </select></label>
        <label className="check"><input type="checkbox" checked={deep} onChange={e => setDeep(e.target.checked)} /> Deep clean</label>
      </div>
      <label>Note <input value={note} maxLength={500} placeholder="e.g. guest checked out at 7am, left keys in the lockbox"
                         onChange={e => setNote(e.target.value)} /></label>
      {err && <p className="banner warn">▲ {err}</p>}
      <div className="button-row">
        <button disabled={busy || !unitId || !date || (needsStay && !resId)} onClick={() => void save()}>{busy ? 'Saving…' : 'Add clean'}</button>
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <span className="note">Paid at the cleaner's rate for the unit's size; it counts in Costs and the calendar like any clean.</span>
      </div>
    </div>
  );
}

/**
 * An arrival's ID and rental agreement (§73), in the reservation's own
 * Drive folders — the same ones the daily file used. Opening it asks
 * Hostaway about the signed agreement and files the PDF if Hostaway has
 * it and the folder is still empty. The ID only ever arrives by upload:
 * Hostaway never exposes it.
 */
function GuestDocs({ r, docs, onDocs, required }: {
  r: BoardRow; docs: StayDocs | undefined; onDocs: (d: StayDocs) => void;
  /** This unit is set up to ask for them (Setup → Guest documents). */
  required: boolean;
}) {
  const [hostaway, setHostaway] = useState<{ signed: boolean; available: boolean; pulled: boolean } | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    syncAgreement(r.resId).then(x => {
      if (!live) return;
      if (x.ok) { setHostaway(x); onDocs(x.docs); } else setErr(x.message ?? 'Hostaway could not be asked.');
    }).catch(e => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [r.resId]);

  const upload = async (kind: 'id' | 'agreement', list: FileList | null) => {
    const files = [...(list ?? [])];
    for (const [i, f] of files.entries()) {
      setBusy(`Uploading ${i + 1} of ${files.length}…`); setErr('');
      const x = await uploadGuestDoc(r.resId, kind, f).catch(e => ({ ok: false as const, message: String(e) }));
      if (x.ok) onDocs(x.docs); else { setErr(`${f.name}: ${x.message ?? 'failed'}`); break; }
    }
    setBusy('');
  };

  return (
    <div className="ops-docs">
      <div className="ops-docs-head">
        <b>Guest documents</b>
        {!required && <span className="note">not asked for at this unit (Setup → Guest documents) — filing is optional</span>}
        {docs?.folderUrl && <a href={docs.folderUrl} target="_blank" rel="noreferrer">Drive folder ↗</a>}
        <span className="note">
          {!hostaway ? 'asking Hostaway about the agreement…'
            : hostaway.pulled ? '✓ signed agreement filed from Hostaway just now'
            : hostaway.signed ? (hostaway.available ? '✓ signed in Hostaway' : '✓ signed in Hostaway — PDF not ready yet')
            : '○ agreement not signed in Hostaway yet'}
        </span>
      </div>
      <div className="ops-docs-cols">
        <DocDrop title="ID" files={docs?.id} busy={busy} onFiles={l => void upload('id', l)} />
        <DocDrop title="Rental agreement" files={docs?.agreement} busy={busy} onFiles={l => void upload('agreement', l)} />
      </div>
      {err && <p className="banner warn">▲ {err}</p>}
    </div>
  );
}

function DocDrop({ title, files, busy, onFiles }: {
  title: string; files: StayDocs['id'] | undefined; busy: string; onFiles: (l: FileList | null) => void;
}) {
  const [hot, setHot] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  return (
    <div className="ops-docs-col">
      <div className="ops-docs-title">{files?.length ? '✓' : '○'} {title}</div>
      {files === undefined ? <div className="note loading-dot">Reading</div>
        : !files.length ? <div className="note">Nothing filed.</div>
        : files.map(f => <a key={f.fileId} className="ops-docs-file" href={f.url} target="_blank" rel="noreferrer" title={f.name}>{f.name}</a>)}
      <div className={`rb-drop-zone ${hot ? 'hot' : ''}`} onClick={() => !busy && picker.current?.click()}
           onDragOver={e => { e.preventDefault(); setHot(true); }} onDragLeave={() => setHot(false)}
           onDrop={e => { e.preventDefault(); setHot(false); if (!busy) onFiles(e.dataTransfer.files); }}>
        {busy || 'Drop a file, or click'}
        <input ref={picker} type="file" multiple hidden onChange={e => { onFiles(e.target.files); e.target.value = ''; }} />
      </div>
    </div>
  );
}

/* ── By cleaner — what their tab in the sheet showed ──────────────── */

function ByCleaner({ data }: { data: OperationsResponse }) {
  const jobs = data.rows.filter(r => r.kind === 'out' && r.assignment === 'assigned' && r.cleaner);
  const names = useMemo(() => {
    const set = new Set<string>(data.roster.filter(c => c.active).map(c => c.name));
    jobs.forEach(j => set.add(j.cleaner!));
    return [...set];
  }, [data]);
  const [who, setWho] = useState<string>(() => names[0] ?? '');
  const mine = jobs.filter(j => j.cleaner === who);
  const unassigned = data.rows.filter(r => r.kind === 'out' && r.assignment === 'tbd');
  const pay = mine.reduce((a, j) => a + (j.price ?? 0), 0);
  const unpriced = mine.filter(j => j.price == null).length;

  return (
    <>
      <div className="row-controls">
        {names.map(n => (
          <button key={n} className={who === n ? 'chip active' : 'chip'} onClick={() => setWho(n)}>
            {n} <b>{jobs.filter(j => j.cleaner === n).length}</b>
          </button>
        ))}
      </div>
      <dl className="strip">
        <div><dt>Cleans</dt><dd>{mine.length}</dd></div>
        <div><dt>Deep</dt><dd>{mine.filter(j => j.deep).length}</dd></div>
        <div><dt>Same-day</dt><dd>{mine.filter(j => j.urgency === 'turnover').length}</dd></div>
        <div><dt>Pays, through {short(data.end)}</dt><dd>{money2(pay)}{unpriced > 0 && <small>+{unpriced} not priced</small>}</dd></div>
      </dl>
      <table className="units compact">
        <thead><tr><th>Day</th><th>Unit</th><th>Checkout</th><th>Next guest</th><th>Flags</th><th className="n">Pays</th><th>Notes</th></tr></thead>
        <tbody>
          {mine.map(j => (
            <tr key={j.resId}>
              <td>{dayLabel(j.date)}</td>
              <td><b>{j.unit}</b>{j.beds ? <span className="sub-n"> {j.beds}BR</span> : null}</td>
              <td>{j.time}</td>
              <td>{j.next ? (j.next.gapDays === 0 ? <b className="breach">same day</b> : `${short(j.next.arrival)} · +${j.next.gapDays}d`)
                : <span className="note">nothing booked through {short(data.lookaheadTo)}</span>}</td>
              <td>
                {j.deep && <span className="ops-flag deep">🧽 deep</span>}
                {(j.inspection.key === 'req' || j.inspection.key === 'due') && <span className="ops-flag due">🔍 inspection</span>}
              </td>
              <td className="n">{j.price == null ? <span className="note">not priced</span> : money2(j.price)}</td>
              <td className="ops-note">{j.note}</td>
            </tr>
          ))}
          {!mine.length && <tr><td colSpan={7} className="note">No cleans for {who || 'anyone'} through {short(data.end)}.</td></tr>}
        </tbody>
      </table>
      {unassigned.length > 0 && (
        <div className="group">
          <h3>Nobody on these yet <span className="count">{unassigned.length}</span></h3>
          <table className="units compact"><tbody>
            {unassigned.map(r => <tr key={r.resId}><td>{dayLabel(r.date)}</td><td><b>{r.unit}</b></td>
              <td className="breach">▲ unassigned</td></tr>)}
          </tbody></table>
        </div>
      )}
    </>
  );
}

/* ── Inspections ──────────────────────────────────────────────────── */

const TIER: Record<InspectionTier, [string, string]> = {
  never: ['tone-bad', 'never inspected'], overdue: ['tone-bad', 'overdue'],
  soon: ['tone-warn', 'due soon'], ok: ['tone-ok', 'current']
};

function Inspections({ data, reload }: { data: OperationsResponse; reload: () => void }) {
  const st = data.rules;
  const count = (t: InspectionTier) => data.panel.filter(p => p.tier === t).length;
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState<InspectionEntry | null>(null);
  const hasHistory = data.inspectionLog.done.length + data.inspectionLog.scheduled.length > 0;
  const canEdit = can(data.permissions, 'operations.edit');
  // §133: the inspection open in the checklist sheet.
  const [run, setRun] = useState<string | null>(null);
  // §135: the scheduled inspection whose link is open.
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const start = async (body: Record<string, unknown>) => {
    setMsg('');
    const r = await runAction<{ id: string }>({ action: 'start', ...body }).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Could not start.'); return; }
    setRun(r.id);
  };

  const schedule = async () => {
    setMsg('Scheduling…');
    const r = await scheduleInspections().catch(e => ({ ok: false as const, message: String(e) }));
    setMsg(r.ok ? `${r.added} booked at each unit's next checkout${r.proposed > r.added ? ` (${r.proposed - r.added} were already booked)` : ''}.`
                : (r.message ?? 'Failed.'));
    if (r.ok) reload();
  };

  return (
    <>
      <dl className="strip">
        <div><dt>Never inspected</dt><dd>{count('never')}</dd></div>
        <div><dt>Overdue</dt><dd>{count('overdue')}</dd></div>
        <div><dt>Due soon</dt><dd>{count('soon')}</dd></div>
        <div><dt>Current</dt><dd>{count('ok')}</dd></div>
        <div><dt>Scheduled</dt><dd>{data.inspectionLog.scheduled.length}</dd></div>
      </dl>
      <p className="note">
        Every unit at least every <b>{st.inspectionIntervalDays} days</b> (amber from day {st.inspectionSoonDays}),
        and before any booking of <b>{data.showMoney ? money(st.inspectionValueTrigger) : 'high value'}</b>.
        The inspector is never the person who cleaned.
        {!hasHistory && ' No inspection is recorded in Kaizen yet, so no unit is called overdue — import the daily file\'s log in Setup, or log them here.'}
      </p>

      {run && <InspectionRun id={run} canEdit={canEdit} onClose={changed => { setRun(null); if (changed) reload(); }} />}
      {canEdit && <InspectStart data={data} onStart={b => void start(b)} onScheduled={reload} />}
      <InspectionCalendar data={data} onOpen={e => { if (!e.result) { if (canEdit) void start({ inspectionId: e.id }); } else if (e.checklist) setRun(e.id); }} />

      <div className="group">
        <h3>Scheduled <span className="count">{data.inspectionLog.scheduled.length}</span>{' '}
          {canEdit && <button className="link" onClick={() => void schedule()}>Auto-schedule what is due</button>}</h3>
        {msg && <p className="note">{msg}</p>}
        <div className="grid-scroll"><table className="units compact"><tbody>
          {data.inspectionLog.scheduled.map(e => (
            <Fragment key={e.id}>
            <tr>
              <td>{e.date}</td><td><b>{e.unit}</b></td><td>{e.by}</td>
              <td className="ops-note">{e.sentBy && <div><b>📨 Sent from the link by {e.sentBy}</b> — review and finish</div>}{e.notes}</td>
              <td className="n">{canEdit && <>
                <button className="small" onClick={() => void start({ inspectionId: e.id })}>▶ {e.sentBy ? 'Review' : e.started ? 'Continue' : 'Start'}</button>{' '}
                <button className="small secondary" onClick={() => setLinkFor(linkFor === e.id ? null : e.id)}>🔗 Link</button>{' '}
                <button className="link tiny danger" onClick={() => void cancelInspection(e.id).then(reload)}>cancel</button>
              </>}</td>
            </tr>
            {linkFor === e.id && <tr><td colSpan={5}><InspectionLinkPanel id={e.id} unit={e.unit} date={e.date} inspector={e.by} onClose={() => setLinkFor(null)} /></td></tr>}
            </Fragment>
          ))}
          {!data.inspectionLog.scheduled.length && <tr><td className="note">Nothing scheduled.</td></tr>}
        </tbody></table></div>
      </div>

      {hasHistory && (
        <div className="grid-scroll"><table className="units compact">
          <thead><tr><th></th><th>Unit</th><th>Last inspected</th><th>By</th><th>Result</th><th>Big booking ahead</th><th>Scheduled</th></tr></thead>
          <tbody>
            {data.panel.map(p => (
              <tr key={p.unitId}>
                <td><span className={`light ${TIER[p.tier][0]}`} /></td>
                <td><b>{p.unit}</b><div className="sub-n">{TIER[p.tier][1]}</div></td>
                <td>{p.last ? <>{p.last} <span className="sub-n">· {p.daysSince}d ago</span></> : <span className="note">never</span>}</td>
                <td>{p.lastBy}</td>
                <td>{p.lastResult}{p.lastNotes && <div className="sub-n">{p.lastNotes}</div>}</td>
                <td>{p.nextBig ? <>{short(p.nextBig.arrival)}{data.showMoney && <span className="sub-n"> · {money(p.nextBig.total)}</span>}</> : ''}</td>
                <td>{p.scheduled ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      <div className="group">
        <h3>Inspection log <span className="count">{data.inspectionLog.done.length}</span></h3>
        <div className="grid-scroll"><table className="units compact">
          <thead><tr><th>Date</th><th>Unit</th><th>By</th><th>Result</th><th>Notes</th><th></th></tr></thead>
          <tbody>
            {data.inspectionLog.done.slice(0, 60).map(e => (
              <tr key={e.id}>
                <td>{e.date}</td><td>{e.unit}</td><td>{e.by}</td>
                <td className={/urgent|maintenance/i.test(e.result) ? 'breach' : undefined}>{e.result}</td>
                <td className="ops-note">{e.notes}</td>
                <td>{e.checklist && <button className="link tiny" onClick={() => setRun(e.id)}>View report</button>}</td>
              </tr>
            ))}
            {!data.inspectionLog.done.length && <tr><td colSpan={5} className="note">Nothing logged yet.</td></tr>}
          </tbody>
        </table></div>
      </div>

      {canEdit && (
        <details className="group">
          <summary className="note">Log a past inspection without the checklist</summary>
          <InspectionForm data={data} editing={editing} onDone={() => { setEditing(null); reload(); }} />
        </details>
      )}
    </>
  );
}

/**
 * §135: the inspector's link for one scheduled inspection — no account, it
 * opens /report on that unit and day. WhatsApp first, like a clean's helper
 * link; the inspector sends, the team reviews and finishes here.
 */
function InspectionLinkPanel({ id, unit, date, inspector, onClose }: { id: string; unit: string; date: string; inspector: string; onClose: () => void }) {
  const [l, setL] = useState<InspectionLink | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    inspectionLinkFor(id).then(r => r.ok ? setL(r) : setMsg(r.message ?? 'No link.')).catch(e => setMsg(String(e)));
  }, [id]);
  if (!l) return <p className={msg ? 'breach' : 'note loading-dot'}>{msg || 'Making the link…'}</p>;
  const text = `Inspection of ${unit} on ${date}${inspector ? ` (${inspector})` : ''}. Open this link, go room by room, and send it when you finish: ${l.link}`;
  return (
    <div className="ops-form">
      <p><b>Link for {unit}, {date}</b> — no sign-in; it works only for this inspection, until {l.expires}.
        The inspector answers and sends; findings become work only when you finish it here.</p>
      <p className="note" style={{ overflowWrap: 'anywhere', fontFamily: 'ui-monospace, monospace', userSelect: 'all' }}>{l.link}</p>
      <div className="button-row">
        <button onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noreferrer')}>💬 Send on WhatsApp</button>
        <button className="secondary" onClick={() => void navigator.clipboard.writeText(l.link).then(() => setMsg('Copied.'), () => setMsg('Select the link above and copy it.'))}>📋 Copy link</button>
        <a className="link" href={l.link} target="_blank" rel="noreferrer">Open it ↗</a>
        <button className="link" onClick={onClose}>Close</button>
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}

/**
 * §133: start an inspection now, or put one on the calendar. The inspector
 * is anyone who did not clean the unit last — an inspection audits the clean.
 */
function InspectStart({ data, onStart, onScheduled }: {
  data: OperationsResponse; onStart: (b: Record<string, unknown>) => void; onScheduled: () => void;
}) {
  const units = useMemo(() => data.panel.map(p => ({ id: p.unitId, name: p.unit })).sort((a, b) => a.name.localeCompare(b.name)), [data.panel]);
  const [unitId, setUnitId] = useState('');
  const [date, setDate] = useState(data.today);
  const [by, setBy] = useState('');
  const [msg, setMsg] = useState('');
  const unit = units.find(u => u.id === unitId)?.name ?? '';
  const cleanedBy = data.rows.filter(r => r.kind === 'out' && r.unitId === unitId && r.date <= date && r.cleaner).map(r => r.cleaner).pop() ?? null;
  const who = eligibleInspectors(data.roster, data.extraInspectors, cleanedBy);
  const schedule = async () => {
    setMsg('');
    const r = await logInspection({ unit, date, inspector: by, result: null, notes: '' }).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Not scheduled.'); return; }
    setMsg(`Scheduled: ${unit} on ${date}.`); onScheduled();
  };
  return (
    <div className="card ops-form">
      <h2>Inspect a unit</h2>
      <div className="row">
        <label>Unit<select value={unitId} onChange={e => setUnitId(e.target.value)}>
          <option value="">—</option>{units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label>Day<input type="date" value={date} min={data.today} onChange={e => setDate(e.target.value)} /></label>
        <label>Inspector<select value={by} onChange={e => setBy(e.target.value)}>
          <option value="">—</option>{who.map(n => <option key={n}>{n}</option>)}</select></label>
      </div>
      {cleanedBy && <p className="note">{cleanedBy} cleaned {unit} last, so is not offered as the inspector.</p>}
      <div className="button-row">
        <button disabled={!unitId || !by || date !== data.today} onClick={() => onStart({ unitId, date, inspector: by })}>▶ Inspect now</button>
        <button className="secondary" disabled={!unitId || !by} onClick={() => void schedule()}>Schedule for {date === data.today ? 'today' : date}</button>
        {msg && <span className="note">{msg}</span>}
      </div>
      <p className="note">The checklist follows the unit's bedrooms and bathrooms. Edit it in Setup → Inspection checklist.</p>
    </div>
  );
}

/** §133: the month's inspections — scheduled (○) and done (✓ / ▲) — by unit and inspector. */
function InspectionCalendar({ data, onOpen }: { data: OperationsResponse; onOpen: (e: InspectionEntry) => void }) {
  const all = [...data.inspectionLog.scheduled, ...data.inspectionLog.done];
  const [month, setMonth] = useState(data.today.slice(0, 7));
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [...Array(first.getUTCDay()).fill(null),
    ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  const shift = (k: number) => { const d = new Date(Date.UTC(y, m - 1 + k, 1)); setMonth(d.toISOString().slice(0, 7)); };
  const mark = (e: InspectionEntry) => !e.result ? (e.started ? '◐' : '○') : /urgent|maintenance/i.test(e.result) ? '▲' : '✓';
  return (
    <div className="card">
      <div className="crew-cal-head">
        <button className="chip" onClick={() => shift(-1)}>‹</button>
        <h2>Inspections · {MON[m - 1]} {y}</h2>
        <button className="chip" onClick={() => shift(1)}>›</button>
      </div>
      <div className="crew-cal">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="crew-cal-dow">{d}</div>)}
        {cells.map((d, i) => d === null ? <div key={i} /> : (
          <div key={d} className={`crew-cal-day${d === data.today ? ' today' : ''}`}>
            <div className="crew-cal-n">{Number(d.slice(8))}</div>
            {all.filter(e => e.date === d).map(e => (
              <button key={e.id} className={`link crew-cal-item ${/urgent|maintenance/i.test(e.result) ? 'flag' : !e.result ? 'ahead' : 'done'}`}
                      title={`${e.unit} · ${e.by || 'no inspector'}${e.result ? ` · ${e.result}` : ''}`} onClick={() => onOpen(e)}>
                {mark(e)} {/\d{3,}$/.exec(e.unit.trim())?.[0] ?? e.unit.trim().split(/\s+/)[0]}</button>
            ))}
          </div>
        ))}
      </div>
      <p className="note">○ scheduled · ◐ started · ✓ done · ▲ maintenance needed or urgent. Tap one to start, continue or open its report.</p>
    </div>
  );
}

function InspectionForm({ data, editing, onDone }: { data: OperationsResponse; editing: InspectionEntry | null; onDone: () => void }) {
  const units = useMemo(() => [...new Set(data.panel.map(p => p.unit))].sort(), [data.panel]);
  const [unit, setUnit] = useState('');
  const [date, setDate] = useState(data.today);
  const [by, setBy] = useState('');
  const [result, setResult] = useState<string>('OK');
  const [notes, setNotes] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!editing) return;
    setUnit(editing.unit); setDate(editing.date > data.today ? data.today : editing.date);
    setBy(editing.by); setNotes(editing.notes.replace(/^⏳ Auto-scheduled · /, ''));
  }, [editing]);

  // The last clean in this unit on or before the day — they may not inspect it.
  const cleanedBy = data.rows.filter(r => r.kind === 'out' && r.unit === unit && r.date <= date && r.cleaner)
    .map(r => r.cleaner).pop() ?? null;
  const who = eligibleInspectors(data.roster, data.extraInspectors, cleanedBy);

  const save = async () => {
    const r = await logInspection({ id: editing?.id, unit, date, inspector: by, result, notes,
      reservationId: editing?.reservationId ?? null }).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Could not save.'); return; }
    setMsg('Logged.'); setNotes(''); onDone();
  };

  return (
    <div className="card ops-form">
      <h2>{editing ? `Close the scheduled inspection — ${editing.unit}` : 'Log an inspection'}</h2>
      <div className="row">
        <label>Unit<select value={unit} onChange={e => setUnit(e.target.value)} disabled={!!editing}>
          <option value="">—</option>{units.map(u => <option key={u}>{u}</option>)}</select></label>
        <label>Date<input type="date" value={date} max={data.today} onChange={e => setDate(e.target.value)} /></label>
        <label>Inspected by<select value={by} onChange={e => setBy(e.target.value)}>
          <option value="">—</option>{who.map(n => <option key={n}>{n}</option>)}</select></label>
        <label>Result<select value={result} onChange={e => setResult(e.target.value)}>
          {INSPECTION_RESULTS.map(x => <option key={x}>{x}</option>)}</select></label>
      </div>
      {cleanedBy && <p className="note">{cleanedBy} cleaned {unit} last, so is not offered as the inspector.</p>}
      <label>Notes<textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} /></label>
      <div className="button-row">
        <button disabled={!unit || !by} onClick={() => void save()}>Log it</button>
        {editing && <button className="secondary" onClick={onDone}>Cancel</button>}
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}

/* ── Notes log ────────────────────────────────────────────────────── */

function Notes({ data }: { data: OperationsResponse }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'checkin' | 'checkout'>('all');
  const needle = q.trim().toLowerCase();
  const list = data.noteLog.filter(n => (kind === 'all' || n.kind === kind) &&
    (!needle || `${n.unit ?? ''} ${n.guest ?? ''} ${n.notes}`.toLowerCase().includes(needle)));
  return (
    <>
      <div className="row-controls">
        {([['all', 'All'], ['checkin', 'Check-in'], ['checkout', 'Check-out']] as const).map(([k, l]) => (
          <button key={k} className={kind === k ? 'chip active' : 'chip'} onClick={() => setKind(k)}>{l}</button>
        ))}
        <input className="date-in" placeholder="Search unit, guest or note" value={q} onChange={e => setQ(e.target.value)} />
        <span className="note right">every change is a row — notes are never edited in place</span>
      </div>
      <table className="units compact">
        <thead><tr><th>Logged</th><th>Check-in</th><th>Unit</th><th>Guest</th><th>Type</th><th>Note</th><th>By</th></tr></thead>
        <tbody>
          {list.slice(0, 200).map((n, i) => (
            <tr key={i}>
              <td className="sub-n">{n.loggedAt}</td><td>{n.checkIn ?? ''}</td><td>{n.unit}</td><td>{n.guest}</td>
              <td>{n.kind === 'checkin' ? 'Check-in' : 'Check-out'}</td>
              <td className="ops-note">{n.notes || <span className="note">cleared</span>}</td>
              <td className="sub-n">{n.by}</td>
            </tr>
          ))}
          {!list.length && <tr><td colSpan={7} className="note">No notes yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

/* ── Rates & rules (read-only) ────────────────────────────────────── */

function RateTable({ roster }: { roster: Cleaner[] }) {
  const cell = (v: number | null | undefined) => v == null ? <span className="note">—</span> : money(v);
  return (
    <table className="units compact">
      <thead><tr><th>Cleaner</th><th>Level</th><th>Zones</th><th className="n">Max a day</th>
        {BEDROOM_SIZES.map(b => <th key={b} className="n">{b}BR</th>)}
        {BEDROOM_SIZES.map(b => <th key={`d${b}`} className="n">Deep {b}BR</th>)}</tr></thead>
      <tbody>
        {roster.map(c => (
          <tr key={c.name} className={c.active ? undefined : 'muted-row'}>
            <td><b>{c.name}</b>{!c.active && <span className="sub-n"> inactive</span>}</td>
            <td>{LEVEL_LABEL[levelOf(c)]}</td><td>{c.zones.length ? c.zones.join(', ') : 'all'}</td>
            <td className="n">{c.maxPerDay ?? <span className="note">no limit</span>}</td>
            {BEDROOM_SIZES.map(b => <td key={b} className="n">{cell(c.rates[b])}</td>)}
            {/* A blank deep rate falls back to the ordinary one — shown as such. */}
            {BEDROOM_SIZES.map(b => <td key={`d${b}`} className="n">{c.deepRates[b] != null ? money(c.deepRates[b]!)
              : <span className="note">{c.rates[b] != null ? `= ${money(c.rates[b]!)}` : '—'}</span>}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Rates({ data }: { data: OperationsResponse }) {
  const st = data.rules;
  return (
    <>
      {data.roster.length ? <RateTable roster={data.roster} /> : <p className="note">No roster yet.</p>}
      <div className="group">
        <h3>How a cleaner is chosen {data.assignRule === 'levels' ? '— by levels' : `— by ${data.assignRule} (levels shown beside, not deciding yet)`}</h3>
        <LevelRules rules={st} />
      </div>
      <div className="group">
        <h3>The tier rule {data.assignRule === 'tiers' ? '(deciding now)' : '(not deciding)'}</h3>
        <ul className="note">
          <li>Outgoing stay of <b>{st.longStayPromoteNights}+ nights</b> → high tier, whatever comes next.</li>
          <li>Next booking within <b>{st.nextResValueHorizonDays} days</b> worth <b>{money(st.cleanerHighThreshold)}+</b> → high tier;
            <b> {money(st.cleanerLowThreshold)} or less</b> → low tier; in between, or nothing booked → mid tier.</li>
          <li>The first cleaner in a tier is the one picked.</li>
          <li>Every clean is <b>regular</b> unless someone confirms it as deep; a stay of {st.deepCleanNights}+ nights only suggests it.</li>
          <li>A gap of <b>{st.longVacancyDays}+ days</b> before the next guest is flagged as a long vacancy.</li>
        </ul>
      </div>
    </>
  );
}

/** The levels rule in words, from the saved (or proposed) numbers (§125). */
function LevelRules({ rules: r }: { rules: OpsRules }) {
  return (
    <ul className="note">
      <li>A stay of <b>{r.levelLongStayNights}+ nights</b> with no mid-stay clean in its last {r.levelMidStayDays} days → <b>high level</b>.</li>
      <li>Otherwise the <b>next guest</b> decides — only one checking in fewer than {r.levelNextWithinDays} days after the checkout:
        {' '}{money(r.levelHighFromNightly)}+/night → high level; less → standard.</li>
      <li>Nothing booked, or the next check-in {r.levelNextWithinDays}+ days away → <b>TBD</b>, waiting for a booking; the day before,
        it asks to be assigned by hand.</li>
      <li>Picked: active, not manual-only, the level or above, covers the zone, under their max that day → the <b>cheapest</b> for
        the unit's size; a tie goes to whoever has fewer cleans that day. Nobody → TBD. High-level cleans are filled first.
        A choice made by hand always wins and uses one of that cleaner's slots.</li>
      <li>Zones: an apartment's building (CL, P2), or Houses. A cleaner with no zone ticked covers all of them.</li>
    </ul>
  );
}

/* ── Setup (admin) ────────────────────────────────────────────────── */

const RULE_LABELS: [keyof OpsRules, string][] = [
  ['cleanerHighThreshold', 'High tier from ($, next booking)'],
  ['cleanerLowThreshold', 'Low tier up to ($, next booking)'],
  ['longStayPromoteNights', 'Long-stay promotion (nights)'],
  ['deepCleanNights', 'Suggest a deep clean from (nights)'],
  ['nextResValueHorizonDays', 'Next-booking horizon (days)'],
  ['longVacancyDays', 'Long vacancy (days)'],
  ['inspectionIntervalDays', 'Inspection interval (days)'],
  ['inspectionSoonDays', 'Inspection due soon (days)'],
  ['inspectionValueTrigger', 'Inspection before a booking of ($)']
];

function Setup({ data, reload }: { data: OperationsResponse; reload: () => void }) {
  const [cfg, setCfg] = useState<OpsSettings | null>(null);
  const [roster, setRoster] = useState<Cleaner[]>([]);
  const [rules, setRules] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState<CutoverPreview | null>(null);
  const [sheetOff, setSheetOff] = useState(false);

  const fetchCfg = () => getOpsSettings().then(r => {
    if (!r.ok) return;
    setCfg(r); setRoster(r.roster);
    setRules(Object.fromEntries(Object.entries(r.rules).map(([k, v]) => [k, String(v)])));
    setExtra(r.extraInspectors.join(', '));
  });
  useEffect(() => { void fetchCfg(); }, []);
  const say = (ok: boolean, text: string) => setMsg({ ok, text });

  const save = async (body: Record<string, unknown>, done: string) => {
    const r = await saveOpsSettings(body).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { say(false, r.message ?? 'Could not save.'); return; }
    say(true, done + ('adopted' in r && r.adopted ? ` ${r.adopted} decision(s) the sheet had made by hand were kept as overrides.` : ''));
    await fetchCfg(); reload();
  };
  const runImport = async (commit: boolean) => {
    say(true, commit ? 'Importing…' : 'Reading the daily file…');
    const r = await cutoverImport(commit).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { say(false, r.message ?? 'Failed.'); return; }
    setPreview(r.preview);
    say(true, commit ? 'Imported.' : 'Preview below — nothing written yet.');
    if (commit) { await fetchCfg(); reload(); }
  };
  const setCard = (i: number, which: 'rates' | 'deepRates', b: string, v: string) =>
    setRoster(rs => rs.map((c, j) => j !== i ? c : { ...c, [which]: { ...c[which], [b]: v === '' ? null : Number(v) } }));
  const setField = <K extends keyof Cleaner>(i: number, k: K, v: Cleaner[K]) =>
    setRoster(rs => rs.map((c, j) => j === i ? { ...c, [k]: v } : c));

  if (!cfg) return <p className="note loading-dot">Loading setup…</p>;
  const shared = data.summary.departures - data.summary.notInDailyFile;

  return (
    <>
      {msg && <p className={`banner ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</p>}

      <div className="card">
        <h2>Who decides <span className={cfg.mode === 'live' ? 'ok-tag' : 'chan-tag'}>{cfg.mode}</span></h2>
        {cfg.mode === 'shadow' ? (
          <>
            <p className="note">
              Kaizen is computing beside the daily file: <b>{shared - data.summary.differing}</b> of {shared} shared
              checkouts agree right now. Going live makes Kaizen the one that decides and writes the Host Note in
              Hostaway. Any decision the sheet made by hand is kept as an override, so nothing on the board changes
              under anyone on the day.
            </p>
            <ol className="note">
              <li>Import the daily file's roster, rules and logs below (previewed first).</li>
              <li>In the daily file: 🏠 Kaizen → 🚫 <b>Disable automatic Hostaway push</b>, and stop running 📅 Next 10 Days.</li>
              <li>Confirm and switch.</li>
            </ol>
            <label className="check"><input type="checkbox" checked={sheetOff} onChange={e => setSheetOff(e.target.checked)} />
              The daily file no longer writes to Hostaway</label>
            <div className="button-row">
              <button disabled={!sheetOff} onClick={() => void save({ mode: 'live', confirmSheetOff: true }, 'Kaizen is live.')}>Go live</button>
            </div>
          </>
        ) : (
          <>
            <p className="note">Kaizen decides and writes the Host Note. Going back to shadow stops the writes at once;
              the daily file would need its push switched back on to take over again.</p>
            <div className="button-row">
              <button className="secondary" onClick={() => void save({ mode: 'shadow' }, 'Back in shadow mode.')}>Back to shadow</button>
            </div>
            <h3 className="note">Last Host Note writes</h3>
            <table className="units compact"><tbody>
              {data.pushes.slice(0, 12).map((p, i) => (
                <tr key={i}><td className="sub-n">{p.at}</td><td>{p.resId}</td>
                  <td className={p.outcome === 'failed' ? 'breach' : undefined}>{p.outcome}</td>
                  <td className="ops-note">{p.detail}</td></tr>
              ))}
              {!data.pushes.length && <tr><td className="note">None yet.</td></tr>}
            </tbody></table>
          </>
        )}
      </div>

      <div className="card">
        <h2>Import from the daily file</h2>
        <p className="note">
          Its roster and both rate cards, its rules, the Inspection Log and the Notes Log — read from the published links in
          Settings → Daily file. Running it again replaces what an earlier import brought; anything entered in Kaizen is never
          touched. In Kaizen now: {cfg.counts.inspections} inspection(s), {cfg.counts.notes} note(s), {cfg.counts.overrides} override(s).
        </p>
        <div className="button-row">
          <button className="secondary" onClick={() => void runImport(false)}>Preview</button>
          {preview && <button onClick={() => void runImport(true)}>Import</button>}
        </div>
        {preview && (
          <div className="note">
            {preview.problems.map(p => <div key={p} className="breach">▲ {p}</div>)}
            <div>Roster: {preview.roster.length ? preview.roster.map(c => `${c.name} (${c.tier})`).join(', ') : '—'}</div>
            <div>Inspections: {preview.inspections.done} done, {preview.inspections.scheduled} scheduled · Notes: {preview.notes}</div>
            {preview.rules && <div>Rules: {RULE_LABELS.map(([k, l]) => `${l} ${preview.rules![k]}`).join(' · ')}</div>}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Roster and pay</h2>
        <p className="note">
          The first active cleaner in each tier (lowest order) is the one the rule picks. A blank rate is "not priced",
          never $0; a blank deep rate pays the ordinary one.
        </p>
        <div className="grid-scroll">
          <table className="units compact roster-edit">
            <thead><tr><th>Name</th><th>Tier</th><th>Order</th><th>Active</th>
              {BEDROOM_SIZES.map(b => <th key={b}>{b}BR</th>)}{BEDROOM_SIZES.map(b => <th key={`d${b}`}>Deep {b}</th>)}<th></th></tr></thead>
            <tbody>
              {roster.map((c, i) => (
                <tr key={i}>
                  <td><input value={c.name} onChange={e => setField(i, 'name', e.target.value)} /></td>
                  <td><select value={c.tier} onChange={e => setField(i, 'tier', e.target.value as Cleaner['tier'])}>
                    <option>high</option><option>mid</option><option>low</option></select></td>
                  <td><input className="amt" type="number" value={c.position} onChange={e => setField(i, 'position', Number(e.target.value))} /></td>
                  <td><input type="checkbox" checked={c.active} onChange={e => setField(i, 'active', e.target.checked)} /></td>
                  {BEDROOM_SIZES.map(b => <td key={b}><input className="amt" value={c.rates[b] ?? ''} onChange={e => setCard(i, 'rates', b, e.target.value)} /></td>)}
                  {BEDROOM_SIZES.map(b => <td key={`d${b}`}><input className="amt" value={c.deepRates[b] ?? ''} onChange={e => setCard(i, 'deepRates', b, e.target.value)} /></td>)}
                  <td><button className="link tiny danger" onClick={() => setRoster(rs => rs.filter((_, j) => j !== i))}>remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="button-row">
          <button className="secondary" onClick={() => setRoster(rs => [...rs, { name: '', tier: 'mid', position: rs.length, rates: {}, deepRates: {}, active: true,
                                                                                 stars: 3, level: 'standard', zones: [], maxPerDay: null }])}>Add cleaner</button>
          <button onClick={() => void save({ roster }, 'Roster saved.')}>Save roster</button>
        </div>
        <p className="note">Renaming someone is removing them and adding a new person — stays set to the old name by hand
          would read as off the roster. Mark them inactive instead and add the new name.</p>
      </div>

      <LevelSetup cfg={cfg} roster={roster} setRoster={setRoster} rules={rules} setRules={setRules} save={save} />
      <CrewSetup cfg={cfg} roster={roster} setRoster={setRoster} save={save} />
      <ChecklistSetup />
      <VendorSetup />

      <div className="card">
        <h2>Rules</h2>
        <div className="row">
          {RULE_LABELS.map(([k, label]) => (
            <label key={k}>{label}
              <input value={rules[k] ?? ''} placeholder={String(cfg.defaults[k])}
                     onChange={e => setRules(r => ({ ...r, [k]: e.target.value }))} /></label>
          ))}
        </div>
        <label>People who inspect but do not clean (comma-separated; Manager and Owner are always included)
          <input value={extra} onChange={e => setExtra(e.target.value)} /></label>
        <div className="button-row">
          <button onClick={() => void save({ rules, extraInspectors: extra.split(',') }, 'Rules saved.')}>Save rules</button>
        </div>
      </div>

      <GuestDocUnits initial={cfg.guestDocUnits ?? []} onSave={ids => save({ guestDocUnits: ids }, 'Guest documents saved.')} />
      {cfg.hostawayTasks && <HostawayTasks state={cfg.hostawayTasks} onChanged={() => void fetchCfg()} />}
    </>
  );
}

/**
 * The crew pages (§122): who signs in with which address, how each
 * invoice runs, the fallback links, and whether cleaners see what is
 * coming — off until the schedule has been checked.
 */
function CrewSetup({ cfg, roster, setRoster, save }: {
  cfg: OpsSettings; roster: Cleaner[]; setRoster: (f: (rs: Cleaner[]) => Cleaner[]) => void;
  save: (body: Record<string, unknown>, done: string) => Promise<void>;
}) {
  const [calendar, setCalendar] = useState(cfg.crewCalendar);
  const [days, setDays] = useState(String(cfg.crewCalendarDays));
  const [autoDays, setAutoDays] = useState(String(cfg.crewAutoDays ?? 4));
  const [link, setLink] = useState<{ name: string; url: string | null } | null>(null);
  const [err, setErr] = useState('');
  const set = (i: number, patch: Partial<Cleaner>) => setRoster(rs => rs.map((c, j) => j === i ? { ...c, ...patch } : c));
  const makeLink = async (name: string, revoke: boolean) => {
    setErr('');
    const r = await crewLink(name, revoke).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setErr(r.message ?? 'Failed.'); return; }
    setLink({ name, url: r.link });
    await save({}, revoke ? `${name}'s link no longer opens anything.` : `New link for ${name} — copy it now, it is not shown again.`);
  };
  const app = location.origin;

  return (
    <div className="card">
      <h2>Crew pages</h2>
      <p className="note">
        Each cleaner sees their cleans, what each paid, what was flagged or not paid, their invoice, and can ask for extras
        (with a receipt or photo) that the team approves or denies in Operations → Crew. To see a page as the cleaner sees it:
        {' '}<code>{app}/#crew/&lt;name&gt;</code>.
      </p>
      <ol className="note">
        <li><b>Sign-in (main way):</b> in Cloudflare Zero Trust → Access → the Kaizen application, add the cleaner's email to the
          policy, with the <b>One-time PIN</b> login method on. They open <code>{app}</code>, type their email and the code they get.
          Kaizen knows them by the address below; it opens their page and nothing else.</li>
        <li><b>Secret link (fallback, for someone the code does not work for):</b> works only after a Cloudflare Access <b>Bypass</b>
          application covers <code>/crew</code>, <code>/assets/*</code> and <code>/api/crew-link</code>. Anyone holding the link sees
          that cleaner's page — revoke it if it leaks.</li>
      </ol>

      <div className="grid-scroll">
        <table className="units compact roster-edit">
          <thead><tr><th>Cleaner</th><th>Sign-in email</th><th>Invoice</th><th>Page language</th><th>Secret link</th></tr></thead>
          <tbody>
            {roster.map((c, i) => (
              <tr key={i} className={c.active ? undefined : 'muted-row'}>
                <td><b>{c.name || '—'}</b></td>
                <td><input type="email" value={c.email ?? ''} placeholder="name@example.com"
                           onChange={e => set(i, { email: e.target.value || null })} /></td>
                <td><select value={c.invoicePeriod ?? 'monthly'} onChange={e => set(i, { invoicePeriod: e.target.value as 'weekly' | 'monthly' })}>
                  <option value="weekly">weekly (Sat–Fri, paid Saturday)</option><option value="monthly">monthly (paid early the next month)</option></select></td>
                {/* §129: what their page opens in; they can switch it on the page, and it is remembered. */}
                <td><select value={c.lang ?? 'en'} onChange={e => set(i, { lang: e.target.value as 'en' | 'es' })}>
                  <option value="en">English</option><option value="es">Español</option></select></td>
                <td>
                  {c.hasLink ? <span className="sub-n">● link active </span> : <span className="sub-n">○ none </span>}
                  {c.name && <button className="link tiny" onClick={() => void makeLink(c.name, false)}>{c.hasLink ? 'new link' : 'make link'}</button>}
                  {c.hasLink && <button className="link tiny danger" onClick={() => void makeLink(c.name, true)}>revoke</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {link?.url && (
        <label>{link.name}'s link — copy it now; Kaizen keeps only a fingerprint of it
          <input readOnly value={link.url} onFocus={e => e.target.select()} /></label>
      )}
      {err && <p className="banner error">{err}</p>}
      <div className="button-row">
        <button onClick={() => void save({ roster }, 'Crew addresses and invoice periods saved.')}>Save addresses and invoices</button>
        <span className="note">Saves the whole roster, as Roster and pay does.</span>
      </div>

      <h3>What is coming</h3>
      <p className="note">Nobody has to confirm anything. Each cleaner sees what a person assigned to them, and the rule's picks
        <b> {autoDays || 0} days ahead</b> — close enough that they rarely move. On the board these carry 👁. A daily snapshot
        tells them what changed since. Publishing the whole schedule shows them everything ahead.</p>
      <label>The rule's picks show this many days ahead (0 = only what a person assigned)
        <input className="amt" value={autoDays} onChange={e => setAutoDays(e.target.value)} /></label>
      <label className="check"><input type="checkbox" checked={calendar} onChange={e => setCalendar(e.target.checked)} />
        Publish the whole schedule</label>
      <label>Whole schedule: days ahead (1–30)<input className="amt" value={days} onChange={e => setDays(e.target.value)} /></label>
      <div className="button-row">
        <button disabled={calendar === cfg.crewCalendar && Number(days) === cfg.crewCalendarDays && Number(autoDays) === (cfg.crewAutoDays ?? 4)}
                onClick={() => void save({ crewCalendar: calendar, crewCalendarDays: Number(days), crewAutoDays: Number(autoDays) },
                                         'What cleaners see ahead is saved.')}>Save</button>
      </div>
    </div>
  );
}

/**
 * §133: the inspection checklist — what is checked, room by room. Items for
 * every unit, or for one; reordered, switched off, or removed (an item
 * already answered is switched off instead, so old reports keep their words).
 */
function ChecklistSetup() {
  const [items, setItems] = useState<InspectionItem[] | null>(null);
  const [units, setUnits] = useState<{ id: string; name: string }[]>([]);
  const [msg, setMsg] = useState('');
  const [draft, setDraft] = useState<{ area: Area; label: string; defaultOutcome: string; unitId: string }>({ area: 'kitchen', label: '', defaultOutcome: 'repair', unitId: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ label: string; defaultOutcome: string; unitId: string }>({ label: '', defaultOutcome: 'repair', unitId: '' });
  useEffect(() => {
    void getInspectionItems().then(r => { if (r.ok) setItems(r.items); });
    void getUnits().then(r => setUnits((r.units ?? []).filter(u => u.active).map(u => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name))));
  }, []);
  const send = async (body: Record<string, unknown>, done?: string) => {
    const r = await saveInspectionItem(body).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return false; }
    setItems(r.items);
    setMsg('switchedOff' in r && r.switchedOff ? 'It was used in an inspection, so it is switched off (old reports keep it) rather than deleted.' : done ?? '');
    return true;
  };
  const OUT: Record<string, string> = { repair: '🔧 repair', purchase: '🛒 purchase', clean: '🧽 clean' };
  const unitName = (id: string | null) => id ? units.find(u => u.id === id)?.name ?? id : 'all units';
  if (!items) return <div className="card"><h2>Inspection checklist</h2><p className="note loading-dot">Loading…</p></div>;
  return (
    <div className="card">
      <h2>Inspection checklist</h2>
      <p className="note">What the inspector checks, room by room. Bedrooms and bathrooms repeat once per room in the unit.
        Each item says what a failure usually becomes — the inspector can change it at the end.</p>
      {AREAS.map(a => {
        const list = items.filter(i => i.area === a.key);
        return (
          <div key={a.key} className="group">
            <h3>{a.label}{a.perRoom ? ' (each one)' : ''} <span className="count">{list.filter(i => i.active).length}</span></h3>
            <table className="units compact"><tbody>
              {list.map(i => editing === i.id ? (
                <tr key={i.id}><td colSpan={4}>
                  <div className="row">
                    <label>Check<input value={edit.label} maxLength={200} onChange={e => setEdit(v => ({ ...v, label: e.target.value }))} /></label>
                    <label>If it fails<select value={edit.defaultOutcome} onChange={e => setEdit(v => ({ ...v, defaultOutcome: e.target.value }))}>
                      {Object.entries(OUT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
                    <label>Units<select value={edit.unitId} onChange={e => setEdit(v => ({ ...v, unitId: e.target.value }))}>
                      <option value="">All units</option>{units.map(u => <option key={u.id} value={u.id}>{u.name} only</option>)}</select></label>
                  </div>
                  <div className="button-row">
                    <button className="small" disabled={!edit.label.trim()} onClick={async () => {
                      if (await send({ action: 'save', id: i.id, area: i.area, label: edit.label, defaultOutcome: edit.defaultOutcome, unitId: edit.unitId || null, active: i.active }, 'Saved.')) setEditing(null);
                    }}>Save</button>
                    <button className="small secondary" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </td></tr>
              ) : (
                <tr key={i.id} className={i.active ? undefined : 'muted-row'}>
                  <td>{i.label}{!i.active && <span className="sub-n"> · off</span>}</td>
                  <td className="sub-n">{OUT[i.defaultOutcome]}</td>
                  <td className="sub-n">{unitName(i.unitId)}</td>
                  <td className="n">
                    <button className="link tiny" title="Up" onClick={() => void send({ action: 'move', id: i.id, dir: -1 })}>↑</button>
                    <button className="link tiny" title="Down" onClick={() => void send({ action: 'move', id: i.id, dir: 1 })}>↓</button>{' '}
                    <button className="link tiny" onClick={() => { setEditing(i.id); setEdit({ label: i.label, defaultOutcome: i.defaultOutcome, unitId: i.unitId ?? '' }); }}>edit</button>{' '}
                    {i.active
                      ? <button className="link tiny danger" onClick={() => void send({ action: 'delete', id: i.id }, 'Removed.')}>remove</button>
                      : <button className="link tiny" onClick={() => void send({ action: 'save', id: i.id, area: i.area, label: i.label, defaultOutcome: i.defaultOutcome, unitId: i.unitId, active: true }, 'Back on.')}>turn on</button>}
                  </td>
                </tr>
              ))}
              {!list.length && <tr><td className="note">Nothing checked here.</td></tr>}
            </tbody></table>
          </div>
        );
      })}
      <h3>Add an item</h3>
      <div className="row">
        <label>Room<select value={draft.area} onChange={e => setDraft(d => ({ ...d, area: e.target.value as Area }))}>
          {AREAS.map(a => <option key={a.key} value={a.key}>{a.label}</option>)}</select></label>
        <label>Check<input value={draft.label} maxLength={200} placeholder="e.g. Hair dryer works" onChange={e => setDraft(d => ({ ...d, label: e.target.value }))} /></label>
        <label>If it fails<select value={draft.defaultOutcome} onChange={e => setDraft(d => ({ ...d, defaultOutcome: e.target.value }))}>
          {Object.entries(OUT).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label>Units<select value={draft.unitId} onChange={e => setDraft(d => ({ ...d, unitId: e.target.value }))}>
          <option value="">All units</option>{units.map(u => <option key={u.id} value={u.id}>{u.name} only</option>)}</select></label>
      </div>
      <div className="button-row">
        <button disabled={!draft.label.trim()} onClick={async () => {
          if (await send({ action: 'save', area: draft.area, label: draft.label, defaultOutcome: draft.defaultOutcome, unitId: draft.unitId || null }, 'Added.')) setDraft(d => ({ ...d, label: '' }));
        }}>Add</button>
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}

/** §133: handymen and suppliers — a directory the repairs pick from. */
function VendorSetup() {
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const blank = { id: '', name: '', trade: '', phone: '', email: '', notes: '', active: true };
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState('');
  useEffect(() => { void getVendors().then(r => { if (r.ok) setVendors(r.vendors); }); }, []);
  const send = async (body: Record<string, unknown>, done: string) => {
    const r = await saveVendor(body).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return false; }
    setVendors(r.vendors); setMsg(done); return true;
  };
  return (
    <div className="card">
      <h2>Vendors &amp; handymen</h2>
      <p className="note">Who does repairs and supplies, and how to reach them. A repair's vendor is picked from this list.
        A vendor's own page (their repairs, like the cleaners' page) comes later; their email is kept for it.</p>
      <table className="units compact">
        <thead><tr><th>Name</th><th>Trade</th><th>Phone</th><th>Email</th><th>Notes</th><th></th></tr></thead>
        <tbody>
          {(vendors ?? []).map(v => (
            <tr key={v.id} className={v.active ? undefined : 'muted-row'}>
              <td><b>{v.name}</b>{!v.active && <span className="sub-n"> · off</span>}</td><td>{v.trade}</td>
              <td>{v.phone && <a href={`tel:${v.phone}`}>{v.phone}</a>}</td>
              <td>{v.email && <a href={`mailto:${v.email}`}>{v.email}</a>}</td><td className="ops-note">{v.notes}</td>
              <td className="n">
                <button className="link tiny" onClick={() => setForm({ id: v.id, name: v.name, trade: v.trade ?? '', phone: v.phone ?? '', email: v.email ?? '', notes: v.notes ?? '', active: v.active })}>edit</button>{' '}
                {v.active && <button className="link tiny danger" onClick={() => void send({ action: 'delete', id: v.id }, `${v.name} switched off.`)}>remove</button>}
              </td>
            </tr>
          ))}
          {vendors && !vendors.length && <tr><td colSpan={6} className="note">No vendors yet.</td></tr>}
        </tbody>
      </table>
      <h3>{form.id ? `Edit ${form.name}` : 'Add a vendor'}</h3>
      <div className="row">
        <label>Name<input value={form.name} maxLength={120} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></label>
        <label>Trade<input value={form.trade} maxLength={80} placeholder="Plumber, handyman, A/C…" onChange={e => setForm(f => ({ ...f, trade: e.target.value }))} /></label>
        <label>Phone<input value={form.phone} maxLength={40} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></label>
        <label>Email<input type="email" value={form.email} maxLength={160} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></label>
      </div>
      <label>Notes<input value={form.notes} maxLength={1000} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></label>
      {form.id && <label className="check"><input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} /> Active</label>}
      <div className="button-row">
        <button disabled={!form.name.trim()} onClick={async () => { if (await send({ action: 'save', ...form, id: form.id || undefined }, form.id ? 'Saved.' : 'Added.')) setForm(blank); }}>
          {form.id ? 'Save' : 'Add'}</button>
        {form.id && <button className="secondary" onClick={() => setForm(blank)}>Cancel</button>}
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}

const LEVEL_RULES: [keyof OpsRules, string][] = [
  ['levelHighFromNightly', 'High level from ($/night, next guest)'], ['levelLongStayNights', 'Long stay from (nights)'],
  ['levelMidStayDays', 'Mid-stay counts if within (days before checkout)'], ['levelNextWithinDays', 'Assign only if next check-in is under (days)']
];

/**
 * Assignment by levels (§125): each cleaner's level, zones and daily max,
 * the rule's numbers, and the switch — all behind a preview. Nothing
 * saves until the board under the proposal has been seen against the
 * board as it is: how many cleans change hands, how many wait, and what
 * it costs.
 */
function LevelSetup({ cfg, roster, setRoster, rules, setRules, save }: {
  cfg: OpsSettings; roster: Cleaner[]; setRoster: (f: (rs: Cleaner[]) => Cleaner[]) => void;
  rules: Record<string, string>; setRules: (f: (r: Record<string, string>) => Record<string, string>) => void;
  save: (body: Record<string, unknown>, done: string) => Promise<void>;
}) {
  const [preview, setPreview] = useState<AssignPreview | null>(null);
  const [previewed, setPreviewed] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const proposal = JSON.stringify({ roster, rules });
  const fresh = !!preview && previewed === proposal;
  const zones = [...new Set([...Object.keys(cfg.zones ?? {}), ...roster.flatMap(c => c.zones)])]
    .sort((a, b) => Number(a === HOUSES_ZONE) - Number(b === HOUSES_ZONE) || a.localeCompare(b));
  const set = (i: number, patch: Partial<Cleaner>) => setRoster(rs => rs.map((c, j) => j === i ? { ...c, ...patch } : c));
  const deciding = cfg.assignRule === 'levels';

  const run = async () => {
    setBusy(true); setErr('');
    const r = await previewAssign(roster, rules).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setErr(r.message ?? 'Could not preview.'); return; }
    setPreview(r.preview); setPreviewed(proposal);
  };
  const delta = (now: number, then: number, fmt: (n: number) => string = String) =>
    now === then ? <>{fmt(now)} <span className="note">(same)</span></> : <>{fmt(now)} → <b>{fmt(then)}</b></>;

  return (
    <div className="card">
      <h2>Who cleans: by levels <span className={deciding ? 'ok-tag' : 'chan-tag'}>{deciding ? 'deciding' : `${cfg.assignRule} decides now`}</span></h2>
      <p className="note">
        {deciding ? 'Levels decide who cleans each turnover.'
          : `The ${cfg.assignRule} rule still decides. The board shows what levels would pick beside each clean ("by levels: …").`}
        {' '}Host Notes change only where the cleaner changes.
      </p>
      <LevelRules rules={withDefaults(rules)} />

      <div className="grid-scroll">
        <table className="units compact roster-edit">
          <thead><tr><th>Cleaner</th><th>Level</th><th>Zones covered</th><th>Max cleans a day</th></tr></thead>
          <tbody>
            {roster.map((c, i) => (
              <tr key={i} className={c.active ? undefined : 'muted-row'}>
                <td><b>{c.name || '—'}</b>{!c.active && <span className="sub-n"> inactive</span>}</td>
                <td><select value={levelOf(c)} onChange={e => set(i, { level: e.target.value as Cleaner['level'] })}>
                  {LEVELS.map(l => <option key={l} value={l}>{LEVEL_LABEL[l]}</option>)}</select></td>
                <td>
                  {zones.map(z => (
                    <label key={z} className="check inline" title={(cfg.zones?.[z] ?? []).join(', ')}>
                      <input type="checkbox" checked={c.zones.includes(z)}
                             onChange={e => set(i, { zones: e.target.checked ? [...c.zones, z] : c.zones.filter(x => x !== z) })} /> {z}
                    </label>
                  ))}
                  {!c.zones.length && <span className="sub-n"> · all zones</span>}
                </td>
                <td><input className="amt" value={c.maxPerDay ?? ''} placeholder="no limit"
                           onChange={e => set(i, { maxPerDay: e.target.value === '' ? null : Number(e.target.value) })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row">
        {LEVEL_RULES.map(([k, label]) => (
          <label key={k}>{label}
            <input value={rules[k] ?? ''} placeholder={String(cfg.defaults[k])}
                   onChange={e => setRules(r => ({ ...r, [k]: e.target.value }))} /></label>
        ))}
      </div>

      {err && <p className="banner error">{err}</p>}
      <div className="button-row">
        <button className="secondary" disabled={busy} onClick={() => void run()}>{busy ? 'Building the board…' : 'Preview'}</button>
        <button disabled={!fresh || busy} onClick={() => void save({ roster, rules }, 'Levels, zones and limits saved.')}>Save</button>
        {!deciding && <button disabled={!fresh || busy} onClick={() => void save({ roster, rules, assignRule: 'levels' }, 'Levels now decide who cleans.')}>Save and switch to levels</button>}
        {!fresh && <span className="note">{preview ? 'Changed since the preview — preview again to save.' : 'Preview first: saving needs the board seen under the change.'}</span>}
      </div>

      {preview && (
        <div className={fresh ? undefined : 'is-stale'}>
          <p className="note">{short(preview.from)} → {short(preview.to)}, {preview.cleans} cleans, levels against what decides now ({preview.rule}):</p>
          <dl className="strip">
            <div><dt>Change cleaner</dt><dd>{preview.changed}</dd></div>
            <div><dt>Waiting for a booking</dt><dd>{preview.waiting ?? 0}</dd></div>
            <div><dt>Unassigned</dt><dd>{delta(preview.unassigned.now, preview.unassigned.then)}</dd></div>
            <div><dt>Cleaner pay</dt><dd>{delta(preview.cost.now, preview.cost.then, money)}
              {(preview.unpriced.now || preview.unpriced.then) ? <small>not priced: {preview.unpriced.now} → {preview.unpriced.then}</small> : null}</dd></div>
          </dl>
          {preview.changes.length > 0 && (
            <table className="units compact">
              <thead><tr><th>Day</th><th>Unit</th><th>Needs</th><th>Now</th><th>By levels</th><th className="n">Pays</th></tr></thead>
              <tbody>
                {preview.changes.map(c => (
                  <tr key={c.resId}>
                    <td>{short(c.date)}</td><td>{c.unit}</td>
                    <td>{c.required === 'waiting' ? '○ waiting' : c.required ? LEVEL_LABEL[String(c.required)] ?? c.required : '—'}</td>
                    <td>{c.now ?? '—'}</td>
                    <td>{c.then ?? '—'}</td>
                    <td className="n">{c.priceNow == null ? '—' : money2(c.priceNow)} → {c.priceThen == null ? '—' : money2(c.priceThen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="note">Stays set by hand keep their cleaner either way. "Unassigned" counts the cleans waiting for a booking —
            they are not the team's problem until the day before. Only the board's window is compared.</p>
        </div>
      )}
    </div>
  );
}

/**
 * Which units ask each guest for an ID and a signed agreement (§73).
 *
 * By building first, because that is where the right to ask comes from —
 * the P2 building requires it, another may not allow it — and unit by
 * unit inside, for the exception.
 */
function GuestDocUnits({ initial, onSave }: { initial: string[]; onSave: (ids: string[]) => Promise<void> }) {
  const [units, setUnits] = useState<{ id: string; name: string }[] | null>(null);
  const [on, setOn] = useState(new Set(initial));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getUnits().then(r => setUnits((r.units ?? []).filter(u => u.active || initial.includes(u.id))
      .map(u => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name))));
  }, []);
  useEffect(() => setOn(new Set(initial)), [initial.join()]);

  // "P2-1201" → P2, "CL1235" / "CL 1125" → CL; a house is its own building.
  const building = (name: string) => name.replace(/[-\s]?\d+[A-Za-z]?$/, '').trim() || name;
  const groups = useMemo(() => {
    const m = new Map<string, { id: string; name: string }[]>();
    for (const u of units ?? []) m.set(building(u.name), [...(m.get(building(u.name)) ?? []), u]);
    return [...m.entries()];
  }, [units]);
  const toggle = (ids: string[], value: boolean) =>
    setOn(s => { const n = new Set(s); for (const id of ids) value ? n.add(id) : n.delete(id); return n; });
  const dirty = [...on].sort().join() !== [...initial].sort().join();

  return (
    <div className="card">
      <h2>Guest documents — copy in Drive</h2>
      <p className="note">Every guest is asked for an ID and a signed rental agreement through Hostaway's guest
        portal, and the board shows both for every arrival. Tick the units whose building also needs a COPY of
        the ID and agreement kept in Drive; those arrivals also show ○/✓ ID in Drive.</p>
      {!units ? <p className="note loading-dot">Reading units</p> : (
        <div className="docunits">
          {groups.map(([b, us]) => {
            const all = us.every(u => on.has(u.id)), some = us.some(u => on.has(u.id));
            return (
              <div key={b} className="docunits-group">
                <label className="docunits-building">
                  <input type="checkbox" checked={all} ref={el => { if (el) el.indeterminate = some && !all; }}
                         onChange={e => toggle(us.map(u => u.id), e.target.checked)} />
                  <b>{b}</b>{us.length > 1 && <span className="sub-n"> {us.filter(u => on.has(u.id)).length}/{us.length}</span>}
                </label>
                {us.length > 1 && us.map(u => (
                  <label key={u.id} className="docunits-unit">
                    <input type="checkbox" checked={on.has(u.id)} onChange={e => toggle([u.id], e.target.checked)} /> {u.name}
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}
      <div className="button-row">
        <button disabled={!dirty || busy} onClick={() => { setBusy(true); void onSave([...on]).finally(() => setBusy(false)); }}>
          {busy ? 'Saving…' : 'Save guest documents'}</button>
        {dirty && <span className="note">unsaved changes</span>}
      </div>
    </div>
  );
}

/**
 * Work ↔ Hostaway tasks (§93). Off until turned on: from then, every to-do
 * and repair (not sub-tasks) is a Hostaway task too, and what the team does
 * with it there — start, finish, assign, cost — comes back to Kaizen.
 */
function HostawayTasks({ state, onChanged }: { state: HostawayTasksState; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const on = state.mode === 'mirror';
  const post = async (body: Record<string, unknown>, done: (r: Record<string, any>) => string) => {
    setBusy(true); setMsg('');
    const r = await saveOpsSettings(body).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    setMsg(r.ok ? done(r as Record<string, any>) : (('message' in r && r.message) || 'Not saved.'));
    onChanged();
  };
  return (
    <div className="card ha-tasks">
      <h2>Hostaway tasks</h2>
      <p className="note">
        When on, every to-do and repair is also a task in Hostaway — on its listing and stay, with its deadline and owner —
        so the team can work it from Hostaway and its mobile app. What they change there (started, done, assigned, cost)
        comes back here, on the task's timeline. Tasks written by hand in Hostaway come in as to-dos. Hostaway's automatic
        cleaning tasks stay out: the board runs the cleans. Removing work here cancels its Hostaway task; nothing is deleted there.
      </p>
      <div className="ha-state">
        <span className={`ha-mode ${on ? 'on' : ''}`}>{on ? '● On' : '○ Off'}</span>
        {on && <span className="sub-n">{state.linked} linked · {state.imported} from Hostaway
          {state.pulledAt ? ` · last checked ${new Date(state.pulledAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })}` : ''}</span>}
        {on && state.errors > 0 && <span className="breach">▲ {state.errors} not sent yet — retried on the next check</span>}
      </div>
      <div className="button-row">
        <button className={on ? 'secondary' : ''} disabled={busy}
                onClick={() => void post({ hostawayTasks: on ? 'off' : 'mirror' }, () => on ? 'Turned off. Links are kept; nothing is sent until it is on again.' : 'On. New and changed work goes to Hostaway from now.')}>
          {on ? 'Turn off' : 'Turn on'}</button>
        {on && state.unsent > 0 && (
          <button className="secondary" disabled={busy}
                  onClick={() => void post({ action: 'hostawayBackfill' }, r => `Sent: ${r.sent?.created ?? 0} created${r.sent?.failed ? `, ${r.sent.failed} failed` : ''}.`)}>
            {busy ? 'Sending…' : `Send the ${state.unsent} open item${state.unsent === 1 ? '' : 's'} to Hostaway`}</button>
        )}
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}

/* ── Calendar — a month of cleans, for checking an invoice ────────── */

/**
 * Moved here from Costs: which day each unit was cleaned, by whom, is the
 * day's work. A cleaner sends a total for a month; this answers which
 * days it covers and whether the count matches — a missing Tuesday is a
 * hole, not an absence to notice.
 *
 * One CLOSED month, every row in it (a September invoice includes cleans
 * after today if today is in September), counted from the record — so a
 * cancelled booking, or one unit's second row on one day, is not in the
 * total, and is listed below with why.
 */
function CleaningsMonth() {
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [picked, setPicked] = useState<string[]>([]);
  const [include, setInclude] = useState<string[]>(['not_needed']);
  const [data, setData] = useState<{ cleanings: Cleaning[]; excluded: ExcludedCleaning[];
    cleaners: { cleaner: string; n: number }[]; states: Record<string, number> } | null>(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    const [y, m] = month.split('-').map(Number);
    const last = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
    setBusy(true); setErr('');
    getCleanings(`${month}-01`, 'all', picked, last, include)
      .then(r => r.ok ? setData(r) : setErr('Could not load the cleanings record.'))
      .catch(e => setErr(String(e)))
      .finally(() => setBusy(false));
  }, [month, picked, include]);

  const flip = (list: string[], v: string) => list.includes(v) ? list.filter(x => x !== v) : [...list, v];

  return (
    <>
      <div className="row-controls">
        <span className="note">Cleaner</span>
        {/* "Everyone" is the empty selection — one state, not two that can disagree. */}
        <button className={picked.length === 0 ? 'chip active' : 'chip'} onClick={() => setPicked([])}>Everyone</button>
        {(data?.cleaners ?? []).map(c => (
          <button key={c.cleaner} className={picked.includes(c.cleaner) ? 'chip active' : 'chip'}
                  onClick={() => setPicked(p => flip(p, c.cleaner))}>{c.cleaner}</button>
        ))}
        <span className="note">|</span>
        <button className={include.includes('tbd') ? 'chip active' : 'chip'} onClick={() => setInclude(i => flip(i, 'tbd'))}>
          Unassigned {data?.states.tbd ? <b>{data.states.tbd}</b> : null}</button>
        <button className={include.includes('not_needed') ? 'chip active' : 'chip'} onClick={() => setInclude(i => flip(i, 'not_needed'))}>
          No clean needed {data?.states.not_needed ? <b>{data.states.not_needed}</b> : null}</button>
        {busy && <span className="note right loading-dot">Loading</span>}
      </div>
      {err && <p className="banner warn">{err}</p>}
      <div className={busy && data ? 'is-stale' : undefined}>
        {data && <CleaningCalendar month={month} cleanings={data.cleanings} onMonth={setMonth} />}
        {data && data.excluded.length > 0 && (
          <div className="group">
            <h3>Not counted this month <span className="count">{data.excluded.length}</span></h3>
            <table className="units compact"><tbody>
              {data.excluded.map(x => (
                <tr key={x.key} className="muted-row">
                  <td>{x.checkout_on.slice(0, 10)}</td><td>{x.unit_name}</td><td>{x.cleaner ?? ''}</td>
                  <td className="n"><s>{x.price == null ? '' : money2(Number(x.price))}</s></td>
                  <td className="sub-n">{x.void_reason}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        )}
      </div>
    </>
  );
}
