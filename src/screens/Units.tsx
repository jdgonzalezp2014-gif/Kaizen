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
import { findGaps, signals, median, type Signal } from '../lib/revenue.ts';
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
  // Benchmarks come from units that can actually be booked — parked ones
  // would drag both towards zero and make everything look healthy.
  const medianOcc = median(live.filter(u => u.occupancy != null).map(u => u.occupancy as number));
  const portfolioAdr = median(live.filter(u => u.adr != null && u.adr > 0).map(u => u.adr as number));
  const totalOpen = live.reduce((a, u) => a + u.nightsOpen, 0);
  const totalPickup = live.reduce((a, u) => a + u.pickup7, 0);
  const totalBooks = live.reduce((a, u) => a + u.onBooks, 0);

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

      {units && (
        <dl className="strip">
          <div><dt>Taking bookings</dt><dd>{live.length}<small>of {ranked.length}</small></dd></div>
          <div><dt>Median occupancy</dt><dd>{pct(medianOcc)}</dd></div>
          <div><dt>Nights open</dt><dd>{totalOpen}<small>in window</small></dd></div>
          <div><dt>Booked last 7d</dt><dd>{totalPickup}<small>nights</small></dd></div>
          <div><dt>On the books</dt><dd>{money(totalBooks)}</dd></div>
        </dl>
      )}

      {units && GROUPS.map(g => {
        const rows = ranked.filter(u => g.states.includes(u.state));
        if (!rows.length) return null;
        const asCards = g.key === 'act' || g.key === 'watch';
        return (
          <div key={g.key} className="group">
            <h3>{g.title} <span className="count">{rows.length}</span></h3>
            <p className="note">{g.blurb}{g.key === 'off' && ` A block running past ${parkedAfter} days counts as parked.`}</p>
            {asCards
              ? rows.map(u => (
                  <UnitCard key={u.listingId} u={u} floor={floor} medianOcc={medianOcc}
                            portfolioAdr={portfolioAdr} asOf={asOf} onEdit={() => setEditing(u)} />
                ))
              : (
                <table className="units compact">
                  <thead>
                    <tr>
                      <th>Unit</th><th className="n">Occupied</th><th className="n">Open</th>
                      <th className="n">RevPAN</th><th className="n">ADR</th>
                      <th className="n">Cleaning in / out</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(u => (
                      <CompactRow key={u.listingId} u={u} parkedAfter={parkedAfter}
                                  onEdit={() => setEditing(u)} />
                    ))}
                  </tbody>
                </table>
              )}
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

/**
 * One unit, as a revenue manager would read it.
 *
 * The bar is occupancy against the portfolio median rather than against
 * 100%, because 45% is not a verdict on its own — it is healthy in one
 * market and a crisis in another, and the portfolio is the only honest
 * benchmark available until real comp data exists.
 */
function UnitCard({ u, floor, medianOcc, portfolioAdr, asOf, onEdit }: {
  u: RankedUnit; floor: number; medianOcc: number | null;
  portfolioAdr: number | null; asOf: string; onEdit: () => void;
}) {
  const gaps = findGaps(u.days);
  const orphanNights = gaps.filter(g => g.orphaned).reduce((a, g) => a + g.nights, 0);
  const sig = signals({
    occupancy: u.occupancy, nightsOpen: u.nightsOpen, pickup7: u.pickup7,
    leadTime: u.leadTime, adr: u.adr, openAsk: u.openAsk,
    lastBookedOn: u.lastBookedOn, orphanNights,
    portfolioAdr: portfolioAdr == null ? null : Math.round(portfolioAdr), today: asOf
  });

  const worst: 'bad' | 'warn' | 'ok' =
    sig.some(x => x.tone === 'bad') ? 'bad' : sig.some(x => x.tone === 'warn') ? 'warn' : 'ok';
  const occ = u.occupancy ?? 0;

  return (
    <article className={`ucard tone-${worst}`}>
      <div className="ucard-head">
        <h4>{u.name}</h4>
        <span className="meta">
          {u.nightsSold} booked · {u.nightsOpen} open of {u.nightsOpen + u.nightsSold} sellable
        </span>
      </div>

      <div className={`occbar tone-${worst}`}>
        <div className="fill" style={{ width: `${Math.min(100, occ * 100)}%` }} />
        {medianOcc != null && (
          <div className="median" style={{ left: `${Math.min(100, medianOcc * 100)}%` }}
               title={`Portfolio median ${pct(medianOcc)}`} />
        )}
      </div>
      <div className="occbar-legend">
        <span>{pct(u.occupancy)} occupied</span>
        {medianOcc != null && (
          <span>
            {/* Signed, in points, so the comparison needs no arithmetic. */}
            {occ >= medianOcc ? '+' : ''}{Math.round((occ - medianOcc) * 100)} pts vs
            portfolio median {pct(medianOcc)}
          </span>
        )}
      </div>

      <dl className="umetrics">
        <div><dt>RevPAN</dt><dd>{money(u.revpan)}</dd></div>
        <div><dt>Achieved ADR</dt><dd>{money(u.adr)}</dd></div>
        <div><dt>Asking, open nights</dt><dd>{u.nightsOpen ? money(u.openAsk) : '—'}</dd></div>
        <div><dt>Booked last 7d</dt><dd>{u.pickup7}<span className="unit"> nights</span></dd></div>
        <div><dt>Books</dt><dd>{u.leadTime == null ? '—' : <>{u.leadTime}<span className="unit"> days out</span></>}</dd></div>
        <div><dt>Money still open</dt><dd>{money(u.exposure)}</dd></div>
        {/* Deliberately a visible hole rather than a hidden one. The comp
            set is the single biggest missing input to any of these
            decisions, and an empty slot says so; omitting it would let
            the card read as if the picture were complete. */}
        <div className="pending"><dt>Market rate</dt><dd>—<span className="unit"> not connected</span></dd></div>
      </dl>

      {sig.length > 0 && (
        <ul className="signals">
          {sig.map(x => <SignalLine key={x.kind} s={x} />)}
        </ul>
      )}

      <div className="ucard-actions">
        <button className="small" onClick={onEdit}>Change price</button>
      </div>
    </article>
  );
}

/* Icon AND word, never colour alone — this has to survive colourblindness,
   a greyscale print and a screenshot pasted into a chat. */
const SIGNAL_ICON = { bad: '▲', warn: '▲', info: 'i' } as const;

function SignalLine({ s }: { s: Signal }) {
  return <li className={s.tone}><i>{SIGNAL_ICON[s.tone]}</i><span>{s.text}</span></li>;
}

function CompactRow({ u, parkedAfter, onEdit }: {
  u: RankedUnit; parkedAfter: number; onEdit: () => void;
}) {
  const dead = u.state === 'parked' || u.state === 'offline' || u.state === 'unknown';
  if (dead) {
    return (
      <tr className="muted-row">
        <td>{u.name}</td>
        <td className="n" colSpan={4}>
          {u.state === 'unknown' ? 'No calendar returned'
            : u.state === 'parked' ? `Blocked every night for ${parkedAfter}+ days`
            : `Blocked all ${u.nights} nights in this window`}
          {u.state === 'parked' && u.listedActive && <span className="sub-n"> · still flagged active in Hostaway</span>}
        </td>
        <td className="n">{money(u.cleaningFeeCharged)}<span className="sub-n"> / {money(u.cleaningCost)}</span></td>
        <td></td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{u.name}</td>
      <td className="n">{pct(u.occupancy)}</td>
      <td className="n">{u.nightsOpen}</td>
      <td className="n">{money(u.revpan)}</td>
      <td className="n">{money(u.adr)}</td>
      <td className="n">
        {money(u.cleaningFeeCharged)}<span className="sub-n"> / {money(u.cleaningCost)}</span>
        {u.cleaningFeeCharged != null && u.cleaningCost != null &&
          u.cleaningFeeCharged - u.cleaningCost < 10 && (
          <span className="breach" title="The cleaning fee barely covers what the cleaner is paid"> ▲</span>
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
  const gaps = findGaps(u.days);

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

        <GapList gaps={gaps} onPick={(f, t) => { setFrom(f); setTo(t); }} />

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

/**
 * The open stretches, longest first, with the minimum stay that governs
 * each one.
 *
 * This is the tool that stops wasted discounts. A two-night gap under a
 * three-night minimum is unbookable at ANY price — the lever is the
 * minimum, not the rate — and nothing in an occupancy figure will ever
 * tell you that. Clicking a gap selects exactly those nights above.
 */
function GapList({ gaps, onPick }: {
  gaps: ReturnType<typeof findGaps>; onPick: (from: string, to: string) => void;
}) {
  if (!gaps.length) return null;
  const sorted = [...gaps].sort((a, b) => b.nights - a.nights).slice(0, 6);
  return (
    <div className="gaps">
      <div className="gaps-head">Open stretches</div>
      <ul>
        {sorted.map(g => (
          <li key={g.from} className={g.orphaned ? 'orphan' : undefined}>
            <button type="button" className="link" onClick={() => onPick(g.from, g.to)}>
              {g.from}{g.nights > 1 && ` → ${g.to}`}
            </button>
            <span className="n">{g.nights} night{g.nights === 1 ? '' : 's'}</span>
            <span className="n">{g.askAvg == null ? '—' : `$${g.askAvg}`}</span>
            <span className="min">
              {g.minStay == null ? '' : `min ${g.minStay}`}
              {g.orphaned && <strong> · too short to book — lower the minimum, not the price</strong>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
