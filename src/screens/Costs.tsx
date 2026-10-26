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
import { Hint } from '../components/Hint.tsx';
import { useEffect, useMemo, useState } from 'react';
import { getInventory, inventoryAction, type Inventory } from '../api.ts';
import {
  getFixed, getVariable, postExpense, deleteExpense,
  type FixedLine, type VariableExpense, type UnitRow
} from '../api.ts';
import { money2 as money } from '../lib/format.ts';
import { Cleanings } from './Cleanings.tsx';
import { COST_CATEGORIES, guessCategory as guessCat } from '../lib/costs.ts';
import { Icon } from '../components/Icon.tsx';
import { useUrlState } from '../components/useUrlState.ts';


const thisMonth = () => new Date().toISOString().slice(0, 7);
const shiftMonth = (m: string, by: number) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y!, mo! - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};
const CATEGORIES = COST_CATEGORIES;

export function Costs({ units }: { units: UnitRow[] }) {
  // Cleanings belong here rather than in a tab of their own: they are a
  // cost, and the third kind alongside the monthly lines and the one-offs.
  const [mode, setMode] = useState<'fixed' | 'variable' | 'cleanings'>('fixed');
  useUrlState('view', mode, setMode, { def: 'fixed', valid: v => ['fixed', 'variable', 'cleanings'].includes(v) });
  return (
    <section>
      <nav className="subtabs">
        <button className={mode === 'fixed' ? 'tab active' : 'tab'} onClick={() => setMode('fixed')}>
          Fixed, by month
        </button>
        <button className={mode === 'variable' ? 'tab active' : 'tab'} onClick={() => setMode('variable')}>
          One-off & repairs
        </button>
        <button className={mode === 'cleanings' ? 'tab active' : 'tab'} onClick={() => setMode('cleanings')}>
          Cleanings
        </button>
      </nav>
      {mode === 'fixed' && <Fixed units={units} />}
      {mode === 'variable' && <Variable units={units} />}
      {mode === 'cleanings' && <Cleanings />}
    </section>
  );
}

/**
 * Fixed costs as a grid: one row per unit, one column per cost type.
 *
 * The shape matters. A flat list of lines answers "what did we spend",
 * which is the question you ask once a month; a grid answers "what does
 * each unit cost to keep", which is the question behind every per-unit
 * number in this app. It also makes a hole obvious — an empty cell in a
 * column every other unit fills is a bill someone forgot to enter, and a
 * list of lines hides that completely.
 *
 * One month at a time. Each cell is its own row in `expenses`, keyed by
 * (label, unit, month), so editing August edits August and last year's
 * figures never move.
 */
function Fixed({ units }: { units: UnitRow[] }) {
  const [month, setMonth] = useState(thisMonth);
  const [lines, setLines] = useState<FixedLine[]>([]);
  const [carryable, setCarryable] = useState<FixedLine[]>([]);
  const [extraCols, setExtraCols] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => getFixed(month).then(r => {
    setLines(r.lines ?? []); setCarryable(r.carryable ?? []);
  });
  useEffect(() => { load(); }, [month]);

  // Columns are whatever cost types exist this month, plus what existed
  // recently (so a month you have not filled in yet still shows the
  // shape of the one before it), plus anything just added by hand.
  const columns = useMemo(() => {
    const set = new Set<string>();
    lines.forEach(l => l.label && set.add(l.label));
    carryable.forEach(l => l.label && set.add(l.label));
    extraCols.forEach(c => set.add(c));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [lines, carryable, extraCols]);

  // (unit or shared) × label → the row that holds that amount.
  const cell = useMemo(() => {
    const m = new Map<string, FixedLine>();
    lines.forEach(l => m.set(`${l.unit_id ?? ''}|${l.label}`, l));
    return m;
  }, [lines]);

  const save = (label: string, unitId: string | null, amount: number) => {
    setBusy(true);
    postExpense({ action: 'fixed', month, label, unitId, amount,
                  category: guessCategory(label) })
      .then(load).finally(() => setBusy(false));
  };

  const removeColumn = (label: string) => {
    const mine = lines.filter(l => l.label === label);
    setBusy(true);
    Promise.all(mine.map(l => deleteExpense(l.id)))
      .then(() => { setExtraCols(c => c.filter(x => x !== label)); return load(); })
      .finally(() => setBusy(false));
  };

  const carry = () => {
    setBusy(true); setMsg('');
    postExpense({ action: 'carryForward', month, fromMonth: shiftMonth(month, -1) })
      .then(r => { setMsg(r.message ?? ''); return load(); })
      .finally(() => setBusy(false));
  };

  const amountOf = (unitId: string | null, label: string) => {
    const l = cell.get(`${unitId ?? ''}|${label}`);
    return l ? Number(l.amount) : null;
  };
  const colTotal = (label: string) =>
    lines.filter(l => l.label === label).reduce((a, l) => a + Number(l.amount), 0);
  const rowTotal = (unitId: string | null) =>
    lines.filter(l => (l.unit_id ?? '') === (unitId ?? '')).reduce((a, l) => a + Number(l.amount), 0);
  const grand = lines.reduce((a, l) => a + Number(l.amount), 0);

  const missing = carryable.filter(c => !lines.some(l => l.label === c.label && l.unit_id === c.unit_id));
  const activeCount = units.filter(u => u.active).length;

  return (
    <>
      <div className="row-controls">
        <button className="ghost" onClick={() => setMonth(shiftMonth(month, -1))}>←</button>
        <input type="month" value={month} onChange={e => setMonth(e.target.value)} />
        <button className="ghost" onClick={() => setMonth(shiftMonth(month, 1))}>→</button>
        <span className="note">{lines.length} entr{lines.length === 1 ? 'y' : 'ies'} · {money(grand)} this month</span>
        <AddColumn existing={columns} onAdd={c => setExtraCols(x => [...x, c])} />
      </div>

      {missing.length > 0 && (
        <p className="banner">
          {missing.length} entr{missing.length === 1 ? 'y' : 'ies'} from {shiftMonth(month, -1)} are not
          in {month} yet.{' '}
          <button className="link" onClick={carry} disabled={busy}>Carry them forward</button>
          {' '}— amounts copy across and you edit the ones that moved. Running it twice changes nothing.
        </p>
      )}
      {msg && <p className="note">{msg}</p>}

      {columns.length === 0 ? (
        <p className="note">
          No cost types yet. Add one — Lease, Internet, Pool maintenance — and it becomes a column
          you fill in per unit.
        </p>
      ) : (
        <div className="grid-scroll">
          <table className="units matrix">
            <thead>
              <tr>
                <th className="sticky-col">Unit</th>
                {columns.map(c => (
                  <th key={c} className="n">
                    {c}
                    <button className="link danger tiny" title={`Remove ${c} from ${month}`}
                            onClick={() => removeColumn(c)}>×</button>
                  </th>
                ))}
                <th className="n">Total</th>
              </tr>
            </thead>
            <tbody>
              {/* Shared costs first: they are the ones that get divided,
                  so they belong above the units they are divided across. */}
              <tr className="shared-row">
                <td className="sticky-col">
                  All units
                  {/* Divided across units that are actually taking bookings.
                      A parked unit still has a lease, so it keeps its own
                      row — but it is not among the units a shared cost is
                      spread over, and printing ÷27 when the dashboard
                      divides by 23 would make the two disagree on screen. */}
                  <span className="sub-n">shared, ÷{activeCount || '—'}</span>
                </td>
                {columns.map(c => (
                  <Cell key={c} value={amountOf(null, c)} busy={busy}
                        onSave={v => save(c, null, v)} />
                ))}
                <td className="n strong">{money(rowTotal(null))}</td>
              </tr>

              {units.map(u => (
                <tr key={u.id} className={u.active ? undefined : 'muted-row'}>
                  <td className="sticky-col">
                    {u.name}
                    {/* A parked unit still pays its lease, so it keeps a
                        row — it is just not one of the units a shared cost
                        gets divided across. */}
                    {u.parked && <span className="sub-n"> parked</span>}
                    {!u.listed && <span className="sub-n"> not listed</span>}
                  </td>
                  {columns.map(c => (
                    <Cell key={c} value={amountOf(u.id, c)} busy={busy}
                          onSave={v => save(c, u.id, v)} />
                  ))}
                  <td className="n strong">{money(rowTotal(u.id))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td className="sticky-col strong">Total</td>
                {columns.map(c => <td key={c} className="n strong">{money(colTotal(c))}</td>)}
                <td className="n strong">{money(grand)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <p className="note">Monthly amounts <Hint>Amounts are per month. The shared row is divided across active units when the dashboard
        prorates it; a cost typed on a unit belongs to that unit alone. An empty cell means nothing
        was recorded, which is not the same as zero.</Hint></p>
    </>
  );
}

/** Category is bookkeeping, not something worth typing per cell. */
const guessCategory = (label: string): string => guessCat(label) ?? 'General';

/**
 * One amount. Saves on blur rather than per keystroke — a cell that
 * writes on every character turns "1200" into four rows of history and
 * four round trips.
 */
function Cell({ value, busy, onSave }: {
  value: number | null; busy: boolean; onSave: (v: number) => void;
}) {
  const [v, setV] = useState(value == null ? '' : String(value));
  useEffect(() => setV(value == null ? '' : String(value)), [value]);

  const commit = () => {
    const n = v.trim() === '' ? null : Number(v);
    if (n == null || !Number.isFinite(n)) { setV(value == null ? '' : String(value)); return; }
    if (n !== value) onSave(n);
  };

  return (
    <td className="n cell">
      <input className="amt" type="number" value={v} disabled={busy}
             onChange={e => setV(e.target.value)}
             onBlur={commit}
             onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </td>
  );
}

function AddColumn({ existing, onAdd }: { existing: string[]; onAdd: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const clash = existing.some(c => c.toLowerCase() === name.trim().toLowerCase());

  if (!open) return <button className="ghost" onClick={() => setOpen(true)}>+ Add cost type</button>;
  return (
    <span className="inline">
      <input autoFocus value={name} onChange={e => setName(e.target.value)}
             placeholder="e.g. Pool maintenance"
             onKeyDown={e => {
               if (e.key === 'Enter' && name.trim() && !clash) { onAdd(name.trim()); setName(''); setOpen(false); }
               if (e.key === 'Escape') { setName(''); setOpen(false); }
             }} />
      <button className="link" disabled={!name.trim() || clash}
              onClick={() => { onAdd(name.trim()); setName(''); setOpen(false); }}>add</button>
      <button className="link" onClick={() => { setName(''); setOpen(false); }}>cancel</button>
      {clash && <span className="note">already a column</span>}
    </span>
  );
}

/**
 * One-off & repairs (§150, owner): filtered by dates (asked of the server, so
 * an older range is never cut off), unit, category and words; grouped by unit,
 * category or month — each group a folded line with its subtotal — and the
 * orders not bought yet on top, so a forgotten one is seen where money is.
 */
type GroupBy = 'none' | 'unit' | 'category' | 'month';
function Variable({ units }: { units: UnitRow[] }) {
  const [rows, setRows] = useState<VariableExpense[]>([]);
  const [capped, setCapped] = useState(false);
  const [unit, setUnit] = useState('');
  const [cat, setCat] = useState('Handyman');
  const [amt, setAmt] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(() => `${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [fUnit, setFUnit] = useState('');
  const [fCat, setFCat] = useState('');
  const [q, setQ] = useState('');
  const [group, setGroup] = useState<GroupBy>('none');
  const [openG, setOpenG] = useState<Set<string>>(new Set());

  const load = () => getVariable(from || undefined, to || undefined).then(r => { setRows(r.expenses ?? []); setCapped(!!r.capped); });
  useEffect(() => { load(); }, [from, to]);

  const add = () => {
    setBusy(true);
    postExpense({ action: 'variable', unitId: unit || null, shared: !unit,
                  category: cat, amount: Number(amt), date, notes })
      .then(() => { setAmt(''); setNotes(''); return load(); })
      .finally(() => setBusy(false));
  };

  const shown = rows.filter(r => (!fUnit || (fUnit === 'shared' ? !r.unit_id : r.unit_id === fUnit)) && (!fCat || r.category === fCat)
    && (!q.trim() || `${r.notes ?? ''} ${r.label ?? ''} ${r.unit_name ?? ''} ${r.created_by ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
  const total = shown.reduce((a, r) => a + Number(r.amount), 0);
  const keyOf = (r: VariableExpense) => group === 'unit' ? r.unit_name ?? 'Shared' : group === 'category' ? r.category
    : group === 'month' ? String(r.start_date).slice(0, 7) : '';
  const groups = group === 'none' ? [] : [...shown.reduce((m, r) => m.set(keyOf(r), [...m.get(keyOf(r)) ?? [], r]), new Map<string, VariableExpense[]>())]
    .map(([k, rs]) => ({ k, rs, sum: rs.reduce((a, r) => a + Number(r.amount), 0) }))
    .sort((a, b) => group === 'month' ? b.k.localeCompare(a.k) : b.sum - a.sum);
  const cats = [...new Set(rows.map(r => r.category))].sort();
  const row = (r: VariableExpense) => (
    <tr key={r.id}>
      <td>{String(r.start_date).slice(0, 10)}</td>
      <td>{r.unit_name ?? <span className="muted">Shared</span>}</td>
      <td>{r.category}</td>
      <td className="n">{money(Number(r.amount))}</td>
      <td>{r.source === 'repair' ? <><Icon n="wrench" /> {r.label}{r.notes ? <span className="muted"> · {r.notes}</span> : null}</> : r.notes ?? r.label}</td>
      <td className="muted">{r.created_by?.split('@')[0]}</td>
      {/* §95: a repair's cost follows the repair — changed or removed there. */}
      <td>{r.source === 'repair'
        ? <span className="muted" title="Change the cost, or reopen the repair, in the to-do list">from repair</span>
        : <button className="link danger" onClick={() => deleteExpense(r.id).then(load)}>remove</button>}</td>
    </tr>
  );

  return (
    <>
      <OpenOrders />
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

      <div className="entry costs-filter">
        <label>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        <label>Unit<select value={fUnit} onChange={e => setFUnit(e.target.value)}>
          <option value="">All</option><option value="shared">Shared</option>
          {units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label>Category<select value={fCat} onChange={e => setFCat(e.target.value)}>
          <option value="">All</option>{cats.map(c => <option key={c}>{c}</option>)}</select></label>
        <label className="grow">Find<input value={q} placeholder="note, cleaner, unit…" onChange={e => setQ(e.target.value)} /></label>
        <label>Group by<select value={group} onChange={e => { setGroup(e.target.value as GroupBy); setOpenG(new Set()); }}>
          <option value="none">Nothing</option><option value="unit">Unit</option><option value="category">Category</option><option value="month">Month</option></select></label>
      </div>
      <p className="note"><b>{shown.length}</b> line{shown.length === 1 ? '' : 's'} · <b>{money(total)}</b>
        {from || to ? ` · ${from || '…'} → ${to || '…'}` : ''}{capped ? ' · ▲ only the latest lines are shown — narrow the dates' : ''}</p>

      <table className="units">
        <thead><tr><th>Date</th><th>Unit</th><th>Category</th><th className="n">Amount</th><th>Note</th><th>By</th><th></th></tr></thead>
        <tbody>
          {group === 'none' ? shown.map(row) : groups.map(g => {
            const on = openG.has(g.k);
            return [
              <tr key={`g-${g.k}`} className="costs-group" onClick={() => setOpenG(s => { const n = new Set(s); if (n.has(g.k)) n.delete(g.k); else n.add(g.k); return n; })}>
                <td colSpan={3}><button type="button" className="link" aria-expanded={on}>{on ? '▾' : '▸'} <b>{g.k}</b></button>
                  <span className="muted"> · {g.rs.length} line{g.rs.length === 1 ? '' : 's'}</span></td>
                <td className="n"><b>{money(g.sum)}</b></td><td colSpan={3}></td>
              </tr>,
              ...(on ? g.rs.map(row) : [])
            ];
          })}
          {shown.length === 0 && <tr><td colSpan={7} className="note">Nothing in these dates and filters.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

/**
 * Orders not bought yet (§150, owner: "see the draft orders in case they
 * forget"): the inventory's draft order and every open order with no purchase
 * recorded — bought, they become a Restock line here.
 */
function OpenOrders() {
  const [inv, setInv] = useState<Inventory | null>(null);
  useEffect(() => { void getInventory().then(r => { if (r.ok) setInv(r); }).catch(() => {}); }, []);
  const [msg, setMsg] = useState('');
  if (!inv) return null;
  const waiting = inv.orders.filter(o => !o.purchases);
  if (!inv.draft && !waiting.length && !inv.toPayBack.length) return null;
  const owed = inv.toPayBack.reduce((m, p) => m.set(p.paidBy, (m.get(p.paidBy) ?? 0) + p.total), new Map<string, number>());
  const paid = async (id: string) => {
    setMsg('');
    const r = await inventoryAction({ action: 'paidBack', id }).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) setMsg(r.message ?? 'Not saved.'); else setInv(r);
  };
  const n = (ls: { qty: number }[]) => `${ls.length} line${ls.length === 1 ? '' : 's'}`;
  return (
    <div className="card costs-orders">
      {(inv.draft || waiting.length > 0) && <>
        <b><Icon n="cart" /> Orders not bought yet</b>
        <ul>
          {inv.draft && <li><Icon n="note" /> Draft order — {n(inv.draft.lines)}, saved {inv.draft.savedAt} by {inv.draft.savedBy.split('@')[0]} · Operations → Inventory → To order</li>}
          {waiting.map(o => <li key={o.todoId}>{o.at} · {o.title} — {n(o.lines)} · Operations → To-do → + <Icon n="cart" /> purchase</li>)}
        </ul>
      </>}
      {inv.toPayBack.length > 0 && <>
        <b><Icon n="cash" /> To pay back</b> <span className="muted">— bought with their own money: {[...owed].map(([who, sum]) => `${who} ${money(sum)}`).join(' · ')}</span>
        <ul>
          {inv.toPayBack.map(p => <li key={p.id}>{p.at} · <b>{p.paidBy}</b> · {money(p.total)}{p.todo ? ` · ${p.todo}` : ''}{p.note ? ` — ${p.note}` : ''}
            {p.photos.map((f, i) => <a key={i} href={f.url} target="_blank" rel="noreferrer"> <Icon n="clip" /></a>)}
            {' '}<button className="link" onClick={() => void paid(p.id)}>✓ Paid back</button></li>)}
        </ul>
        {msg && <p className="breach">{msg}</p>}
      </>}
    </div>
  );
}
