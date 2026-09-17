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

export function BandTag({ band }: { band: Band }) {
  return (
    <span className={`tag ${band}`}>
      <span aria-hidden>{BAND_MARK[band]}</span> {BAND_LABEL[band]}
    </span>
  );
}

/**
 * Per-unit net, sorted worst first.
 *
 * A bar rather than a tile grid: the job is comparing magnitude, and
 * length is the only encoding people read accurately. Bars are anchored
 * to a zero baseline because net goes negative, and a tile would have to
 * express that with colour alone.
 */
export function UnitBars({ units, occFloor }: {
  units: {
    listingId: string; name: string; net: number; target: number;
    delta: number; band: Band; occupancy: number | null;
  }[];
  occFloor: number;
}) {
  if (!units.length) return <p className="note">No units yet — run “Sync listings” in Settings.</p>;

  // One shared scale across positive and negative so bar lengths stay
  // comparable; a per-row scale would make the worst unit look average.
  const extent = Math.max(...units.map(u => Math.abs(u.net)), 1);
  const zero = 50;   // % — the baseline sits mid-track so losses read left

  return (
    <div className="bars">
      {units.map(u => {
        const w = (Math.abs(u.net) / extent) * 48;
        return (
          <div className="bar-row" key={u.listingId}
               title={`${u.name} · net ${money(u.net)} · target ${money(u.target)}`}>
            <div className="bar-name">{u.name}</div>
            <div className="bar-track">
              <div className="bar-zero" style={{ left: `${zero}%` }} />
              <div className={`bar-fill ${u.band}`}
                   style={u.net >= 0
                     ? { left: `${zero}%`, width: `${w}%` }
                     : { left: `${zero - w}%`, width: `${w}%` }} />
            </div>
            <div className="bar-value">{money(u.net)}</div>
            <div className="bar-occ">
              {/* The guardrail, shown beside the verdict rather than on
                  another screen. A unit can clear its profit target on a
                  half-empty calendar — that is a price that found few
                  takers, not a unit that is working. */}
              {u.occupancy == null ? '—' : `${Math.round(u.occupancy * 100)}%`}
              {u.occupancy != null && u.occupancy < occFloor && (
                <span className="breach" title={`Below the ${Math.round(occFloor * 100)}% occupancy floor`}>
                  {' '}⚠ thin
                </span>
              )}
            </div>
            <BandTag band={u.band} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Net over time. One series, so no legend — the title names it.
 *
 * Partial buckets are drawn hatched rather than hidden: the last week of
 * a range ending today is still filling, and plotting it solid beside
 * complete ones makes every chart look like it falls off a cliff.
 */
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
