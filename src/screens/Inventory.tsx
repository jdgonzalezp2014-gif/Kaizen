/**
 * Operations → Inventory (§134, §150): the supplies each PLACE holds — the
 * Repository's storages and each house's own closet; units hold none — as the
 * record has them; a count that reconciles the record with what is really
 * there; what to order for the coming cleans of the units each place supplies;
 * and the reports from the field (cleaners and the people they hire).
 *
 * Which place a unit draws from is the Repository's `storage` column, and
 * only there (Setup → Inventory shows the map). The record is only as good as
 * its last count — so every place says when it was counted, and a "not there"
 * report asks for a count instead of changing the number on one person's word.
 */
import { Fragment, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getInventory, inventoryAction, inventoryItemAction, inventoryUpload, type InvItemRow, type InvPlace, type Inventory } from '../api.ts';
import { CATEGORIES, reconcile } from '../lib/inventory.ts';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-12 …" → "Oct 12". */
const short = (at: string) => `${MON[Number(at.slice(5, 7)) - 1]} ${Number(at.slice(8, 10))}`;
const fmt = (n: number | null | undefined) => n == null ? '—' : String(Math.round(n * 100) / 100);
const KIND_WORD: Record<string, string> = { count: '▣ counted', used: '− used', purchase: '+ bought', adjust: '± corrected', missing: '⚠ not there',
                                             taken: '↗ taken for a clean' };
const SOURCE_WORD: Record<string, string> = { team: 'team', cleaner: 'cleaner', link: 'cleaner’s helper' };
/** A house's own place reads as its closet. */
const placeTitle = (p: Pick<InvPlace, 'name' | 'self'>) => p.self ? `${p.name} — closet` : p.name;
const pk = (place: string | null) => place ?? '';
/** The Repository record that holds the assignment: the link opens it (§150). */
export const repoHref = (recordId: string) => `/?repo=${encodeURIComponent(recordId)}`;

/**
 * How the view talks to the server — the real API, or Practice's (§139, §150:
 * the team trains on the same screen with example data, nothing leaves the browser).
 */
type InvResult = ({ ok: true; todoId?: string } & Inventory) | { ok: false; message?: string };
export interface InvTransport {
  get: () => Promise<InvResult>; act: (body: Record<string, unknown>) => Promise<InvResult>; upload: (form: FormData) => Promise<InvResult>;
}
const REAL: InvTransport = { get: getInventory, act: inventoryAction, upload: inventoryUpload } as InvTransport;
const InvApi = createContext<InvTransport>(REAL);

export function InventoryView({ canEdit, api = REAL }: { canEdit: boolean; api?: InvTransport }) {
  return <InvApi.Provider value={api}><InventoryBody canEdit={canEdit} /></InvApi.Provider>;
}

function InventoryBody({ canEdit }: { canEdit: boolean }) {
  const api = useContext(InvApi);
  const [inv, setInv] = useState<Inventory | null>(null);
  const [err, setErr] = useState('');
  const [place, setPlace] = useState<string | null>(null);
  const load = () => api.get().then(r => { if (r.ok) { setInv(r); setErr(''); } else setErr(r.message ?? 'Could not load.'); })
    .catch(e => setErr(String(e)));
  useEffect(() => { void load(); }, []);
  if (err) return <p className="banner error">{err}</p>;
  if (!inv) return <p className="note loading-dot">Loading the inventory…</p>;

  const flagged = inv.places.filter(p => p.items.some(i => i.missingSince));
  const never = inv.places.filter(p => p.place && p.items.every(i => !i.countedAt));
  // The busiest place first: the one most units draw from.
  const current = inv.places.find(p => pk(p.place) === place) ?? [...inv.places].sort((a, b) => b.units.length - a.units.length)[0];
  return (
    <div className="inv">
      <div className="card">
        <h2>Inventory</h2>
        <p className="note">Supplies are kept in places — a storage, or a house's own closet — never in each unit. Each unit draws
          from the place its Repository record names (⚙ Setup → Inventory shows the map). The stock is the last count plus what was bought,
          minus what cleaners took. Counting a place resets its record and shows how far off it was. Cleaners and their helpers
          report from their pages; they cannot count or correct.</p>
        <p className="note">
          {flagged.length ? <span className="breach">⚠ {flagged.length} place{flagged.length === 1 ? '' : 's'} with something reported not there: {flagged.map(placeTitle).join(', ')}</span>
                          : '✓ Nothing reported missing.'}
          {' · '}{never.length} of {inv.places.filter(p => p.place).length} places never counted.
          {inv.unassigned.length > 0 && <> · <span className="breach">▲ {inv.unassigned.length} unit{inv.unassigned.length === 1 ? '' : 's'} with no
            place: {inv.unassigned.map(u => u.name).join(', ')}</span></>}
        </p>
        {current && <label>Place
          <select value={pk(current.place)} onChange={e => setPlace(e.target.value)}>
            {inv.places.map(p => <option key={pk(p.place)} value={pk(p.place)}>
              {placeTitle(p)}{p.units.length && !p.self ? ` · ${p.units.length} unit${p.units.length === 1 ? '' : 's'}` : ''}{p.items.some(i => i.missingSince) ? ' ⚠' : ''}</option>)}
          </select></label>}
      </div>
      {current && <PlaceStock key={pk(current.place)} inv={inv} p={current} canEdit={canEdit} onSaved={setInv} />}
      <OrderPlan inv={inv} canEdit={canEdit} onSaved={setInv} />
      {canEdit && <PurchaseForm inv={inv} onSaved={setInv} />}
      <RecentMoves inv={inv} />
    </div>
  );
}

/** One place: what the record says, what its units' cleans take, a count against it, its minimums and a quick move. */
function PlaceStock({ inv, p, canEdit, onSaved }: { inv: Inventory; p: InvPlace; canEdit: boolean; onSaved: (i: Inventory) => void }) {
  const api = useContext(InvApi);
  const items = inv.items.filter(i => i.active);
  const [mode, setMode] = useState<'view' | 'count' | 'mins'>('view');
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // §150, owner: "On record" corrected in place with − / + (something brought from outside, a loss…) —
  // staged, then saved together with why, so a stray tap never moves the stock.
  const [fix, setFix] = useState<Record<string, number>>({});
  const [why, setWhy] = useState('');
  const fixes = Object.entries(fix).filter(([, d]) => d !== 0);
  const bump = (id: string, d: number, now: number) => setFix(m => ({ ...m, [id]: Math.max(-now, (m[id] ?? 0) + d) }));
  const levelOf = (id: string) => p.items.find(l => l.itemId === id);
  const send = async (body: Record<string, unknown>, done: string) => {
    setBusy(true); setMsg('');
    try {
      const r = await api.act(body);
      if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return false; }
      onSaved(r); setMsg(done); return true;
    } catch (e) { setMsg(String(e)); return false; } finally { setBusy(false); }
  };
  const given = Object.entries(counts).filter(([, v]) => v !== '');
  const changedMins = Object.entries(counts);
  const ahead = p.units.reduce((a, u) => a + u.cleansAhead, 0);
  const edit = canEdit && !!p.place;
  return (
    <div className="card">
      <h2>{placeTitle(p)}</h2>
      <p className="note">
        {!p.place ? <>▲ What cleaners took for units that had no place at the time. Give those units a place in the Repository; these
          moves stay here.</>
          : !p.units.length ? <>No active unit draws from here now.</>
          : <>Supplies {p.units.map(u => u.name).join(', ')} — {ahead} clean{ahead === 1 ? '' : 's'} in the next {inv.aheadDays} days.</>}
        {' '}<b>Per clean</b> is the average of what cleaners reported taking (over the last {inv.windowDays} days, every clean that
        answered, “nothing” included) — the item's estimate until 3 cleans have reported. <b>To order</b> = what those cleans
        will take + the minimum to keep − what is here, once the place has been counted.</p>
      <div className="grid-scroll">
        <table className="units compact">
          <thead><tr><th>Item</th><th className="n">On record</th><th>Counted</th><th className="n">Per clean</th>
            <th className="n">Cleans take ({inv.aheadDays} d)</th><th className="n">Keep at least</th><th className="n">To order</th>
            {mode === 'count' && <><th className="n">Counted now</th><th className="n">Gap</th></>}
            {mode === 'mins' && <th className="n">New minimum</th>}</tr></thead>
          <tbody>
            {items.map(i => {
              const l = levelOf(i.id);
              const c = counts[i.id] ?? '';
              const gap = mode === 'count' && c !== '' ? reconcile(l?.qty ?? null, Number(c)).gap : null;
              return (
                <tr key={i.id}>
                  <td><b>{i.name}</b> <span className="sub-n">{i.measure}</span>
                    {l?.missingSince && <div className="breach">⚠ reported not there {short(l.missingSince)} — count it</div>}</td>
                  <td className="n">{edit && mode === 'view' ? (
                    <span className="inv-adj">
                      <button type="button" aria-label={`One less ${i.name}`} disabled={busy || ((l?.qty ?? 0) + (fix[i.id] ?? 0)) <= 0}
                              onClick={() => bump(i.id, -1, l?.qty ?? 0)}>−</button>
                      <b>{fmt((l?.qty ?? 0) + (fix[i.id] ?? 0))}</b>
                      <button type="button" aria-label={`One more ${i.name}`} disabled={busy} onClick={() => bump(i.id, 1, l?.qty ?? 0)}>+</button>
                      {fix[i.id] ? <span className="breach"> {fix[i.id]! > 0 ? `+${fix[i.id]}` : fix[i.id]}</span> : null}
                    </span>) : fmt(l?.qty)}</td>
                  <td>{l?.countedAt ? short(l.countedAt) : <span className="sub-n">never</span>}</td>
                  <td className="n">{fmt(l?.perClean)}{l?.perClean != null && <span className="sub-n">{l.learned ? ` avg of ${l.reportedCleans}` : ' est.'}</span>}</td>
                  <td className="n">{l?.need ? l.need : '—'}</td>
                  <td className="n">{fmt(l?.min)}{l?.min != null && <span className="sub-n">{l.minOwn ? ' here' : ' item'}</span>}</td>
                  <td className="n">{l?.toOrder ? <b>{l.toOrder}</b> : '—'}</td>
                  {mode === 'count' && <>
                    <td className="n"><input className="inv-qty" type="number" inputMode="decimal" min="0" step="any" value={c}
                                             onChange={e => setCounts(m => ({ ...m, [i.id]: e.target.value }))} /></td>
                    <td className="n">{gap == null ? (c !== '' ? 'first count' : '') : gap === 0 ? '✓ 0' : <span className="breach">{gap > 0 ? `+${gap}` : gap}</span>}</td>
                  </>}
                  {mode === 'mins' && <td className="n"><input className="inv-qty" type="number" inputMode="decimal" min="0" step="any"
                    value={counts[i.id] ?? (l?.minOwn ? String(l.min) : '')} placeholder={fmt(i.reorderAt)}
                    onChange={e => setCounts(m => ({ ...m, [i.id]: e.target.value }))} /></td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {edit && (
        <div className="button-row">
          {mode === 'view' && fixes.length > 0 && <>
            <input value={why} maxLength={500} placeholder="Why — e.g. brought from outside, broken, lent" onChange={e => setWhy(e.target.value)} />
            <button disabled={busy || !why.trim()}
                    onClick={async () => { if (await send({ action: 'adjusts', place: p.place, note: why, adjusts: fixes.map(([itemId, qty]) => ({ itemId, qty })) },
                                                      `Corrected ${fixes.length} item${fixes.length === 1 ? '' : 's'}.`)) { setFix({}); setWhy(''); } }}>
              Save corrections ({fixes.length})</button>
            <button className="secondary" onClick={() => { setFix({}); setWhy(''); }}>Undo</button>
          </>}
          {mode === 'view' && !fixes.length && <>
            <button onClick={() => { setMode('count'); setCounts({}); setMsg(''); }}>▣ Count {placeTitle(p)}</button>
            <button className="secondary" onClick={() => { setMode('mins'); setCounts({}); setMsg(''); }}>✎ Minimums here</button>
          </>}
          {mode === 'count' && <>
            <button disabled={busy || !given.length}
                    onClick={async () => { if (await send({ action: 'count', place: p.place, counts: given.map(([itemId, qty]) => ({ itemId, qty })) },
                                                      `Counted ${given.length} item${given.length === 1 ? '' : 's'}.`)) { setMode('view'); setCounts({}); } }}>
              Save the count ({given.length})</button>
            <span className="note">Only the items you fill in are counted; the rest keep their record.</span>
          </>}
          {mode === 'mins' && <>
            <button disabled={busy || !changedMins.length}
                    onClick={async () => { if (await send({ action: 'mins', place: p.place, mins: changedMins.map(([itemId, qty]) => ({ itemId, qty })) },
                                                      'Minimums saved.')) { setMode('view'); setCounts({}); } }}>Save the minimums</button>
            <span className="note">Blank = the item's own minimum (Setup → Inventory).</span>
          </>}
          {mode !== 'view' && <button className="secondary" onClick={() => { setMode('view'); setCounts({}); }}>Cancel</button>}
          {msg && <span className="note">{msg}</span>}
        </div>
      )}
      {edit && mode === 'view' && <p className="note">− / + on “On record” corrects it (say why); a full count replaces it. What was bought
        goes in 🧾 Record a purchase (below), with its cost.</p>}
    </div>
  );
}

/**
 * Items, each to one place or split between several (§150, owner) — the
 * order and the purchase are written the same way: "Everything goes to" sends
 * every line to one place by default (most purchases go to one storage); 🔍
 * adds any item; ⑂ on a part splits it — half to another place, which can be
 * split again; "one place" puts the item back together.
 */
type Part = { place: string; qty: string };
type Lines = Map<string, Part[]>;
const flat = (m: Lines) => [...m].flatMap(([itemId, parts]) => parts.map(p => ({ itemId, place: p.place, qty: Math.ceil(Number(p.qty) || 0) })))
  .filter(l => l.qty > 0 && l.place);
function ItemLines({ inv, value, onChange, hints, canEdit, defaultPlace }: {
  inv: Inventory; value: Lines; onChange: (m: Lines) => void; hints?: Lines; canEdit: boolean; defaultPlace?: string | null;
}) {
  const places = inv.places.filter(p => p.place);
  const [q, setQ] = useState('');
  const item = (id: string) => inv.items.find(i => i.id === id);
  const placeName = (key: string) => { const p = places.find(x => x.place === key); return p ? placeTitle(p) : key; };
  // Everything goes where it was asked for, else where most units draw from — until someone says otherwise.
  const [allTo, setAllTo] = useState(defaultPlace ?? [...places].sort((a, b) => b.units.length - a.units.length)[0]?.place ?? '');
  const busiest = allTo;
  const set = (id: string, parts: Part[] | null) => { const n = new Map(value); if (parts?.length) n.set(id, parts); else n.delete(id); onChange(n); };
  // Lines not split follow "Everything goes to"; a split line keeps its parts.
  const sendAll = (place: string) => {
    setAllTo(place);
    onChange(new Map([...value].map(([id, parts]) => [id, parts.length === 1 ? [{ ...parts[0]!, place }] : parts])));
  };
  const splitPart = (id: string, parts: Part[], k: number) => {
    const p = parts[k]!, n = Math.ceil(Number(p.qty) || 0);
    const other = places.find(x => !parts.some(q => q.place === x.place))?.place ?? p.place;
    const half = Math.floor(n / 2);
    set(id, [...parts.slice(0, k), { ...p, qty: n ? String(n - half) : p.qty }, { place: other, qty: n ? String(half) : '' }, ...parts.slice(k + 1)]);
  };
  const found = q.trim() ? inv.items.filter(i => i.active && !value.has(i.id) && i.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];
  return <>
    {canEdit && places.length > 1 && <label>Everything goes to
      <select value={allTo} onChange={e => sendAll(e.target.value)}>
        {places.map(x => <option key={x.place} value={x.place!}>{placeTitle(x)}</option>)}</select>
      <span className="sub-n">items not split follow this; ⑂ splits one part to another place</span></label>}
    {canEdit && <label>🔍 Add an item
      <input value={q} placeholder="Search the supplies list…" onChange={e => setQ(e.target.value)} /></label>}
    {found.length > 0 && <div className="button-row">{found.map(i => (
      <button key={i.id} className="secondary" onClick={() => { set(i.id, [{ place: busiest, qty: '' }]); setQ(''); }}>+ {i.name}</button>))}</div>}
    {q.trim() && !found.length && <p className="note">No other item matches “{q.trim()}”.</p>}
    {value.size > 0 && (
      <div className="grid-scroll">
        <table className="units compact">
          <thead><tr><th>Item</th><th className="n">Total</th><th>Goes to</th><th></th></tr></thead>
          <tbody>
            {[...value].map(([id, parts]) => {
              const total = parts.reduce((a, p) => a + Math.ceil(Number(p.qty) || 0), 0);
              const hint = hints?.get(id);
              return (
                <tr key={id}>
                  <td><b>{item(id)?.name}</b> <span className="sub-n">{item(id)?.measure}</span>
                    {hint && <div className="sub-n">suggested: {hint.map(h => `${h.place ? placeName(h.place) : '▲ no place'} ${h.qty}`).join(' · ')}</div>}</td>
                  <td className="n"><b>{total || '—'}</b></td>
                  <td>
                    {parts.map((p, k) => (
                      <div key={k} className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <select value={p.place} aria-label="Place" onChange={e => set(id, parts.map((x, j) => j === k ? { ...x, place: e.target.value } : x))}>
                          {!p.place && <option value="">▲ choose a place</option>}
                          {places.map(x => <option key={x.place} value={x.place!}>{placeTitle(x)}</option>)}</select>
                        <input className="inv-qty" type="number" min="0" step="1" value={p.qty} aria-label="Quantity"
                               onChange={e => set(id, parts.map((x, j) => j === k ? { ...x, qty: e.target.value } : x))} />
                        {canEdit && <button className="link tiny" title="Split this part: half to another place" onClick={() => splitPart(id, parts, k)}>⑂ split</button>}
                        {parts.length > 1 && <button className="link tiny" aria-label="Remove this place" onClick={() => set(id, parts.filter((_, j) => j !== k))}>✕</button>}
                      </div>))}
                    {canEdit && parts.length > 1 && <button className="link tiny" onClick={() => set(id, [{ place: parts[0]!.place, qty: String(total) }])}>⇢ one place</button>}
                  </td>
                  <td className="n">{canEdit && <button className="link tiny danger" onClick={() => set(id, null)}>remove</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>)}
  </>;
}
const linesOf = (ls: { itemId: string; place: string; qty: number }[]): Lines => {
  const m: Lines = new Map();
  for (const l of ls) m.set(l.itemId, [...m.get(l.itemId) ?? [], { place: l.place, qty: String(l.qty) }]);
  return m;
};

/**
 * The ORDER (§150, owner): a shopping to-do, item by item, each to its place.
 * Suggested: what each counted place is short of for the coming cleans.
 * Nothing changes the stock until the purchase is recorded.
 */
function OrderPlan({ inv, canEdit, onSaved }: { inv: Inventory; canEdit: boolean; onSaved: (i: Inventory) => void }) {
  const api = useContext(InvApi);
  const suggested = useMemo(() => linesOf(inv.places.filter(p => p.place).flatMap(p => p.items.filter(l => l.toOrder > 0)
    .map(l => ({ itemId: l.itemId, place: p.place!, qty: l.toOrder })))), [inv]);
  const [order, setOrder] = useState<Lines>(() => new Map(suggested));
  useEffect(() => setOrder(new Map(suggested)), [suggested]);
  // §150: an order can belong to a to-do from the field — a clean's supplies request, a problem.
  const [forTodo, setForTodo] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = flat(order);
  const nItems = new Set(lines.map(l => l.itemId)).size;
  // Nothing is suggested for a place until it has been counted: its record would be a guess.
  const uncounted = inv.places.filter(p => p.place && p.units.length && p.items.every(l => !l.countedAt));
  return (
    <div className="card">
      <h2>🛒 To order — next {inv.aheadDays} days</h2>
      <p className="note">An order is a shopping to-do: a line per item and where it goes. Suggested: what each place's units will take
        in the next {inv.aheadDays} days, plus its minimum, minus what it holds — places never counted are not guessed at. The stock
        changes only when the purchase is recorded (🧾 below).</p>
      {uncounted.length > 0 && <p className="note">▲ Count first (nothing is suggested for them until then): {uncounted.map(placeTitle).join(', ')}.</p>}
      {!order.size && <p className="note">Nothing to order from what has been counted. Add an item with 🔍 to order it anyway.</p>}
      <ItemLines inv={inv} value={order} onChange={setOrder} hints={suggested} canEdit={canEdit} />
      {canEdit && order.size > 0 && inv.fieldTodos.length > 0 && <label>For
        <select value={forTodo} onChange={e => setForTodo(e.target.value)}>
          <option value="">a new order to-do</option>
          {inv.fieldTodos.map(t => <option key={t.id} value={t.id}>{t.group === 'problem' ? '⚠️' : '🧴'} {t.title}</option>)}
        </select></label>}
      {canEdit && order.size > 0 && <div className="button-row">
        <button disabled={busy || !lines.length} onClick={async () => {
          setBusy(true); setMsg('');
          try {
            const r = await api.act({ action: 'order', lines, forTodo: forTodo || undefined });
            if (!r.ok) setMsg(r.message ?? 'Not saved.');
            else { onSaved(r); setMsg(forTodo ? '✓ Order added to that to-do.' : '✓ Order created — a to-do in Operations → To-do.'); setForTodo(''); }
          } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
        }}>{forTodo ? 'Add the order to that to-do' : 'Create the order'} ({nItems} item{nItems === 1 ? '' : 's'})</button>
        {suggested.size > 0 && <button className="secondary" onClick={() => setOrder(new Map(suggested))}>Back to the suggestion</button>}
        {msg && <span className="note">{msg}</span>}
      </div>}
    </div>
  );
}

/**
 * The PURCHASE (§150, owner): what was really bought — from an open order
 * (its lines come filled in, the inspector's too) or from scratch. It adds to
 * each place's stock and reaches Costs (Restock) with the receipt.
 */
function PurchaseForm({ inv, onSaved }: { inv: Inventory; onSaved: (i: Inventory) => void }) {
  const api = useContext(InvApi);
  const [todoId, setTodoId] = useState('');
  const [lines, setLines] = useState<Lines>(new Map());
  const [total, setTotal] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = (id: string) => {
    setTodoId(id);
    const o = inv.orders.find(x => x.todoId === id);
    setLines(o ? linesOf(o.lines) : new Map());
  };
  const out = flat(lines);
  const unplaced = [...lines.values()].some(ps => ps.some(p => !p.place && Number(p.qty) > 0));
  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const f = new FormData();
      f.append('action', 'purchase'); f.append('lines', JSON.stringify(out)); f.append('total', total); f.append('note', note);
      if (todoId) f.append('todoId', todoId);
      for (const x of files) f.append('file', x);
      const r = await api.upload(f);
      if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
      onSaved(r); setMsg('✓ Purchase recorded: in the stock and in Costs (Restock).');
      setTodoId(''); setLines(new Map()); setTotal(''); setNote(''); setFiles([]);
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <h2>🧾 Record a purchase</h2>
      <p className="note">What was really bought: it adds to each place's stock and goes to Costs as one Restock expense with its receipt.
        Start from an open order (its lines come filled in) or add the items with 🔍. Close the order in To-do once everything is bought.</p>
      <label>For the order
        <select value={todoId} onChange={e => pick(e.target.value)}>
          <option value="">— none (a purchase on its own)</option>
          {inv.orders.map(o => <option key={o.todoId} value={o.todoId}>{o.at} · {o.title}{o.purchases ? ` · ${o.purchases} purchase${o.purchases === 1 ? '' : 's'} so far` : ''}</option>)}
        </select></label>
      <ItemLines inv={inv} value={lines} onChange={setLines} canEdit />
      <div className="row">
        <label>Total paid ($)<input type="number" inputMode="decimal" min="0" step="0.01" value={total} onChange={e => setTotal(e.target.value)} /></label>
        <label>Note<input value={note} maxLength={500} placeholder="Store, card…" onChange={e => setNote(e.target.value)} /></label>
        <label className="chip">📎 {files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'Receipt'}
          <input type="file" accept="image/*,application/pdf" multiple hidden onChange={e => setFiles([...(e.target.files ?? [])].slice(0, 5))} /></label>
      </div>
      <div className="button-row">
        <button disabled={busy || !out.length || unplaced || !(Number(total) > 0)} onClick={() => void save()}>{busy ? 'Saving…' : 'Record the purchase'}</button>
        {unplaced && <span className="note">▲ Say which place each item went to.</span>}
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}

function RecentMoves({ inv }: { inv: Inventory }) {
  const [all, setAll] = useState(false);
  const shown = all ? inv.recent : inv.recent.slice(0, 15);
  return (
    <div className="card">
      <h2>Recent moves &amp; reports</h2>
      {!inv.recent.length ? <p className="note">Nothing yet. Cleaners report from their page; their helpers from the link they share.</p> : <>
        <div className="grid-scroll">
          <table className="units compact">
            <thead><tr><th>When</th><th>Who</th><th>Place</th><th>Item</th><th>What</th><th className="n">Qty</th><th>Note</th></tr></thead>
            <tbody>
              {shown.map(m => (
                <tr key={m.id}>
                  <td>{m.at}</td><td>{m.byName}<div className="sub-n">{SOURCE_WORD[m.source]}</div></td>
                  <td>{m.place ?? '▲ no place'}{m.unit && <div className="sub-n">{m.kind === 'taken' ? '→ ' : ''}{m.unit}</div>}</td><td>{m.item}</td>
                  <td className={m.kind === 'missing' ? 'breach' : undefined}>{KIND_WORD[m.kind]}</td><td className="n">{fmt(m.qty)}</td>
                  <td className="ops-note">{m.note}{m.photos?.map((p, i) => <Fragment key={i}> <a href={p.url} target="_blank" rel="noreferrer">📎</a></Fragment>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {inv.recent.length > 15 && <button className="link" onClick={() => setAll(a => !a)}>{all ? 'Show fewer' : `Show all ${inv.recent.length}`}</button>}
      </>}
    </div>
  );
}

/**
 * Setup → Inventory: which place each unit draws from (§150). Read from the
 * Repository's `storage` column — the one source; changed there, so each
 * unit links to its record.
 */
function PlacesMap({ inv }: { inv: Inventory }) {
  const rec = (u: { name: string; recordId: string | null }) =>
    u.recordId ? <a href={repoHref(u.recordId)} target="_blank" rel="noreferrer">{u.name}</a> : <span>{u.name} <span className="sub-n">(no Repository record)</span></span>;
  const storages = inv.places.filter(p => p.place && !p.self);
  const closets = inv.places.filter(p => p.self);
  return (
    <div className="card">
      <h2>Places &amp; who draws from them</h2>
      <p className="note">A unit's supplies come from the place its Repository record names in <b>Storage</b>: a Storage row
        (e.g. S1105), or the house's own name = its own closet. Click a unit to change it there; past moves stay where they happened.
        A new storage = a new record with Property type “Storage” in a Units table.</p>
      {inv.unassigned.length > 0 && <p className="breach">▲ No place ({inv.unassigned.length}): {inv.unassigned.map((u, i) =>
        <Fragment key={u.id}>{i ? ', ' : ''}{rec(u)}</Fragment>)} — what their cleaners take is recorded with no place until this is set.</p>}
      <div className="grid-scroll">
        <table className="units compact">
          <thead><tr><th>Place</th><th>Units</th></tr></thead>
          <tbody>
            {storages.map(p => <tr key={p.place}><td><b>{p.name}</b></td>
              <td>{p.units.length ? p.units.map((u, i) => <Fragment key={u.id}>{i ? ', ' : ''}{rec(u)}</Fragment>) : <span className="sub-n">none now</span>}</td></tr>)}
            {closets.map(p => <tr key={p.place}><td>{p.name} <span className="sub-n">closet</span></td>
              <td>{p.units.map((u, i) => <Fragment key={u.id}>{i ? ', ' : ''}{rec(u)}</Fragment>)}</td></tr>)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A cleaner's "I bought something" approved by recording it (§150, owner):
 * they said it in their own words; the team says which items and where each
 * went — new lines start at the place of the unit it was for.
 */
export function FieldPurchaseLines({ unitId, said, onSave, onCancel }: {
  unitId: string | null; said: string; onSave: (lines: { itemId: string; place: string; qty: number }[]) => Promise<void>; onCancel: () => void;
}) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [lines, setLines] = useState<Lines>(new Map());
  const [busy, setBusy] = useState(false);
  useEffect(() => { void getInventory().then(r => { if (r.ok) setInv(r); }); }, []);
  if (!inv) return <p className="note loading-dot">Loading the supplies…</p>;
  const out = flat(lines);
  const home = inv.places.find(p => p.units.some(u => u.id === unitId))?.place ?? null;
  return (
    <div className="card">
      <p className="note">They wrote: <b>“{said.replace(/^Bought: /, '')}”</b>. Record it in the inventory to approve it — the items and
        where each went. That purchase adds to the stock and goes to Costs (Restock) with their receipt.</p>
      <ItemLines inv={inv} value={lines} onChange={setLines} canEdit defaultPlace={home} />
      <div className="button-row">
        <button className="small" disabled={busy || !out.length} onClick={async () => { setBusy(true); try { await onSave(out); } finally { setBusy(false); } }}>
          {busy ? 'Saving…' : '✓ Approve and record'}</button>
        <button className="small secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Operations → Setup → Inventory (§134, §150): who draws from which place, and the supplies list. */
export function InventorySetup() {
  const [inv, setInv] = useState<Inventory | null>(null);
  const load = () => void getInventory().then(r => { if (r.ok) setInv(r); });
  useEffect(load, []);
  if (!inv) return <div className="card"><h2>Supplies list</h2><p className="note loading-dot">Loading…</p></div>;
  return <><PlacesMap inv={inv} /><Catalog items={inv.items} onSaved={load} /></>;
}

/** The supplies the team keeps track of. Switching one off keeps its history. */
function Catalog({ items, onSaved }: { items: InvItemRow[]; onSaved: () => void }) {
  const blank = { id: '', name: '', category: 'other', measure: 'unit', perClean: '', reorderAt: '', active: true };
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState('');
  const send = async (body: Record<string, unknown>, done: string) => {
    const r = await inventoryItemAction(body).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return false; }
    setMsg(done); onSaved(); return true;
  };
  return (
    <div className="card">
      <h2>Supplies list</h2>
      <p className="note">What is tracked, how it is counted, the starting estimate per clean (until cleaners have reported 3 cleans), and the minimum to keep in a place unless the place sets its own.</p>
      <div className="grid-scroll">
        <table className="units compact">
          <thead><tr><th>Item</th><th>Category</th><th>Counted in</th><th className="n">Per clean (est.)</th><th className="n">Keep at least</th><th></th></tr></thead>
          <tbody>
            {items.map(i => (
              <tr key={i.id} className={i.active ? undefined : 'muted-row'}>
                <td><b>{i.name}</b>{!i.active && <span className="sub-n"> · off</span>}</td><td>{i.category}</td><td>{i.measure}</td>
                <td className="n">{fmt(i.perClean)}</td><td className="n">{fmt(i.reorderAt)}</td>
                <td className="n">
                  <button className="link tiny" onClick={() => setForm({ id: i.id, name: i.name, category: i.category, measure: i.measure,
                    perClean: i.perClean == null ? '' : String(i.perClean), reorderAt: i.reorderAt == null ? '' : String(i.reorderAt), active: i.active })}>edit</button>{' '}
                  {i.active && <button className="link tiny danger" onClick={() => void send({ action: 'delete', id: i.id }, `${i.name} switched off.`)}>remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>{form.id ? `Edit ${form.name}` : 'Add an item'}</h3>
      <div className="row">
        <label>Name<input value={form.name} maxLength={120} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></label>
        <label>Category<select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Counted in<input value={form.measure} maxLength={20} placeholder="roll, bottle, pod…" onChange={e => setForm(f => ({ ...f, measure: e.target.value }))} /></label>
        <label>Per clean (est.)<input type="number" min="0" step="any" value={form.perClean} onChange={e => setForm(f => ({ ...f, perClean: e.target.value }))} /></label>
        <label>Keep at least<input type="number" min="0" step="any" value={form.reorderAt} onChange={e => setForm(f => ({ ...f, reorderAt: e.target.value }))} /></label>
      </div>
      {form.id && <label className="check"><input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} /> Active</label>}
      <div className="button-row">
        <button disabled={!form.name.trim()} onClick={async () => { if (await send({ action: 'save', ...form, id: form.id || undefined }, form.id ? 'Saved.' : 'Added.')) setForm(blank); }}>
          {form.id ? 'Save' : 'Add'}</button>
        {form.id && <button className="secondary" onClick={() => setForm(blank)}>Cancel</button>}
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}
