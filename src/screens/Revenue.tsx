import { useEffect, useMemo, useState } from 'react';
import { RangePicker } from '../components/RangePicker.tsx';
import { NetOverTime } from '../components/charts.tsx';
import { resolvePreset, granularityFor, type PresetId } from '../lib/ranges.ts';
import { portfolioSeries, scoreboard, type Dataset } from '../lib/series.ts';
import type { Period } from '../lib/finance.ts';
import { byChannel, byCategory } from '../lib/breakdown.ts';
import {
  Filters, filterUnits, EMPTY_FILTER, type FilterState, type Light
} from '../components/Filters.tsx';
import { money as fmtMoney, pct } from '../lib/format.ts';

interface Portfolio {
  meta: { targets: { perUnitNet: number; activeUnits: number; portfolioNet: number; basis: string };
          occFloorPct?: number;
          window: { from: string; to: string }; tookMs: number };
  listings: { listingId: string; name: string; active: boolean; city?: string; state?: string }[];
  reservations: Dataset['reservations'];
  costs: Dataset['costs'];
}

const money = fmtMoney;

export function Revenue() {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState('');
  const [preset, setPreset] = useState<PresetId | 'custom'>('mtd');
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [openUnit, setOpenUnit] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>(() => resolvePreset('mtd')!);

  useEffect(() => {
    fetch('/api/portfolio')
      .then(r => r.json() as Promise<Portfolio & { ok?: boolean; message?: string; error?: string }>)
      .then(j => j.ok === false ? setError(j.message ?? j.error ?? 'Request failed') : setData(j))
      .catch(e => setError(String(e)));
  }, []);

  // Everything below recomputes in the browser, so dragging the range
  // never touches the network. That is the whole reason the API serves
  // period-free rows.
  const view = useMemo(() => {
    if (!data) return null;
    const set: Dataset = {
      reservations: data.reservations,
      costs: data.costs,
      listingIds: data.listings.filter(l => l.active).map(l => l.listingId)
    };
    const names = new Map(data.listings.map(l => [l.listingId, l.name]));
    const places = new Map(data.listings.map(l => [l.listingId, { city: l.city, state: l.state }]));
    const board = scoreboard(set, period, data.meta.targets.perUnitNet);
    return {
      board,
      units: board.units.map(u => ({
        ...u,
        name: names.get(u.listingId) ?? u.listingId,
        city: places.get(u.listingId)?.city, state: places.get(u.listingId)?.state
      })),
      series: portfolioSeries(set, period),
      // Both breakdowns run the same window arithmetic as the headline
      // figures, so their parts add up to the totals above them.
      channels: byChannel(set.reservations, period),
      categories: byCategory(set.costs, set.listingIds, period),
      thin: board.units.filter(u =>
        u.occupancy != null && u.occupancy < (data.meta.occFloorPct ?? 60) / 100).length,
      granularity: granularityFor(period),
      anyCosts: data.costs.length > 0,
      counts: countLights(board.units.map(u => ({
        ...u, name: names.get(u.listingId) ?? u.listingId })))
    };
  }, [data, period]);

  if (error) return <div className="card"><div className="banner error">{error}</div></div>;
  if (!view || !data) return <div className="card"><p className="note">Loading…</p></div>;

  const { board } = view;
  const delta = board.portfolio.net - board.portfolioTarget;
  const shownUnits = filterUnits(view.units, filter, lightOfUnit);

  return (
    <>
      <RangePicker period={period} preset={preset}
                   onChange={(p, id) => { setPeriod(p); setPreset(id); }} />

      {!view.anyCosts && (
        // Stating the limitation on screen, not only in a comment. With no
        // costs recorded, "net" is revenue — and a green board that means
        // "we have not entered our expenses" is worse than no board.
        <div className="banner warn">
          No costs recorded yet, so net is revenue only. Add them in Settings → Import,
          or the profit figures below overstate every unit.
        </div>
      )}

      <div className="card hero">
        <div>
          <p className="hero-label">Portfolio net · {period.from} → {period.to}</p>
          <p className="hero-value">{money(board.portfolio.net)}</p>
          <p className="note">
            {delta >= 0 ? 'Above' : 'Below'} target by {money(Math.abs(delta))} ·
            {' '}target {money(board.portfolioTarget)} ({data.meta.targets.basis},
            {' '}scaled ×{board.scale.toFixed(2)} for this period)
          </p>
        </div>
        <dl className="stats">
          <div><dt>Revenue</dt><dd>{money(board.portfolio.revenue)}</dd></div>
          <div><dt>Costs</dt><dd>{money(board.portfolio.costs.total)}</dd></div>
          <div><dt>Occupancy</dt><dd>{board.portfolio.occupancy == null ? '—'
            : `${Math.round(board.portfolio.occupancy * 100)}%`}</dd></div>
          <div><dt>ADR</dt><dd>{money(board.portfolio.adr)}</dd></div>
          <div><dt>RevPAN</dt><dd>{money(board.portfolio.revpan)}</dd></div>
          <div><dt>Below floor</dt><dd>{view.thin} of {view.units.length}</dd></div>
        </dl>
      </div>

      <div className="card">
        <h2>By unit</h2>
        <p className="note">
          Worst first — that is what needs a decision. Occupancy sits beside the money on
          purpose: a unit can clear its target on a half-empty calendar, and that is a price
          that found few takers rather than a unit that is working. Click a unit for its
          own revenue, costs and channels.
        </p>
        <Filters rows={view.units} value={filter} onChange={setFilter} counts={view.counts} />
        <div className="ulist">
          {shownUnits.map(u => (
            <RevenueRow key={u.listingId} u={u} period={period} data={data}
                        expanded={openUnit === u.listingId}
                        onToggle={() => setOpenUnit(openUnit === u.listingId ? null : u.listingId)} />
          ))}
          {shownUnits.length === 0 && <p className="note" style={{ padding: 12 }}>No unit matches those filters.</p>}
        </div>
      </div>

      <div className="card">
        <Breakdown
          title="Where the revenue came from"
          empty="No bookings in this window."
          note="Room revenue only — the cleaning fee a guest pays is counted on the checkout date."
          total={board.portfolio.revenue}
          rows={view.channels.map(c => ({
            key: c.channel, label: c.channel, value: c.revenue, share: c.share,
            detail: `${c.bookings} booking${c.bookings === 1 ? '' : 's'} · ${c.nights} nights · ADR ${money(c.adr)}`
          }))}
        />
      </div>

      <div className="card">
        <Breakdown
          title="Where the money went"
          empty="No costs recorded for this window yet."
          note="Shared costs are already divided across active units, so these add up to the cost figure above."
          total={board.portfolio.costs.total}
          tone="cost"
          rows={view.categories.map(c => ({
            key: c.category, label: c.category, value: c.total, share: c.share,
            detail: c.fixed > 0 && c.variable > 0
              ? `${money(c.fixed)} fixed · ${money(c.variable)} one-off`
              : c.fixed > 0 ? 'monthly' : 'one-off'
          }))}
        />
      </div>

      <div className="card">
        <h2>Net over time</h2>
        <p className="note">
          By {view.granularity}, chosen from the length of the range rather than picked.
        </p>
        <NetOverTime points={view.series} />
      </div>
    </>
  );
}

/**
 * A share-of-total breakdown.
 *
 * One bar per row against the same baseline, sorted largest first — the
 * question is always "what is the biggest slice", and a pie makes that
 * harder to answer, not easier. The total is printed at the top so the
 * parts can be checked against it rather than trusted.
 */
function Breakdown({ title, note, empty, total, rows, tone }: {
  title: string; note: string; empty: string; total: number;
  tone?: 'cost';
  rows: { key: string; label: string; value: number; share: number; detail: string }[];
}) {
  if (!rows.length) return <><h2>{title}</h2><p className="note">{empty}</p></>;
  const top = rows[0]!.share || 1;
  return (
    <>
      <h2>{title} <span className="bd-total">{money(total)}</span></h2>
      <p className="note">{note}</p>
      <div className="bd">
        {rows.map(r => (
          <div className="bd-row" key={r.key}>
            <div className="bd-label">{r.label}</div>
            <div className="bd-track">
              {/* Scaled to the largest slice, not to 100%, so small rows
                  stay legible instead of collapsing to a sliver. */}
              <div className={tone === 'cost' ? 'bd-fill cost' : 'bd-fill'}
                   style={{ width: `${Math.max(1.5, (r.share / top) * 100)}%` }} />
            </div>
            <div className="bd-value">{money(r.value)}</div>
            <div className="bd-share">{pct(r.share)}</div>
            <div className="bd-detail">{r.detail}</div>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * The same traffic light the Units screen uses, applied to money rather
 * than to occupancy — a unit far under its target is critical whatever
 * its calendar looks like. One vocabulary across both screens: a red
 * chip must mean "this needs me" in either place, or the filter stops
 * being trustworthy.
 */
type UnitRowData = ReturnType<typeof scoreboard>['units'][number] &
  { name: string; city?: string; state?: string };

function lightOfUnit(u: { delta: number; target: number }): Light {
  if (u.target <= 0) return 'info';
  const r = u.delta / u.target;
  if (r <= -0.25) return 'bad';
  if (r < 0) return 'warn';
  return 'ok';
}

function countLights(units: { delta: number; target: number }[]): Partial<Record<Light, number>> {
  const c: Partial<Record<Light, number>> = {};
  units.forEach(u => { const l = lightOfUnit(u); c[l] = (c[l] ?? 0) + 1; });
  return c;
}

/**
 * One unit's line, opening in place to show where ITS money came from
 * and went — the same two breakdowns as the portfolio, scoped down.
 */
function RevenueRow({ u, period, data, expanded, onToggle }: {
  u: UnitRowData; period: Period; data: Portfolio;
  expanded: boolean; onToggle: () => void;
}) {
  const light = lightOfUnit(u);
  const detail = useMemo(() => {
    if (!expanded) return null;
    const res = data.reservations.filter(r => r.listingId === u.listingId);
    return {
      channels: byChannel(res, period),
      // Scoped to this listing alone, so its share of a shared cost is
      // what appears — not the whole portfolio's bill.
      categories: byCategory(data.costs, [u.listingId], period)
    };
  }, [expanded, u.listingId, data, period]);

  return (
    <div className={`urow${expanded ? ' open' : ''}`}>
      <button type="button" className="urow-head rev" onClick={onToggle} aria-expanded={expanded}>
        <span className={`light tone-${light}`} aria-hidden="true" />
        <span className="uname">{u.name}</span>
        <span className="ustate">{u.occupancy == null ? '—' : `${Math.round(u.occupancy * 100)}% occupied`}</span>
        <span className="uocc">{money(u.net)}</span>
        <span className="uopen">{u.delta >= 0 ? '+' : ''}{money(u.delta)}</span>
        <span className="ustake">{money(u.revenue)}</span>
        <span className="uchev" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && detail && (
        <div className="udetail">
          <dl className="facts-grid">
            <div className="fact"><dt><span className="fact-k">Revenue</span></dt><dd>{money(u.revenue)}</dd></div>
            <div className="fact"><dt><span className="fact-k">Costs</span></dt><dd>{money(u.costs.total)}</dd></div>
            <div className="fact"><dt><span className="fact-k">Net</span></dt><dd>{money(u.net)}</dd></div>
            <div className="fact"><dt><span className="fact-k">Target</span></dt><dd>{money(u.target)}</dd></div>
            <div className="fact"><dt><span className="fact-k">ADR</span></dt><dd>{money(u.adr)}</dd></div>
            <div className="fact"><dt><span className="fact-k">RevPAN</span></dt><dd>{money(u.revpan)}</dd></div>
            <div className="fact"><dt><span className="fact-k">Nights sold</span></dt><dd>{u.nights}</dd></div>
            <div className="fact"><dt><span className="fact-k">ROI</span></dt>
              {/* Blank, not zero, when nothing was spent: no costs recorded
                  is missing data, not infinite return. */}
              <dd>{u.roi == null ? '—' : `${Math.round(u.roi * 100)}%`}</dd></div>
          </dl>

          <div className="split">
            <div>
              <Breakdown title="Revenue by channel" empty="No bookings in this window."
                note="" total={u.revenue}
                rows={detail.channels.map(c => ({
                  key: c.channel, label: c.channel, value: c.revenue, share: c.share,
                  detail: `${c.nights} nights · ADR ${money(c.adr)}`
                }))} />
            </div>
            <div>
              <Breakdown title="Costs by category" empty="No costs recorded for this unit."
                note="" total={u.costs.total} tone="cost"
                rows={detail.categories.map(c => ({
                  key: c.category, label: c.category, value: c.total, share: c.share,
                  detail: c.fixed > 0 && c.variable > 0
                    ? `${money(c.fixed)} fixed · ${money(c.variable)} one-off`
                    : c.fixed > 0 ? 'monthly share' : 'one-off'
                }))} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
