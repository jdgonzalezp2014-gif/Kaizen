/**
 * Operations › Calendar log (§169): when each unit's nights were blocked, opened or booked — whoever did
 * it, in Kaizen or in Hostaway. Known to the hour: Kaizen looks once an hour and Hostaway keeps no history.
 */
import { useEffect, useMemo, useState } from 'react';
import { getCalendarLog, type CalendarLogResponse } from '../api.ts';
import { CODE_WORD, isBlockChange, type DayCode } from '../lib/calendar-watch.ts';
import { Hint } from './Hint.tsx';
import { Icon } from './Icon.tsx';
import { Loading } from './Loading.tsx';

const ICON: Record<DayCode, string> = { a: 'calendar', b: 'lock', r: 'bed', p: 'clock', '?': 'help' };
const at = (iso: string) => new Date(iso).toLocaleString('en-US',
  { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const night = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US',
  { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: '2-digit' });

/** What a person did, in a word: the headline a row is read by. */
function headline(was: DayCode, now: DayCode): string {
  if (now === 'b') return was === 'r' ? 'Blocked (booking gone)' : 'Blocked';
  if (was === 'b') return now === 'a' ? 'Opened' : now === 'r' ? 'Booked (was blocked)' : 'Unblocked';
  if (now === 'r') return 'Booked';
  if (was === 'r' && now === 'a') return 'Booking gone — open again';
  return `${CODE_WORD[was]} → ${CODE_WORD[now]}`;
}

export function CalendarLog() {
  const [data, setData] = useState<CalendarLogResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [unit, setUnit] = useState('');
  const [days, setDays] = useState(90);
  useEffect(() => {
    setData(null);
    getCalendarLog(days).then(setData, e => setError(e instanceof Error ? e.message : String(e)));
  }, [days]);

  const names = useMemo(() => Object.entries(data?.units ?? {}).sort((a, b) => a[1].localeCompare(b[1])), [data]);
  if (error) return <p className="note">Could not load the calendar log: {error}</p>;
  if (!data) return <Loading estimateMs={1500} stages={['Reading the calendar log']} />;
  const list = data.runs.filter(r => (all || isBlockChange(r)) && (!unit || r.unitId === unit));

  return (
    <>
      <div className="row-controls">
        <button className={!all ? 'chip active' : 'chip'} onClick={() => setAll(false)}><Icon n="lock" /> Blocks & openings</button>
        <button className={all ? 'chip active' : 'chip'} onClick={() => setAll(true)}><Icon n="list" /> All changes</button>
        <select className="date-in" value={unit} onChange={e => setUnit(e.target.value)}>
          <option value="">All units</option>
          {names.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
        </select>
        <select className="date-in" value={days} onChange={e => setDays(Number(e.target.value))}>
          {[7, 30, 90, 365].map(d => <option key={d} value={d}>Last {d} days</option>)}
        </select>
        <Hint>Every hour Kaizen reads each unit's calendar a year ahead and writes down every night whose state
          changed — blocked, opened, booked — whether it was changed here, in Hostaway or by a channel.
          A change shows the hour it was seen and the look before it: it happened between the two.
          Hostaway does not say who made a change, so neither can this. "Blocks & openings" leaves out plain
          bookings; "All changes" shows them too.</Hint>
        <span className="note right">
          {data.watchingSince ? <>watching since {at(data.watchingSince)} · last look {data.lastLook ? at(data.lastLook) : '—'}</> : 'not looking yet — the first hourly look sets the starting point'}
        </span>
      </div>
      <table className="units compact">
        <thead><tr><th>Seen</th><th>Unit</th><th>Nights</th><th>Change</th><th>Note in Hostaway</th></tr></thead>
        <tbody>
          {list.slice(0, 500).map((r, i) => (
            <tr key={i}>
              <td className="sub-n" title={r.since ? `Changed between ${at(r.since)} and ${at(r.seenAt)}` : undefined}>
                {at(r.seenAt)}{r.since && <div className="note">after {at(r.since)}</div>}
              </td>
              <td>{data.units[r.unitId] ?? r.unitId}</td>
              <td>{r.first === r.last ? night(r.first) : <>{night(r.first)} – {night(r.last)}</>}
                <div className="note">{r.nights} night{r.nights === 1 ? '' : 's'}</div></td>
              <td><Icon n={ICON[r.now]} /> <b>{headline(r.was, r.now)}</b>
                <div className="note">{CODE_WORD[r.was]} → {CODE_WORD[r.now]}</div></td>
              <td className="ops-note">{r.note ?? ''}</td>
            </tr>
          ))}
          {!list.length && <tr><td colSpan={5} className="note">No changes seen in this period.</td></tr>}
        </tbody>
      </table>
      {list.length > 500 && <p className="note">Showing the newest 500 of {list.length} — pick a unit or a shorter period.</p>}
    </>
  );
}
