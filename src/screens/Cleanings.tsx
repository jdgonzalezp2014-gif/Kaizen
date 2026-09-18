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

const RANGES: [string, number][] = [['30 days', 30], ['90 days', 90], ['This year', 365]];

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
  const [days, setDays] = useState(30);
  const [scope, setScope] = useState<CleaningScope>('done');
  const [data, setData] = useState<{
    cleanings: Cleaning[]; scheduledAhead: number; doneCount: number; today: string } | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    // Scheduled work is ahead of today, so a backward window would ask
    // for a range that cannot contain any of it.
    const from = scope === 'scheduled'
      ? '' : new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
    getCleanings(from, scope)
      .then(r => r.ok ? setData(r) : setErr('Could not load.'))
      .catch(e => setErr(String(e)));
  }, [days, scope]);

  const stats = useMemo(() => {
    const list = data?.cleanings ?? [];
    // Rows with no price are counted as CLEANS but not as money. A
    // missing figure is "not priced yet", and treating it as zero would
    // quietly report the month as cheaper than it was.
    const priced = list.filter(c => c.price != null);
    const spend = priced.reduce((a, c) => a + Number(c.price), 0);
    const byCleaner = new Map<string, { n: number; paid: number }>();
    list.forEach(c => {
      const who = c.cleaner?.trim() || 'Unassigned';
      const e = byCleaner.get(who) ?? { n: 0, paid: 0 };
      e.n++; e.paid += Number(c.price ?? 0);
      byCleaner.set(who, e);
    });
    return {
      total: list.length, priced: priced.length, spend,
      deep: list.filter(c => c.deep).length,
      cleaners: [...byCleaner.entries()].sort((a, b) => b[1].n - a[1].n)
    };
  }, [data]);

  return (
    <section>
      <div className="row-controls">
        {SCOPES.map(([k, label]) => (
          <button key={k} className={scope === k ? 'chip active' : 'chip'}
                  onClick={() => setScope(k)}>{label}</button>
        ))}
        {scope !== 'scheduled' && (
          <>
            <span className="note">over</span>
            {RANGES.map(([label, n]) => (
              <button key={n} className={days === n ? 'chip active' : 'chip'}
                      onClick={() => setDays(n)}>{label}</button>
            ))}
          </>
        )}
        <span className="note right">
          {scope === 'done' ? 'up to and including today'
           : scope === 'scheduled' ? 'after today — not yet paid'
           : 'paid and committed together'}
        </span>
      </div>

      {err && <p className="banner warn">{err}</p>}
      {!data && !err && <p className="note">Loading…</p>}

      {data && (
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
          </dl>

          {stats.total > stats.priced && (
            <p className="note">
              {stats.total - stats.priced} clean(s) have no figure in the sheet yet. They are
              counted as cleans and left out of the total — a blank is "not priced", and
              treating it as zero would report the period as cheaper than it was.
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
                <th className="n">Paid</th><th>Notes</th>
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
                  <td>{c.cleaner ?? '—'}
                    {c.deep && <span className="sub-n"> deep</span>}
                    {c.urgency && <span className="breach"> {c.urgency}</span>}
                  </td>
                  <td className="n">{c.price == null
                    ? <span className="note">not priced</span> : money2(Number(c.price))}</td>
                  <td className="note">{c.notes}</td>
                </tr>
              ))}
              {data.cleanings.length === 0 && (
                <tr><td colSpan={5} className="note">
                  {data.doneCount + data.scheduledAhead === 0
                    ? 'No cleanings imported yet. Settings → Cleaning cost → Pull now reads the sheet.'
                    : 'Nothing in this range. Try a longer window, or another scope.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
