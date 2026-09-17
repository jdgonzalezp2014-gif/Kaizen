/**
 * Costs, in the two shapes they actually arrive in.
 *
 * FIXED is a month at a time. Each recurring line gets its own amount
 * for that month, so a bill that jumps in August is recorded as having
 * jumped in August rather than retroactively rewriting the year.
 *
 * VARIABLE is dated and one-off: a repair on one unit, or something
 * shared that gets divided across the active ones.
 */
import { useEffect, useState } from 'react';
import {
  getFixed, getVariable, postExpense, deleteExpense,
  type FixedLine, type VariableExpense
} from '../api.ts';

const money = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const thisMonth = () => new Date().toISOString().slice(0, 7);
const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y!, mo! - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const CATEGORIES = ['Lease', 'Electricity', 'Gas', 'Water', 'Internet', 'Cleaning',
                    'Restock', 'Handyman', 'Software', 'Insurance', 'General'];

export function Costs({ units }: { units: { id: string; name: string }[] }) {
  const [mode, setMode] = useState<'fixed' | 'variable'>('fixed');
  return (
    <section>
      <nav className="subtabs">
        <button className={mode === 'fixed' ? 'tab active' : 'tab'} onClick={() => setMode('fixed')}>
          Fixed, by month
        </button>
        <button className={mode === 'variable' ? 'tab active' : 'tab'} onClick={() => setMode('variable')}>
          One-off & repairs
        </button>
      </nav>
      {mode === 'fixed' ? <Fixed units={units} /> : <Variable units={units} />}
    </section>
  );
}

function Fixed({ units }: { units: { id: string; name: string }[] }) {
  const [month, setMonth] = useState(thisMonth);
  const [lines, setLines] = useState<FixedLine[]>([]);
  const [carryable, setCarryable] = useState<FixedLine[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => getFixed(month).then(r => { setLines(r.lines ?? []); setCarryable(r.carryable ?? []); });
  useEffect(() => { load(); }, [month]);

  const save = (label: string, unitId: string | null, amount: number, category: string) => {
    setBusy(true);
    postExpense({ action: 'fixed', month, label, unitId, amount, category })
      .then(load).finally(() => setBusy(false));
  };

  const carry = () => {
    setBusy(true); setMsg('');
    postExpense({ action: 'carryForward', month, fromMonth: shiftMonth(month, -1) })
      .then(r => { setMsg(r.message ?? ''); return load(); })
      .finally(() => setBusy(false));
  };

  const total = lines.reduce((a, l) => a + Number(l.amount), 0);
  const missing = carryable.filter(c => !lines.some(l => l.label === c.label && l.unit_id === c.unit_id));

  return (
    <>
      <div className="row-controls">
        <button className="ghost" onClick={() => setMonth(shiftMonth(month, -1))}>←</button>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)} />
        <button className="ghost" onClick={() => setMonth(shiftMonth(month, 1))}>→</button>
        <span className="note">{lines.length} line(s) · {money(total)} this month</span>
      </div>

      {missing.length > 0 && (
        <p className="banner">
          {missing.length} line(s) from {shiftMonth(month, -1)} are not in {month} yet.
          {' '}<button className="link" onClick={carry} disabled={busy}>Carry them forward</button>
          {' '}— amounts copy across and you edit the ones that moved. Running it twice changes nothing.
        </p>
      )}
      {msg && <p className="note">{msg}</p>}

      <table className="units">
        <thead><tr><th>Line</th><th>Applies to</th><th>Category</th><th className="n">{month}</th><th></th></tr></thead>
        <tbody>
          {lines.map(l => (
            <LineRow key={l.id} line={l} busy={busy}
              onSave={a => save(l.label, l.unit_id, a, l.category)}
              onDelete={() => deleteExpense(l.id).then(load)} />
          ))}
          <NewLine units={units} busy={busy} onSave={save} />
        </tbody>
      </table>
      <p className="note">
        Amounts are per month. A line with no unit is shared and gets divided across the active
        units when the dashboard prorates it.
      </p>
    </>
  );
}

function LineRow({ line, busy, onSave, onDelete }: {
  line: FixedLine; busy: boolean; onSave: (amount: number) => void; onDelete: () => void;
}) {
  const [v, setV] = useState(String(Number(line.amount)));
  useEffect(() => setV(String(Number(line.amount))), [line.amount]);
  const dirty = Number(v) !== Number(line.amount);
  return (
    <tr>
      <td>{line.label}</td>
      <td>{line.unit_name ?? <span className="muted">All active units</span>}</td>
      <td>{line.category}</td>
      <td className="n">
        <input className="amt" type="number" value={v} onChange={e => setV(e.target.value)} />
        {dirty && <button className="link" disabled={busy} onClick={() => onSave(Number(v))}>save</button>}
      </td>
      <td><button className="link danger" onClick={onDelete}>remove</button></td>
    </tr>
  );
}

function NewLine({ units, busy, onSave }: {
  units: { id: string; name: string }[]; busy: boolean;
  onSave: (label: string, unitId: string | null, amount: number, category: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [unit, setUnit] = useState('');
  const [cat, setCat] = useState('General');
  const [amt, setAmt] = useState('');
  const ready = label.trim() !== '' && amt.trim() !== '';
  return (
    <tr className="new-row">
      <td><input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Internet" /></td>
      <td>
        <select value={unit} onChange={e => setUnit(e.target.value)}>
          <option value="">All active units</option>
          {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </td>
      <td>
        <select value={cat} onChange={e => setCat(e.target.value)}>
          {CATEGORIES.map(c => <option key={c}>{c}</option>)}
        </select>
      </td>
      <td className="n"><input className="amt" type="number" value={amt} onChange={e => setAmt(e.target.value)} /></td>
      <td>
        <button className="link" disabled={!ready || busy}
          onClick={() => { onSave(label.trim(), unit || null, Number(amt), cat); setLabel(''); setAmt(''); }}>
          add
        </button>
      </td>
    </tr>
  );
}

function Variable({ units }: { units: { id: string; name: string }[] }) {
  const [rows, setRows] = useState<VariableExpense[]>([]);
  const [unit, setUnit] = useState('');
  const [cat, setCat] = useState('Handyman');
  const [amt, setAmt] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => getVariable().then(r => setRows(r.expenses ?? []));
  useEffect(() => { load(); }, []);

  const add = () => {
    setBusy(true);
    postExpense({ action: 'variable', unitId: unit || null, shared: !unit,
                  category: cat, amount: Number(amt), date, notes })
      .then(() => { setAmt(''); setNotes(''); return load(); })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="entry">
        <label>Date<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
        <label>Unit
          <select value={unit} onChange={e => setUnit(e.target.value)}>
            <option value="">Shared — split across active units</option>
            {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label>Category
          <select value={cat} onChange={e => setCat(e.target.value)}>
            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>Amount<input type="number" value={amt} onChange={e => setAmt(e.target.value)} /></label>
        <label className="grow">What for
          <input value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="e.g. replaced water heater" />
        </label>
        <button disabled={busy || amt.trim() === ''} onClick={add}>Add</button>
      </div>

      <table className="units">
        <thead><tr><th>Date</th><th>Unit</th><th>Category</th><th className="n">Amount</th><th>Note</th><th>By</th><th></th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.start_date}</td>
              <td>{r.unit_name ?? <span className="muted">Shared</span>}</td>
              <td>{r.category}</td>
              <td className="n">{money(Number(r.amount))}</td>
              <td>{r.notes}</td>
              <td className="muted">{r.created_by?.split('@')[0]}</td>
              <td><button className="link danger" onClick={() => deleteExpense(r.id).then(load)}>remove</button></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={7} className="note">Nothing recorded yet.</td></tr>}
        </tbody>
      </table>
    </>
  );
}
