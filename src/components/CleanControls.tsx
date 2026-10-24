/**
 * A clean's controls shared by Movements and a cleaner's page in Operations → Cleaners
 * (owner, 2026-10-24: the same edits in both places): flag (with a deduction or a corrected
 * pay) and add a manual clean.
 */
import { useEffect, useState } from 'react';
import { crewAdminAction, getStaysOnDay, getUnits, manualClean, type ManualCleanKind, type StayOnDay } from '../api.ts';
import { levelOf, type Cleaner } from '../lib/operations.ts';
import { Hint } from './Hint.tsx';

export const MANUAL_WORD: Record<ManualCleanKind, string> = {
  early_departure: 'Guest left early', mid_stay: 'Mid-stay clean', extra: 'Extra clean'
};
export const LEVEL_LABEL: Record<string, string> = { high: 'high level', standard: 'standard', manual: 'manual only' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return `${MON[t.getUTCMonth()]} ${t.getUTCDate()}`; };

/**
 * Flag a clean by hand (§122; from Movements, §124): a note the cleaner
 * reads on their crew page — and, for a clean already due, the pay
 * corrected in the same step (§128), with the note as the reason.
 */
export function FlagControl({ cleanKey, flag, onChanged, date, today, price, onPrice, hint = true }: {
  cleanKey: string; flag: string | null; onChanged: (note: string | null) => void;
  /** When given and due (today or before), the flag can also correct the pay. */
  date?: string; today?: string; price?: number | null; onPrice?: (price: number) => void;
  /** Off on a list of many cleans, whose card already explains it. */
  hint?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [pay, setPay] = useState('');
  const [cut, setCut] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const canPay = !!date && !!today && date <= today;
  // A deduction is taken off the pay shown; it becomes the corrected pay, and the note says so.
  const canCut = canPay && price != null;
  const newPay = cut !== '' && price != null ? Math.max(0, Math.round((price - Number(cut)) * 100) / 100) : pay !== '' ? Number(pay) : null;
  const send = async (note: string | null) => {
    setBusy(true); setMsg('');
    const full = note !== null && cut !== '' ? `${note} (−$${Number(cut)} deducted)` : note;
    const r = await crewAdminAction(full === null ? { action: 'unflag', key: cleanKey }
      : { action: 'flag', key: cleanKey, note: full, ...(canPay && newPay != null ? { price: newPay } : {}) })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
    if (full !== null && canPay && newPay != null) onPrice?.(newPay);
    setEditing(false); setText(''); setPay(''); setCut(''); onChanged(full);
  };
  return (
    <div className="button-row ops-manual-actions" onClick={e => e.stopPropagation()}>
      {flag
        ? <><span className="breach">⚑ Flagged: {flag}</span>
            <button className="link tiny" disabled={busy} onClick={() => void send(null)}>Remove flag</button></>
        : !editing && <><button className="link tiny" onClick={() => setEditing(true)}>⚑ Flag this clean…</button>
            {hint && <Hint label="What a flag does">The cleaner reads it on their crew page{canPay ? '; you can correct the pay with it' : ''}.</Hint>}</>}
      {editing && (
        <form className="stay-work" onSubmit={e => { e.preventDefault(); if (text.trim()) void send(text.trim()); }}>
          <input autoFocus value={text} maxLength={500} placeholder="What the cleaner should know (they read this)"
                 onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setEditing(false); }} />
          {canCut && <input className="amt" inputMode="decimal" value={cut} disabled={pay !== ''}
                            onChange={e => setCut(e.target.value)} placeholder="deduct $" title={`Taken off the ${price} this clean pays`} />}
          {canPay && <input className="amt" inputMode="decimal" value={pay} disabled={cut !== ''} onChange={e => setPay(e.target.value)}
                            placeholder={price != null ? `pays ${price}` : 'pay'} title="Leave blank to keep the pay as it is" />}
          <button className="small" disabled={!text.trim() || busy || (pay !== '' && !(Number(pay) >= 0)) || (cut !== '' && !(Number(cut) > 0))}>
            {busy ? '…' : cut !== '' ? `Flag and deduct (pays ${newPay})` : pay !== '' ? 'Flag and correct pay' : 'Flag'}</button>
          <button type="button" className="link tiny" onClick={() => setEditing(false)}>Cancel</button>
        </form>
      )}
      {msg && <span className="breach">▲ {msg}</span>}
    </div>
  );
}

/**
 * Add a manual clean: a unit, a day, why, which stay, who. For "guest left
 * early" the stay is required — its checkout clean is what becomes "no
 * clean needed"; for a mid-stay clean it is optional; an extra clean has
 * none. The stays are asked of Hostaway for that unit and day.
 */
export function ManualCleanForm({ today, roster, initial, onDone, onCancel }: {
  today: string; roster: Cleaner[];
  /** From a cleaner's page (Operations → Cleaners): that cleaner, and a day already past. */
  initial: { unitId?: string; resId?: string; kind?: ManualCleanKind; cleaner?: string; date?: string };
  onDone: () => void; onCancel: () => void;
}) {
  const [units, setUnits] = useState<{ id: string; name: string }[]>([]);
  const [unitId, setUnitId] = useState(initial.unitId ?? '');
  const [date, setDate] = useState(initial.date ?? today);
  const [kind, setKind] = useState<ManualCleanKind>(initial.kind ?? 'mid_stay');
  const [stays, setStays] = useState<StayOnDay[] | null>(null);
  const [resId, setResId] = useState(initial.resId ?? '');
  const [cleaner, setCleaner] = useState(initial.cleaner ?? '');
  const [deep, setDeep] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const active = roster.filter(c => c.active);

  useEffect(() => {
    void getUnits().then(r => setUnits((r.units ?? []).filter(u => u.active).map(u => ({ id: u.id, name: u.name }))
      .sort((a, b) => a.name.localeCompare(b.name))));
  }, []);
  // Who was staying in that unit that day — asked of Hostaway, now.
  useEffect(() => {
    if (!unitId || kind === 'extra') { setStays(null); return; }
    setStays(null);
    void getStaysOnDay(unitId, date).then(r => {
      if (!r.ok) { setErr(r.message ?? 'Could not ask Hostaway.'); setStays([]); return; }
      setStays(r.stays);
      setResId(prev => r.stays.some(s => s.resId === prev) ? prev : r.stays.length === 1 ? r.stays[0]!.resId : '');
    });
  }, [unitId, date, kind]);

  const needsStay = kind === 'early_departure';
  const save = async () => {
    setBusy(true); setErr('');
    const r = await manualClean({ action: 'create', unitId, date, kind, reservationId: kind === 'extra' ? null : resId || null,
                                  cleaner: cleaner || null, deep, note: note || null })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (r.ok) onDone(); else setErr(r.message ?? 'Not saved.');
  };

  return (
    <div className="card ops-manual-form">
      <h3>Manual clean</h3>
      <div className="todo-kind" role="group" aria-label="Why">
        {(['early_departure', 'mid_stay', 'extra'] as ManualCleanKind[]).map(k => (
          <button key={k} type="button" className={kind === k ? 'chip active' : 'chip'} onClick={() => setKind(k)}>{MANUAL_WORD[k]}</button>
        ))}
      </div>
      {kind === 'early_departure' && <p className="note">The unit is cleaned on this day, and the stay's checkout clean becomes
        “no clean needed” — it is not cleaned twice. Cancelling this puts the checkout clean back.</p>}
      <div className="row">
        <label>Unit
          <select value={unitId} onChange={e => { setUnitId(e.target.value); setResId(''); }}>
            <option value="">Choose…</option>
            {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></label>
        <label>Day cleaned
          <input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        {kind !== 'extra' && (
          <label>Stay {needsStay ? '' : '(optional)'}
            <select value={resId} disabled={!unitId || stays === null} onChange={e => setResId(e.target.value)}>
              <option value="">{!unitId ? 'Choose a unit first' : stays === null ? 'Asking Hostaway…' : stays.length ? (needsStay ? 'Which stay?' : 'None') : 'No stay that day'}</option>
              {(stays ?? []).map(s => <option key={s.resId} value={s.resId}>{s.guest || 'Guest'} · {short(s.arrival)} → {short(s.departure)}</option>)}
            </select></label>
        )}
        <label>Cleaner
          <select value={cleaner} onChange={e => setCleaner(e.target.value)}>
            <option value="">Not assigned yet</option>
            {active.map(c => <option key={c.name} value={c.name}>{c.name} — {LEVEL_LABEL[levelOf(c)]}</option>)}
          </select></label>
        <label className="check"><input type="checkbox" checked={deep} onChange={e => setDeep(e.target.checked)} /> Deep clean</label>
      </div>
      <label>Note <input value={note} maxLength={500} placeholder="e.g. guest checked out at 7am, left keys in the lockbox"
                         onChange={e => setNote(e.target.value)} /></label>
      {err && <p className="banner warn">▲ {err}</p>}
      <div className="button-row">
        <button disabled={busy || !unitId || !date || (needsStay && !resId)} onClick={() => void save()}>{busy ? 'Saving…' : 'Add clean'}</button>
        <button className="secondary" onClick={onCancel}>Cancel</button>
        <span className="note">Paid at the cleaner's rate for the unit's size; it counts in Costs and the calendar like any clean.</span>
      </div>
    </div>
  );
}
