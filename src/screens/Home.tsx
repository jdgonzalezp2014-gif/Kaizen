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
  can, getClaims, getForward, getOperations, getVariable,
  type Claim, type OperationsResponse, type VariableExpense
} from '../api.ts';
import { redUnits } from '../lib/verdicts.ts';
import { todayIn, addDays } from '../lib/dates.ts';
import { money, money2 } from '../lib/format.ts';
import type { BoardRow } from '../lib/operations.ts';

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

  const ops = useLoad(canOps, async () => {
    const r = await getOperations(1);
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

  const todays = useMemo(() => {
    const rows = ops.data?.rows ?? [];
    return {
      outs: rows.filter(r => r.kind === 'out' && r.date === today),
      ins: rows.filter(r => r.kind === 'in' && r.date === today),
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
        {canOps && (
          <Card title="Cleanings today" count={cleans.length} load={ops} action="Open the board" onAction={() => onGo('operations')}
                foot={todays.tomorrowOuts ? `Tomorrow: ${todays.tomorrowOuts} clean${todays.tomorrowOuts === 1 ? '' : 's'}` : undefined}>
            {!todays.outs.length ? <Empty>No departures today.</Empty> : (
              <ul className="home-list">
                {todays.outs.map(r => <CleanItem key={r.resId} r={r} />)}
              </ul>
            )}
          </Card>
        )}

        {canOps && (
          <Card title="Check-ins today" count={todays.ins.length} load={ops} action="Open the board" onAction={() => onGo('operations')}
                foot={todays.tomorrowIns ? `Tomorrow: ${todays.tomorrowIns} arrival${todays.tomorrowIns === 1 ? '' : 's'}` : undefined}>
            {!todays.ins.length ? <Empty>No arrivals today.</Empty> : (
              <ul className="home-list">
                {todays.ins.map(r => {
                  // Ready means a clean is recorded for this unit today, or
                  // nobody left today (it was already empty).
                  const clean = todays.outs.find(o => o.unitId === r.unitId);
                  const ready = !clean ? 'no departure today' : clean.assignment === 'assigned' ? `cleaned by ${clean.cleaner}` : '▲ clean not assigned';
                  return (
                    <li key={r.resId}>
                      <span className="home-time">{r.time}</span>
                      <span className="home-main"><b>{r.unit}</b> <span className="sub-n">· {r.guest || 'guest'} · {r.nights} night{r.nights === 1 ? '' : 's'}{r.guests ? ` · ${r.guests} guests` : ''}</span></span>
                      <span className={`home-side ${ready.startsWith('▲') ? 'breach' : 'sub-n'}`}>{ready}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}

        {canUnits && (
          <Card title="Units in red" count={red.data?.list.length} load={red} action="Open Units" onAction={() => onGo('units')}
                busyText="Reading every calendar…"
                foot={red.data ? `By the Units screen's analysis, of ${red.data.total} live units` : undefined}>
            {red.data && !red.data.list.length ? <Empty>No unit is red. ● All live units are filling, full or too early to tell.</Empty> : (
              <ul className="home-list">
                {red.data?.list.map(({ unit: u, read }) => (
                  <li key={u.listingId}>
                    <span className="light tone-bad" aria-hidden="true" />
                    <span className="home-main"><b>{u.name}</b> <span className="home-verdict">{read.v.label}</span>
                      <span className="home-reason">{read.v.reason}</span></span>
                    {can(permissions, 'money') && u.exposure > 0 && <span className="home-side sub-n">{money(u.exposure)} open</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {(canOps || canCosts || canClaims) && (
          <Card title="Coming up" load={{ data: true, err: [ops.err, spend.err, claims.err].filter(Boolean).join(' · '), busy: ops.busy || spend.busy || claims.busy }}
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
                  items={openClaims.slice(0, 5).map((c: Claim) => ({ key: c.id, when: short(c.occurred_on.slice(0, 10)), what: c.unit_name ?? 'shared',
                    note: `${c.severity} · ${c.category ?? ''} · waiting ${Math.max(0, Math.round((Date.parse(today) - Date.parse(c.occurred_on)) / 864e5))}d`, warn: c.severity === 'Critical' || c.severity === 'High' }))}
                  onMore={() => onGo('claims')} more={openClaims.length > 5 ? `${openClaims.length - 5} more` : undefined} />
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

function Card<T>({ title, count, load, action, onAction, foot, busyText, children }: {
  title: string; count?: number; load: Load<T>; action?: string; onAction?: () => void;
  foot?: string; busyText?: string; children: ReactNode;
}) {
  return (
    <div className="card home-card">
      <div className="home-card-head">
        <h3>{title}{count != null && !load.busy && <span className="count">{count}</span>}</h3>
        {action && <button className="link" onClick={onAction}>{action} →</button>}
      </div>
      {load.busy ? <p className="note loading-dot">{busyText ?? 'Loading'}</p>
        : load.err ? <p className="banner warn">▲ {load.err}</p>
        : children}
      {foot && !load.busy && !load.err && <p className="home-foot">{foot}</p>}
    </div>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="note home-empty">{children}</p>;

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
        <ul className="home-list">
          {items.map(i => (
            <li key={i.key}>
              <span className={`home-time ${i.when === 'today' ? 'today' : ''}`}>{i.when}</span>
              <span className="home-main"><b>{i.what}</b> <span className={i.warn ? 'breach' : 'sub-n'}>{i.note}</span></span>
            </li>
          ))}
        </ul>
      )}
      {more && onMore && <button className="link tiny" onClick={onMore}>{more} →</button>}
    </div>
  );
}
