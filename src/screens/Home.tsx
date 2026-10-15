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
  can, getClaims, getCrewAdmin, getForward, getInventory, getGuestDocs, getOperations, getTodos, getVariable, uploadGuestDoc,
  type Claim, type Todo, type OperationsResponse, type StayDocs, type VariableExpense
} from '../api.ts';
import { redUnits } from '../lib/verdicts.ts';
import { channelLabel } from '../lib/breakdown.ts';
import { todayIn, addDays } from '../lib/dates.ts';
import { TodoList, type WorkSum, type WorkTab } from '../components/Todos.tsx';
import { money, money2 } from '../lib/format.ts';
import { hostawayReservationUrl, type BoardRow } from '../lib/operations.ts';
import { Hint, IconFlag } from '../components/Hint.tsx';
import { usePhone } from '../components/usePhone.ts';
import { Icon } from '../components/Icon.tsx';

const TZ = 'America/New_York';
const WEEK = 7;
type Load<T> = { data: T | null; err: string; busy: boolean };
const idle = <T,>(): Load<T> => ({ data: null, err: '', busy: true });
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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
    const r = await getForward(today, 30, true); // up to 10 minutes old (owner, Oct 2026)
    if (!r.ok) throw new Error(r.error === 'not_configured' ? 'Hostaway is not connected.' : (r.error ?? 'Could not load.'));
    return { list: redUnits(r.units, (r.meta.occFloorPct ?? 60) / 100, r.meta.asOf), total: r.units.filter(u => u.active).length, at: r.meta.generatedAt };
  });
  const spend = useLoad(canCosts, async () => {
    const r = await getVariable();
    return r.expenses ?? [];
  });
  const claims = useLoad(canClaims, async () => {
    const r = await getClaims();
    return r.claims ?? [];
  });
  // Cleaners' extras and purchases paid in the field, waiting for a decision.
  // Lost here means Costs is off and the person who paid is unpaid, so Home
  // keeps the door — the approval screen is Operations → Cleaners (§122, §137).
  const canApprove = can(permissions, 'operations.edit');
  const approvals = useLoad(canApprove, async () => {
    const r = await getCrewAdmin();
    if (!r.ok) throw new Error(r.message ?? r.error ?? 'Could not load approvals.');
    const extras = (r.pending ?? []).reduce((a, e) => a + Number(e.amount || 0), 0);
    const field = (r.fieldPending ?? []).reduce((a, e) => a + Number(e.amount || 0), 0);
    // owner, Oct 2026: each one, for the Approvals tab in the To-do card.
    const items = [
      ...(r.pending ?? []).map(e => ({ id: `x${e.id}`, amount: Number(e.amount || 0), who: e.cleaner, what: e.description || 'Extra', where: e.unit })),
      ...(r.fieldPending ?? []).map(e => ({ id: `f${e.id}`, amount: Number(e.amount || 0), who: e.byName, what: e.description || e.category, where: e.unit ?? '' }))];
    return { count: items.length, total: extras + field, items };
  });
  // owner, Oct 2026: the open purchase orders (shopping to-dos) get their own tab in the To-do card.
  const orders = useLoad(canOps, async () => {
    const r = await getInventory();
    return r.ok ? new Set(r.orders.map(o => o.todoId)) : new Set<string>();
  });

  // Open to-dos per unit, for the work chips on each check-in/out row — as on the board (§159).
  const work = useLoad(canOps && canTodos, async () => {
    const r = await getTodos();
    const m = new Map<string, Todo[]>();
    if (r.ok) for (const t of r.todos) if (!t.doneAt) for (const u of t.unitIds) m.set(u, [...(m.get(u) ?? []), t]);
    return m;
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
  // §106: what Drive holds for every arrival — the ID and the agreement — and where.
  const [docs, setDocs] = useState<Record<string, { id: boolean; agreement: boolean; folderUrl: string | null }>>({});
  const arrivals = [...todays.ins, ...todays.ins2];
  const arrivalsKey = arrivals.map(r => r.resId).join();
  const docsOf = (d: StayDocs) => ({ id: d.id.length > 0, agreement: d.agreement.length > 0, folderUrl: d.folderUrl });
  useEffect(() => {
    if (!canDocs || !arrivals.length) return;
    const stays = arrivals.map(r => ({ resId: r.resId, arrival: r.date, name: r.docName }));
    void getGuestDocs(stays).then(x => { if (x.ok) setDocs(Object.fromEntries(Object.entries(x.docs).map(([k, d]) => [k, docsOf(d)]))); });
  }, [canDocs, arrivalsKey]);
  // A file dropped anywhere but a drop zone is not opened by the browser instead of the page.
  useEffect(() => {
    const stop = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
    addEventListener('dragover', stop); addEventListener('drop', stop);
    return () => { removeEventListener('dragover', stop); removeEventListener('drop', stop); };
  }, []);
  const signed = (r: BoardRow) => r.agreement === 'signed';
  const unsigned = arrivals.filter(r => r.agreement === 'not_signed').length;
  const needsCopy = new Set(ops.data?.guestDocUnits ?? []);
  const [uploading, setUploading] = useState<string | null>(null);
  const [upErr, setUpErr] = useState('');
  // The guest's ID or agreement, into the reservation's Drive folder (§90, §106): picked, or dropped on the row.
  const upload = async (r: BoardRow, kind: 'id' | 'agreement', file: File | undefined) => {
    if (!file) return;
    if (!/^image\/|^application\/pdf$/.test(file.type)) { setUpErr(`${r.unit}: a photo or a PDF, please.`); return; }
    setUploading(`${r.resId}:${kind}`); setUpErr('');
    const x = await uploadGuestDoc(r.resId, kind, file).catch(e => ({ ok: false as const, message: String(e) }));
    setUploading(null);
    if (x.ok) setDocs(m => ({ ...m, [r.resId]: docsOf(x.docs) })); else setUpErr(`${r.unit}: ${x.message ?? 'not uploaded'}`);
  };
  /**
   * A document pill, the board's DocChip logic: solid green once it is there (signed in Hostaway's portal, or filed
   * in Drive — the agreement — §89), dashed while missing; dashed and clickable to upload when this person may file it.
   */
  const docPill = (r: BoardRow, kind: 'id' | 'agreement') => {
    const have = docs[r.resId];
    const done = kind === 'agreement' ? signed(r) || !!have?.agreement : !!have?.id;
    // The agreement is a sheet with ✓ or ▲ — "signed / not signed" is on hover (owner, 2026-10-15).
    const text = kind === 'agreement' ? <>{done ? '✓' : '▲'} <Icon n="file" /></> : (done ? '✓ ID' : '○ ID');
    const what = kind === 'agreement' ? 'rental agreement' : 'ID copy';
    if (done) {
      return have?.folderUrl
        ? <a key={kind} className="ops-flag ops-doc filed" href={have.folderUrl} target="_blank" rel="noreferrer"
             data-tip={`${kind === 'agreement' ? 'Signed — t' : 'T'}he ${what} — open the reservation's Drive folder`}>{text}</a>
        : <span key={kind} className="ops-flag ops-doc filed" data-tip={`${kind === 'agreement' ? 'Signed — t' : 'T'}he ${what} is in.`}>{text}</span>;
    }
    const cls = `ops-flag ops-doc missing ${kind === 'agreement' ? 'urgent' : ''}`;
    if (!canDocs) return <span key={kind} className={cls} data-tip={`Not signed — no ${what} yet.`}>{text}</span>;
    return (
      <label key={kind} className={`${cls} home-upload`}
             data-tip={`${kind === 'agreement' ? 'Not signed — n' : 'N'}o ${what} yet — click to upload it to the reservation's Drive folder, or drop the file on this line.`}>
        {uploading === `${r.resId}:${kind}` ? 'Uploading…' : text}
        <input type="file" accept="image/*,.pdf" className="sr-file" disabled={!!uploading}
               onChange={e => { void upload(r, kind, e.target.files?.[0]); e.target.value = ''; }} />
      </label>
    );
  };
  const arrivalRow = (r: BoardRow, isToday: boolean) => {
    const clean = isToday ? todays.outs.find(o => o.unitId === r.unitId) : undefined;
    const ready = !isToday ? null : !clean ? 'no departure today' : clean.assignment === 'assigned' ? `cleaned by ${clean.cleaner}` : '▲ clean not assigned';
    return (
      <DropRow key={r.resId} enabled={canDocs} label={`${r.unit} · ${r.guest || 'guest'}`} onDrop={(kind, file) => void upload(r, kind, file)}>
        <span className="home-time">{r.time}</span>
        <UnitCell r={r} />
        <span className="home-flags">
          {workChips(r.unitId)}
          {ready && <IconFlag tone={ready.startsWith('▲') ? 'attn' : undefined} icon={<Icon n="brush" />}
            label={ready.startsWith('▲') ? 'Clean not assigned' : 'Prepped'} detail={ready.startsWith('▲') ? 'The departure before this guest has no cleaner yet' : ready} />}
          {(r.agreement || docs[r.resId]) && docPill(r, 'agreement')}
          {/* The ID copy only where the building keeps one (§73, §106) — as on the board. */}
          {canDocs && needsCopy.has(r.unitId) && docPill(r, 'id')}
        </span>
      </DropRow>
    );
  };
  /**
   * Open work on the unit, as the board shows it (§159) but only that there is some: a wrench for work orders,
   * a list for to-dos, a cart for purchase orders — the titles on hover, a click opens them (owner, 2026-10-15).
   */
  const workChips = (unitId: string) => {
    const all = work.data?.get(unitId) ?? [];
    const po = orders.data ?? new Set<string>();
    const open = () => { onGo('operations:todos'); setTimeout(() => dispatchEvent(new CustomEvent('kaizen:work-for', { detail: unitId })), 0); };
    return ([
      ['wrench', 'Work orders', all.filter(t => t.kind === 'work_order')],
      ['cart', 'Purchase orders', all.filter(t => t.kind !== 'work_order' && po.has(t.id))],
      ['list', 'To-dos', all.filter(t => t.kind !== 'work_order' && !po.has(t.id))]
    ] as const).filter(([, , ts]) => ts.length).map(([n, label, ts]) => (
      <button key={n} type="button" className="ops-flag due ops-flag-btn home-work" aria-label={label} onClick={open}
              data-tip={`${label}:\n${ts.map(t => `· ${t.title}`).join('\n')}`}><Icon n={n} /></button>
    ));
  };
  // Not signed first — the three shown are the three to chase.
  const bySigned = (list: BoardRow[]) => [...list].sort((a, b) => Number(signed(a)) - Number(signed(b)));
  const [todoSum, setTodoSum] = useState<WorkSum | null>(null);
  const showMoney = can(permissions, 'money');
  const approvalTab: WorkTab[] = canApprove ? [{
    key: 'approvals', label: '$ Approvals', count: approvals.data?.count ?? 0, alert: !!approvals.data?.count,
    body: !approvals.data?.items.length ? <p className="note">{approvals.busy ? 'Reading…' : 'Nothing waiting for approval. ✓'}</p> : <>
      <ul className="todo-list">{approvals.data.items.map(a => (
        <li key={a.id} className="todo"><div className="todo-line">
          <span className="todo-title-text">{a.what}</span>
          {a.where && <span className="todo-unit">{a.where}</span>}
          <span className="sub-n">→ {a.who}</span>
          {showMoney && <span className="sub-n">{money2(a.amount)}</span>}
          <span className="todo-quick"><button type="button" onClick={() => onGo('operations:crew')}>Review →</button></span>
        </div></li>))}</ul>
      <p className="note">Approve or deny in Operations → Cleaners.</p>
    </>
  }] : [];
  // Coming up (§91). Open claims only when the to-do card is not already
  // showing them in its Claims lane — the same case twice on one screen
  // makes the eye check whether they differ.
  type Ev = { key: string; when: string; what: string; note: string; warn: boolean };
  const comingGroups: { title: string; items: Ev[]; quiet: string; onMore?: () => void; more?: string }[] = [
    ...(canOps ? [{ title: 'Inspections', quiet: 'no inspections in the next 7 days', onMore: () => onGo('operations'), items: [
      ...dueOnBoard.filter(r => !inspections.some(i => i.date === today && i.unit === r.unit))
        .map(r => ({ key: `due-${r.resId}`, when: 'today', what: r.unit, note: r.inspection.key === 'req' ? 'required before the next guest — not yet scheduled' : 'due this turnover — not yet scheduled', warn: true })),
      ...inspections.map(i => ({ key: i.id, when: i.date === today ? 'today' : short(i.date), what: i.unit, note: i.by ? `by ${i.by}` : '', warn: false }))
    ] }] : []),
    ...(canCosts ? [{ title: 'Expenses', quiet: 'no one-off expenses in the next 14 days',
      items: upcoming.map((e: VariableExpense) => ({ key: e.id, when: e.start_date.slice(0, 10) === today ? 'today' : short(e.start_date.slice(0, 10)),
        what: e.label || e.category, note: `${e.unit_name ?? 'shared'} · ${money2(Number(e.amount))}`, warn: false })) }] : []),
    ...(canClaims && !canTodos ? [{ title: 'Open claims', quiet: 'no open claims',
      items: openClaims.map((c: Claim) => ({ key: c.id, when: short(c.occurred_on.slice(0, 10)), what: c.unit_name ?? 'shared',
        note: [c.description || c.category, c.severity, `waiting ${Math.max(0, Math.round((Date.parse(today) - Date.parse(c.occurred_on)) / 864e5))}d`]
          .filter(Boolean).join(' · '), warn: c.severity === 'Critical' || c.severity === 'High' })) }] : [])
  ];
  const comingCount = comingGroups.reduce((a, g) => a + g.items.length, 0);
  const comingErr = [ops.err, spend.err, claims.err].filter(Boolean).join(' · ');

  const [pick, setPick] = useState('');
  const phone = usePhone();
  const unassignedAll = unassigned.length + todays.outs2.filter(isOpen).length;
  const checkAlert = unassignedAll + unsigned + notReady;
  // The modules this person may see, in order; each renders itself so a new one is one more entry (§159).
  const mods: { key: string; label: string; count?: number; alert?: boolean; body: ReactNode }[] = [
    ...(canOps ? [{ key: 'checkio', label: 'Check-ins/outs', count: ops.busy ? undefined : cleans.length + todays.ins.length, alert: checkAlert > 0, body: (
      <Panel title="Check-ins & check-outs" hint="Today and tomorrow, from the Operations board. Unassigned cleans and unsigned agreements come first." load={ops}
             action="Open the board" onAction={() => onGo('operations')}
             summary={checkAlert > 0 ? <span className="breach">▲ {[unassignedAll && `${unassignedAll} unassigned`, unsigned && `${unsigned} not signed`, notReady && `${notReady} not ready`].filter(Boolean).join(' · ')}</span> : undefined}>
        {upErr && <p className="banner warn">▲ {upErr}</p>}
        <h4 className="home-sub">Check-outs</h4>
        <DayGroup label={`Today · ${dayWord(today)}`} empty="No departures today.">
          {todays.outs.length > 0 && <ShowMore items={[...todays.outs].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)))} render={r => <CleanItem key={r.resId} r={r} work={workChips(r.unitId)} />} />}
        </DayGroup>
        <DayGroup label={`Tomorrow · ${dayWord(tomorrow)}`} empty="No departures tomorrow.">
          {todays.outs2.length > 0 && <ShowMore items={[...todays.outs2].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)))} render={r => <CleanItem key={r.resId} r={r} work={workChips(r.unitId)} />} />}
        </DayGroup>
        <h4 className="home-sub">Check-ins</h4>
        <DayGroup label={`Today · ${dayWord(today)}`} empty="No arrivals today.">
          {todays.ins.length > 0 && <ShowMore items={bySigned(todays.ins)} render={r => arrivalRow(r, true)} />}
        </DayGroup>
        <DayGroup label={`Tomorrow · ${dayWord(tomorrow)}`} empty="No arrivals tomorrow.">
          {todays.ins2.length > 0 && <ShowMore items={bySigned(todays.ins2)} render={r => arrivalRow(r, false)} />}
        </DayGroup>
      </Panel>) }] : []),
    ...(comingGroups.length > 0 ? [{ key: 'coming', label: 'Coming up', count: ops.busy || spend.busy || claims.busy ? undefined : comingCount, body: (
      <Panel title="Coming up" hint="Inspections in the next 7 days and what costs money in the next 14." load={{ data: true, err: comingErr, busy: ops.busy || spend.busy || claims.busy }}
             action={canCosts ? 'Open Costs' : undefined} onAction={() => onGo('costs')}>
        <div className="home-events">
          {comingGroups.filter(g => g.items.length).map(g => (
            <EventGroup key={g.title} title={g.title} items={g.items} onMore={g.onMore} more={g.more} />
          ))}
          {/* Empty groups say so in one quiet line, not a heading each (§91). */}
          {comingGroups.some(g => !g.items.length) && (
            <p className="note home-empty">{cap(comingGroups.filter(g => !g.items.length).map(g => g.quiet).join(' · '))}.</p>
          )}
        </div>
      </Panel>) }] : []),
    ...(canUnits ? [{ key: 'red', label: 'Units in red', count: red.busy ? undefined : red.data?.list.length, alert: !!red.data?.list.length, body: (
      <Panel title="Units in red" hint="Units the Units screen's analysis flags red, worst first." load={red} action="Open Units" onAction={() => onGo('units')}
             busyText="Reading every calendar…"
             foot={red.data ? `By the Units screen's analysis, of ${red.data.total} live units · read ${red.data.at ? new Date(red.data.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : 'now'} (kept 10 min; Units is live)` : undefined}>
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
      </Panel>) }] : [])
  ];
  // Phone: To-dos is a tab too, and the default. Desktop: To-dos is always the left column; the rail picks among the rest.
  const tabs = phone && canTodos ? [{ key: 'todo', label: 'To-dos', count: todoSum?.open, alert: !!(todoSum?.overdue || todoSum?.urgent), body: null as ReactNode }, ...mods] : mods;
  const active = tabs.some(t => t.key === pick) ? pick : tabs[0]?.key ?? '';

  return (
    <section className="home">
      {/* §159 (owner, 2026-10-14): the date lives in the menu now, and the summary pills (they repeated the cards) are gone. */}

      {ops.data?.mode === 'shadow' && (
        <p className="note">○ Operations is in shadow mode — cleaners shown are Kaizen's reading; the daily file still decides.</p>
      )}

      <div className={`home-layout ${canTodos && mods.length ? '' : 'solo'}`}>
        {canTodos && (
          <div className="home-main-col" role={phone ? 'tabpanel' : undefined} id="home-panel-todo" hidden={phone && active !== 'todo'}>
            <div className="card home-card home-todos">
              <TodoList today={today} compact canClaims={canClaims} onSummary={setTodoSum} extraTabs={approvalTab}
                        orderIds={canOps ? orders.data ?? new Set() : undefined}
                        head={{ title: 'To-dos', hint: 'Everything that needs a person, by category. Overdue, today and urgent come first; Now, Later and Further out group the rest. "All" opens the full list, with filters, in Operations.', onAll: canOps ? () => onGo('operations:todos') : undefined }} />
            </div>
          </div>
        )}

        {mods.length > 0 && (
          <aside className="home-side-col" aria-label="Operations">
            {/* One strip of modules: on a phone it also carries To-dos and takes the whole screen. */}
            <div className="home-rail" role="tablist" aria-label="Home modules">
              {tabs.map(m => (
                <button key={m.key} role="tab" id={`home-tab-${m.key}`} aria-selected={active === m.key} aria-controls={`home-panel-${m.key}`}
                        className={`home-chip ${active === m.key ? 'on' : ''}`} onClick={() => setPick(m.key)}>
                  {m.label}
                  {m.count != null && <span className={`home-chip-n ${m.alert ? 'alert' : ''}`}>{m.alert && <span aria-hidden="true">▲ </span>}{m.count}</span>}
                </button>
              ))}
            </div>
            {mods.filter(m => m.key === active).map(m => (
              <div key={m.key} className="home-slide" role="tabpanel" id={`home-panel-${m.key}`} aria-labelledby={`home-tab-${m.key}`}>{m.body}</div>
            ))}
          </aside>
        )}
      </div>

      {!canOps && !canUnits && !canCosts && !canClaims && (
        <p className="note">Your role does not include any of the day's work. Ask an admin if you need more.</p>
      )}
    </section>
  );
}


/**
 * A Home module's body (§81, §159): title, its "?", what needs attention, and the door to the full screen.
 * Folding is gone — the module strip does the choosing, so one module is on screen at a time.
 */
function Panel<T>({ title, hint, count, summary, load, action, onAction, foot, busyText, children, className = '' }: {
  title: string; hint?: string; count?: number; summary?: ReactNode; load: Load<T>; action?: string; onAction?: () => void;
  foot?: string; busyText?: string; children: ReactNode; className?: string;
}) {
  return (
    <div className={`card home-card ${className}`}>
      <div className="home-card-head">
        <h3>{title}{count != null && !load.busy && <span className="count">{count}</span>}{hint && <Hint>{hint}</Hint>}</h3>
        {summary && !load.busy && <span className="home-summary">{summary}</span>}
        {action && <button className="link" onClick={onAction}>{action} →</button>}
      </div>
      {load.busy ? <p className="note loading-dot">{busyText ?? 'Loading'}</p>
        : load.err ? <p className="banner warn">▲ {load.err}</p>
        : children}
      {foot && !load.busy && !load.err && <p className="home-foot">{foot}</p>}
    </div>
  );
}

/** Every item, in the order that puts what needs acting on first; the module's body scrolls, nothing folds. */
function ShowMore<T>({ items, render }: { items: T[]; render: (x: T) => ReactNode }) {
  return <ul className="home-list">{items.map(render)}</ul>;
}

const Empty = ({ children }: { children: ReactNode }) => <p className="note home-empty">{children}</p>;

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

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

/**
 * Time | unit ↗ | icons — one line (owner, 2026-10-15). The stay (guest, nights, what it pays) is the arrow's
 * hover, the arrow still opens the reservation in Hostaway, as on the board.
 */
function UnitCell({ r }: { r: BoardRow }) {
  const stay = [r.guest || 'guest', `${r.nights} night${r.nights === 1 ? '' : 's'}`, r.guests ? `${r.guests} guests` : '',
    r.channel ? channelLabel(r.channel) : '', r.total ? money(r.total) : ''].filter(Boolean).join(' · ');
  return (
    <span className="home-main home-unit">
      <b>{r.unit}</b>{r.beds ? <span className="sub-n"> {r.beds}BR</span> : null}
      {' '}<a className="home-hostaway" href={hostawayReservationUrl(r.resId)} target="_blank" rel="noreferrer"
              aria-label={`${stay} — open the reservation in Hostaway`} data-tip={`${stay}\nOpen the reservation in Hostaway`}>↗</a>
    </span>
  );
}

function CleanItem({ r, work }: { r: BoardRow; work: ReactNode }) {
  const who = r.assignment === 'assigned' ? r.cleaner
    : r.assignment === 'not_needed' ? 'No clean needed' : 'Unassigned';
  return (
    <li className={r.assignment === 'not_needed' ? 'muted' : undefined}>
      <span className="home-time">{r.time}</span>
      <UnitCell r={r} />
      <span className="home-flags">
        {work}
        {/* Who cleans and the pay, on hover; amber when nobody does yet. */}
        <IconFlag tone={r.assignment === 'assigned' || r.assignment === 'not_needed' ? undefined : 'attn'} icon={<Icon n="user" />}
          label={who ?? 'Unassigned'} detail={r.price != null ? `Pays ${money2(r.price)}` : null} />
        {r.urgency === 'turnover' && <IconFlag tone="attn" icon={<Icon n="zap" />} label="Same-day turnover" detail="The next guest arrives the same day" />}
        {r.deep && <IconFlag icon={<Icon n="brush" />} label="Deep clean" />}
        {(r.inspection.key === 'req' || r.inspection.key === 'due') && <IconFlag tone={r.inspection.key === 'req' ? 'attn' : undefined} icon={<Icon n="search" />}
          label={r.inspection.key === 'req' ? 'Inspection required' : 'Monthly inspection due'} detail={r.inspection.reason} />}
      </span>
    </li>
  );
}

function EventGroup({ title, items, onMore, more }: {
  title: string; onMore?: () => void; more?: string;
  items: { key: string; when: string; what: string; note: string; warn: boolean }[];
}) {
  return (
    <div className="home-evgroup">
      <h4>{title}</h4>
      {/* What needs acting on first, then by date. */}
      <ShowMore items={[...items].sort((a, b) => Number(b.warn) - Number(a.warn))} render={i => (
        <li key={i.key}>
          <span className={`home-time ${i.when === 'today' ? 'today' : ''}`}>{i.when}</span>
          <span className="home-main"><b>{i.what}</b> <span className={i.warn ? 'breach' : 'sub-n'}>{i.note}</span></span>
        </li>
      )} />
      {more && onMore && <button className="link tiny home-more" onClick={onMore}>{more} →</button>}
    </div>
  );
}

/**
 * An arrival that takes a file (§106): drag one over the line and it offers
 * two places to drop it — as the ID or as the agreement.
 */
function DropRow({ enabled, label, onDrop, children }: { enabled: boolean; label: string; onDrop: (kind: 'id' | 'agreement', file: File) => void; children: ReactNode }) {
  const [over, setOver] = useState(false);
  const isFile = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  if (!enabled) return <li>{children}</li>;
  // The zones cover the line — each says whose stay it files to.
  const zone = (kind: 'id' | 'agreement', text: string) => (
    <div className="drop-zone" onDragOver={e => { if (isFile(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
         onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onDrop(kind, f); }}>
      <b>{text}</b><span className="sub-n">{label}</span>
    </div>
  );
  return (
    <li className={`drop-row ${over ? 'is-over' : ''}`}
        onDragEnter={e => { if (isFile(e)) setOver(true); }}
        onDragOver={e => { if (isFile(e)) e.preventDefault(); }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
        onDrop={e => { e.preventDefault(); setOver(false); }}>
      {children}
      {over && <div className="drop-zones">{zone('id', '⇪ Drop as ID')}{zone('agreement', '⇪ Drop as Agreement')}</div>}
    </li>
  );
}
