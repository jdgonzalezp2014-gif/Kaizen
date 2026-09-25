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
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  getOperations, saveTurnover, logInspection, scheduleInspections, cancelInspection,
  getOpsSettings, saveOpsSettings, cutoverImport, can,
  type OperationsResponse, type TurnoverSet, type OpsSettings, type CutoverPreview, type InspectionEntry
} from '../api.ts';
import {
  BEDROOM_SIZES, DEFAULT_CHECKIN_TIME, DEFAULT_CHECKOUT_TIME, INSPECTION_RESULTS,
  eligibleInspectors, rateFor, summarize,
  type BoardRow, type Cleaner, type InspectionTier, type OpsRules
} from '../lib/operations.ts';
import { money, money2 } from '../lib/format.ts';
import { channelLabel } from '../lib/breakdown.ts';
import { Loading } from '../components/Loading.tsx';
import { recallTiming, rememberTiming } from '../lib/progress.ts';

type View = 'board' | 'cleaners' | 'inspections' | 'notes' | 'rates' | 'setup';

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
      n.assignment = r.auto.cleaner ? 'assigned' : 'tbd';
      n.cleaner = r.auto.cleaner; n.manual.cleaner = false;
    } else {
      n.assignment = set.assignment;
      n.cleaner = set.assignment === 'assigned' ? (set.cleaner ?? null) : null;
      n.manual.cleaner = true;
    }
  }
  if (set.deep !== undefined) {
    n.deep = set.deep ?? r.nights >= rules.deepCleanNights;
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

  /** Apply a saved edit to the rows on screen and re-total. */
  const patch = (resId: string, kind: 'in' | 'out', f: (r: BoardRow) => BoardRow) =>
    setData(d => {
      if (!d) return d;
      const rows = d.rows.map(r => r.resId === resId && r.kind === kind ? f(r) : r);
      return { ...d, rows, summary: summarize(rows) };
    });

  const views: [View, string][] = [
    ['board', 'Next 10 days'], ['cleaners', 'By cleaner'], ['inspections', 'Inspections'],
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
        {data && <span className="note">{dayLabel(data.today)} → {dayLabel(data.end)} · New York time</span>}
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
        {data && view === 'board' && <Board data={data} patch={patch} />}
        {data && view === 'cleaners' && <ByCleaner data={data} />}
        {data && view === 'inspections' && <Inspections data={data} reload={() => load()} />}
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
    const failed = data.pushes.filter(p => p.outcome === 'failed').length;
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

/* ── Next 10 days ─────────────────────────────────────────────────── */

type Filter = 'all' | 'out' | 'in' | 'attention' | 'differs';

/** Everything on a departure that someone has to act on. */
function needsAttention(r: BoardRow): boolean {
  if (r.kind !== 'out') return false;
  return r.assignment === 'tbd' || (r.assignment === 'assigned' && r.price == null) ||
    r.inspection.key === 'req' || r.inspection.key === 'due' || r.urgency === 'turnover';
}

function Board({ data, patch }: { data: OperationsResponse; patch: (id: string, k: 'in' | 'out', f: (r: BoardRow) => BoardRow) => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const s = data.summary;

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.rows.filter(r =>
      (filter === 'all' || (filter === 'attention' ? needsAttention(r)
        : filter === 'differs' ? r.differs.length > 0 : r.kind === filter)) &&
      (!needle || `${r.unit} ${r.guest} ${r.cleaner ?? ''}`.toLowerCase().includes(needle)));
  }, [data, filter, q]);

  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = data.today; d <= data.end;) {
      out.push(d);
      const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1);
      d = t.toISOString().slice(0, 10);
    }
    return out;
  }, [data.today, data.end]);

  const filters: [Filter, string][] = [
    ['all', 'Everything'], ['out', 'Departures'], ['in', 'Arrivals'],
    ['attention', `Needs attention ${data.rows.filter(needsAttention).length}`],
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
      </dl>

      {data.roster.length === 0 && (
        <p className="banner warn">▲ No cleaners on the roster yet, so every clean reads unassigned.
          {can(data.permissions, 'operations.setup') ? ' Setup → import from the daily file, or add them by hand.' : ' Someone with Operations setup sets it up.'}</p>
      )}

      <div className="row-controls">
        {filters.map(([k, label]) => (
          <button key={k} className={filter === k ? 'chip active' : 'chip'} onClick={() => setFilter(k)}>{label}</button>
        ))}
        <input className="date-in" placeholder="Unit, guest or cleaner" value={q} onChange={e => setQ(e.target.value)} />
        {can(data.permissions, 'operations.edit') && <span className="note right">click a row to change it</span>}
      </div>

      <div className="grid-scroll">
        <table className="units compact ops-board">
          <thead>
            <tr><th></th><th>Unit</th><th>Guest</th><th>Time</th><th>Next stay</th>
                <th>Cleaner</th><th className="n">Pays</th><th>Flags</th><th>Notes</th></tr>
          </thead>
          {days.map(d => {
            const dayRows = rows.filter(r => r.date === d);
            if (!dayRows.length && (filter !== 'all' || q)) return null;
            return (
              <tbody key={d}>
                <tr className="ops-day">
                  <td colSpan={9}>
                    {dayLabel(d)}{d === data.today ? ' · today' : ''}{isWeekend(d) ? ' · weekend' : ''}
                    <span className="sub-n"> {dayRows.filter(r => r.kind === 'out').length} out · {dayRows.filter(r => r.kind === 'in').length} in</span>
                  </td>
                </tr>
                {!dayRows.length && <tr><td colSpan={9} className="note ops-quiet">no arrivals or departures</td></tr>}
                {dayRows.map(r => {
                  const key = `${r.resId}-${r.kind}`;
                  return (
                    <Fragment key={key}>
                      <BoardLine r={r} showMoney={data.showMoney} shadow={data.mode === 'shadow'} through={short(data.lookaheadTo)}
                                 open={open === key} onToggle={() => {
                                   // Read-only roles see the board; the editor is not offered.
                                   if (can(data.permissions, 'operations.edit')) setOpen(open === key ? null : key);
                                 }} />
                      {open === key && (
                        <tr className="ops-edit-row"><td colSpan={9}>
                          <Editor r={r} data={data} onSaved={(set, note) => {
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

function BoardLine({ r, showMoney, shadow, open, onToggle, through }: {
  r: BoardRow; showMoney: boolean; shadow: boolean; open: boolean; onToggle: () => void;
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
        <div className="sub-n">
          {r.nights} night{r.nights === 1 ? '' : 's'}{r.guests ? ` · ${r.guests} guests` : ''}
          {r.channel ? ` · ${channelLabel(r.channel)}` : ''}
          {showMoney && r.total > 0 ? ` · ${money(r.total)}` : ''}
        </div>
      </td>
      <td className={r.manual.time ? 'ops-manual' : undefined}>{r.time}</td>
      <td>
        {!out ? (r.preppedBy ? <span className="sub-n">prepped by {r.preppedBy}</span> : null)
          : !r.next ? <span className="breach">▲ nothing booked through {through}</span>
          : (<>
              {short(r.next.arrival)}{' '}
              {r.next.gapDays === 0 ? <b className="breach">same day</b>
                : <span className={r.next.longVacancy ? 'breach' : 'sub-n'}>+{r.next.gapDays}d</span>}
              {showMoney && r.next.total != null && <div className="sub-n">{money(r.next.total)}</div>}
            </>)}
      </td>
      <td>
        {out && (
          <>
            <span className={r.assignment === 'tbd' ? 'breach' : r.assignment === 'not_needed' ? 'note' : undefined}>
              {r.assignment === 'tbd' ? '▲ ' : ''}{r.assignment === 'assigned' ? r.cleaner : r.assignment === 'not_needed' ? 'no clean needed' : 'unassigned'}
            </span>
            {r.manual.cleaner && <span className="sub-n"> · set by hand</span>}
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
        {r.deep && <span className="ops-flag deep">🧽 deep{r.manual.deep ? ' · by hand' : ''}</span>}
        {shadow && r.differs.includes('deep') && <span className="ops-diff">sheet: {r.sheet?.deep ? 'deep' : 'not deep'}</span>}
        {r.urgency && URGENCY[r.urgency] && <span className="ops-flag urgent">{URGENCY[r.urgency]}</span>}
        {r.inspection.key === 'req' && <span className="ops-flag req" title={r.inspection.reason}>🔍 required</span>}
        {r.inspection.key === 'due' && <span className="ops-flag due" title={r.inspection.reason}>🔍 monthly</span>}
        {r.inspection.key === 'ok' && <span className="ops-flag ok" title={r.inspection.reason}>✓ inspected</span>}
      </td>
      <td className="ops-note">{r.note}</td>
    </tr>
  );
}

/** One stay's controls, opened in place under its row. */
function Editor({ r, data, onSaved }: {
  r: BoardRow; data: OperationsResponse; onSaved: (set: TurnoverSet | null, note?: string) => void;
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
    setMsg(r2.push === 'queued' ? 'Saved — the Host Note is being updated in Hostaway.'
      : 'Saved in Kaizen. Shadow mode: nothing is written to Hostaway.');
  };

  const cleanerValue = !r.manual.cleaner ? '__rule'
    : r.assignment === 'assigned' ? `c:${r.cleaner}` : r.assignment;

  return (
    <div className="ops-editor" onClick={e => e.stopPropagation()}>
      {out && (
        <div className="ops-editor-why">
          <b>The rule says {r.auto.cleaner ?? 'nobody'}</b> — {r.auto.reason}.
          {r.sheet && <> The daily file has <b>{sheetText(r.sheet)}</b>{r.sheet.price != null ? ` at ${money2(r.sheet.price)}` : ''}.</>}
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
              {active.map(c => <option key={c.name} value={`c:${c.name}`}>{c.name} — {c.tier}</option>)}
              <option value="tbd">Unassigned (TBD)</option>
              <option value="not_needed">No clean needed</option>
            </select>
          </label>
        )}
        {out && (
          <label>Deep clean
            <select disabled={busy} value={!r.manual.deep ? 'rule' : r.deep ? 'yes' : 'no'}
                    onChange={e => void send({ deep: e.target.value === 'rule' ? null : e.target.value === 'yes' })}>
              <option value="rule">By the rule ({r.nights} nights → {r.nights >= data.rules.deepCleanNights ? 'deep' : 'normal'})</option>
              <option value="yes">Yes — deep</option>
              <option value="no">No — normal</option>
            </select>
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
        <div><dt>Pays, next 10 days</dt><dd>{money2(pay)}{unpriced > 0 && <small>+{unpriced} not priced</small>}</dd></div>
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
          {!mine.length && <tr><td colSpan={7} className="note">No cleans for {who || 'anyone'} in the next 10 days.</td></tr>}
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

      {can(data.permissions, 'operations.edit') &&
        <InspectionForm data={data} editing={editing} onDone={() => { setEditing(null); reload(); }} />}

      <div className="group">
        <h3>Scheduled <span className="count">{data.inspectionLog.scheduled.length}</span>{' '}
          {can(data.permissions, 'operations.edit') &&
            <button className="link" onClick={() => void schedule()}>Auto-schedule what is due</button>}</h3>
        {msg && <p className="note">{msg}</p>}
        <table className="units compact"><tbody>
          {data.inspectionLog.scheduled.map(e => (
            <tr key={e.id}>
              <td>{e.date}</td><td><b>{e.unit}</b></td><td>{e.by}</td><td className="ops-note">{e.notes}</td>
              <td className="n">{can(data.permissions, 'operations.edit') && <>
                <button className="link tiny" onClick={() => setEditing(e)}>mark done</button>{' '}
                <button className="link tiny danger" onClick={() => void cancelInspection(e.id).then(reload)}>cancel</button>
              </>}</td>
            </tr>
          ))}
          {!data.inspectionLog.scheduled.length && <tr><td className="note">Nothing scheduled.</td></tr>}
        </tbody></table>
      </div>

      {hasHistory && (
        <table className="units compact">
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
        </table>
      )}

      <div className="group">
        <h3>Inspection log <span className="count">{data.inspectionLog.done.length}</span></h3>
        <table className="units compact">
          <thead><tr><th>Date</th><th>Unit</th><th>By</th><th>Result</th><th>Notes</th></tr></thead>
          <tbody>
            {data.inspectionLog.done.slice(0, 60).map(e => (
              <tr key={e.id}>
                <td>{e.date}</td><td>{e.unit}</td><td>{e.by}</td>
                <td className={/urgent|maintenance/i.test(e.result) ? 'breach' : undefined}>{e.result}</td>
                <td className="ops-note">{e.notes}</td>
              </tr>
            ))}
            {!data.inspectionLog.done.length && <tr><td colSpan={5} className="note">Nothing logged yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
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
      <thead><tr><th>Cleaner</th><th>Tier</th>
        {BEDROOM_SIZES.map(b => <th key={b} className="n">{b}BR</th>)}
        {BEDROOM_SIZES.map(b => <th key={`d${b}`} className="n">Deep {b}BR</th>)}</tr></thead>
      <tbody>
        {roster.map(c => (
          <tr key={c.name} className={c.active ? undefined : 'muted-row'}>
            <td><b>{c.name}</b>{!c.active && <span className="sub-n"> inactive</span>}</td><td>{c.tier}</td>
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
        <h3>How a cleaner is chosen</h3>
        <ul className="note">
          <li>Outgoing stay of <b>{st.longStayPromoteNights}+ nights</b> → high tier, whatever comes next.</li>
          <li>Next booking within <b>{st.nextResValueHorizonDays} days</b> worth <b>{money(st.cleanerHighThreshold)}+</b> → high tier;
            <b> {money(st.cleanerLowThreshold)} or less</b> → low tier; in between, or nothing booked → mid tier.</li>
          <li>The first cleaner in a tier is the one picked. A stay of <b>{st.deepCleanNights}+ nights</b> is a deep clean.</li>
          <li>A gap of <b>{st.longVacancyDays}+ days</b> before the next guest is flagged as a long vacancy.</li>
        </ul>
      </div>
    </>
  );
}

/* ── Setup (admin) ────────────────────────────────────────────────── */

const RULE_LABELS: [keyof OpsRules, string][] = [
  ['cleanerHighThreshold', 'High tier from ($, next booking)'],
  ['cleanerLowThreshold', 'Low tier up to ($, next booking)'],
  ['longStayPromoteNights', 'Long-stay promotion (nights)'],
  ['deepCleanNights', 'Deep clean from (nights)'],
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
          <button className="secondary" onClick={() => setRoster(rs => [...rs, { name: '', tier: 'mid', position: rs.length, rates: {}, deepRates: {}, active: true }])}>Add cleaner</button>
          <button onClick={() => void save({ roster }, 'Roster saved.')}>Save roster</button>
        </div>
        <p className="note">Renaming someone is removing them and adding a new person — stays set to the old name by hand
          would read as off the roster. Mark them inactive instead and add the new name.</p>
      </div>

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
    </>
  );
}
