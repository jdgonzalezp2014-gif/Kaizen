/**
 * Operations — the daily file, inside Kaizen OS.
 *
 * Five views of one fetch, each mirroring a tab people already use in the
 * sheet: Main (the next ten days), the per-cleaner tabs, the Inspections
 * panel with its log, the Notes Log, and the rate card.
 *
 * Read-only, and that is the design rather than a gap. The sheet is where
 * the team decides who cleans and what it pays, and it is what pushes
 * those decisions into the Hostaway calendar. A second place to edit them
 * would be a second version of the truth — and this one would not reach
 * Hostaway. Every view links back to the sheet for the change itself.
 */
import { useEffect, useMemo, useState } from 'react';
import { getOperations, type OperationsResponse, type SourceState } from '../api.ts';
import type { BoardRow, InspectionTier } from '../lib/operations.ts';
import { money, money2 } from '../lib/format.ts';
import { channelLabel } from '../lib/breakdown.ts';
import { Loading } from '../components/Loading.tsx';
import { recallTiming, rememberTiming } from '../lib/progress.ts';

type View = 'board' | 'cleaners' | 'inspections' | 'notes' | 'rates';
const VIEWS: [View, string][] = [
  ['board', 'Next 10 days'], ['cleaners', 'By cleaner'], ['inspections', 'Inspections'],
  ['notes', 'Notes log'], ['rates', 'Rates & rules']
];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Wed, Sep 24" — computed in UTC from the ISO date, so no browser zone can shift it. */
const dayLabel = (d: string) => {
  const t = new Date(`${d}T12:00:00Z`);
  return `${DOW[t.getUTCDay()]}, ${MON[t.getUTCMonth()]} ${t.getUTCDate()}`;
};
const short = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${MON[t.getUTCMonth()]} ${t.getUTCDate()}`; };
/**
 * The daily file's Urgency column is a bare symbol — its legend lives in a
 * cell note on Main. Here each one carries its word. ⏳ ("no next
 * booking") is left out: the Next stay column already says it in words.
 */
const URGENCY: Record<string, string | null> = {
  '⚡': '⚡ same-day', '🔁': '🔁 same guest again', '⏳': null
};
const urgencyLabel = (u: string | null) => !u ? null : (u in URGENCY ? URGENCY[u]! : u);
const isWeekend = (d: string) => [0, 6].includes(new Date(`${d}T12:00:00Z`).getUTCDay());

export function Operations() {
  const [data, setData] = useState<OperationsResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(true);
  const [view, setView] = useState<View>('board');

  const load = (refresh = false) => {
    setBusy(true); setErr('');
    const started = Date.now();
    getOperations(10, refresh)
      .then(r => {
        if (!r.ok) { setErr(r.message ?? r.error ?? 'Could not load.'); return; }
        rememberTiming('operations', Date.now() - started);
        setData(r);
      })
      .catch(e => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(), []);

  return (
    <section>
      <nav className="subtabs">
        {VIEWS.map(([k, label]) => (
          <button key={k} className={view === k ? 'tab active' : 'tab'} onClick={() => setView(k)}>
            {label}
          </button>
        ))}
      </nav>

      <div className="row-controls">
        {data && (
          <span className="note">
            {dayLabel(data.today)} → {dayLabel(data.end)} · {data.timeZone.replace('_', ' ')} time
          </span>
        )}
        {/* Re-reads the Cleanings Log now instead of waiting out its
            half-hour — for "I just changed the cleaner in the sheet". */}
        <button className="chip" disabled={busy} onClick={() => load(true)}>
          {busy && data ? 'Reading…' : 'Re-read the sheet'}
        </button>
        {data?.sheetUrl && (
          <a className="chip" href={data.sheetUrl} target="_blank" rel="noreferrer">Open the daily file ↗</a>
        )}
        {busy && data && <span className="note right loading-dot">Loading…</span>}
      </div>

      {err && <p className="banner error">{err}</p>}
      {!data && !err && (
        <Loading estimateMs={recallTiming('operations', 6000)}
                 stages={['Reading the daily file…', 'Fetching reservations from Hostaway…',
                          'Matching cleaners to checkouts…', 'Checking inspections…']} />
      )}
      {data && <Sources sources={data.sources} />}

      <div className={busy && data ? 'is-stale' : undefined}>
        {data && view === 'board' && <Board data={data} />}
        {data && view === 'cleaners' && <ByCleaner data={data} />}
        {data && view === 'inspections' && <Inspections data={data} />}
        {data && view === 'notes' && <Notes data={data} />}
        {data && view === 'rates' && <Rates data={data} />}
      </div>
    </section>
  );
}

/**
 * What could not be read, said once, at the top. A tab that is not
 * published and a tab with nothing in it look identical on a board —
 * both are blank — and only one of them is fine.
 */
function Sources({ sources }: { sources: OperationsResponse['sources'] }) {
  const names: Record<string, string> = {
    cleanings: 'Cleanings Log', notes: 'Notes Log', inspections: 'Inspection Log', settings: 'Settings tab'
  };
  const bad = (Object.entries(sources) as [string, SourceState][]).filter(([, s]) => !s.ok || s.warning);
  if (!bad.length) return null;
  return (
    <div className="banner warn">
      {bad.map(([k, s]) => (
        <div key={k}>▲ <b>{names[k]}</b>: {s.problem ?? s.warning}</div>
      ))}
    </div>
  );
}

/* ── Next 10 days ─────────────────────────────────────────────────── */

type Filter = 'all' | 'out' | 'in' | 'attention';

/** Everything on a departure that someone has to act on. */
function needsAttention(r: BoardRow): string[] {
  if (r.kind !== 'out') return [];
  const why: string[] = [];
  if (!r.inDailyFile) why.push('not in the daily file yet');
  if (r.assignment === 'tbd') why.push('no cleaner');
  if (r.assignment === 'assigned' && r.price == null) why.push('not priced');
  if (r.inspection.key === 'req' || r.inspection.key === 'due') why.push('inspection');
  if (r.next?.gapDays === 0) why.push('same-day turnover');
  return why;
}

function Board({ data }: { data: OperationsResponse }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const s = data.summary;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.rows.filter(r =>
      (filter === 'all' || (filter === 'attention' ? needsAttention(r).length > 0 : r.kind === filter)) &&
      (!needle || `${r.unit} ${r.guest} ${r.cleaner ?? ''}`.toLowerCase().includes(needle)));
  }, [data, filter, q]);

  // Every day in the window, quiet or not, so the board reads as a
  // calendar — a day with nothing on it is information too.
  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = data.today; d <= data.end;) {
      out.push(d);
      const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1);
      d = t.toISOString().slice(0, 10);
    }
    return out;
  }, [data.today, data.end]);

  const attention = data.rows.filter(r => needsAttention(r).length > 0).length;

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
      </dl>

      {s.notInDailyFile > 0 && (
        <p className="note">
          ▲ {s.notInDailyFile} checkout(s) are in Hostaway but not yet in the daily file — booked
          since its last refresh. They have no cleaner until someone runs <b>📅 Next 10 Days</b> in
          the sheet; nothing here assigns one.
        </p>
      )}

      <div className="row-controls">
        {([['all', 'Everything'], ['out', 'Departures'], ['in', 'Arrivals'],
           ['attention', `Needs attention ${attention}`]] as [Filter, string][]).map(([k, label]) => (
          <button key={k} className={filter === k ? 'chip active' : 'chip'} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
        <input className="date-in" placeholder="Unit, guest or cleaner" value={q}
               onChange={e => setQ(e.target.value)} />
      </div>

      <div className="grid-scroll">
        <table className="units compact ops-board">
          <thead>
            <tr>
              <th></th><th>Unit</th><th>Guest</th><th>Time</th><th>Next stay</th>
              <th>Cleaner</th><th className="n">Pays</th><th>Flags</th><th>Notes</th>
            </tr>
          </thead>
          {days.map(d => {
            const dayRows = rows.filter(r => r.date === d);
            if (!dayRows.length && (filter !== 'all' || q)) return null;
            return (
              <tbody key={d}>
                <tr className="ops-day">
                  <td colSpan={9}>
                    {dayLabel(d)}{d === data.today ? ' · today' : ''}{isWeekend(d) ? ' · weekend' : ''}
                    <span className="sub-n">
                      {' '}{dayRows.filter(r => r.kind === 'out').length} out ·{' '}
                      {dayRows.filter(r => r.kind === 'in').length} in
                    </span>
                  </td>
                </tr>
                {!dayRows.length && (
                  <tr><td colSpan={9} className="note ops-quiet">no arrivals or departures</td></tr>
                )}
                {dayRows.map(r => <BoardLine key={`${r.resId}-${r.kind}`} r={r} money={data.showMoney} />)}
              </tbody>
            );
          })}
        </table>
      </div>
      <p className="note">
        Cleaner, pay, deep and checkout time are the daily file's decisions, read from its Cleanings
        Log; change them in the sheet and press <b>Re-read the sheet</b>. Stays, guests and the next
        booking come live from Hostaway.
      </p>
    </>
  );
}

function BoardLine({ r, money: showMoney }: { r: BoardRow; money: boolean }) {
  const out = r.kind === 'out';
  return (
    <tr className={out ? 'ops-out' : 'ops-in'}>
      <td><span className={`ops-kind ${r.kind}`}>{out ? 'OUT' : 'IN'}</span></td>
      <td>
        <b>{r.unit}</b>
        {r.beds ? <span className="sub-n"> {r.beds}BR</span> : null}
      </td>
      <td>
        {r.guest || <span className="note">—</span>}
        <div className="sub-n">
          {r.nights} night{r.nights === 1 ? '' : 's'}{r.guests ? ` · ${r.guests} guests` : ''}
          {r.channel ? ` · ${channelLabel(r.channel)}` : ''}
          {showMoney && r.total > 0 ? ` · ${money(r.total)}` : ''}
        </div>
      </td>
      <td>
        {out ? (r.time ?? <span className="note">10:00 AM</span>)
          // A custom check-in time is kept on Main only — no log carries
          // it — so a default printed here could contradict the sheet.
          : <span className="note" title="Check-in times live on the daily file's Main tab">—</span>}
      </td>
      <td>
        {!out ? (
          r.preppedBy ? <span className="sub-n">prepped by {r.preppedBy}</span> : null
        ) : !r.next ? (
          <span className="breach">▲ nothing booked</span>
        ) : (
          <>
            {short(r.next.arrival)}{' '}
            {r.next.gapDays === 0
              ? <b className="breach">same day</b>
              : <span className={r.next.longVacancy ? 'breach' : 'sub-n'}>+{r.next.gapDays}d</span>}
            {showMoney && r.next.total != null && <div className="sub-n">{money(r.next.total)}</div>}
          </>
        )}
      </td>
      <td>
        {!out ? null
          : !r.inDailyFile ? <span className="breach">▲ not in the daily file yet</span>
          : r.assignment === 'not_needed' ? <span className="note">no clean needed</span>
          : r.assignment === 'tbd' ? <span className="breach">▲ unassigned</span>
          : r.cleaner}
      </td>
      <td className="n">
        {out && r.assignment === 'assigned'
          ? (r.price == null ? <span className="note">not priced</span> : money2(r.price))
          : null}
      </td>
      <td>
        {r.deep && <span className="ops-flag deep">🧽 deep</span>}
        {urgencyLabel(r.urgency) && <span className="ops-flag urgent">{urgencyLabel(r.urgency)}</span>}
        {r.inspection.key === 'req' && <span className="ops-flag req" title={r.inspection.reason}>🔍 required</span>}
        {r.inspection.key === 'due' && <span className="ops-flag due" title={r.inspection.reason}>🔍 monthly</span>}
        {r.inspection.key === 'ok' && <span className="ops-flag ok" title={r.inspection.reason}>✓ inspected</span>}
      </td>
      <td className="ops-note">{r.note}</td>
    </tr>
  );
}

/* ── By cleaner — the per-cleaner tabs ────────────────────────────── */

function ByCleaner({ data }: { data: OperationsResponse }) {
  const jobs = data.rows.filter(r => r.kind === 'out' && r.assignment === 'assigned' && r.cleaner);
  const roster = useMemo(() => {
    const names = new Set<string>(data.settings.cleaners.map(c => c.name));
    jobs.forEach(j => names.add(j.cleaner!));
    return [...names];
  }, [data]);
  const [who, setWho] = useState<string>(() => roster[0] ?? '');
  const mine = jobs.filter(j => j.cleaner === who);
  const unassigned = data.rows.filter(r => r.kind === 'out' && (r.assignment === 'tbd' || !r.inDailyFile));
  const pay = mine.reduce((a, j) => a + (j.price ?? 0), 0);
  const unpriced = mine.filter(j => j.price == null).length;

  return (
    <>
      <div className="row-controls">
        {roster.map(n => (
          <button key={n} className={who === n ? 'chip active' : 'chip'} onClick={() => setWho(n)}>
            {n} <b>{jobs.filter(j => j.cleaner === n).length}</b>
          </button>
        ))}
      </div>

      <dl className="strip">
        <div><dt>Cleans</dt><dd>{mine.length}</dd></div>
        <div><dt>Deep</dt><dd>{mine.filter(j => j.deep).length}</dd></div>
        <div><dt>Same-day</dt><dd>{mine.filter(j => j.next?.gapDays === 0).length}</dd></div>
        <div><dt>Pays, next 10 days</dt><dd>{money2(pay)}{unpriced > 0 && <small>+{unpriced} not priced</small>}</dd></div>
      </dl>

      <table className="units compact">
        <thead>
          <tr><th>Day</th><th>Unit</th><th>Checkout</th><th>Next guest</th><th>Flags</th>
              <th className="n">Pays</th><th>Notes</th></tr>
        </thead>
        <tbody>
          {mine.map(j => (
            <tr key={j.resId}>
              <td>{dayLabel(j.date)}</td>
              <td><b>{j.unit}</b>{j.beds ? <span className="sub-n"> {j.beds}BR</span> : null}</td>
              <td>{j.time ?? '10:00 AM'}</td>
              <td>{j.next
                ? (j.next.gapDays === 0 ? <b className="breach">same day</b> : `${short(j.next.arrival)} · +${j.next.gapDays}d`)
                : <span className="note">nothing booked</span>}</td>
              <td>
                {j.deep && <span className="ops-flag deep">🧽 deep</span>}
                {(j.inspection.key === 'req' || j.inspection.key === 'due') &&
                  <span className="ops-flag due">🔍 inspection</span>}
              </td>
              <td className="n">{j.price == null ? <span className="note">not priced</span> : money2(j.price)}</td>
              <td className="ops-note">{j.note}</td>
            </tr>
          ))}
          {!mine.length && <tr><td colSpan={7} className="note">No cleans for {who || 'anyone'} in the next 10 days.</td></tr>}
        </tbody>
      </table>

      {unassigned.length > 0 && (
        <div className="group">
          <h3>Nobody on these yet <span className="count">{unassigned.length}</span></h3>
          <table className="units compact">
            <tbody>
              {unassigned.map(r => (
                <tr key={r.resId}>
                  <td>{dayLabel(r.date)}</td><td><b>{r.unit}</b></td>
                  <td className="breach">{r.inDailyFile ? '▲ unassigned' : '▲ not in the daily file yet'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ── Inspections — the panel and the log ──────────────────────────── */

const TIER: Record<InspectionTier, [string, string]> = {
  never: ['tone-bad', 'never inspected'], overdue: ['tone-bad', 'overdue'],
  soon: ['tone-warn', 'due soon'], ok: ['tone-ok', 'current']
};

function Inspections({ data }: { data: OperationsResponse }) {
  const st = data.settings;
  const count = (t: InspectionTier) => data.panel.filter(p => p.tier === t).length;
  if (!data.sources.inspections.ok) {
    return (
      <p className="banner warn">
        ▲ The Inspection Log is not readable ({data.sources.inspections.problem}) — so nothing here
        can say when a unit was last inspected, and no unit is shown as overdue. Departures before
        a booking of {data.showMoney ? money(st.inspectionValueTrigger) + '+' : 'high value'} are still
        flagged on the board, because that rule needs no history.
      </p>
    );
  }
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
        Every unit at least every <b>{st.inspectionIntervalDays} days</b> (amber from day{' '}
        {st.inspectionSoonDays}), and before any booking of <b>{money(st.inspectionValueTrigger)}</b> or
        more{st.source === 'defaults' && ' — the sheet\'s built-in defaults, because its Settings tab is not linked; the live values may differ'}.
        The inspector is never the person who cleaned.
      </p>

      <table className="units compact">
        <thead>
          <tr><th></th><th>Unit</th><th>Last inspected</th><th>By</th><th>Result</th>
              <th>Big booking ahead</th><th>Scheduled</th></tr>
        </thead>
        <tbody>
          {data.panel.map(p => (
            <tr key={p.unitId}>
              <td><span className={`light ${TIER[p.tier][0]}`} /></td>
              <td><b>{p.unit}</b><div className="sub-n">{TIER[p.tier][1]}</div></td>
              <td>{p.last ? <>{p.last} <span className="sub-n">· {p.daysSince}d ago</span></> : <span className="note">never</span>}</td>
              <td>{p.lastBy}</td>
              <td>{p.lastResult}{p.lastNotes && <div className="sub-n">{p.lastNotes}</div>}</td>
              <td>{p.nextBig
                ? <>{short(p.nextBig.arrival)}{data.showMoney && <span className="sub-n"> · {money(p.nextBig.total)}</span>}</>
                : ''}</td>
              <td>{p.scheduled ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="group">
        <h3>Inspection log <span className="count">{data.inspectionLog.done.length}</span></h3>
        <table className="units compact">
          <thead><tr><th>Date</th><th>Unit</th><th>By</th><th>Result</th><th>Notes</th></tr></thead>
          <tbody>
            {data.inspectionLog.done.slice(0, 60).map((e, i) => (
              <tr key={i}>
                <td>{e.date}</td><td>{e.unit}</td><td>{e.by}</td>
                <td className={/urgent|maintenance/i.test(e.result) ? 'breach' : undefined}>{e.result}</td>
                <td className="ops-note">{e.notes}</td>
              </tr>
            ))}
            {!data.inspectionLog.done.length && (
              <tr><td colSpan={5} className="note">
                {data.sources.inspections.ok ? 'Nothing logged yet.' : 'The Inspection Log is not linked.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── Notes log ────────────────────────────────────────────────────── */

function Notes({ data }: { data: OperationsResponse }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'checkin' | 'checkout'>('all');
  const needle = q.trim().toLowerCase();
  const list = data.noteLog.filter(n =>
    (kind === 'all' || n.kind === kind) &&
    (!needle || `${n.unit} ${n.guest} ${n.notes}`.toLowerCase().includes(needle)));
  return (
    <>
      <div className="row-controls">
        {([['all', 'All'], ['checkin', 'Check-in'], ['checkout', 'Check-out']] as const).map(([k, l]) => (
          <button key={k} className={kind === k ? 'chip active' : 'chip'} onClick={() => setKind(k)}>{l}</button>
        ))}
        <input className="date-in" placeholder="Search unit, guest or note" value={q}
               onChange={e => setQ(e.target.value)} />
        <span className="note right">every change is a row — the log is append-only</span>
      </div>
      <table className="units compact">
        <thead><tr><th>Logged</th><th>Check-in</th><th>Unit</th><th>Guest</th><th>Type</th><th>Note</th></tr></thead>
        <tbody>
          {list.slice(0, 200).map((n, i) => (
            <tr key={i}>
              <td className="sub-n">{n.loggedAt}</td><td>{n.checkIn}</td><td>{n.unit}</td><td>{n.guest}</td>
              <td>{n.kind === 'checkin' ? 'Check-in' : n.kind === 'checkout' ? 'Check-out' : ''}</td>
              {/* A blank row is a note someone cleared — shown, because it is history. */}
              <td className="ops-note">{n.notes || <span className="note">cleared</span>}</td>
            </tr>
          ))}
          {!list.length && (
            <tr><td colSpan={6} className="note">
              {data.sources.notes.ok ? 'No notes match.' : 'The Notes Log is not linked.'}
            </td></tr>
          )}
        </tbody>
      </table>
    </>
  );
}

/* ── Rates & rules ────────────────────────────────────────────────── */

function Rates({ data }: { data: OperationsResponse }) {
  const st = data.settings;
  const sizes = ['1', '2', '3', '4', '5'];
  const cell = (v: number | null | undefined) => v == null ? <span className="note">—</span> : money(v);
  return (
    <>
      {st.source === 'defaults' && (
        <p className="banner warn">
          ▲ The daily file's Settings tab is not linked, so the roster and rate cards cannot be shown
          and the rules below are the sheet's built-in defaults — the live ones are edited from its
          ⚙️ Settings dialog and may differ.
        </p>
      )}
      {st.cleaners.length > 0 && (
        <table className="units compact">
          <thead>
            <tr><th>Cleaner</th><th>Tier</th>
              {sizes.map(b => <th key={b} className="n">{b}BR</th>)}
              {sizes.map(b => <th key={`d${b}`} className="n">Deep {b}BR</th>)}
            </tr>
          </thead>
          <tbody>
            {st.cleaners.map(c => (
              <tr key={c.name}>
                <td><b>{c.name}</b></td><td>{c.tier}</td>
                {sizes.map(b => <td key={b} className="n">{cell(c.rates[b])}</td>)}
                {/* A blank deep rate falls back to the ordinary one — shown as such. */}
                {sizes.map(b => <td key={`d${b}`} className="n">
                  {c.deepRates[b] != null ? money(c.deepRates[b]!) : <span className="note">{c.rates[b] != null ? `= ${money(c.rates[b]!)}` : '—'}</span>}
                </td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="group">
        <h3>How a cleaner is chosen</h3>
        <ul className="note">
          <li>Outgoing stay of <b>{st.longStayPromoteNights}+ nights</b> → high tier, whatever comes next.</li>
          <li>Next booking within <b>{st.nextResValueHorizonDays} days</b> worth <b>{money(st.cleanerHighThreshold)}+</b> → high tier;
              <b> {money(st.cleanerLowThreshold)} or less</b> → low tier; in between, or nothing booked → mid tier.</li>
          <li>A stay of <b>{st.deepCleanNights}+ nights</b> is flagged deep and paid off the deep card.</li>
          <li>A gap of <b>{st.longVacancyDays}+ days</b> before the next guest is flagged as a long vacancy.</li>
        </ul>
        <p className="note">
          These rules run in the daily file, not here. This screen shows their result; the sheet's
          ⚙️ Settings is where they change.
        </p>
      </div>
    </>
  );
}
