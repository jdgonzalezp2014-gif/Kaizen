/**
 * The unit list: what each unit is doing in the study window, and the
 * two levers that can change it.
 *
 * Ordered worst-first, because a list sorted by name is a list nobody
 * acts on. What "worst" means lives in src/lib/forward.ts.
 */
import { useEffect, useState } from 'react';
import { getForward, applyPrice, type PriceResult } from '../api.ts';
import { rank, suspectedDuplicates, type RankedUnit, type ForwardUnit, type ForwardState } from '../lib/forward.ts';

const money = (n: number | null) => n == null ? '—' : `$${Math.round(n).toLocaleString()}`;
const pct   = (n: number | null) => n == null ? '—' : `${Math.round(n * 100)}%`;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

const STATE_LABEL: Record<ForwardState, string> = {
  thin: 'Needs a decision', watch: 'Nearly spent', ok: 'On track',
  unknown: 'No calendar', offline: 'Out of service'
};

export function Units() {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [days, setDays] = useState(30);
  const [units, setUnits] = useState<ForwardUnit[] | null>(null);
  const [floor, setFloor] = useState(0.6);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<RankedUnit | null>(null);

  const load = () => {
    setLoading(true); setError('');
    getForward(asOf, days)
      .then(r => {
        if (!r.ok) { setError(r.error === 'not_configured'
          ? 'No Hostaway credentials yet — add them in Settings.' : (r.error ?? 'Could not load.')); return; }
        setUnits(r.units); setFloor((r.meta.occFloorPct ?? 60) / 100);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [asOf, days]);

  const ranked = units ? rank(units, floor) : [];
  const dupes = units ? suspectedDuplicates(units) : [];
  const live = ranked.filter(u => u.state !== 'offline' && u.state !== 'unknown');
  const parked = ranked.filter(u => u.state === 'offline' || u.state === 'unknown');

  return (
    <section>
      <div className="row-controls">
        <label>Study from
          <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} />
        </label>
        <label>for
          <select value={days} onChange={e => setDays(Number(e.target.value))}>
            {[7, 14, 30, 45, 60, 90].map(d => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
        <span className="note">
          through {addDays(asOf, days - 1)} — the nights a price can still change.
        </span>
      </div>

      {error && <p className="banner warn">{error}</p>}
      {loading && <p className="note">Reading {units?.length ?? ''} calendars from Hostaway…</p>}

      {dupes.length > 0 && (
        <p className="banner warn">
          {dupes.map(([a, b]) => `“${a}” and “${b}”`).join('; ')} report identical nights, rates and
          revenue. If that is one unit listed twice, every portfolio total counts it twice.
        </p>
      )}

      {units && (
        <>
          <table className="units">
            <thead>
              <tr>
                <th>Unit</th><th>State</th><th className="n">Occ</th>
                <th className="n">Sold</th><th className="n">Open</th>
                <th className="n">On books</th><th className="n">Rate</th>
                <th className="n">Wk / Mo</th><th className="n">Clean</th><th></th>
              </tr>
            </thead>
            <tbody>
              {live.map(u => <Row key={u.listingId} u={u} floor={floor} onEdit={() => setEditing(u)} />)}
            </tbody>
          </table>

          {parked.length > 0 && (
            <>
              <h3 className="parked-head">Not sellable in this window</h3>
              <p className="note">
                Every night blocked, or no calendar returned. These are deliberately kept out of the
                ranking above: a blocked unit is not an empty one, and discounting it would be a price
                cut on something nobody can book.
              </p>
              <table className="units">
                <tbody>
                  {parked.map(u => (
                    <tr key={u.listingId} className="muted-row">
                      <td>{u.name}</td>
                      <td><span className="tag grey">{STATE_LABEL[u.state]}</span></td>
                      <td className="n" colSpan={3}>
                        {u.state === 'offline' ? `${u.nightsBlocked} of ${u.nights} nights blocked` : 'no data'}
                      </td>
                      <td className="n">{money(u.onBooks || null)}</td>
                      <td className="n">{money(u.basePrice)}</td>
                      <td className="n">—</td><td className="n">{money(u.cleaningFeeCharged)}</td><td></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {editing && (
        <PriceDialog u={editing} asOf={asOf} days={days}
          onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />
      )}
    </section>
  );
}

function Row({ u, floor, onEdit }: { u: RankedUnit; floor: number; onEdit: () => void }) {
  const breach = u.occupancy != null && u.occupancy < floor;
  return (
    <tr>
      <td>{u.name}</td>
      <td>
        <span className={`tag ${u.state === 'thin' ? 'amber' : u.state === 'watch' ? 'grey' : 'green'}`}>
          {STATE_LABEL[u.state]}
        </span>
      </td>
      <td className={breach ? 'n breach' : 'n'}>{pct(u.occupancy)}</td>
      <td className="n">{u.nightsSold}</td>
      <td className="n">
        {u.nightsOpen}
        {/* The money still winnable in this window, which is the actual
            size of the problem — 18 open nights on a $300 house is not
            the same problem as 4 on a $150 studio. */}
        {u.exposure > 0 && <span className="sub-n"> · {money(u.exposure)} open</span>}
      </td>
      <td className="n">{money(u.onBooks)}</td>
      <td className="n">{money(u.askAvg ?? u.basePrice)}</td>
      <td className="n">
        {u.weeklyDiscountPct == null ? '—' : `${u.weeklyDiscountPct}%`} /{' '}
        {u.monthlyDiscountPct == null ? '—' : `${u.monthlyDiscountPct}%`}
      </td>
      <td className="n">{money(u.cleaningFeeCharged)}</td>
      <td><button className="link" onClick={onEdit}>Edit price</button></td>
    </tr>
  );
}

/**
 * The confirm step.
 *
 * It states, in words, exactly what is about to change and where — the
 * live guest-facing calendar, not a draft in this app. Anyone who clicks
 * through it should be unable to say afterwards that they did not know
 * the price moved, and the result panel says what actually landed rather
 * than assuming the request worked.
 */
function PriceDialog({ u, asOf, days, onClose, onDone }: {
  u: RankedUnit; asOf: string; days: number; onClose: () => void; onDone: () => void;
}) {
  const current = u.askAvg ?? u.basePrice;
  const [rate, setRate] = useState<string>(current == null ? '' : String(current));
  const [disc, setDisc] = useState<string>('');
  const [kind, setKind] = useState<'weekly' | 'monthly' | 'window'>('weekly');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PriceResult | null>(null);

  const to = addDays(asOf, days - 1);
  const rateNum = rate.trim() === '' ? null : Number(rate);
  const discNum = disc.trim() === '' ? null : Number(disc);
  const rateChanged = rateNum != null && rateNum !== current;
  const marked = kind === 'window' && discNum != null && rateNum != null
    ? Math.round(rateNum * (1 - discNum / 100)) : null;

  const send = (recordOnly: boolean) => {
    setBusy(true); setResult(null);
    applyPrice({
      listingId: u.listingId,
      baseRate: rateChanged ? rateNum : null,
      discountPct: discNum,
      discountKind: kind,
      from: asOf, to, note, confirmed: true, recordOnly
    }).then(setResult).catch(e => setResult({ ok: false, error: String(e) }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h3>{u.name}</h3>
        <p className="note">
          {pct(u.occupancy)} occupied · {u.nightsOpen} of {u.nightsOpen + u.nightsSold} sellable
          nights still open, {asOf} → {to}.
        </p>

        <label>Nightly rate
          <input type="number" value={rate} onChange={e => setRate(e.target.value)} placeholder={String(current ?? '')} />
        </label>

        <label>Discount
          <span className="inline">
            <input type="number" value={disc} onChange={e => setDisc(e.target.value)} placeholder="none" />
            <select value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
              <option value="weekly">% off — weekly stays (7+ nights)</option>
              <option value="monthly">% off — monthly stays (28+ nights)</option>
              <option value="window">% off — these dates only</option>
            </select>
          </span>
        </label>

        <label>Why (optional)
          <input value={note} onChange={e => setNote(e.target.value)}
            placeholder="e.g. three weeks open, school holidays over" />
        </label>

        {!result && (
          <div className="disclaimer">
            <strong>This changes the live price guests see.</strong>
            <ul>
              {rateChanged && <li>Nightly rate {money(current)} → {money(rateNum)} on every open night from {asOf} to {to}.</li>}
              {discNum != null && kind !== 'window' && (
                <li>{kind === 'weekly' ? 'Weekly' : 'Monthly'} discount set to {discNum}% on the listing —
                  it applies to any qualifying stay, not just these dates.</li>
              )}
              {marked != null && <li>These dates repriced to {money(marked)} ({discNum}% off {money(rateNum)}).</li>}
              {!rateChanged && discNum == null && <li>Nothing changed yet — enter a rate or a discount.</li>}
              <li>Nights already reserved keep their price; Hostaway will not reprice a booked night.</li>
              <li>It is recorded either way, with today's occupancy, so its effect can be measured later.</li>
            </ul>
          </div>
        )}

        {result && (
          <div className={`disclaimer ${result.ok ? 'good' : 'bad'}`}>
            <strong>{result.ok ? 'Applied.' : result.pushed ? 'Partly applied.' : 'Not applied.'}</strong>
            <p>{result.message ?? result.error}</p>
            {result.detail && <p className="mono">{result.detail}</p>}
          </div>
        )}

        <div className="modal-actions">
          {result
            ? <button onClick={onDone}>Done</button>
            : <>
                <button onClick={onClose} className="ghost">Cancel</button>
                <button onClick={() => send(true)} disabled={busy} className="ghost">
                  Record only
                </button>
                <button onClick={() => send(false)} disabled={busy || (!rateChanged && discNum == null)}>
                  {busy ? 'Applying…' : 'Change the live price'}
                </button>
              </>}
        </div>
      </div>
    </div>
  );
}
