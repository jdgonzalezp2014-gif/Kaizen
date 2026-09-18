/**
 * A month grid of the study window: which nights are sold, blocked, or
 * still open, and a range selected by clicking two of them.
 *
 * The point is that a price decision is aimed at specific nights. A
 * plain pair of date inputs makes you guess which ones are actually
 * empty; here the empty ones are visible and you pick them.
 *
 * State is never colour alone — every day carries a letter and the
 * legend names each state in words, so the grid survives colourblindness,
 * a greyscale print and a screenshot pasted into a chat.
 */
import { useMemo } from 'react';

export type DayState = 'o' | 's' | 'b';
export interface Day { d: string; s: DayState; p: number | null }

const LABEL: Record<DayState, string> = { o: 'Open', s: 'Booked', b: 'Blocked' };
const MARK:  Record<DayState, string> = { o: '·',    s: '●',      b: '×' };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(`${s}T00:00:00Z`);
const MONTH = ['January','February','March','April','May','June',
               'July','August','September','October','November','December'];

export function DayPicker({ days, from, to, onChange }: {
  days: Day[];
  from: string; to: string;
  onChange: (from: string, to: string) => void;
}) {
  const byDate = useMemo(() => new Map(days.map(d => [d.d, d])), [days]);

  // One grid per calendar month the window touches, each padded to start
  // on Sunday so the columns are weekdays rather than an arbitrary offset.
  const months = useMemo(() => {
    if (!days.length) return [];
    const out: { key: string; label: string; cells: (Day | null)[] }[] = [];
    let cursor = parse(days[0]!.d);
    const last = parse(days[days.length - 1]!.d);
    while (cursor <= last) {
      const y = cursor.getUTCFullYear(), m = cursor.getUTCMonth();
      const first = new Date(Date.UTC(y, m, 1));
      const count = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const cells: (Day | null)[] = Array(first.getUTCDay()).fill(null);
      for (let i = 1; i <= count; i++) cells.push(byDate.get(iso(new Date(Date.UTC(y, m, i)))) ?? null);
      out.push({ key: `${y}-${m}`, label: `${MONTH[m]} ${y}`, cells });
      cursor = new Date(Date.UTC(y, m + 1, 1));
    }
    return out;
  }, [days, byDate]);

  const click = (d: string) => {
    // First click after a completed range starts a new one; the second
    // closes it, in either direction so dragging backwards still works.
    if (from !== to) { onChange(d, d); return; }
    if (d < from) onChange(d, from); else onChange(from, d);
  };

  return (
    <div className="daypicker">
      <div className="months">
        {months.map(mo => (
          <div key={mo.key} className="month">
            <div className="month-name">{mo.label}</div>
            <div className="dow">{['S','M','T','W','T','F','S'].map((d, i) => <span key={i}>{d}</span>)}</div>
            <div className="grid">
              {mo.cells.map((c, i) => {
                if (!c) return <span key={i} className="day empty" />;
                const sel = c.d >= from && c.d <= to;
                // Selection is drawn as a continuous BAND, rounded at its
                // two ends, rather than a border around every cell. With
                // the default range covering the whole window, a per-cell
                // outline made all thirty nights look individually picked
                // and the range impossible to see at a glance.
                const edge = sel ? (c.d === from ? ' sel-start' : '') + (c.d === to ? ' sel-end' : '') : '';
                return (
                  <button key={i} type="button"
                    className={`day st-${c.s}${sel ? ' sel' : ''}${edge}`}
                    aria-pressed={sel}
                    title={`${c.d} — ${LABEL[c.s]}${c.p ? ` · $${c.p}` : ''}`}
                    onClick={() => click(c.d)}>
                    <span className="num">{Number(c.d.slice(8))}</span>
                    <span className="mk">{MARK[c.s]}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="legend">
        {(['o', 's', 'b'] as DayState[]).map(s => (
          <span key={s} className={`key st-${s}`}><i>{MARK[s]}</i> {LABEL[s]}</span>
        ))}
        {from === to && <span className="key hint">click a second day to finish the range</span>}
      </div>
    </div>
  );
}
