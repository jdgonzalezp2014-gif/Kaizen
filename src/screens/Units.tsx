/**
 * Units — what each one is doing over the nights you can still change,
 * and the levers that change them.
 *
 * Grouped rather than ranked into one long table. The first question is
 * never "what is row 14 doing", it is "which of these needs me today",
 * and three groups answer that before any number is read.
 */
import { useEffect, useState } from 'react';
import { getForward, applyPrice, type PriceResult } from '../api.ts';
import { rank, suspectedDuplicates, type RankedUnit, type ForwardUnit, type ForwardState } from '../lib/forward.ts';
import { DayPicker } from '../components/DayPicker.tsx';

const money = (n: number | null) => n == null ? '—' : `$${Math.round(n).toLocaleString()}`;
const pct   = (n: number | null) => n == null ? '—' : `${Math.round(n * 100)}%`;
const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

interface Group {
  key: string; title: string; blurb: string; states: ForwardState[];
}

// Ordered by what you would act on first. The blurb is the explanation
// that stops the table needing one.
const GROUPS: Group[] = [
  { key: 'act', title: 'Needs a decision', states: ['thin'],
    blurb: 'Below your occupancy floor with nights still open. These are the ones a price ' +
           'change can still do something about — biggest money at stake first, not lowest percentage.' },
  { key: 'watch', title: 'Nearly spent', states: ['watch'],
    blurb: 'Under the floor, but almost nothing left to sell in this window. Too late to fix here; ' +
           'worth looking at further out.' },
  { key: 'ok', title: 'On track', states: ['ok'],
    blurb: 'At or above your occupancy floor for these dates.' },
  { key: 'off', title: 'Not taking bookings', states: ['parked', 'offline', 'unknown'],
    blurb: 'Blocked, or no calendar. Deliberately kept out of the ranking: a blocked unit is not ' +
           'an empty one, and discounting it would cut the price of something nobody can book.' }
];

export function Units() {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [days, setDays] = useState(30);
  const [units, setUnits] = useState<ForwardUnit[] | null>(null);
  const [floor, setFloor] = useState(0.6);
  const [parkedAfter, setParkedAfter] = useState(45);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<RankedUnit | null>(null);

  const load = () => {
    setLoading(true); setError('');
    getForward(asOf, days)
      .then(r => {
        if (!r.ok) {
          setError(r.error === 'not_configured'
            ? 'No Hostaway credentials yet — add them in Settings.' : (r.error ?? 'Could not load.'));
          return;
        }
        setUnits(r.units);
        setFloor((r.meta.occFloorPct ?? 60) / 100);
        setParkedAfter(r.meta.offlineAfterDays ?? 45);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [asOf, days]);

  const ranked = units ? rank(units, floor) : [];
  const dupes  = units ? suspectedDuplicates(units) : [];
  const live   = ranked.filter(u => u.active);
  const parked = ranked.filter(u => u.parked);

  return (
    <section>
      <div className="explain">
        <h2>The next {days} nights</h2>
        <p>
          Everything here is forward-looking: nights that have not happened yet and that a price
          can still change. It is a different question from the Revenue tab, which is money that
          already landed.
        </p>
      </div>

      <div className="row-controls">
        <label>From
          <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} />
        </label>
        <label>for
          <select value={days} onChange={e => setDays(Number(e.target.value))}>
            {[7, 14, 30, 45, 60, 90].map(d => <option key={d} value={d}>{d} nights</option>)}
          </select>
        </label>
        <span className="note">through {addDays(asOf, days - 1)}</span>
        {units && (
          <span className="note right">
            {live.length} unit{live.length === 1 ? '' : 's'} taking bookings
            {parked.length > 0 && <> · {parked.length} parked</>}
          </span>
        )}
      </div>

      {error && <p className="banner warn">{error}</p>}
      {loading && <p className="note">Reading calendars from Hostaway…</p>}

      {dupes.length > 0 && (
        <p className="banner warn">
          {dupes.map(([a, b]) => `“${a}” and “${b}”`).join('; ')} report identical nights, rates and
          revenue. If that is one unit listed twice, every portfolio total counts it twice.
        </p>
      )}

      {units && GROUPS.map(g => {
        const rows = ranked.filter(u => g.states.includes(u.state));
        if (!rows.length) return null;
        return (
          <div key={g.key} className="group">
            <h3>{g.title} <span className="count">{rows.length}</span></h3>
            <p className="note">{g.blurb}{g.key === 'off' && ` A block running past ${parkedAfter} days counts as parked.`}</p>
            <table className="units">
              <thead>
                <tr>
                  <th>Unit</th>
                  <th className="n">Occupied</th>
                  <th className="n">Booked</th>
                  <th className="n">Still open</th>
                  <th className="n">Earned</th>
                  <th className="n">Asking</th>
                  <th className="n">Weekly / Monthly off</th>
                  <th className="n">Cleaning charged / paid</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(u => (
                  <Row key={u.listingId} u={u} floor={floor}
                       parkedAfter={parkedAfter} onEdit={() => setEditing(u)} />
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {editing && (
        <PriceDialog u={editing} asOf={asOf} days={days}
          onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />
      )}
    </section>
  );
}

function Row({ u, floor, parkedAfter, onEdit }: {
  u: RankedUnit; floor: number; parkedAfter: number; onEdit: () => void;
}) {
  const breach = u.occupancy != null && u.occupancy < floor;
  const sellable = u.nightsOpen + u.nightsSold;

  if (u.state === 'parked' || u.state === 'offline' || u.state === 'unknown') {
    return (
      <tr className="muted-row">
        <td>{u.name}</td>
        <td className="n" colSpan={3}>
          {u.state === 'unknown' ? 'No calendar returned'
            : u.state === 'parked' ? `Blocked every night for ${parkedAfter}+ days`
            : `Blocked all ${u.nights} nights in this window`}
          {u.state === 'parked' && u.listedActive && <span className="sub-n"> · still flagged active in Hostaway</span>}
        </td>
        <td className="n">{money(u.onBooks || null)}</td>
        <td className="n">{money(u.basePrice)}</td>
        <td className="n">—</td>
        <td className="n">{money(u.cleaningFeeCharged)}</td>
        <td></td>
      </tr>
    );
  }

  return (
    <tr>
      <td>{u.name}</td>
      <td className={breach ? 'n breach' : 'n'}>
        {pct(u.occupancy)}
        <span className="sub-n"> of {sellable}</span>
      </td>
      <td className="n">{u.nightsSold}</td>
      <td className="n">
        {u.nightsOpen}
        {/* The money still winnable, which is the real size of the
            problem: 18 open nights on a $300 house is not the same
            problem as 4 on a $150 studio, and the percentage hides it. */}
        {u.exposure > 0 && <span className="sub-n"> · {money(u.exposure)} at stake</span>}
      </td>
      <td className="n">{money(u.onBooks)}</td>
      <td className="n">{money(u.askAvg ?? u.basePrice)}</td>
      <td className="n">
        {u.weeklyDiscountPct == null ? '—' : `${u.weeklyDiscountPct}%`} /{' '}
        {u.monthlyDiscountPct == null ? '—' : `${u.monthlyDiscountPct}%`}
      </td>
      <td className="n">
        {money(u.cleaningFeeCharged)}
        <span className="sub-n"> / {money(u.cleaningCost)}</span>
        {/* A turnover that charges the guest less than the cleaner costs
            is a loss on every booking, and neither number alone says so. */}
        {u.cleaningFeeCharged != null && u.cleaningCost != null &&
          u.cleaningFeeCharged - u.cleaningCost < 10 && (
          <span className="breach" title="The cleaning fee barely covers what the cleaner is paid"> ⚠</span>
        )}
      </td>
      <td><button className="link" onClick={onEdit}>Change price</button></td>
    </tr>
  );
}

/**
 * The confirm step.
 *
 * It says in words exactly what is about to change and where — the live
 * guest-facing calendar, not a draft in this app — and the result panel
 * reports what actually landed rather than assuming the request worked.
 */
function PriceDialog({ u, asOf, days, onClose, onDone }: {
  u: RankedUnit; asOf: string; days: number; onClose: () => void; onDone: () => void;
}) {
  const current = u.askAvg ?? u.basePrice;
  const [from, setFrom] = useState(asOf);
  const [to, setTo] = useState(addDays(asOf, days - 1));
  const [rate, setRate] = useState<string>(current == null ? '' : String(current));
  const [disc, setDisc] = useState<string>('');
  const [kind, setKind] = useState<'weekly' | 'monthly' | 'window'>('weekly');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PriceResult | null>(null);

  const rateNum = rate.trim() === '' ? null : Number(rate);
  const discNum = disc.trim() === '' ? null : Number(disc);
  const rateChanged = rateNum != null && rateNum !== current;
  const marked = kind === 'window' && discNum != null && rateNum != null
    ? Math.round(rateNum * (1 - discNum / 100)) : null;
  const openInRange = u.days.filter(d => d.d >= from && d.d <= to && d.s === 'o').length;

  const send = (recordOnly: boolean) => {
    setBusy(true); setResult(null);
    applyPrice({
      listingId: u.listingId,
      baseRate: rateChanged ? rateNum : null,
      discountPct: discNum, discountKind: kind,
      from, to, note, confirmed: true, recordOnly
    }).then(setResult).catch(e => setResult({ ok: false, error: String(e) }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={e => e.stopPropagation()}>
        <h3>{u.name}</h3>
        <p className="note">
          {pct(u.occupancy)} occupied · {u.nightsOpen} of {u.nightsOpen + u.nightsSold} sellable
          nights still open in the next {days}.
        </p>

        <DayPicker days={u.days} from={from} to={to}
          onChange={(f, t) => { setFrom(f); setTo(t); }} />

        <div className="fields">
          <label>Nightly rate
            <input type="number" value={rate} onChange={e => setRate(e.target.value)}
                   placeholder={String(current ?? '')} />
          </label>
          <label>Discount
            <span className="inline">
              <input type="number" value={disc} onChange={e => setDisc(e.target.value)} placeholder="none" />
              <select value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
                <option value="weekly">% off stays of 7+ nights</option>
                <option value="monthly">% off stays of 28+ nights</option>
                <option value="window">% off the selected dates</option>
              </select>
            </span>
          </label>
        </div>
        <label>Why (optional)
          <input value={note} onChange={e => setNote(e.target.value)}
                 placeholder="e.g. three weeks open, school holidays over" />
        </label>

        {!result && (
          <div className="disclaimer">
            <strong>This changes the live price guests see.</strong>
            <ul>
              {rateChanged && <li>Nightly rate {money(current)} → {money(rateNum)} on the {openInRange} open night(s) between {from} and {to}.</li>}
              {discNum != null && kind !== 'window' && (
                <li>{kind === 'weekly' ? 'Weekly' : 'Monthly'} discount set to {discNum}% on the listing —
                    it applies to any qualifying stay, not only the dates selected above.</li>
              )}
              {marked != null && <li>The selected dates repriced to {money(marked)} ({discNum}% off {money(rateNum)}).</li>}
              {!rateChanged && discNum == null && <li>Nothing to change yet — enter a rate or a discount.</li>}
              <li>Nights already booked keep their price; Hostaway will not reprice a booked night.</li>
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
                <button onClick={() => send(true)} disabled={busy} className="ghost">Record only</button>
                <button onClick={() => send(false)} disabled={busy || (!rateChanged && discNum == null)}>
                  {busy ? 'Applying…' : 'Change the live price'}
                </button>
              </>}
        </div>
      </div>
    </div>
  );
}
