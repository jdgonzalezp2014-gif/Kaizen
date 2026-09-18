/**
 * One filter bar, used by every screen that lists units.
 *
 * Three axes, because they answer three different questions a manager
 * actually asks: *what needs me* (status), *where* (location), and *this
 * one specifically* (search). Filters are additive and always visible —
 * a hidden filter that is still applied is the fastest way to make
 * someone distrust a number.
 */
import { useMemo } from 'react';

export type Light = 'bad' | 'warn' | 'ok' | 'info' | 'off';

export interface FilterState {
  lights: Light[];          // empty = all
  places: string[];         // empty = all
  q: string;
}

export const EMPTY_FILTER: FilterState = { lights: [], places: [], q: '' };

const LIGHT_LABEL: Record<Light, string> = {
  bad: 'Critical', warn: 'Watch', ok: 'Fine', info: 'Informational', off: 'Not booking'
};

export function filterUnits<T extends { name: string; city?: string; state?: string }>(
  rows: T[], f: FilterState, lightOf: (row: T) => Light
): T[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter(r => {
    if (f.lights.length && !f.lights.includes(lightOf(r))) return false;
    if (f.places.length && !f.places.includes(placeOf(r))) return false;
    if (q && !r.name.toLowerCase().includes(q) && !placeOf(r).toLowerCase().includes(q)) return false;
    return true;
  });
}

export function placeOf(r: { city?: string; state?: string }): string {
  const c = (r.city ?? '').trim();
  const s = (r.state ?? '').trim();
  if (!c && !s) return 'Unknown';
  return s ? `${c}, ${s}` : c;
}

export function Filters({ rows, value, onChange, counts }: {
  rows: { city?: string; state?: string }[];
  value: FilterState;
  onChange: (f: FilterState) => void;
  /** How many rows carry each light, so a filter shows its own weight. */
  counts: Partial<Record<Light, number>>;
}) {
  const places = useMemo(() => {
    const m = new Map<string, number>();
    rows.forEach(r => { const p = placeOf(r); m.set(p, (m.get(p) ?? 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const toggle = <K extends string>(list: K[], v: K): K[] =>
    list.includes(v) ? list.filter(x => x !== v) : [...list, v];

  const active = value.lights.length > 0 || value.places.length > 0 || value.q.trim() !== '';
  // Informational never gets its own chip: it is a nuance of "fine", and
  // a fifth colour in the bar buys nothing a manager would act on.
  const lights: Light[] = ['bad', 'warn', 'ok', 'off'];

  return (
    <div className="filters-bar">
      <div className="fgroup">
        {lights.map(l => {
          const n = counts[l] ?? 0;
          const on = value.lights.includes(l);
          return (
            <button key={l} type="button" disabled={n === 0}
              className={`fchip light-${l}${on ? ' on' : ''}`}
              aria-pressed={on}
              onClick={() => onChange({ ...value, lights: toggle(value.lights, l) })}>
              <span className={`light tone-${l}`} aria-hidden="true" />
              {LIGHT_LABEL[l]}<b>{n}</b>
            </button>
          );
        })}
      </div>

      {places.length > 1 && (
        <div className="fgroup">
          {places.map(([p, n]) => {
            const on = value.places.includes(p);
            return (
              <button key={p} type="button" className={`fchip${on ? ' on' : ''}`} aria-pressed={on}
                onClick={() => onChange({ ...value, places: toggle(value.places, p) })}>
                {p}<b>{n}</b>
              </button>
            );
          })}
        </div>
      )}

      <input className="fsearch" type="search" placeholder="Find a unit…"
             value={value.q} onChange={e => onChange({ ...value, q: e.target.value })} />

      {active && (
        <button type="button" className="link" onClick={() => onChange(EMPTY_FILTER)}>clear</button>
      )}
    </div>
  );
}
