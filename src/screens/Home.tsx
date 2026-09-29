/**
 * Home — the day at a glance.
 *
 * Four questions someone opening the app in the morning actually has, in
 * the order they act on them:
 *
 *   1. Who is cleaning what today — and is anything unassigned?
 *   2. Who is arriving today, and is their unit ready?
 *   3. Which units does the analysis flag red?
 *   4. What is on the calendar that costs something — inspections
 *      scheduled, expenses coming up, claims still open?
 *
 * Nothing here is computed differently from the screen it summarises:
 * the cleanings and arrivals are the Operations board's rows, red is the
 * Units screen's own rule (src/lib/verdicts.ts), the rest are the Costs
 * and Claims records. Every block links to that screen, because Home
 * points at work; it is not where the work happens.
 *
 * Each block loads on its own. The red-units read sweeps every calendar
 * and takes the longest, and the day's cleanings must not wait for it.
 * A role only asks for what it may see — the server refuses the rest
 * regardless.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  can, getClaims, getForward, getGuestDocs, getOperations, getVariable, uploadGuestDoc,
  type Claim, type OperationsResponse, type VariableExpense
} from '../api.ts';
import { redUnits } from '../lib/verdicts.ts';
import { todayIn, addDays } from '../lib/dates.ts';
import { TodoList, type WorkSum } from '../components/Todos.tsx';
import { money, money2 } from '../lib/format.ts';
import { hostawayReservationUrl, type BoardRow } from '../lib/operations.ts';

const TZ = 'America/New_York';
const WEEK = 7;
type Load<T> = { data: T | null; err: string; busy: boolean };
const idle = <T,>(): Load<T> => ({ data: null, err: '', busy: true });
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const long = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${DOW[t.getUTCDay()]}, ${MON[t.getUTCMonth()]} ${t.getUTCDate()}`; };
const short = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${DOW[t.getUTCDay()]!.slice(0, 3)} ${MON[t.getUTCMonth()]} ${t.getUTCDate()}`; };

function useLoad<T>(enabled: boolean, fn: () => Promise<T>): Load<T> {
  const [s, set] = useState<Load<T>>(idle);
  useEffect(() => {
    if (!enabled) { set({ data: null, err: '', busy: false }); return; }
    fn().then(data => set({ data, err: '', busy: false }))
      .catch(e => set({ data: null, err: e instanceof Error ? e.message : String(e), busy: false }));
  }, [enabled]);
  return s;
}

export function Home({ permissions, onGo }: { permissions: string[]; onGo: (tab: string) => void }) {
  const today = todayIn(TZ);
  const canOps = can(permissions, 'operations');
  const canUnits = can(permissions, 'units');
  const canCosts = can(permissions, 'costs');
  const canClaims = can(permissions, 'claims');
  const canTodos = can(permissions, 'todos');

  const ops = useLoad(canOps, async () => {
    // Today and tomorrow (§89): the team prepares a day ahead.
    const r = await getOperations(2);
    if (!r.ok) throw new Error(r.message ?? r.error ?? 'Could not load the board.');
    return r;
  });
  const red = useLoad(canUnits, async () => {
    const r = await getForward(today, 30);
    if (!r.ok) throw new Error(r.error === 'not_configured' ? 'Hostaway is not connected.' : (r.error ?? 'Could not load.'));
    return { list: redUnits(r.units, (r.meta.occFloorPct ?? 60) / 100, r.meta.asOf), total: r.units.filter(u => u.active).length };
  });
  const spend = useLoad(canCosts, async () => {
    const r = await getVariable();
    return r.expenses ?? [];
  });
  const claims = useLoad(canClaims, async () => {
    const r = await getClaims();
    return r.claims ?? [];
  });

  const tomorrow = addDays(today, 1);
  const todays = useMemo(() => {
    const rows = ops.data?.rows ?? [];
    return {
      outs: rows.filter(r => r.kind === 'out' && r.date === today),
      ins: rows.filter(r => r.kind === 'in' && r.date === today),
      outs2: rows.filter(r => r.kind === 'out' && r.date === tomorrow),
      ins2: rows.filter(r => r.kind === 'in' && r.date === tomorrow),
      tomorrowOuts: rows.filter(r => r.kind === 'out' && r.date === addDays(today, 1) && r.assignment !== 'not_needed').length,
      tomorrowIns: rows.filter(r => r.kind === 'in' && r.date === addDays(today, 1)).length
    };
  }, [ops.data, today]);
  const inspections = (ops.data?.inspectionLog.scheduled ?? []).filter(e => e.date >= today && e.date <= addDays(today, WEEK));
  const dueOnBoard = todays.outs.filter(r => r.inspection.key === 'req' || r.inspection.key === 'due');
  const upcoming = (spend.data ?? []).filter(e => e.start_date.slice(0, 10) >= today && e.start_date.slice(0, 10) <= addDays(today, 14))
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const openClaims = (claims.data ?? []).filter(c => c.status === 'Open' || c.status === 'In progress');
  const cleans = todays.outs.filter(r => r.assignment !== 'not_needed');
  const unassigned = cleans.filter(r => r.assignment === 'tbd' || r.assignment === 'unknown');
  const isOpen = (r: BoardRow) => r.assignment === 'tbd' || r.assignment === 'unknown';
  // A check-in is ready when its unit's clean today is assigned, or nobody left today.
  const readyFor = (r: BoardRow) => { const c = todays.outs.find(o => o.unitId === r.unitId); return !c || c.assignment !== 'tbd' && c.assignment !== 'unknown'; };
  const notReady = todays.ins.filter(r => !readyFor(r)).length;
  // Every guest signs the rental agreement (§89): Hostaway's guest portal
  // says whether they have; the ID is what is filed in Drive.
  const canDocs = can(permissions, 'guests.documents');
  const [ids, setIds] = useState<Record<string, boolean>>({});
  const arrivals = [...todays.ins, ...todays.ins2];
  const arrivalsKey = arrivals.map(r => r.resId).join();
  useEffect(() => {
    if (!canDocs || !arrivals.length) return;
    const need = new Set(ops.data?.guestDocUnits ?? []);
    const stays = arrivals.filter(r => need.has(r.unitId)).map(r => ({ resId: r.resId, arrival: r.date, name: r.docName }));
    if (!stays.length) return;
    void getGuestDocs(stays).then(x => { if (x.ok) setIds(Object.fromEntries(Object.entries(x.docs).map(([k, d]) => [k, d.id.length > 0]))); });
  }, [canDocs, arrivalsKey]);
  const signed = (r: BoardRow) => r.agreement === 'signed';
  const unsigned = arrivals.filter(r => r.agreement === 'not_signed').length;
  const needsCopy = new Set(ops.data?.guestDocUnits ?? []);
  const [uploading, setUploading] = useState<string | null>(null);
  const [upErr, setUpErr] = useState('');
  // The building's copy of the ID (§90): one tap from Home to the reservation's Drive folder.
  const uploadId = async (r: BoardRow, file: File | undefined) => {
    if (!file) return;
    setUploading(r.resId); setUpErr('');
    const x = await uploadGuestDoc(r.resId, 'id', file).catch(e => ({ ok: false as const, message: String(e) }));
    setUploading(null);
    if (x.ok) setIds(m => ({ ...m, [r.resId]: x.docs.id.length > 0 })); else setUpErr(`${r.unit}: ${x.message ?? 'not uploaded'}`);
  };
  const arrivalRow = (r: BoardRow, isToday: boolean) => {
    const clean = isToday ? todays.outs.find(o => o.unitId === r.unitId) : undefined;
    const ready = !isToday ? null : !clean ? 'no departure today' : clean.assignment === 'assigned' ? `cleaned by ${clean.cleaner}` : '▲ clean not assigned';
    return (
      <li key={r.resId}>
        <span className="home-time">{r.time}</span>
        <span className="home-main"><b>{r.unit}</b> <span className="sub-n">· {r.guest || 'guest'} · {r.nights} night{r.nights === 1 ? '' : 's'}{r.guests ? ` · ${r.guests} guests` : ''}</span>
          {ready && <span className={`home-ready ${ready.startsWith('▲') ? 'breach' : 'sub-n'}`}> · {ready}</span>}</span>
        <span className="home-side home-docs">
          {r.agreement && <span className={signed(r) ? 'doc-ok' : 'breach'}>{signed(r) ? '✓ Signed' : '▲ Not signed'}</span>}
          {/* Hostaway's own check, only when it says so: an ID the guest
              uploaded in the portal is not "verified" there, and "○ ID" read
              as missing when it was not (§90). */}
          {r.idVerified && <span className="doc-ok" title="ID verified in Hostaway">✓ ID verified</span>}
          {/* The building's copy, where one is needed — and the way to add it. */}
          {canDocs && needsCopy.has(r.unitId) && r.resId in ids && (ids[r.resId]
            ? <span className="doc-ok" title="A copy of the ID is in the reservation's Drive folder">✓ ID in Drive</span>
            : <label className="home-upload" title="Upload the guest's ID to the reservation's Drive folder">
                {uploading === r.resId ? 'Uploading…' : '⇪ ID to Drive'}
                <input type="file" accept="image/*,.pdf" hidden disabled={!!uploading}
                       onChange={e => { void uploadId(r, e.target.files?.[0]); e.target.value = ''; }} />
              </label>)}
          <a className="home-hostaway" href={hostawayReservationUrl(r.resId)} target="_blank" rel="noreferrer"
             title="Open the reservation in Hostaway — the ID and the agreement are there">↗ Hostaway</a>
        </span>
      </li>
    );
  };
  // Not signed first — the three shown are the three to chase.
  const bySigned = (list: BoardRow[]) => [...list].sort((a, b) => Number(signed(a)) - Number(signed(b)));
  const [todoSum, setTodoSum] = useState<WorkSum | null>(null);

  return (
    <section className="home">
      <header className="home-head">
        <div>
          <h2>{long(today)}</h2>
          <p className="note">New York time · everything below is today unless it says otherwise</p>
        </div>
        {/* The day in one line, each figure a door to its block. */}
        <div className="home-chips">
          {canOps && <Chip n={cleans.length} label="cleans" warn={unassigned.length ? `${unassigned.length} unassigned` : ''} busy={ops.busy} />}
          {canOps && <Chip n={todays.ins.length} label="check-ins" busy={ops.busy} />}
          {canUnits && <Chip n={red.data?.list.length ?? 0} label="units in red" busy={red.busy} bad={!!red.data?.list.length} />}
          {canOps && <Chip n={inspections.length} label={`inspection${inspections.length === 1 ? '' : 's'} this week`} busy={ops.busy} />}
        </div>
      </header>

      {ops.data?.mode === 'shadow' && (
        <p className="note">○ Operations is in shadow mode — cleaners shown are Kaizen's reading; the daily file still decides.</p>
      )}

      <div className="home-grid">
        {canTodos && (
          <Card id="todo" title="To-do" count={todoSum?.open} className="home-todos" load={{ data: true, err: '', busy: false }}
                summary={todoSum && <WorkSummary s={todoSum} />}
                action={canOps ? 'All to-dos' : undefined} onAction={() => onGo('operations:todos')}>
            <TodoList today={today} compact canClaims={canClaims} onSummary={setTodoSum}
                      onMore={canOps ? () => onGo('operations:todos') : undefined} />
          </Card>
        )}
        {canOps && (
          <Card id="cleans" title="Check-outs" count={cleans.length} load={ops} action="Open the board" onAction={() => onGo('operations')}
                summary={unassigned.length || todays.outs2.some(isOpen)
                  ? <span className="breach">▲ {unassigned.length + todays.outs2.filter(isOpen).length} clean{unassigned.length + todays.outs2.filter(isOpen).length === 1 ? '' : 's'} unassigned</span> : undefined}>
            {/* Today and tomorrow, unassigned first: the three shown are the three that need someone. */}
            <DayGroup label={`Today · ${dayWord(today)}`} empty="No departures today.">
              {todays.outs.length > 0 && <ShowMore items={[...todays.outs].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)))}
                                                   render={r => <CleanItem key={r.resId} r={r} />} />}
            </DayGroup>
            <DayGroup label={`Tomorrow · ${dayWord(tomorrow)}`} empty="No departures tomorrow.">
              {todays.outs2.length > 0 && <ShowMore items={[...todays.outs2].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)))}
                                                    render={r => <CleanItem key={r.resId} r={r} />} />}
            </DayGroup>
          </Card>
        )}

        {canOps && (
          <Card id="checkins" title="Check-ins" count={todays.ins.length} load={ops} action="Open the board" onAction={() => onGo('operations')}
                summary={(unsigned || notReady) ? <>
                  {unsigned > 0 && <span className="breach">▲ {unsigned} not signed</span>}
                  {unsigned > 0 && notReady > 0 && ' · '}
                  {notReady > 0 && <span className="breach">▲ {notReady} not ready</span>}
                </> : undefined}>
            {upErr && <p className="banner warn">▲ {upErr}</p>}
            <DayGroup label={`Today · ${dayWord(today)}`} empty="No arrivals today.">
              {todays.ins.length > 0 && <ShowMore items={bySigned(todays.ins)} render={r => arrivalRow(r, true)} />}
            </DayGroup>
            <DayGroup label={`Tomorrow · ${dayWord(tomorrow)}`} empty="No arrivals tomorrow.">
              {todays.ins2.length > 0 && <ShowMore items={bySigned(todays.ins2)} render={r => arrivalRow(r, false)} />}
            </DayGroup>
          </Card>
        )}

        {canUnits && (
          <Card id="red" title="Units in red" count={red.data?.list.length} load={red} action="Open Units" onAction={() => onGo('units')}
                busyText="Reading every calendar…"
                foot={red.data ? `By the Units screen's analysis, of ${red.data.total} live units` : undefined}>
            {red.data && !red.data.list.length ? <Empty>No unit is red. ● All live units are filling, full or too early to tell.</Empty> : (
              <ShowMore items={red.data?.list ?? []} render={({ unit: u, read }) => (
                  <li key={u.listingId}>
                    <span className="light tone-bad" aria-hidden="true" />
                    <span className="home-main"><b>{u.name}</b> <span className="home-verdict">{read.v.label}</span>
                      <span className="home-reason">{read.v.reason}</span></span>
                    {can(permissions, 'money') && u.exposure > 0 && <span className="home-side sub-n">{money(u.exposure)} open</span>}
                  </li>
                )} />
            )}
          </Card>
        )}

        {(canOps || canCosts || canClaims) && (
          <Card id="coming" title="Coming up" load={{ data: true, err: [ops.err, spend.err, claims.err].filter(Boolean).join(' · '), busy: ops.busy || spend.busy || claims.busy }}
                action={canCosts ? 'Open Costs' : undefined} onAction={() => onGo('costs')}>
            <div className="home-events">
              {canOps && (
                <EventGroup title="Inspections" empty="Nothing scheduled in the next 7 days."
                  items={[
                    ...dueOnBoard.filter(r => !inspections.some(i => i.date === today && i.unit === r.unit))
                      .map(r => ({ key: `due-${r.resId}`, when: 'today', what: r.unit, note: r.inspection.key === 'req' ? 'required before the next guest — not yet scheduled' : 'due this turnover — not yet scheduled', warn: true })),
                    ...inspections.map(i => ({ key: i.id, when: i.date === today ? 'today' : short(i.date), what: i.unit, note: i.by ? `by ${i.by}` : '', warn: false }))
                  ]} onMore={() => onGo('operations')} />
              )}
              {canCosts && (
                <EventGroup title="Expenses" empty="No one-off expenses dated in the next 14 days."
                  items={upcoming.map((e: VariableExpense) => ({ key: e.id, when: e.start_date.slice(0, 10) === today ? 'today' : short(e.start_date.slice(0, 10)),
                    what: e.label || e.category, note: `${e.unit_name ?? 'shared'} · ${money2(Number(e.amount))}`, warn: false }))} />
              )}
              {canClaims && (
                <EventGroup title="Open claims" empty="No open claims."
                  items={openClaims.map((c: Claim) => ({ key: c.id, when: short(c.occurred_on.slice(0, 10)), what: c.unit_name ?? 'shared',
                    note: [c.description || c.category, c.severity, `waiting ${Math.max(0, Math.round((Date.parse(today) - Date.parse(c.occurred_on)) / 864e5))}d`]
                      .filter(Boolean).join(' · '), warn: c.severity === 'Critical' || c.severity === 'High' }))}
                  onMore={() => onGo('claims')} more="Open Claims" />
              )}
            </div>
          </Card>
        )}
      </div>

      {!canOps && !canUnits && !canCosts && !canClaims && (
        <p className="note">Your role does not include any of the day's work. Ask an admin if you need more.</p>
      )}
    </section>
  );
}

function Chip({ n, label, warn, busy, bad }: { n: number; label: string; warn?: string; busy: boolean; bad?: boolean }) {
  return (
    <span className={`home-chip ${bad ? 'bad' : ''}`}>
      <b>{busy ? '…' : n}</b> {label}{warn && !busy && <span className="breach"> · {warn}</span>}
    </span>
  );
}

/**
 * A Home card (§81). Home is a summary, not a workspace: every card can
 * fold to its title, its count and what needs attention — and stays folded
 * on this device — so no one card can push the others off the screen.
 */
function Card<T>({ id, title, count, summary, load, action, onAction, foot, busyText, children, className = '' }: {
  id: string; title: string; count?: number; summary?: ReactNode; load: Load<T>; action?: string; onAction?: () => void;
  foot?: string; busyText?: string; children: ReactNode; className?: string;
}) {
  const [folded, toggle] = useFolded(id);
  return (
    <div className={`card home-card ${folded ? 'folded' : ''} ${className}`}>
      <div className="home-card-head">
        <button className="home-fold" onClick={toggle} aria-expanded={!folded} title={folded ? 'Show' : 'Fold'}>
          <span className="home-caret" aria-hidden="true">{folded ? '▸' : '▾'}</span>
          <h3>{title}{count != null && !load.busy && <span className="count">{count}</span>}</h3>
        </button>
        {summary && !load.busy && <span className="home-summary">{summary}</span>}
        {action && <button className="link" onClick={onAction}>{action} →</button>}
      </div>
      {!folded && (load.busy ? <p className="note loading-dot">{busyText ?? 'Loading'}</p>
        : load.err ? <p className="banner warn">▲ {load.err}</p>
        : children)}
      {!folded && foot && !load.busy && !load.err && <p className="home-foot">{foot}</p>}
    </div>
  );
}

/** Folded or not, remembered per card on this device (a per-person convenience, never data). */
function useFolded(id: string): [boolean, () => void] {
  const key = `kaizen.home.folded.${id}`;
  const [folded, setFolded] = useState(() => { try { return localStorage.getItem(key) === '1'; } catch { return false; } });
  const toggle = () => setFolded(v => {
    try { localStorage.setItem(key, v ? '0' : '1'); } catch { /* private window: it just is not remembered */ }
    return !v;
  });
  return [folded, toggle];
}

/**
 * The first three, and the rest one tap away — in place, not on another
 * screen. Three is what a glance holds; the order puts what needs acting
 * on first, so the three shown are the three that matter.
 */
function ShowMore<T>({ items, render, limit = 3 }: { items: T[]; render: (x: T) => ReactNode; limit?: number }) {
  const [all, setAll] = useState(false);
  return (
    <>
      <ul className="home-list">{(all ? items : items.slice(0, limit)).map(render)}</ul>
      {items.length > limit && (
        <button className="link tiny home-more" onClick={() => setAll(!all)}>
          {all ? 'Show less ▴' : `Show ${items.length - limit} more ▾`}</button>
      )}
    </>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="note home-empty">{children}</p>;

/** "Mon Sep 28" */
const dayWord = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A day inside a card (§89): today, then tomorrow. */
function DayGroup({ label, empty, children }: { label: string; empty: string; children: ReactNode }) {
  const has = Array.isArray(children) ? children.some(Boolean) : !!children;
  return (
    <div className="home-day">
      <h4>{label}</h4>
      {has ? children : <p className="note home-empty">{empty}</p>}
    </div>
  );
}

/** The to-do card's line when folded — the counts that say whether to open it. */
function WorkSummary({ s }: { s: WorkSum }) {
  const parts: ReactNode[] = [];
  if (s.overdue) parts.push(<span key="o" className="breach">▲ {s.overdue} overdue</span>);
  if (s.today) parts.push(<span key="t" className="home-today">● {s.today} today</span>);
  if (s.urgent) parts.push(<span key="u" className="breach">▲▲ {s.urgent} urgent</span>);
  if (s.cases) parts.push(<span key="c">⚑ {s.cases} claim{s.cases === 1 ? '' : 's'}</span>);
  return parts.length ? <>{parts.map((p, i) => <span key={i}>{i > 0 && ' · '}{p}</span>)}</> : <span className="sub-n">nothing urgent</span>;
}

function CleanItem({ r }: { r: BoardRow }) {
  const who = r.assignment === 'assigned' ? r.cleaner
    : r.assignment === 'not_needed' ? 'no clean needed' : '▲ unassigned';
  return (
    <li className={r.assignment === 'not_needed' ? 'muted' : undefined}>
      <span className="home-time">{r.time}</span>
      <span className="home-main">
        <b>{r.unit}</b>{r.beds ? <span className="sub-n"> {r.beds}BR</span> : null}
        {r.urgency === 'turnover' && <span className="ops-flag urgent">⚡ same-day</span>}
        {r.deep && <span className="ops-flag deep">🧽 deep</span>}
        {(r.inspection.key === 'req' || r.inspection.key === 'due') && <span className="ops-flag req">🔍 inspection</span>}
      </span>
      <span className={`home-side ${who?.startsWith('▲') ? 'breach' : ''}`}>
        {who}{r.price != null && <span className="sub-n"> · {money2(r.price)}</span>}
      </span>
    </li>
  );
}

function EventGroup({ title, items, empty, onMore, more }: {
  title: string; empty: string; onMore?: () => void; more?: string;
  items: { key: string; when: string; what: string; note: string; warn: boolean }[];
}) {
  return (
    <div className="home-evgroup">
      <h4>{title}</h4>
      {!items.length ? <p className="note home-empty">{empty}</p> : (
        // What needs acting on first, then by date.
        <ShowMore items={[...items].sort((a, b) => Number(b.warn) - Number(a.warn))} render={i => (
          <li key={i.key}>
            <span className={`home-time ${i.when === 'today' ? 'today' : ''}`}>{i.when}</span>
            <span className="home-main"><b>{i.what}</b> <span className={i.warn ? 'breach' : 'sub-n'}>{i.note}</span></span>
          </li>
        )} />
      )}
      {more && onMore && <button className="link tiny home-more" onClick={onMore}>{more} →</button>}
    </div>
  );
}
