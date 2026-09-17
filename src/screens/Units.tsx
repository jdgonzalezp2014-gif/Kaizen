/**
 * Units — what each one is doing over the nights you can still change,
 * and the levers that change them.
 *
 * Grouped rather than ranked into one long table. The first question is
 * never "what is row 14 doing", it is "which of these needs me today",
 * and three groups answer that before any number is read.
 */
import { useEffect, useState } from 'react';
import { getForward, applyPrice, askSuggestion, type PriceResult, type Suggestion } from '../api.ts';
import { rank, suspectedDuplicates, type RankedUnit, type ForwardUnit, type ForwardState } from '../lib/forward.ts';
import { findGaps, signals, verdict, median, portfolioAskRatio,
         type Signal } from '../lib/revenue.ts';
import { money, pct, points } from '../lib/format.ts';
import { DayPicker } from '../components/DayPicker.tsx';
import { Glossary } from '../components/Glossary.tsx';


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
  const [help, setHelp] = useState(false);

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
  const askRatio = portfolioAskRatio(live);
  const totalOpen = live.reduce((a, u) => a + u.nightsOpen, 0);
  const totalPickup = live.reduce((a, u) => a + u.pickup7, 0);
  const totalBooks = live.reduce((a, u) => a + u.onBooks, 0);

  return (
    <section>
      <div className="explain">
        <h2>The next {days} nights <button className="link" onClick={() => setHelp(true)}>What do these mean?</button></h2>
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
                  <UnitCard key={u.listingId} u={u} medianOcc={medianOcc}
                            portfolioAdr={portfolioAdr} askRatio={askRatio} asOf={asOf}
                            onEdit={() => setEditing(u)} onExplain={() => setHelp(true)} />
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

      {help && <Glossary onClose={() => setHelp(false)} />}

      {editing && (
        <PriceDialog u={editing} asOf={asOf} days={days}
          onClose={() => setEditing(null)} onDone={() => { setEditing(null); load(); }} />
      )}
    </section>
  );
}

/**
 * One unit, led by the diagnosis rather than by its metrics.
 *
 * The bar is occupancy against the PORTFOLIO MEDIAN, not against 100%,
 * because 45% is not a verdict on its own. The metrics sit underneath in
 * one quiet line: they are the evidence, and evidence does not need to
 * shout over the finding it supports.
 */
function UnitCard({ u, medianOcc, portfolioAdr, askRatio, asOf, onEdit, onExplain }: {
  u: RankedUnit; medianOcc: number | null;
  portfolioAdr: number | null; askRatio: number | null; asOf: string;
  onEdit: () => void; onExplain: () => void;
}) {
  const gaps = findGaps(u.days);
  const orphans = gaps.filter(g => g.orphaned);
  const input = {
    occupancy: u.occupancy, nightsOpen: u.nightsOpen, pickup7: u.pickup7,
    leadTime: u.leadTime, adr: u.adr, openAsk: u.openAsk,
    lastBookedOn: u.lastBookedOn,
    orphanNights: orphans.reduce((a, g) => a + g.nights, 0),
    orphanRuns: orphans.length,
    portfolioAdr: portfolioAdr == null ? null : Math.round(portfolioAdr),
    portfolioAskRatio: askRatio,
    today: asOf
  };
  const v = verdict(input);
  const rest = signals(input).filter(x => !v.reason.includes(x.text.slice(0, 24)));
  const occ = u.occupancy ?? 0;

  return (
    <article className="ucard">
      <header>
        <h4>{u.name}</h4>
        <span className="at-stake">
          {u.nightsOpen} open · <strong>{money(u.exposure)}</strong> still winnable
        </span>
      </header>

      <p className={`verdict tone-${v.tone}`}>
        <span className="dot" aria-hidden="true" />
        <strong>{v.label}</strong>
        <span className="because">{v.reason}</span>
      </p>

      {rest.length > 0 && (
        <ul className="signals">{rest.map(x => <SignalLine key={x.kind} s={x} />)}</ul>
      )}

      <div className={`occbar tone-${v.tone}`}>
        <div className="fill" style={{ width: `${Math.min(100, occ * 100)}%` }} />
        {medianOcc != null && (
          <div className="median" style={{ left: `${Math.min(100, medianOcc * 100)}%` }} />
        )}
      </div>
      <div className="occbar-legend">
        <span><strong>{pct(u.occupancy)}</strong> of sellable nights booked</span>
        {medianOcc != null && (
          <span>{points((occ - medianOcc) * 100)} pts vs portfolio median {pct(medianOcc)}</span>
        )}
      </div>

      <footer>
        <p className="facts">
          <Fact k="RevPAN" v={money(u.revpan)} onExplain={onExplain} />
          <Fact k="ADR" v={money(u.adr)} onExplain={onExplain} />
          <Fact k="asking" v={u.nightsOpen ? money(u.openAsk) : '—'} />
          <Fact k="booked 7d" v={`${u.pickup7}n`} onExplain={onExplain} />
          <Fact k="books" v={u.leadTime == null ? '—' : `${u.leadTime}d out`} onExplain={onExplain} />
          {/* A visible hole, not a hidden one: the comp set is the biggest
              missing input here, and leaving the row out entirely would
              let the card read as though the picture were complete. */}
          <Fact k="market" v="not connected" muted />
        </p>
        <button className="small" onClick={onEdit}>Change price</button>
      </footer>
    </article>
  );
}

function Fact({ k, v, onExplain, muted }: {
  k: string; v: string; onExplain?: () => void; muted?: boolean;
}) {
  return (
    <span className={muted ? 'fact muted' : 'fact'}>
      {onExplain
        ? <button type="button" className="fact-k" onClick={onExplain} title={`What is ${k}?`}>{k}</button>
        : <span className="fact-k">{k}</span>}
      <b>{v}</b>
    </span>
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
  const [advice, setAdvice] = useState<Suggestion | null>(null);
  const [adviceErr, setAdviceErr] = useState('');
  const [thinking, setThinking] = useState(false);

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

  const ask = () => {
    setThinking(true); setAdviceErr(''); setAdvice(null);
    askSuggestion(u.listingId, from, to)
      .then(r => {
        if (!r.ok) { setAdviceErr(r.message ?? r.error ?? 'Could not get a suggestion.'); return; }
        setAdvice(r.suggestion!);
      })
      .catch(e => setAdviceErr(String(e)))
      .finally(() => setThinking(false));
  };

  /** Fill the form from the advice. It still goes through the same confirm. */
  const applyAdvice = (a: Suggestion) => {
    if (a.suggestedRate != null) setRate(String(a.suggestedRate));
    if (a.suggestedWeeklyDiscountPct != null) { setKind('weekly'); setDisc(String(a.suggestedWeeklyDiscountPct)); }
    else if (a.suggestedMonthlyDiscountPct != null) { setKind('monthly'); setDisc(String(a.suggestedMonthlyDiscountPct)); }
    if (!note) setNote(`AI: ${a.action.replace(/_/g, ' ')}`);
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
        <div className="advice-block">
          {!advice && !thinking && (
            <button type="button" className="ghost small" onClick={ask}>Ask Gemini what to do</button>
          )}
          {thinking && <p className="note">Reading this unit's calendar and booking history…</p>}
          {adviceErr && <p className="banner warn">{adviceErr}</p>}
          {advice && (
            <div className="advice">
              <div className="advice-head">
                <strong>{advice.action.replace(/_/g, ' ')}</strong>
                <span className={`conf conf-${advice.confidence}`}>{advice.confidence} confidence</span>
              </div>
              <p>{advice.reasoning}</p>
              {/* What the model could NOT see. Shown as prominently as the
                  advice, because a recommendation made without the comp
                  set is a different object from one made with it. */}
              {advice.missing && <p className="missing"><i>Not considered:</i> {advice.missing}</p>}
              <div className="advice-actions">
                {(advice.suggestedRate != null || advice.suggestedWeeklyDiscountPct != null ||
                  advice.suggestedMonthlyDiscountPct != null) && (
                  <button type="button" className="ghost small" onClick={() => applyAdvice(advice)}>
                    Fill the form with this
                  </button>
                )}
                {advice.suggestedMinimumStay != null && (
                  <span className="note">
                    Suggests a minimum stay of {advice.suggestedMinimumStay} night(s) — change that in
                    Hostaway; this app does not write minimum stays yet.
                  </span>
                )}
              </div>
              <p className="note">
                Advice only. Nothing has changed, and it is recorded next to whatever you decide,
                so its track record becomes measurable.
              </p>
            </div>
          )}
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
