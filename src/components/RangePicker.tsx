import { PRESETS, normalisePeriod, type PresetId } from '../lib/ranges.ts';
import type { Period } from '../lib/finance.ts';

/**
 * Filters sit in one row above the charts, per the interaction spec.
 * Presets carry the weight; the two date inputs are the escape hatch for
 * a range nobody anticipated.
 */
export function RangePicker({
  period, preset, onChange
}: {
  period: Period;
  preset: PresetId | 'custom';
  onChange: (p: Period, id: PresetId | 'custom') => void;
}) {
  return (
    <div className="filters">
      <div className="presets">
        {PRESETS.map(p => (
          <button key={p.id}
                  className={preset === p.id ? 'chip active' : 'chip'}
                  onClick={() => onChange(p.resolve(), p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="dates">
        <input type="date" value={period.from}
               onChange={e => onChange(normalisePeriod(e.target.value, period.to), 'custom')} />
        <span aria-hidden>→</span>
        <input type="date" value={period.to}
               onChange={e => onChange(normalisePeriod(period.from, e.target.value), 'custom')} />
      </div>
    </div>
  );
}
