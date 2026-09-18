import type { SeriesPoint } from '../lib/series.ts';
import type { Band } from '../lib/series.ts';

const money = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Status wears a word as well as a colour — colour never carries meaning alone. */
export const BAND_LABEL: Record<Band, string> = {
  green: 'at or above target',
  amber: 'below target',
  red: 'well below target'
};
const BAND_MARK: Record<Band, string> = { green: '●', amber: '▲', red: '■' };

/* BandTag and UnitBars lived here. The Revenue screen now uses the same
   traffic-light list as Units, so both were unreferenced — and unused UI
   rots quietly, drifting from the components that replaced it. */

export function NetOverTime({ points }: { points: SeriesPoint[] }) {
  if (!points.length) return null;
  const extent = Math.max(...points.map(p => Math.abs(p.net)), 1);
  const hasNegative = points.some(p => p.net < 0);

  return (
    <div className="chart">
      <div className="plot" style={{ '--zero': hasNegative ? '50%' : '100%' } as React.CSSProperties}>
        {points.map(p => {
          const h = (Math.abs(p.net) / extent) * (hasNegative ? 46 : 92);
          return (
            <div className="col" key={p.from} title={`${p.from} → ${p.to}\nnet ${money(p.net)}`}>
              <div className={`col-fill ${p.net < 0 ? 'neg' : 'pos'}${p.partial ? ' partial' : ''}`}
                   style={{ height: `${Math.max(h, 0.6)}%` }} />
            </div>
          );
        })}
        <div className="plot-zero" />
      </div>
      <div className="axis">
        {points.map((p, i) => (
          // Selective labels: every tick on a 90-bucket chart is unreadable.
          <span key={p.from}>{i % Math.ceil(points.length / 6) === 0 ? p.label : ''}</span>
        ))}
      </div>
      {points.some(p => p.partial) && (
        <p className="note">Hatched bars are periods still filling.</p>
      )}
    </div>
  );
}
