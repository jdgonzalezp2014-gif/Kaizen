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
import { useEffect, useState } from 'react';
import {
  getForward, applyPrice, askSuggestion,
  type PriceResult, type Suggestion
} from '../api.ts';
import {
  rank, suspectedDuplicates,
  type RankedUnit, type ForwardUnit, type ForwardState
} from '../lib/forward.ts';
import {
  findGaps, signals, verdict, median, portfolioAskRatio,
  type Signal, type Verdict
} from '../lib/revenue.ts';
import { money, pct, points } from '../lib/format.ts';
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
      {loading && !units && <p className="note">Reading calendars from Hostaway…</p>}

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

interface Read { v: Verdict; rest: Signal[]; orphanNights: number; gaps: ReturnType<typeof findGaps> }

function diagnose(u: RankedUnit, portfolioAdr: number | null,
                  askRatio: number | null, asOf: string): Read {
  const gaps = findGaps(u.days);
  const orphans = gaps.filter(g => g.orphaned);
  const input = {
    occupancy: u.occupancy, nightsOpen: u.nightsOpen, pickup7: u.pickup7,
    leadTime: u.leadTime, adr: u.adr, openAsk: u.openAsk, lastBookedOn: u.lastBookedOn,
    orphanNights: orphans.reduce((a, g) => a + g.nights, 0),
    orphanRuns: orphans.length,
    portfolioAdr: portfolioAdr == null ? null : Math.round(portfolioAdr),
    portfolioAskRatio: askRatio,
    today: asOf
  };
  const v = verdict(input);
  // The headline already carries its own evidence; repeating it under
  // itself is noise, so the signal that produced it is filtered out.
  const rest = signals(input).filter(s => !v.reason.includes(s.text.slice(0, 24)));
  return { v, rest, orphanNights: input.orphanNights, gaps };
}

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

  return (
    // The tone rides on the wrapper as well as the light, so an opened
    // row can carry its own colour on the edge that frames it.
    <div className={`urow tone-${tone}${expanded ? ' open' : ''}`}>
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

      <dl className="facts-grid">
        <Fact k="RevPAN" v={money(u.revpan)} onExplain={onExplain} />
        <Fact k="ADR achieved" v={money(u.adr)} onExplain={onExplain} />
        <Fact k="Asking, open nights" v={u.nightsOpen ? money(u.openAsk) : '—'} />
        <Fact k="Booked last 7d" v={`${u.pickup7} nights`} onExplain={onExplain} />
        <Fact k="Books" v={u.leadTime == null ? '—' : `${u.leadTime} days out`} onExplain={onExplain} />
        <Fact k="On the books" v={money(u.onBooks)} />
        <Fact k="Cleaning in / out"
              v={`${money(u.cleaningFeeCharged)} / ${money(u.cleaningCost)}`} onExplain={onExplain} />
        {/* A visible hole, not a hidden one: the comp set is the biggest
            missing input here, and omitting the row would let the panel
            read as though the picture were complete. */}
        <Fact k="Market rate" v="not connected" muted />
      </dl>

      {!dead && (
        <>
          <div className="occline">
            <span className="ubar big">
              <span className={`ubar-fill tone-${read.v.tone}`} style={{ width: `${Math.min(100, occ * 100)}%` }} />
              {medianOcc != null && (
                <span className="ubar-median" style={{ left: `${Math.min(100, medianOcc * 100)}%` }} />
              )}
            </span>
            <span className="note">
              <strong>{pct(u.occupancy)}</strong> of {u.nightsOpen + u.nightsSold} sellable nights booked
              {medianOcc != null && <> · {points((occ - medianOcc) * 100)} pts vs portfolio median {pct(medianOcc)}</>}
            </span>
          </div>

          <PriceWorkspace u={u} gaps={read.gaps} asOf={asOf} days={days} onChanged={onChanged} />
        </>
      )}
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
function PriceWorkspace({ u, gaps, asOf, days, onChanged }: {
  u: RankedUnit; gaps: ReturnType<typeof findGaps>;
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
