import { useEffect, useMemo, useState } from 'react';
import { RangePicker } from '../components/RangePicker.tsx';
import { NetOverTime, UnitBars } from '../components/charts.tsx';
import { resolvePreset, granularityFor, type PresetId } from '../lib/ranges.ts';
import { portfolioSeries, scoreboard, type Dataset } from '../lib/series.ts';
import type { Period } from '../lib/finance.ts';

interface Portfolio {
  meta: { targets: { perUnitNet: number; activeUnits: number; portfolioNet: number; basis: string };
          occFloorPct?: number;
          window: { from: string; to: string }; tookMs: number };
  listings: { listingId: string; name: string; active: boolean }[];
  reservations: Dataset['reservations'];
  costs: Dataset['costs'];
}

const money = (n: number | null) => n == null ? '—'
  : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

export function Revenue() {
  const [data, setData] = useState<Portfolio | null>(null);
  const [error, setError] = useState('');
  const [preset, setPreset] = useState<PresetId | 'custom'>('mtd');
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
    const board = scoreboard(set, period, data.meta.targets.perUnitNet);
    return {
      board,
      units: board.units.map(u => ({ ...u, name: names.get(u.listingId) ?? u.listingId })),
      occFloor: (data.meta.occFloorPct ?? 60) / 100,
      series: portfolioSeries(set, period),
      thin: board.units.filter(u =>
        u.occupancy != null && u.occupancy < (data.meta.occFloorPct ?? 60) / 100).length,
      granularity: granularityFor(period),
      anyCosts: data.costs.length > 0
    };
  }, [data, period]);

  if (error) return <div className="card"><div className="banner error">{error}</div></div>;
  if (!view || !data) return <div className="card"><p className="note">Loading…</p></div>;

  const { board } = view;
  const delta = board.portfolio.net - board.portfolioTarget;

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
        <h2>Net by unit</h2>
        <p className="note">
          Worst first — that is what needs a decision. Occupancy sits beside the money on
          purpose: a unit can clear its target on a half-empty calendar, and that is a price
          that found few takers rather than a unit that is working.
        </p>
        <UnitBars units={view.units} occFloor={view.occFloor} />
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
