/**
 * Units — a status list you scan, and one row you open.
 *
 * Twenty-three expanded cards is not a workspace, it is a scroll. The
 * shape that matches the actual job is a traffic light per unit: colour
 * and a three-word finding, scanned in seconds, and then ONE row opened
 * to do the work in — metrics, calendar, gaps, advice and the price
 * controls, all in place. Nothing modal, because a dialog hides the list
 * you were comparing against.
 */
import { useEffect, useRef, useState } from 'react';
import {
  getForward, applyPrice, askSuggestion, getMarket,
  type PriceResult, type Suggestion, type ChannelStatus, type PageRead, type StoredRead, type PlatformRating
} from '../api.ts';
import {
  rank, suspectedDuplicates,
  type RankedUnit, type ForwardUnit, type ForwardState
} from '../lib/forward.ts';
import {
  findGaps, median, portfolioAskRatio, agreement, type Verdict
} from '../lib/revenue.ts';
import { money, pct, points } from '../lib/format.ts';
import { diagnose, type Read } from '../lib/verdicts.ts';
import { channelState } from '../lib/channels.ts';
import { Loading } from '../components/Loading.tsx';
import { rememberTiming, recallTiming } from '../lib/progress.ts';
import { DayPicker } from '../components/DayPicker.tsx';
import { Glossary } from '../components/Glossary.tsx';
import {
  Filters, filterUnits, placeOf, EMPTY_FILTER,
  type FilterState, type Light
} from '../components/Filters.tsx';

const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

interface Group { key: string; title: string; blurb: string; states: ForwardState[] }

const GROUPS: Group[] = [
  { key: 'act', title: 'Needs a decision', states: ['thin'],
    blurb: 'Below your occupancy floor with nights still open — ordered by money at stake, ' +
           'not by lowest percentage.' },
  { key: 'watch', title: 'Nearly spent', states: ['watch'],
    blurb: 'Under the floor, but almost nothing left to sell in this window.' },
  { key: 'ok', title: 'On track', states: ['ok'],
    blurb: 'At or above your occupancy floor for these dates.' },
  { key: 'off', title: 'Not taking bookings', states: ['archived', 'parked', 'offline', 'unknown'],
    blurb: 'Blocked, or no calendar. Held out of the ranking: a blocked unit is not an empty ' +
           'one, and discounting it would cut the price of something nobody can book.' }
];

export function Units() {
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [days, setDays] = useState(30);
  const [units, setUnits] = useState<ForwardUnit[] | null>(null);
  const [floor, setFloor] = useState(0.6);
  const [parkedAfter, setParkedAfter] = useState(45);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);

  const load = () => {
    setLoading(true); setError('');
    const started = Date.now();
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
        // The server reports what it actually spent; the browser adds
        // its own latency, so the wall-clock figure is the honest input
        // to the next estimate.
        rememberTiming('forward', Date.now() - started);
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [asOf, days]);

  const ranked = units ? rank(units, floor) : [];
  const dupes  = units ? suspectedDuplicates(units) : [];
  const live   = ranked.filter(u => u.active);
  // Benchmarks come from units that can actually be booked — parked ones
  // would drag them towards zero and make everything look healthy.
  const medianOcc = median(live.filter(u => u.occupancy != null).map(u => u.occupancy as number));
  const portfolioAdr = median(live.filter(u => u.adr != null && u.adr > 0).map(u => u.adr as number));
  const askRatio = portfolioAskRatio(live);
  const totalOpen = live.reduce((a, u) => a + u.nightsOpen, 0);
  const totalPickup = live.reduce((a, u) => a + u.pickup7, 0);
  const totalBooks = live.reduce((a, u) => a + u.onBooks, 0);

  const read = (u: RankedUnit) => diagnose(u, portfolioAdr, askRatio, asOf);
  // A unit that is not taking bookings has no diagnosis to show — its
  // light is "off" rather than a verdict it never earned.
  const lightOf = (u: RankedUnit): Light =>
    u.active && u.listedActive ? read(u).v.tone : 'off';

  const counts: Partial<Record<Light, number>> = {};
  ranked.forEach(u => { const l = lightOf(u); counts[l] = (counts[l] ?? 0) + 1; });
  const shown = filterUnits(ranked, filter, lightOf);

  return (
    <section>
      <div className="row-controls">
        <h2 className="screen-title">Next {days} nights</h2>
        <label>From <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></label>
        <label>for
          <select value={days} onChange={e => setDays(Number(e.target.value))}>
            {[7, 14, 30, 45, 60, 90].map(d => <option key={d} value={d}>{d} nights</option>)}
          </select>
        </label>
        <span className="note">to {addDays(asOf, days - 1)}</span>
        <button className="link right" onClick={() => setHelp(h => !h)}>
          {help ? 'hide' : 'what do these mean?'}
        </button>
      </div>

      {help && <Glossary onClose={() => setHelp(false)} />}

      {error && <p className="banner warn">{error}</p>}
      {loading && !units && (
        <Loading
          estimateMs={recallTiming('forward', 9000)}
          stages={[
            'Asking Hostaway for the listings',
            'Reading each calendar',
            'Pulling the booking history',
            'Working out pace and open nights'
          ]}
        />
      )}

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
          <div><dt>Nights open</dt><dd>{totalOpen}</dd></div>
          <div><dt>Booked last 7d</dt><dd>{totalPickup}<small>nights</small></dd></div>
          <div><dt>On the books</dt><dd>{money(totalBooks)}</dd></div>
        </dl>
      )}

      {units && (
        <Filters rows={ranked} value={filter} onChange={setFilter} counts={counts} />
      )}

      {units && shown.length === 0 && (
        <p className="note">No unit matches those filters.</p>
      )}

      {units && GROUPS.map(g => {
        const rows = shown.filter(u => g.states.includes(u.state));
        if (!rows.length) return null;
        return (
          <div key={g.key} className="group">
            <h3>{g.title} <span className="count">{rows.length}</span></h3>
            <p className="note">
              {g.blurb}{g.key === 'off' && ` A block running past ${parkedAfter} days counts as parked.`}
            </p>
            <div className="ulist">
              {rows.map(u => (
                <UnitRow
                  key={u.listingId} u={u} read={read(u)} medianOcc={medianOcc}
                  expanded={open === u.listingId}
                  onToggle={() => setOpen(open === u.listingId ? null : u.listingId)}
                  asOf={asOf} days={days} parkedAfter={parkedAfter}
                  onExplain={() => setHelp(true)} onChanged={load}
                />
              ))}
            </div>
          </div>
        );
      })}

    </section>
  );
}

/* ── the read ──────────────────────────────────────────────────────── */

/* ── the traffic-light row ─────────────────────────────────────────── */

function UnitRow({ u, read, medianOcc, expanded, onToggle, asOf, days, parkedAfter, onExplain, onChanged }: {
  u: RankedUnit; read: Read; medianOcc: number | null;
  expanded: boolean; onToggle: () => void;
  asOf: string; days: number; parkedAfter: number;
  onExplain: () => void; onChanged: () => void;
}) {
  const dead = u.state === 'parked' || u.state === 'offline'
            || u.state === 'unknown' || u.state === 'archived';
  const occ = u.occupancy ?? 0;
  const tone = dead ? 'off' : read.v.tone;
  const ref = useRef<HTMLDivElement>(null);

  // Bring an opened row to the top of the viewport. Opening a row near
  // the bottom of a list of twenty-three otherwise leaves its panel
  // entirely below the fold, so the click appears to do nothing.
  useEffect(() => {
    if (!expanded) return;
    const el = ref.current;
    if (!el) return;
    const id = window.setTimeout(() => {
      const top = el.getBoundingClientRect().top + window.scrollY - 12;
      // Only scroll when the row is not already comfortably in view —
      // nudging the page under someone who can already see it is worse
      // than not scrolling at all.
      if (Math.abs(window.scrollY - top) > 40) {
        window.scrollTo({ top, behavior: 'smooth' });
      }
    }, 60);
    return () => window.clearTimeout(id);
  }, [expanded]);

  return (
    // The tone rides on the wrapper as well as the light, so an opened
    // row can carry its own colour on the edge that frames it.
    <div ref={ref} className={`urow tone-${tone}${expanded ? ' open' : ''}`}>
      <button type="button" className="urow-head" onClick={onToggle} aria-expanded={expanded}>
        {/* Colour AND a word. The dot is the scan; the label is the meaning,
            so nothing here depends on seeing the difference between red
            and amber. */}
        <span className={`light tone-${tone}`} aria-hidden="true" />
        <span className="uname">{u.name}</span>
        <span className="ustate">
          {dead
            ? (u.state === 'archived' ? `Not published — ${u.specialStatus ?? 'archived'} in Hostaway`
               : u.state === 'unknown' ? 'No calendar'
               : u.state === 'parked' ? `Parked ${parkedAfter}+ days` : 'Blocked all window')
            : read.v.label}
        </span>

        {dead ? <span className="ubar" /> : (
          <span className="ubar" title={`${pct(u.occupancy)} occupied`}>
            <span className={`ubar-fill tone-${tone}`} style={{ width: `${Math.min(100, occ * 100)}%` }} />
            {medianOcc != null && (
              <span className="ubar-median" style={{ left: `${Math.min(100, medianOcc * 100)}%` }} />
            )}
          </span>
        )}

        <span className="uocc">{dead ? '—' : pct(u.occupancy)}</span>
        <span className="uopen">{dead ? '—' : `${u.nightsOpen} open`}</span>
        <span className="ustake">{dead ? '' : money(u.exposure)}</span>
        <span className="uchev" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <UnitDetail u={u} read={read} medianOcc={medianOcc} asOf={asOf} days={days}
                    dead={dead} onExplain={onExplain} onChanged={onChanged} />
      )}
    </div>
  );
}

/* ── the workspace ─────────────────────────────────────────────────── */

function UnitDetail({ u, read, medianOcc, asOf, days, dead, onExplain, onChanged }: {
  u: RankedUnit; read: Read; medianOcc: number | null;
  asOf: string; days: number; dead: boolean;
  onExplain: () => void; onChanged: () => void;
}) {
  const occ = u.occupancy ?? 0;
  return (
    <div className="udetail">
      {/* The finding spans both columns: it is the one thing that should
          be read before anything else on the card. */}
      {/* Both analyses on this card reach the same conclusion most of the
          time, so each one says who is speaking. Without it the reader
          cannot tell corroboration from repetition — or which of the two
          to believe when they differ. */}
      <div className="byline">
        <span className="who">Read from your booking data</span>
      </div>
      <p className={`verdict tone-${dead ? 'info' : read.v.tone}`}>
        <span>{read.v.reason}</span>
      </p>

      {read.rest.length > 0 && (
        <ul className="signals">
          {read.rest.map(s => (
            <li key={s.kind} className={s.tone}>
              <i>{s.tone === 'info' ? 'i' : '▲'}</i><span>{s.text}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Two columns on a wide screen: evidence on the left, the thing
          you came to do on the right. Stacked they ran to two screens of
          scrolling, so the calendar — the control the whole panel exists
          for — sat below the fold behind numbers you had already read. */}
      <div className="udetail-cols">
        <div className="ud-evidence">
          <dl className="facts-grid">
            <Fact k="RevPAN" v={money(u.revpan)} onExplain={onExplain} />
            <Fact k="ADR" v={money(u.adr)} onExplain={onExplain} />
            {/* Labelled by source. This is Hostaway's calendar price, which
            is what we asked for, not what a guest was shown. */}
        <Fact k="Our ask (Hostaway)" v={u.nightsOpen ? money(u.openAsk) : '—'} />
            <Fact k="Booked 7d" v={`${u.pickup7} nights`} onExplain={onExplain} />
            <Fact k="Books" v={u.leadTime == null ? '—' : `${u.leadTime} days out`} onExplain={onExplain} />
            <Fact k="On books" v={money(u.onBooks)} />
            <Fact k="Cleaning in/out"
                  v={`${money(u.cleaningFeeCharged)} / ${money(u.cleaningCost)}`} onExplain={onExplain} />
            <Fact k="Market" v="not connected" muted />
          </dl>

          {!dead && (
            <div className="occline">
              <span className="ubar big">
                <span className={`ubar-fill tone-${read.v.tone}`} style={{ width: `${Math.min(100, occ * 100)}%` }} />
                {medianOcc != null && (
                  <span className="ubar-median" style={{ left: `${Math.min(100, medianOcc * 100)}%` }} />
                )}
              </span>
              <span className="note">
                <strong>{pct(u.occupancy)}</strong> of {u.nightsOpen + u.nightsSold} sellable nights booked
                {medianOcc != null && <> · {points((occ - medianOcc) * 100)} pts vs median {pct(medianOcc)}</>}
              </span>
            </div>
          )}

          <Market listingId={u.listingId} from={asOf} days={days} />
        </div>

        {!dead && (
          <div className="ud-action">
            <PriceWorkspace u={u} gaps={read.gaps} verdictKind={read.v.kind}
                            asOf={asOf} days={days} onChanged={onChanged} />
          </div>
        )}
      </div>
    </div>
  );
}

function Fact({ k, v, onExplain, muted }: {
  k: string; v: string; onExplain?: () => void; muted?: boolean;
}) {
  return (
    <div className={muted ? 'fact muted' : 'fact'}>
      {onExplain
        ? <dt><button type="button" className="fact-k" onClick={onExplain} title={`What is ${k}?`}>{k}</button></dt>
        : <dt><span className="fact-k">{k}</span></dt>}
      <dd>{v}</dd>
    </div>
  );
}

/**
 * Everything needed to change a price, in the row you opened.
 *
 * The calendar, the open stretches, the model's read and the controls
 * sit together because they are one decision — and because a modal would
 * cover the list you were comparing this unit against.
 */
function PriceWorkspace({ u, gaps, verdictKind, asOf, days, onChanged }: {
  u: RankedUnit; gaps: ReturnType<typeof findGaps>;
  verdictKind: Verdict['kind'];
  asOf: string; days: number; onChanged: () => void;
}) {
  const current = u.openAsk ?? u.basePrice;
  const [from, setFrom] = useState(asOf);
  const [to, setTo] = useState(addDays(asOf, days - 1));
  const [rate, setRate] = useState(current == null ? '' : String(current));
  const [disc, setDisc] = useState('');
  const [kind, setKind] = useState<'weekly' | 'monthly' | 'window'>('weekly');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PriceResult | null>(null);
  const [advice, setAdvice] = useState<Suggestion | null>(null);
  const [adviceErr, setAdviceErr] = useState('');
  const [thinking, setThinking] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Coarse on purpose: it compares the direction of the advice, not its
  // wording. A model phrasing "hold" as three sentences about lead time
  // is still saying hold.
  const agree = agreement(verdictKind, advice?.action);

  const rateNum = rate.trim() === '' ? null : Number(rate);
  const discNum = disc.trim() === '' ? null : Number(disc);
  const rateChanged = rateNum != null && rateNum !== current;
  const marked = kind === 'window' && discNum != null && rateNum != null
    ? Math.round(rateNum * (1 - discNum / 100)) : null;
  const openInRange = u.days.filter(d => d.d >= from && d.d <= to && d.s === 'o').length;
  const nothingToDo = !rateChanged && discNum == null;

  const ask = () => {
    setThinking(true); setAdviceErr(''); setAdvice(null);
    askSuggestion(u.listingId, from, to)
      .then(r => r.ok ? setAdvice(r.suggestion!) : setAdviceErr(r.message ?? r.error ?? 'No suggestion.'))
      .catch(e => setAdviceErr(String(e)))
      .finally(() => setThinking(false));
  };

  // Runs as soon as the row opens: by the time someone has read the
  // calendar the answer is already there, instead of costing a click and
  // another wait. Once only — it deliberately does not re-run when the
  // date range is nudged, because that would fire a paid call on every
  // click in the calendar.
  useEffect(() => { ask(); /* eslint-disable-next-line */ }, [u.listingId]);

  const useAdvice = (a: Suggestion) => {
    if (a.suggestedRate != null) setRate(String(a.suggestedRate));
    if (a.suggestedWeeklyDiscountPct != null) { setKind('weekly'); setDisc(String(a.suggestedWeeklyDiscountPct)); }
    else if (a.suggestedMonthlyDiscountPct != null) { setKind('monthly'); setDisc(String(a.suggestedMonthlyDiscountPct)); }
    if (!note) setNote(`Gemini: ${a.action.replace(/_/g, ' ')}`);
  };

  const send = (recordOnly: boolean) => {
    setBusy(true); setResult(null);
    applyPrice({
      listingId: u.listingId, baseRate: rateChanged ? rateNum : null,
      discountPct: discNum, discountKind: kind, from, to, note,
      confirmed: true, recordOnly
    }).then(r => { setResult(r); setConfirming(false); if (r.ok) onChanged(); })
      .catch(e => setResult({ ok: false, error: String(e) }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="workspace">
      {/* Above the calendar, not below it. Sitting between the calendar
          and the rate fields, this read as though the stretch rows were
          part of the pricing form — when they are a way of CHOOSING the
          dates, which is the step before. */}
      {gaps.length > 0 && <GapList gaps={gaps} onPick={(f, t) => { setFrom(f); setTo(t); }} />}

      <DayPicker days={u.days} from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t); }} />

      <Effect from={from} to={to} openInRange={openInRange}
              soldInRange={u.days.filter(d => d.d >= from && d.d <= to && d.s === 's').length}
              current={current} rateNum={rateNum} rateChanged={rateChanged}
              discNum={discNum} kind={kind} marked={marked} />

      <div className="tools">
        <div className="tool-fields">
          <label>Nightly rate
            <input type="number" value={rate} onChange={e => setRate(e.target.value)}
                   placeholder={String(current ?? '')} />
          </label>
          <label>Discount
            <span className="inline">
              <input type="number" value={disc} onChange={e => setDisc(e.target.value)} placeholder="none" />
              <select value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
                <option value="weekly">% off 7+ nights</option>
                <option value="monthly">% off 28+ nights</option>
                <option value="window">% off selected dates</option>
              </select>
            </span>
          </label>
          <label>Why (optional)
            <input value={note} onChange={e => setNote(e.target.value)}
                   placeholder="e.g. three weeks open, holidays over" />
          </label>
        </div>

        {!thinking && (
          <button type="button" className="ghost small" onClick={ask}>
            {advice ? 'Re-run for these dates' : 'Ask Gemini'}
          </button>
        )}
        {thinking && <span className="note">Checking the calendar, the history and what is on locally…</span>}
      </div>

      {adviceErr && <p className="banner warn">{adviceErr}</p>}

      {advice && (
        <div className="advice">
          <div className="byline">
            <span className="who ai"><span className="ai-mark" aria-hidden="true">✦</span> Gemini</span>
            {/* Agreement is corroboration worth a glance; disagreement is
                the only time the model is saying something the rules did
                not, and that is worth stopping on. */}
            {agree !== 'unclear' && (
              <span className={`agree agree-${agree}`}>
                {agree === 'agrees' ? 'agrees with the read above' : 'differs from the read above'}
              </span>
            )}
          </div>
          <div className="advice-head">
            <strong>{advice.action.replace(/_/g, ' ')}</strong>
            <span className={`conf conf-${advice.confidence}`}>{advice.confidence} confidence</span>
          </div>
          <p>{advice.reasoning}</p>
          {/* What the model could NOT see, shown as prominently as what it
              did. A recommendation made without the comp set is a
              different object from one made with it. */}
          {advice.eventNote && <p className="eventnote"><i>Locally:</i> {advice.eventNote}</p>}
          {advice.missing && <p className="missing"><i>Not considered:</i> {advice.missing}</p>}

          {(advice.events || advice.eventsError) && (
            <details className="events">
              <summary>
                {advice.eventsError ? 'Local events unavailable' : `What is on near ${u.name.split(' ')[0] ?? 'here'}`}
              </summary>
              {advice.eventsError
                ? <p className="note">{advice.eventsError}</p>
                : <>
                    {/* Shown verbatim with its sources. This is the one input
                        that came from outside the account, so it is the one a
                        human has to be able to check — an event that does not
                        exist is exactly the kind of confident detail that
                        would otherwise justify a price rise. */}
                    <p className="note">{advice.events}</p>
                    {advice.eventSources && advice.eventSources.length > 0 && (
                      <ul className="sources">
                        {advice.eventSources.map(src => (
                          <li key={src.uri}>
                            <a href={src.uri} target="_blank" rel="noreferrer noopener">
                              {src.title || src.uri}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="note"><em>From a web search — verify before pricing against it.</em></p>
                  </>}
            </details>
          )}
          <div className="advice-actions">
            {(advice.suggestedRate != null || advice.suggestedWeeklyDiscountPct != null ||
              advice.suggestedMonthlyDiscountPct != null) && (
              <button type="button" className="ghost small" onClick={() => useAdvice(advice)}>
                Use these numbers
              </button>
            )}
            {advice.suggestedMinimumStay != null && (
              <span className="note">
                Suggests a {advice.suggestedMinimumStay}-night minimum — set that in Hostaway;
                this app does not write minimum stays yet.
              </span>
            )}
            <button type="button" className="link" onClick={() => setAdvice(null)}>dismiss</button>
          </div>
        </div>
      )}

      {result && (
        <div className={`disclaimer ${result.ok ? 'good' : 'bad'}`}>
          <strong>{result.ok ? 'Applied.' : result.pushed ? 'Partly applied.' : 'Not applied.'}</strong>
          <p>{result.message ?? result.error}</p>
          {result.detail && <p className="mono">{result.detail}</p>}
        </div>
      )}

      {confirming && !result && (
        <div className="disclaimer">
          <strong>This changes the live price guests see.</strong>
          <ul>
            {rateChanged && <li>Nightly rate {money(current)} → {money(rateNum)} on the {openInRange} open night(s), {from} to {to}.</li>}
            {discNum != null && kind !== 'window' && (
              <li>{kind === 'weekly' ? 'Weekly' : 'Monthly'} discount set to {discNum}% on the listing —
                  it applies to any qualifying stay, not only these dates.</li>
            )}
            {marked != null && <li>Selected dates repriced to {money(marked)} ({discNum}% off {money(rateNum)}).</li>}
            <li>Nights already booked keep their price; Hostaway will not reprice a booked night.</li>
            <li>It is recorded either way, with today's occupancy, so its effect can be measured later.</li>
          </ul>
        </div>
      )}

      <div className="workspace-actions">
        {result
          ? <button className="small" onClick={() => setResult(null)}>Make another change</button>
          : confirming
            ? <>
                <button className="ghost small" onClick={() => setConfirming(false)}>Back</button>
                <button className="small" disabled={busy} onClick={() => send(false)}>
                  {busy ? 'Applying…' : 'Yes, change the live price'}
                </button>
              </>
            : <>
                <button className="ghost small" disabled={busy || nothingToDo} onClick={() => send(true)}>
                  Record only
                </button>
                <button className="small" disabled={nothingToDo} onClick={() => setConfirming(true)}>
                  Change price…
                </button>
              </>}
      </div>
    </div>
  );
}

/**
 * The open stretches, longest first, with the minimum stay governing each.
 *
 * This is the tool that prevents wasted discounts: a two-night gap under
 * a three-night minimum is unbookable at ANY price — the lever is the
 * minimum, not the rate — and no occupancy figure will show you that.
 * Clicking a stretch selects exactly those nights above.
 */
function GapList({ gaps, onPick }: {
  gaps: ReturnType<typeof findGaps>; onPick: (from: string, to: string) => void;
}) {
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
            <span className="n">{g.nights}n</span>
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

/**
 * What the selected dates actually mean for the price.
 *
 * The calendar shows which nights are picked; it cannot show what
 * picking them DOES. Without this, a range and a rate sit next to each
 * other and the reader has to assume the connection — and the two cases
 * behave very differently: a nightly rate touches exactly the selected
 * open nights, while a length-of-stay discount is a listing-wide setting
 * that the dates do not bound at all.
 */
function Effect({ from, to, openInRange, soldInRange, current, rateNum, rateChanged, discNum, kind, marked }: {
  from: string; to: string; openInRange: number; soldInRange: number;
  current: number | null; rateNum: number | null; rateChanged: boolean;
  discNum: number | null; kind: 'weekly' | 'monthly' | 'window'; marked: number | null;
}) {
  const span = from === to ? from : `${from} → ${to}`;
  const nights = `${openInRange} open night${openInRange === 1 ? '' : 's'}`;

  if (!rateChanged && discNum == null) {
    return (
      <p className="effect quiet">
        <strong>{span}</strong> · {nights} selected
        {soldInRange > 0 && `, ${soldInRange} already booked`}. Enter a rate or a discount to see
        what would change.
      </p>
    );
  }

  return (
    <p className="effect">
      <strong>{span}</strong>
      <span className="eff-lines">
        {rateChanged && (
          <span>
            Nightly rate <b>{money(current)} → {money(rateNum)}</b> on {nights}.
          </span>
        )}
        {marked != null && (
          <span>These dates repriced to <b>{money(marked)}</b> ({discNum}% off {money(rateNum)}) on {nights}.</span>
        )}
        {discNum != null && kind !== 'window' && (
          <span>
            {kind === 'weekly' ? 'Weekly' : 'Monthly'} discount <b>{discNum}%</b> —
            {' '}a listing setting, so it applies to any qualifying stay,{' '}
            <b>not only these dates</b>.
          </span>
        )}
        {soldInRange > 0 && (
          <span className="muted">{soldInRange} booked night(s) in this range keep their price.</span>
        )}
      </span>
    </p>
  );
}

/**
 * Where this unit is published, and what a guest actually sees there.
 *
 * Two different kinds of fact, so they are shown as two. Publication
 * comes from Hostaway and is certain. The rating and the quoted price
 * come from the live listing page and can fail — and when they do, the
 * reason is printed, because a blank rating for "Airbnb blocked us" and
 * a blank rating for "this listing has no reviews" are not the same
 * thing and must not look alike.
 *
 * Only Airbnb is read today. The other channels still show their
 * publication state, since that much is free and already known.
 */
function Market({ listingId, from, days }: { listingId: string; from: string; days: number }) {
  const [channels, setChannels] = useState<ChannelStatus[] | null>(null);
  const [page, setPage] = useState<PageRead | null>(null);
  const [stored, setStored] = useState<StoredRead | null>(null);
  const [ratings, setRatings] = useState<Record<string, PlatformRating>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // A three-night midweek stay a fortnight out: a representative quote
  // rather than the whole window, which would price as a long stay and
  // pick up length-of-stay discounts that no ordinary guest sees.
  const to = addDays(from, Math.min(3, days));

  const load = () => {
    setBusy(true); setErr(''); setMsg('');
    getMarket(listingId, addDays(from, 14), addDays(from, 17))
      .then(r => {
        if (!r.ok) { setErr(r.error ?? 'Could not check.'); return; }
        setChannels(r.channels ?? []);
        setPage(r.page ?? null);
        setStored(r.stored ?? null);
        setRatings(r.ratings ?? {});
        setMsg(r.message ?? '');
      })
      .catch(e => setErr(String(e)))
      .finally(() => setBusy(false));
  };
  useEffect(load, [listingId]);

  const airbnb = channels?.find(c => c.key === 'airbnb');
  const others = channels?.filter(c => c.key !== 'airbnb') ?? [];

  // Four states, not one blank space: never published, current, going
  // stale, or never readable at all. Only the last needs anyone to do
  // something, and only it gets a warning.
  const air = channelState({
    published: !!airbnb?.live,
    liveOk: page?.rating != null || page?.nightly != null,
    observedAt: stored?.observedAt ?? null,
    problem: page?.problem ?? null
  });

  return (
    <div className="market">
      <div className="market-head">
        <span className="fact-k">Published &amp; public rating</span>
        {!busy && <button type="button" className="link" onClick={load}>refresh</button>}
      </div>

      {busy && <p className="note">Checking Airbnb…</p>}
      {err && <p className="note">{err}</p>}

      {channels && (
        <>
          <div className="chan-row">
            <span className={`chan st-${air.state}`} title={air.detail}>
              {air.mark} Airbnb
            </span>
            {air.label && <span className={`chan-tag st-${air.state}`} title={air.detail}>{air.label}</span>}
            {airbnb?.url && (
              <a className="chan-link" href={airbnb.url} target="_blank" rel="noreferrer noopener">open listing</a>
            )}

            {(page?.rating ?? stored?.rating) != null && (
              <span className="chan-metric">
                <b>{(page?.rating ?? stored!.rating)!.toFixed(2)}</b> ★
                {(page?.reviews ?? stored?.reviews) != null &&
                  <span className="note"> · {page?.reviews ?? stored!.reviews} reviews</span>}
              </span>
            )}
            {page?.nightly != null && (
              <span className="chan-metric">
                <b>${page.nightly}</b> <span className="note">shown to guests</span>
              </span>
            )}
          </div>

          {/* The guest-facing quote, with the dates it is for. A price
              without its stay is not a price: the same unit quotes
              differently for a weekend, a week and a month, and this is
              the number a guest actually decides on. */}
          {stored && (stored.total != null || stored.nightly != null) && page?.nightly == null && (
            <div className="quote">
              <div className="quote-main">
                {stored.total != null && (
                  <span><b>${Math.round(stored.total).toLocaleString('en-US')}</b> total</span>
                )}
                {stored.nightly != null && (
                  <span className="note">${stored.nightly}/night</span>
                )}
                {stored.nights != null && stored.windowStart && (
                  <span className="note">
                    {/* The stay length is not decoration. A nightly figure
                        derived from a 30-night total carries the monthly
                        discount inside it and is not comparable to a
                        weekend rate — so it never appears without the
                        stay it came from. */}
                    for the next bookable {stored.nights}-night stay, from {stored.windowStart}
                  </span>
                )}
              </div>
              {/* Hostaway's own figure is shown, never used as the
                  baseline to measure against.
                  It is biased here: listings are recycled and the
                  calendar price is what we pushed, not what a channel
                  ended up displaying. Deriving a "% above our rate" from
                  it dressed the unreliable number up as the reference
                  and the scraped one as the deviation, which is backwards.
                  The scraped price is what a guest actually pays; the
                  other is context. */}
              {stored.ourRate != null && stored.ourRate > 0 && (
                <div className="note quote-gap">
                  Hostaway shows ${stored.ourRate}/night for the same nights — its own calendar
                  figure, not what any channel displayed.
                </div>
              )}
            </div>
          )}

          {msg && <p className="note">{msg}</p>}

          {/* The long explanation only when it is the actionable state.
              A paragraph about a blocked reader beside a rating read
              yesterday is noise about a problem already worked around —
              and a warning shown every day teaches people to skip it. */}
          {air.state === 'blocked' && (
            <p className="note market-problem">{air.detail}</p>
          )}

          {/* Two separate facts, never merged into one dot.
              Publication comes from Hostaway and is certain. The rating
              comes from scraping the live page, and a platform only
              reads as confirmed once we have actually read one —
              Hostaway's own rating is never used, because listings get
              recycled here and it carries reviews across that reuse,
              describing a different property. */}
          <div className="chan-others">
            {others.map(c => {
              const r = ratings[c.key];
              const rated = r?.rating != null;
              return (
                <span key={c.key} className="chan-other">
                  <span className={rated ? 'chan live' : 'chan off'}>
                    {rated ? '●' : '○'} {c.label}
                  </span>
                  <span className="note">{c.live ? 'listed' : 'not listed'}</span>
                  {rated
                    ? <b>{r!.rating!.toFixed(2)} ★{r!.reviews != null && (
                        <span className="note"> · {r!.reviews}</span>)}</b>
                    : <span className="note">· rating not scraped yet</span>}
                </span>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
