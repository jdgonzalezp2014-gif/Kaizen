/**
 * Finance → Analytics (owner, 2026-11-23): an executive summary of a range — a Sunday-to-Saturday week by default,
 * any dates on request — and, under it, the four things it is made of, each opening to its detail: what was spent
 * (by kind; cleaning → the cleans and who did them), how full the houses were night by night (a night → who was in),
 * what came in net, and what the guests wrote. Every figure is set beside the range just before it.
 *
 * Left for later on purpose (finance.md, open items): the monthly view with rent and utilities prorated per unit, and
 * profit per unit (income − spend) to see which units lose money.
 */
import { useEffect, useMemo, useState } from 'react';
import './analytics.css';
import { getAnalytics, type AnalyticsData } from '../api.ts';
import { Hint } from '../components/Hint.tsx';
import { Icon } from '../components/Icon.tsx';
import { Loading } from '../components/Loading.tsx';
import { param, setParams } from '../components/useUrlState.ts';
import { money } from '../lib/format.ts';
import { addDays, daysBetween, todayIn } from '../lib/dates.ts';
import {
  CHANNEL, cleaningSummary, isLow, occupancyByDay, reviewSummary, slices, stars, weekIncome, weekOccupancy, weekOf,
  type DayOccupancy, type Stay
} from '../lib/analytics.ts';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const md = (d: string) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
const dow = (d: string) => DOW[new Date(`${d}T12:00:00Z`).getUTCDay()]!;
const span = (a: string, b: string) => a === b ? md(a) : `${md(a)} – ${md(b)}`;
const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const ISO = /^\d{4}-\d{2}-\d{2}$/;

type Preset = 'last' | 'this' | '30' | 'custom';
const PRESETS: { id: Exclude<Preset, 'custom'>; label: string }[] = [
  { id: 'last', label: 'Last week' }, { id: 'this', label: 'This week' }, { id: '30', label: 'Last 30 days' }];

function resolve(id: Exclude<Preset, 'custom'>, today: string) {
  if (id === 'this') return weekOf(today);
  if (id === '30') return { from: addDays(today, -29), to: today };
  return weekOf(addDays(today, -7));
}

/** The change against the previous range: an arrow and a word, never colour alone. Up is not "good" for spend. */
function Delta({ now, before, kind = 'money' }: { now: number | null; before: number | null; kind?: 'money' | 'pts' | 'stars' }) {
  if (now == null || before == null) return <span className="an-delta">no comparison</span>;
  const d = now - before;
  if (Math.abs(d) < (kind === 'money' ? 0.5 : 0.005)) return <span className="an-delta">same as before</span>;
  const arrow = d > 0 ? '↑' : '↓';
  const text = kind === 'money' ? (before ? `${Math.round(Math.abs(d) / before * 100)}%` : money(Math.abs(d)))
    : kind === 'pts' ? `${Math.round(Math.abs(d) * 100)} pts` : Math.abs(d).toFixed(2);
  return <span className="an-delta"><span aria-hidden>{arrow}</span> {text} vs before</span>;
}

/** A horizontal share bar: one segment per slice, ink at falling strength — the legend carries the names. */
function ShareBar({ parts }: { parts: { key: string; share: number }[] }) {
  return (
    <div className="an-share" role="img" aria-label={parts.map(p => `${p.key} ${pct(p.share)}`).join(', ')}>
      {parts.map((p, i) => <span key={p.key} style={{ width: `${p.share * 100}%`, opacity: Math.max(0.18, 0.9 - i * 0.16) }} />)}
    </div>
  );
}

function Bars({ rows, value = r => money(r.total) }: { rows: { key: string; total: number; count: number; share: number }[];
  value?: (r: { key: string; total: number; count: number; share: number }) => string }) {
  const max = Math.max(...rows.map(r => r.total), 0);
  return (
    <ul className="an-bars">
      {rows.map(r => (
        <li key={r.key}>
          <span className="an-bars-name" title={r.key}>{r.key}</span>
          <span className="an-bars-track"><span style={{ width: max ? `${(r.total / max) * 100}%` : 0 }} /></span>
          <span className="an-bars-val">{value(r)}</span>
        </li>
      ))}
    </ul>
  );
}

/** A section of the summary: its headline figure on the closed card, its detail once opened. */
function Panel({ id, open, onOpen, icon, title, hint, figure, sub, subOpen = true, children }: {
  id: string; open: string | null; onOpen: (id: string | null) => void; icon: string; title: string; hint: React.ReactNode;
  figure: React.ReactNode; sub: React.ReactNode;
  /** Keep the glance once open — false when the detail draws the same thing (Occupancy's nights). */
  subOpen?: boolean; children: React.ReactNode;
}) {
  const isOpen = open === id;
  return (
    <section className={`card an-panel${isOpen ? ' open' : ''}`}>
      <div className="an-panel-top">
        <button className="an-panel-head" aria-expanded={isOpen} onClick={() => onOpen(isOpen ? null : id)}>
          <Icon n={icon} />
          <span className="an-panel-title">{title}</span>
          <span className="an-panel-fig">{figure}</span>
          <span className="an-chev" aria-hidden>{isOpen ? '−' : '+'}</span>
        </button>
        <Hint>{hint}</Hint>
      </div>
      {(!isOpen || subOpen) && <div className="an-panel-sub">{sub}</div>}
      {isOpen && <div className="an-panel-body">{children}</div>}
    </section>
  );
}

export function Analytics() {
  const today = todayIn('America/New_York');
  const qf = param('from'), qt = param('to');
  const initial = qf && qt && ISO.test(qf) && ISO.test(qt) ? { from: qf, to: qt } : resolve('last', today);
  const [range, setRange] = useState(initial);
  const [preset, setPreset] = useState<Preset>(qf ? 'custom' : 'last');
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const pick = (r: { from: string; to: string }, p: Preset) => {
    if (r.to < r.from) r = { from: r.to, to: r.from };
    setRange(r); setPreset(p);
    setParams(p === 'last' ? { from: null, to: null } : { from: r.from, to: r.to }, { replace: true });
  };
  const len = daysBetween(range.from, range.to) + 1;
  const step = (n: number) => pick({ from: addDays(range.from, n * len), to: addDays(range.to, n * len) }, 'custom');

  useEffect(() => {
    let live = true;
    setData(null); setError(null);
    getAnalytics(range.from, range.to).then(d => { if (live) setData(d); })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [range.from, range.to]);

  return (
    <section className="an">
      <div className="an-top">
        <div>
          <h1>Analytics <Hint>
            <p>An executive summary of the dates on top — by default last week, Sunday to Saturday — set against the same
              number of days just before. Pick another week with ‹ ›, a preset, or any two dates.</p>
            <p>Open a card for its detail: <b>Spent</b> by kind (Cleaning → the cleans and who did them), <b>Occupancy</b> night
              by night (a night → who was in), <b>Net income</b> by unit, <b>Reviews</b> with what guests wrote.</p>
            <p>Not yet: rent and utilities (monthly, prorated per unit) and profit per unit — the monthly view, later.</p>
          </Hint></h1>
          <p className="sub">{span(range.from, range.to)}, {range.to.slice(0, 4)}
            {data && <> · vs {span(data.previous.from, data.previous.to)}</>}</p>
        </div>
        <div className="an-range" role="group" aria-label="Dates">
          <div className="an-presets">
            {PRESETS.map(p => (
              <button key={p.id} className={`chip${preset === p.id ? ' active' : ''}`} onClick={() => pick(resolve(p.id, today), p.id)}>{p.label}</button>
            ))}
          </div>
          <div className="an-dates">
            <button className="ghost small" aria-label="Previous range" onClick={() => step(-1)}>‹</button>
            <input type="date" value={range.from} max={range.to} aria-label="From"
                   onChange={e => ISO.test(e.target.value) && pick({ from: e.target.value, to: range.to }, 'custom')} />
            <span aria-hidden>→</span>
            <input type="date" value={range.to} min={range.from} aria-label="To"
                   onChange={e => ISO.test(e.target.value) && pick({ from: range.from, to: e.target.value }, 'custom')} />
            <button className="ghost small" aria-label="Next range" onClick={() => step(1)} disabled={range.to >= today}>›</button>
          </div>
        </div>
      </div>

      {error && <p className="banner error">Analytics could not load: {error}</p>}
      {!data && !error && <Loading estimateMs={len > 14 ? 5000 : 2500} stages={['Reading Hostaway stays', 'Reading costs and cleans', 'Reading reviews']} />}
      {data && <Report data={data} open={open} onOpen={setOpen} />}
    </section>
  );
}

function Report({ data, open, onOpen }: { data: AnalyticsData; open: string | null; onOpen: (id: string | null) => void }) {
  const { from, to } = data.range, prev = data.previous;
  const name = useMemo(() => new Map(data.units.map(u => [u.id, u.name])), [data.units]);
  const unitName = (id: string | null) => (id ? name.get(id) ?? `#${id}` : 'Shared');
  const liveIds = useMemo(() => data.units.filter(u => u.live).map(u => u.id), [data.units]);
  const inR = <T extends { on: string }>(xs: T[], a: string, b: string) => xs.filter(x => x.on >= a && x.on <= b);

  const m = useMemo(() => {
    const stays = data.stays as Stay[];
    const build = (a: string, b: string) => {
      const costs = inR(data.costs, a, b);
      const cleans = inR(data.cleans, a, b);
      const days = occupancyByDay(stays, liveIds, a, b);
      const income = weekIncome(stays, a, b);
      const other = inR(data.income, a, b).reduce((s, r) => s + r.amount, 0);
      const reviews = data.reviews.filter(r => r.submittedAt >= a && r.submittedAt <= b);
      return {
        costs, cleans, days, income, other, reviews,
        spent: costs.reduce((s, c) => s + c.amount, 0),
        occ: weekOccupancy(days),
        cats: slices(costs, c => c.category, c => c.amount),
        clean: cleaningSummary(cleans),
        rev: reviewSummary(reviews, a === from ? data.departures : [])
      };
    };
    return { now: build(from, to), before: build(prev.from, prev.to) };
  }, [data, liveIds]);

  const { now, before } = m;
  const waiting = data.pending.reduce((a, p) => a + p.amount, 0);
  const netIn = now.income.revenue + now.other;
  const busiest = [...now.days].sort((a, b) => b.occupied - a.occupied)[0];
  const top = now.cats[0];
  const topCleaner = now.clean.byCleaner.find(c => c.key !== 'Unassigned');

  // The executive summary in words: what someone reads first, built only from the figures below it.
  // The one thing to know first (owner, 2026-11-23: "give me the insight at once"), then the rest behind "Read more".
  // Rules, not a model: the first that applies wins — money waiting on someone, guests unhappy, then the biggest move.
  const change = (a: number, b: number) => (b ? (a - b) / b : null);
  const spentCh = change(now.spent, before.spent), incomeCh = change(netIn, before.income.revenue + before.other);
  const occCh = now.occ != null && before.occ != null ? now.occ - before.occ : null;
  const moves = [
    spentCh != null && Math.abs(spentCh) >= 0.15 ? { size: Math.abs(spentCh), text: `Spent ${spentCh > 0 ? 'rose' : 'fell'} ${pct(Math.abs(spentCh))} against the days before (${money(now.spent)} vs ${money(before.spent)})${top ? `; ${top.key} is ${pct(top.share)} of it` : ''}.` } : null,
    incomeCh != null && Math.abs(incomeCh) >= 0.1 ? { size: Math.abs(incomeCh), text: `Net income ${incomeCh > 0 ? 'rose' : 'fell'} ${pct(Math.abs(incomeCh))} (${money(netIn)}).` } : null,
    occCh != null && Math.abs(occCh) >= 0.05 ? { size: Math.abs(occCh) * 2, text: `Occupancy ${occCh > 0 ? 'rose' : 'fell'} ${Math.round(Math.abs(occCh) * 100)} points, to ${pct(now.occ)}.` } : null
  ].filter((x): x is { size: number; text: string } => !!x).sort((a, b) => b.size - a.size);
  const insight = data.pending.length
    ? `${money(waiting)} in field charges is waiting for someone to approve it (${data.pending.length}, the oldest from ${md(data.pending[0]!.on)}) — it is not in Spent until then.`
    : now.rev.low ? `${now.rev.low} review${now.rev.low === 1 ? '' : 's'} to read — under 5 ★ or a weak category.`
    : moves[0]?.text ?? `A steady stretch: ${money(netIn)} net income, ${money(now.spent)} spent, ${pct(now.occ)} occupancy.`;
  const [more, setMore] = useState(false);

  const lines = [
    now.spent > 0 && top ? `Spent ${money(now.spent)}; ${top.key} is ${pct(top.share)} of it` +
      (top.key === 'Cleaning' && now.clean.count ? ` — ${now.clean.count} cleans${topCleaner ? `, ${topCleaner.key} the most (${topCleaner.count}, ${money(topCleaner.total)})` : ''}.` : '.')
      : now.clean.count ? `No spend in Costs yet — ${now.clean.count} cleans (${money(now.clean.total)}) are not in Costs.` : 'Nothing spent was recorded in these dates.',
    `Occupancy ${pct(now.occ)}${busiest ? `; fullest night ${dow(busiest.day)} ${md(busiest.day)} (${busiest.occupied} of ${busiest.units})` : ''}.`,
    `Net income ${money(netIn)} from ${now.income.nights} nights${now.other ? `, ${money(now.other)} of it claims, upsells and portal sales` : ''}.`,
    now.rev.count
      ? `${now.rev.count} review${now.rev.count === 1 ? '' : 's'}, ${now.rev.stars?.toFixed(2) ?? '—'} ★${now.rev.low ? ` — ${now.rev.low} to read` : ', none below 5 ★'}.`
      : 'No reviews were written in these dates.',
    ...moves.map(m => m.text)
  ].filter(l => l !== insight);

  return (
    <>
      <section className="card an-exec" aria-label="Executive summary">
        <dl className="an-kpis">
          <div><dt>Net income</dt><dd>{money(netIn)}</dd><Delta now={netIn} before={before.income.revenue + before.other} /></div>
          <div><dt>Spent</dt><dd>{money(now.spent)}</dd><Delta now={now.spent} before={before.spent} /></div>
          <div><dt>Occupancy</dt><dd>{pct(now.occ)}</dd><Delta now={now.occ} before={before.occ} kind="pts" /></div>
          <div><dt>Reviews</dt><dd>{now.rev.stars?.toFixed(2) ?? '—'} <small>★ · {now.rev.count}</small></dd>
            <Delta now={now.rev.stars} before={before.rev.stars} kind="stars" /></div>
        </dl>
      </section>
      {/* Owner, 2026-11-23: the week in words sits apart from the figures — small, grey, plain sentences. */}
      <div className="an-notes">
        <p className="an-insight">{insight}{' '}
          <button className="link an-more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Less' : 'Read more'}</button></p>
        {more && <p>{lines.join(' ')} <span className="an-limit">One-off spend only — rent and utilities are not in these figures yet.</span></p>}
      </div>

      <div className="an-grid">
        <Panel id="spent" open={open} onOpen={onOpen} icon="receipt" title="Spent" figure={money(now.spent)}
               hint={<p>Every one-off line in Costs dated in the range (cleans, cleaners' extras, repairs, purchases, field
                 expenses, Stripe's fee on portal sales). Open a kind for its lines; Cleaning shows the cleans and who did them.
                 Monthly lines (rent, utilities) are left out. Charges a handyman or cleaner sent that nobody has approved yet are
                 listed under "Waiting approval" — any date, never in the total — approve them in Vendor portal → Handymen.</p>}
               sub={<>
                 {now.cats.length ? <><ShareBar parts={now.cats} />
                   <ul className="an-legend">{now.cats.slice(0, 5).map(c => <li key={c.key}>{c.key} <b>{pct(c.share)}</b></li>)}</ul></>
                   : <span className="muted">{now.clean.count ? `▲ ${now.clean.count} cleans not in Costs yet — open for who cleaned.` : 'Nothing recorded.'}</span>}
                 {data.pending.length > 0 && <p className="an-waiting">▲ {money(waiting)} waiting for approval · {data.pending.length} charge{data.pending.length === 1 ? '' : 's'} — not in the total</p>}
               </>}>
          <SpentDetail now={now} pending={data.pending} unitName={unitName} />
        </Panel>

        <Panel id="occ" open={open} onOpen={onOpen} icon="bed" title="Occupancy" figure={pct(now.occ)} subOpen={false}
               hint={<p>Nights with a guest over nights available, on the {liveIds.length} listings taking bookings (active, not
                 parked). A blocked night counts as empty here. Open it and pick a night to see who was in and what was empty.</p>}
               sub={<DayColumns days={now.days} />}>
          <OccDetail days={now.days} liveIds={liveIds} unitName={unitName} />
        </Panel>

        <Panel id="income" open={open} onOpen={onOpen} icon="dollar" title="Net income" figure={money(netIn)}
               hint={<p>What reaches the bank from the nights inside the range — taxes and the channel's cut out, the cleaning
                 fee on checkout day (the same rule as Revenue) — plus claims, upsells and portal sales received.</p>}
               sub={<span className="muted">{now.income.nights} nights · ADR {now.income.nights ? money(now.income.revenue / now.income.nights) : '—'}</span>}>
          <IncomeDetail now={now} unitName={unitName} />
        </Panel>

        <Panel id="reviews" open={open} onOpen={onOpen} icon="message" title="Reviews"
               figure={<>{now.rev.stars?.toFixed(2) ?? '—'} <small>★</small></>}
               hint={<p>Guest reviews written in the range, read from Hostaway per stay (out of 10 there, shown as stars).
                 "To read": under 5 ★, or any category under 4 ★. Response rate = guests who checked out in the range and have
                 already written. Airbnb shows a review once both sides wrote or 14 days passed.</p>}
               sub={<span className="muted">{now.rev.count} written · {now.rev.asked ? `${now.rev.wrote} of ${now.rev.asked} who left` : 'no checkouts'}{now.rev.low ? ` · ${now.rev.low} to read` : ''}</span>}>
          {data.reviewError && <p className="banner warn">▲ Hostaway did not return reviews: {data.reviewError}</p>}
          <ReviewDetail reviews={now.reviews} rev={now.rev} unitName={unitName} />
        </Panel>
      </div>
    </>
  );
}

type Built = {
  costs: AnalyticsData['costs']; cleans: AnalyticsData['cleans']; days: DayOccupancy[];
  income: ReturnType<typeof weekIncome>; other: number; reviews: AnalyticsData['reviews'];
  spent: number; cats: ReturnType<typeof slices>; clean: ReturnType<typeof cleaningSummary>; rev: ReturnType<typeof reviewSummary>;
};

function SpentDetail({ now, pending, unitName }: { now: Built; pending: AnalyticsData['pending']; unitName: (id: string | null) => string }) {
  // The cleans are read from the record itself, so "who cleaned" answers even when Costs is behind.
  const cats = now.clean.count && !now.cats.some(c => c.key === 'Cleaning')
    ? [...now.cats, { key: 'Cleaning', total: 0, count: 0, share: 0 }] : now.cats;
  const [cat, setCat] = useState<string | null>(cats[0]?.key ?? null);
  const WAIT = 'Waiting approval';
  const waitTotal = pending.reduce((a, p) => a + p.amount, 0);
  const lines = now.costs.filter(c => c.category === cat).sort((a, b) => b.amount - a.amount);
  const byUnit = slices(lines, c => unitName(c.unitId), c => c.amount);
  return (
    <>
      <div className="an-tabs" role="tablist">
        {cats.map(c => (
          <button key={c.key} role="tab" aria-selected={cat === c.key} className={`chip${cat === c.key ? ' active' : ''}`} onClick={() => setCat(c.key)}>
            {c.key} · {money(c.total)}
          </button>
        ))}
        {pending.length > 0 && (
          <button role="tab" aria-selected={cat === WAIT} className={`chip${cat === WAIT ? ' active' : ''}`} onClick={() => setCat(WAIT)}>
            ▲ {WAIT} · {money(waitTotal)}
          </button>
        )}
      </div>
      {cat === WAIT && (
        <>
          <p className="note">Charges sent from the field that nobody approved yet — not in Costs, not in the total. Any date.</p>
          <table className="an-table">
            <thead><tr><th>Sent</th><th>Who</th><th>Unit</th><th>What</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {pending.map(p => (
                <tr key={p.id}><td>{dow(p.on)} {md(p.on)}</td><td>{p.who} <span className="muted">· {p.kind}</span></td>
                  <td>{unitName(p.unitId)}</td><td>{p.description}{p.todoId ? <span className="muted"> · to-do #{p.todoId}</span> : null}</td>
                  <td className="num">{money(p.amount)}</td></tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {cat === 'Cleaning' && (
        <>
          <dl className="an-mini">
            <div><dt>Cleans</dt><dd>{now.clean.count}</dd></div>
            <div><dt>Deep</dt><dd>{now.clean.deep}</dd></div>
            <div><dt>Avg per clean</dt><dd>{now.clean.count - now.clean.unpriced ? money(now.clean.total / (now.clean.count - now.clean.unpriced)) : '—'}</dd></div>
            {now.clean.unpriced > 0 && <div><dt>Not priced</dt><dd>▲ {now.clean.unpriced}</dd></div>}
          </dl>
          {now.clean.total > 0 && Math.abs(now.clean.total - (now.cats.find(c => c.key === 'Cleaning')?.total ?? 0)) > 0.5 && (
            <p className="banner warn">▲ The cleans add up to {money(now.clean.total)}; Costs has {money(now.cats.find(c => c.key === 'Cleaning')?.total ?? 0)} for
              Cleaning (extras included). Costs catches up within the hour.</p>
          )}
          <h3 className="an-h">By cleaner</h3>
          <Bars rows={now.clean.byCleaner} value={r => `${r.count} · ${money(r.total)}`} />
        </>
      )}
      {lines.length > 0 && <>
      <h3 className="an-h">By unit</h3>
      <Bars rows={byUnit.slice(0, 8)} />
      <h3 className="an-h">Lines</h3>
      <table className="an-table">
        <thead><tr><th>Day</th><th>Unit</th><th>What</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {lines.slice(0, 60).map(l => (
            <tr key={l.id}><td>{dow(l.on)} {md(l.on)}</td><td>{unitName(l.unitId)}</td>
              <td>{l.label ?? l.category}{l.cleaner ? <span className="muted"> · {l.cleaner}</span> : null}</td>
              <td className="num">{money(l.amount)}</td></tr>
          ))}
        </tbody>
      </table>
      </>}
      {!cats.length && <p className="note">Nothing was spent in these dates.</p>}
      {lines.length > 60 && <p className="note">Showing the 60 largest of {lines.length} — Costs → One-off has them all.</p>}
    </>
  );
}

function DayColumns({ days, sel, onSel }: { days: DayOccupancy[]; sel?: string | null; onSel?: (d: string) => void }) {
  return (
    <div className={`an-days${days.length > 14 ? ' dense' : ''}`}>
      {days.map(d => {
        const body = <>
          <span className="an-day-col"><span style={{ height: `${(d.rate ?? 0) * 100}%` }} /></span>
          <span className="an-day-pct">{pct(d.rate)}</span>
          <span className="an-day-lbl">{days.length > 14 ? Number(d.day.slice(8)) : dow(d.day)}</span>
        </>;
        return onSel
          ? <button key={d.day} className={`an-day${sel === d.day ? ' on' : ''}`} aria-pressed={sel === d.day}
                    aria-label={`${dow(d.day)} ${md(d.day)}: ${d.occupied} of ${d.units}`} onClick={() => onSel(d.day)}>{body}</button>
          : <span key={d.day} className="an-day" title={`${dow(d.day)} ${md(d.day)}: ${d.occupied} of ${d.units}`}>{body}</span>;
      })}
    </div>
  );
}

function OccDetail({ days, liveIds, unitName }: { days: DayOccupancy[]; liveIds: string[]; unitName: (id: string | null) => string }) {
  const [sel, setSel] = useState<string | null>(days[0]?.day ?? null);
  const d = days.find(x => x.day === sel);
  const inIds = new Set(d?.stays.map(s => s.listingId));
  const empty = liveIds.filter(id => !inIds.has(id)).map(unitName).sort();
  return (
    <>
      <DayColumns days={days} sel={sel} onSel={setSel} />
      {d && (
        <>
          <h3 className="an-h">{dow(d.day)} {md(d.day)} · {d.occupied} of {d.units} · {d.arrivals} in · {d.departures} out</h3>
          <table className="an-table">
            <thead><tr><th>Unit</th><th>Guest</th><th>Stay</th></tr></thead>
            <tbody>
              {[...d.stays].sort((a, b) => unitName(a.listingId).localeCompare(unitName(b.listingId))).map(s => (
                <tr key={s.reservationId}><td>{unitName(s.listingId)}</td><td>{s.guest ?? '—'}</td>
                  <td>{span(s.arrival, addDays(s.departure, -1))}{s.arrival === d.day ? <span className="muted"> · arrives</span> : null}</td></tr>
              ))}
            </tbody>
          </table>
          {empty.length > 0 && <p className="an-empty"><b>Empty ({empty.length}):</b> {empty.join(', ')}</p>}
        </>
      )}
    </>
  );
}

function IncomeDetail({ now, unitName }: { now: Built; unitName: (id: string | null) => string }) {
  const rows = now.income.units.map(u => ({ key: unitName(u.listingId), total: u.revenue, count: u.nights, share: 0 }));
  return (
    <>
      <dl className="an-mini">
        <div><dt>From stays</dt><dd>{money(now.income.revenue)}</dd></div>
        <div><dt>Claims, upsells, portal</dt><dd>{money(now.other)}</dd></div>
        <div><dt>Nights sold</dt><dd>{now.income.nights}</dd></div>
      </dl>
      <h3 className="an-h">By unit</h3>
      <Bars rows={rows} value={r => `${money(r.total)} · ${r.count} n`} />
    </>
  );
}

function ReviewDetail({ reviews, rev, unitName }: { reviews: AnalyticsData['reviews']; rev: ReturnType<typeof reviewSummary>; unitName: (id: string | null) => string }) {
  const sorted = [...reviews].sort((a, b) => Number(isLow(b)) - Number(isLow(a)) || (a.rating ?? 11) - (b.rating ?? 11));
  const CAT: Record<string, string> = { checkin: 'Check-in', cleanliness: 'Cleanliness', communication: 'Communication', accuracy: 'Accuracy', location: 'Location', value: 'Value' };
  return (
    <>
      {rev.categories.length > 0 && (
        <dl className="an-mini">
          {rev.categories.map(c => <div key={c.category}><dt>{CAT[c.category] ?? c.category}</dt><dd>{c.stars.toFixed(2)} <small>★</small></dd></div>)}
        </dl>
      )}
      {rev.byChannel.length > 0 && <p className="muted an-small">{rev.byChannel.map(c => `${c.key} ${c.count}`).join(' · ')}</p>}
      <ul className="an-reviews">
        {sorted.map(r => (
          <li key={r.id} className={isLow(r) ? 'low' : ''}>
            <div className="an-rev-head">
              <b>{r.rating == null ? 'No rating' : `${stars(r.rating)!.toFixed(1)} ★`}</b>
              {isLow(r) && <span className="an-tag">▲ to read</span>}
              <span>{unitName(r.listingId)}</span>
              <span className="muted">{r.guest ?? 'Guest'} · {CHANNEL[r.channelId] ?? 'Other'} · {md(r.submittedAt)}</span>
            </div>
            {r.publicReview && <p>{r.publicReview}</p>}
            {r.privateFeedback && <p className="an-private"><Icon n="lock" /> {r.privateFeedback}</p>}
            {r.categories.some(c => c.rating < 10) && (
              <p className="muted an-small">{r.categories.filter(c => c.rating < 10).map(c => `${CAT[c.category] ?? c.category} ${stars(c.rating)}`).join(' · ')}</p>
            )}
          </li>
        ))}
      </ul>
      {!reviews.length && <p className="note">No reviews were written in these dates.</p>}
    </>
  );
}
