/**
 * Cleanings that have happened.
 *
 * Past and today only, and the cut is made on the server. A clean booked
 * for next week is a plan: counting it would answer "what did cleaning
 * cost this month" with work nobody has done and money nobody has paid.
 * Anything scheduled ahead is mentioned as a count and never mixed in.
 *
 * Read-only on purpose. The sheet is where this is maintained — daily,
 * by the people doing the work — and a second place to edit it would be
 * a second version of the truth.
 */
import { useEffect, useMemo, useState } from 'react';
import { getCleanings, type Cleaning, type CleaningScope } from '../api.ts';
import { money2 } from '../lib/format.ts';
import { CleaningCalendar } from '../components/CleaningCalendar.tsx';

const RANGES: [string, number][] = [['30 days', 30], ['90 days', 90], ['This year', 365]];

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 864e5));

/**
 * Two different questions of the same table, never blended.
 *
 * `done` is what cleaning COST — the only scope that is a fact, and so
 * the default. `scheduled` is work committed but not done, which is what
 * a projection needs. A total mixing money paid with money promised
 * answers neither.
 */
const SCOPES: [CleaningScope, string, string][] = [
  ['done', 'Done', 'paid out'],
  ['scheduled', 'Scheduled', 'committed, not yet paid'],
  ['all', 'Both', 'paid and committed']
];

export function Cleanings() {
  // A preset is a shortcut for a range, not a different kind of thing, so
  // both write to the same two dates and the table only ever reads those.
  // Anything else and "90 days" and "1 Aug to 14 Aug" answer through
  // different code paths and drift apart.
  const [from, setFrom] = useState(() => daysAgo(30));
  const [to, setTo] = useState(() => iso(new Date()));
  const [preset, setPreset] = useState<number | null>(30);
  const [scope, setScope] = useState<CleaningScope>('done');
  const [picked, setPicked] = useState<string[]>([]);
  // Off by default. A row with nobody on it is not an answer to "who
  // cleaned what", so it has to be asked for.
  const [include, setInclude] = useState<string[]>([]);
  const [view, setView] = useState<'list' | 'calendar'>('list');
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [data, setData] = useState<{
    cleanings: Cleaning[]; cleaners: { cleaner: string; n: number }[];
    states: Record<string, number>; sheetUrl: string | null;
    scheduledAhead: number; doneCount: number; today: string } | null>(null);
  const [err, setErr] = useState('');
  // Stale numbers that look current are worse than no numbers. While a
  // request is out the panel says so and dims, because a filter chip
  // reading "Michelle" above a table still showing everyone is a bug
  // report waiting to happen.
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    // The calendar asks for one CLOSED month — an invoice covers a month,
    // and a window open at either end cannot be reconciled against one.
    // It also ignores the scope: a September invoice includes cleans
    // after today if today is in September.
    if (view === 'calendar') {
      const [y, m] = month.split('-').map(Number);
      const last = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
      setBusy(true);
      getCleanings(`${month}-01`, 'all', picked, last, include)
        .then(r => r.ok ? setData(r) : setErr('Could not load.'))
        .catch(e => setErr(String(e)))
        .finally(() => setBusy(false));
      return;
    }
    setBusy(true);
    // Scheduled work is ahead of today, so a backward window would ask for
    // a range that cannot contain any of it — the dates are dropped rather
    // than inverted.
    getCleanings(scope === 'scheduled' ? '' : from, scope, picked,
                 scope === 'scheduled' ? '' : to, include)
      .then(r => r.ok ? setData(r) : setErr('Could not load.'))
      .catch(e => setErr(String(e)))
      .finally(() => setBusy(false));
  }, [from, to, scope, picked, include, view, month]);

  const usePreset = (n: number) => {
    setPreset(n); setFrom(daysAgo(n)); setTo(iso(new Date()));
  };
  const flip = (set: (f: (p: string[]) => string[]) => void) => (name: string) =>
    set(p => p.includes(name) ? p.filter(x => x !== name) : [...p, name]);
  const toggle = flip(setPicked);
  const toggleState = flip(setInclude);

  const stats = useMemo(() => {
    const all = data?.cleanings ?? [];
    // A stay that needed no clean is not a clean. Counting it inflated
    // the number and made the average cost per clean look lower than it
    // is, so it is held out of every figure and reported on its own.
    const notNeeded = all.filter(c => c.assignment === 'not_needed');
    const list = all.filter(c => c.assignment !== 'not_needed');
    const unassigned = list.filter(c => c.assignment === 'tbd');

    // Rows with no price count as CLEANS but not as money: a missing
    // figure is "not priced yet", and treating it as zero would report
    // the period as cheaper than it was.
    const priced = list.filter(c => c.price != null);
    const spend = priced.reduce((a, c) => a + Number(c.price), 0);

    const byCleaner = new Map<string, { n: number; paid: number }>();
    list.filter(c => c.assignment === 'assigned' && c.cleaner).forEach(c => {
      const e = byCleaner.get(c.cleaner!) ?? { n: 0, paid: 0 };
      e.n++; e.paid += Number(c.price ?? 0);
      byCleaner.set(c.cleaner!, e);
    });

    return {
      total: list.length, priced: priced.length, spend,
      deep: list.filter(c => c.deep).length,
      notNeeded: notNeeded.length, unassigned: unassigned.length,
      cleaners: [...byCleaner.entries()].sort((a, b) => b[1].n - a[1].n)
    };
  }, [data]);

  return (
    <section>
      <div className="row-controls">
        <button className={view === 'list' ? 'chip active' : 'chip'}
                onClick={() => setView('list')}>List</button>
        <button className={view === 'calendar' ? 'chip active' : 'chip'}
                onClick={() => setView('calendar')}>Calendar</button>
        <span className="note">|</span>
        {view === 'list' && SCOPES.map(([k, label]) => (
          <button key={k} className={scope === k ? 'chip active' : 'chip'}
                  onClick={() => setScope(k)}>{label}</button>
        ))}
        {view === 'list' && scope !== 'scheduled' && (
          <>
            <span className="note">over</span>
            {RANGES.map(([label, n]) => (
              <button key={n} className={preset === n ? 'chip active' : 'chip'}
                      onClick={() => usePreset(n)}>{label}</button>
            ))}
            {/* Typing a date is choosing a range too, so it clears the
                preset rather than fighting it. */}
            <input type="date" className="date-in" value={from} max={to}
                   onChange={e => { setPreset(null); setFrom(e.target.value); }} />
            <span className="note">to</span>
            <input type="date" className="date-in" value={to} min={from}
                   onChange={e => { setPreset(null); setTo(e.target.value); }} />
          </>
        )}
        {data?.sheetUrl && (
          <a className="chip" href={data.sheetUrl} target="_blank" rel="noreferrer">
            Open the sheet ↗
          </a>
        )}
        <span className="note right">
          {busy ? <span className="loading-dot">Loading…</span>
           : view === 'calendar' ? 'one whole month, for checking an invoice'
           : scope === 'done' ? 'up to and including today'
           : scope === 'scheduled' ? 'after today — not yet paid'
           : 'paid and committed together'}
        </span>
      </div>

      {(data?.cleaners.length ?? 0) > 1 && (
        <div className="row-controls">
          <span className="note">Cleaner</span>
          {/* Multi-select. "Everyone" is the empty selection rather than a
              chip of its own, so there is one state, not two that can
              disagree about who is showing. */}
          <button className={picked.length === 0 ? 'chip active' : 'chip'}
                  onClick={() => setPicked([])}>Everyone</button>
          {data!.cleaners.map(c => (
            <button key={c.cleaner}
                    className={picked.includes(c.cleaner) ? 'chip active' : 'chip'}
                    aria-pressed={picked.includes(c.cleaner)}
                    onClick={() => toggle(c.cleaner)}>
              {c.cleaner} <b>{c.n}</b>
            </button>
          ))}
          {picked.length > 1 && (
            <span className="note">{picked.length} selected, added together</span>
          )}

          {/* Separated, and off until clicked: these are states, not
              people, and the count is over the whole table so a chip
              that is switched off still says what it is holding back. */}
          {(data!.states?.tbd || data!.states?.not_needed) ? <span className="note">|</span> : null}
          {data!.states?.tbd ? (
            <button className={include.includes('tbd') ? 'chip active' : 'chip'}
                    aria-pressed={include.includes('tbd')}
                    onClick={() => toggleState('tbd')}>
              Unassigned <b>{data!.states.tbd}</b>
            </button>
          ) : null}
          {data!.states?.not_needed ? (
            <button className={include.includes('not_needed') ? 'chip active' : 'chip'}
                    aria-pressed={include.includes('not_needed')}
                    onClick={() => toggleState('not_needed')}>
              No clean needed <b>{data!.states.not_needed}</b>
            </button>
          ) : null}
        </div>
      )}

      {err && <p className="banner warn">{err}</p>}
      {!data && !err && <p className="note">Loading…</p>}

      <div className={busy && data ? 'is-stale' : undefined}>
      {data && view === 'calendar' && (
        <CleaningCalendar month={month} cleanings={data.cleanings} onMonth={setMonth} />
      )}

      {data && view === 'list' && (
        <>
          <dl className="strip">
            <div><dt>Cleans</dt><dd>{stats.total}</dd></div>
            {/* The label changes with the scope, because the number means
                something different. Calling committed work "paid out"
                would be the whole mistake in one word. */}
            <div><dt>{scope === 'done' ? 'Paid out'
                      : scope === 'scheduled' ? 'Committed' : 'Paid + committed'}</dt>
              <dd>{money2(stats.spend)}</dd></div>
            <div><dt>Deep cleans</dt><dd>{stats.deep}</dd></div>
            <div><dt>Not priced</dt><dd>{stats.total - stats.priced}
              <small>of {stats.total}</small></dd></div>
            <div><dt>No clean needed</dt><dd>{stats.notNeeded}
              <small>not counted above</small></dd></div>
          </dl>

          {stats.total > stats.priced && (
            <p className="note">
              {stats.total - stats.priced} clean(s) have no figure in the sheet yet. They
              count as cleans and stay out of the money — a blank is "not priced", and treating
              it as zero would report the period as cheaper than it was.
            </p>
          )}

          {/* Says what it is NOT showing, so a filtered view never reads
              as an empty table. */}
          {scope === 'done' && data.scheduledAhead > 0 && (
            <p className="note">
              {data.scheduledAhead} more are scheduled after today, not counted here — a clean
              that has not happened is a commitment, not a cost.{' '}
              <button className="link" onClick={() => setScope('scheduled')}>See them</button>
            </p>
          )}
          {scope === 'scheduled' && (
            <p className="note">
              Work committed but not done. Useful for a projection; not part of what this month
              has cost.{' '}
              <button className="link" onClick={() => setScope('done')}>Back to what was paid</button>
            </p>
          )}

          {stats.cleaners.length > 1 && (
            <div className="group">
              <h3>By cleaner</h3>
              <div className="bd">
                {stats.cleaners.map(([who, e]) => (
                  <div className="bd-row" key={who}>
                    <div className="bd-label">{who}</div>
                    <div className="bd-track">
                      <div className="bd-fill" style={{
                        width: `${Math.max(2, (e.n / stats.cleaners[0]![1].n) * 100)}%` }} />
                    </div>
                    <div className="bd-value">{money2(e.paid)}</div>
                    <div className="bd-share">{e.n}</div>
                    <div className="bd-detail">
                      {e.n > 0 && e.paid > 0 ? `${money2(e.paid / e.n)} average` : ''}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <table className="units compact">
            <thead>
              <tr>
                <th>Checkout</th><th>Unit</th><th>Cleaner</th>
                <th className="n">Paid</th>
              </tr>
            </thead>
            <tbody>
              {data.cleanings.map(c => (
                <tr key={c.key}>
                  <td>
                    {c.checkout_on.slice(0, 10)}
                    {c.future && <span className="sub-n"> ahead</span>}
                  </td>
                  <td>
                    {c.unit_name}
                    {/* A name the sheet uses that matches no unit here. Worth
                        seeing: it is usually a typo that is also keeping the
                        cost off that unit's row. */}
                    {!c.unit_id && <span className="sub-n"> not matched</span>}
                  </td>
                  <td>
                    {c.cleaner ?? (
                      <span className="note">
                        {c.assignment === 'not_needed' ? 'no clean needed' : 'unassigned'}
                      </span>
                    )}
                    {c.deep && <span className="sub-n"> deep</span>}
                    {c.urgency && <span className="breach"> {c.urgency}</span>}
                  </td>
                  <td className="n">{c.price == null
                    ? <span className="note">not priced</span> : money2(Number(c.price))}</td>

                </tr>
              ))}
              {data.cleanings.length === 0 && (
                <tr><td colSpan={4} className="note">
                  {data.doneCount + data.scheduledAhead === 0
                    ? 'No cleanings imported yet. Settings → Cleaning cost → Pull now reads the sheet.'
                    : 'Nothing in this range. Try a longer window, or another scope.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
      </div>
    </section>
  );
}
