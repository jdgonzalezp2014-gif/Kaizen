/**
 * Operations → Inventory (§134): the supplies each unit and the storage
 * hold, as the record has them; a count that reconciles the record with
 * what is really there; what to order for the coming cleans; and the
 * reports from the field (cleaners and the people they hire).
 *
 * The record is only as good as its last count — so every place says when
 * it was counted, and a "not there" report from the field asks for a count
 * instead of changing the number on one person's word.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { getInventory, inventoryAction, inventoryItemAction, type InvItemRow, type Inventory } from '../api.ts';
import { CATEGORIES, reconcile } from '../lib/inventory.ts';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-12 …" → "Oct 12". */
const short = (at: string) => `${MON[Number(at.slice(5, 7)) - 1]} ${Number(at.slice(8, 10))}`;
const fmt = (n: number | null | undefined) => n == null ? '—' : String(Math.round(n * 100) / 100);
const KIND_WORD: Record<string, string> = { count: '▣ counted', used: '− used', purchase: '+ bought', adjust: '± corrected', missing: '⚠ not there',
                                             taken: '↗ taken for a clean' };
const SOURCE_WORD: Record<string, string> = { team: 'team', cleaner: 'cleaner', link: 'cleaner’s helper' };

export function InventoryView({ canEdit }: { canEdit: boolean }) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [err, setErr] = useState('');
  const [place, setPlace] = useState<string>('storage');
  const load = () => getInventory().then(r => { if (r.ok) { setInv(r); setErr(''); } else setErr(r.message ?? 'Could not load.'); })
    .catch(e => setErr(String(e)));
  useEffect(() => { void load(); }, []);
  if (err) return <p className="banner error">{err}</p>;
  if (!inv) return <p className="note loading-dot">Loading the inventory…</p>;

  const flagged = inv.places.filter(p => p.items.some(i => i.missingSince));
  const never = inv.places.filter(p => p.items.every(i => !i.countedAt));
  const current = inv.places.find(p => (p.unitId ?? 'storage') === place) ?? inv.places[0]!;
  return (
    <div className="inv">
      <div className="card">
        <h2>Inventory</h2>
        <p className="note">The stock is the last count plus what was bought, minus what cleaners reported using. Counting a place
          resets its record and shows how far off it was. Cleaners and their helpers report from their pages; they cannot count or correct.</p>
        <p className="note">
          {flagged.length ? <span className="breach">⚠ {flagged.length} place{flagged.length === 1 ? '' : 's'} with something reported not there: {flagged.map(p => p.place).join(', ')}</span>
                          : '✓ Nothing reported missing.'}
          {' · '}{never.length} of {inv.places.length} places never counted.
        </p>
        <label>Place
          <select value={place} onChange={e => setPlace(e.target.value)}>
            {inv.places.map(p => <option key={p.unitId ?? 'storage'} value={p.unitId ?? 'storage'}>
              {p.place}{p.items.some(i => i.missingSince) ? ' ⚠' : ''}</option>)}
          </select></label>
      </div>
      <PlaceStock key={place} inv={inv} unitId={current.unitId} canEdit={canEdit} onSaved={setInv} />
      <OrderPlan inv={inv} canEdit={canEdit} onSaved={setInv} />
      <RecentMoves inv={inv} />
    </div>
  );
}

/** One place: what the record says, a count against it, and a quick move. */
function PlaceStock({ inv, unitId, canEdit, onSaved }: { inv: Inventory; unitId: string | null; canEdit: boolean; onSaved: (i: Inventory) => void }) {
  const p = inv.places.find(x => x.unitId === unitId)!;
  const items = inv.items.filter(i => i.active);
  const [counting, setCounting] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [move, setMove] = useState({ kind: 'purchase', itemId: '', qty: '', note: '', cost: '' });
  const levelOf = (id: string) => p.items.find(l => l.itemId === id);
  const send = async (body: Record<string, unknown>, done: string) => {
    setBusy(true); setMsg('');
    try {
      const r = await inventoryAction(body);
      if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return false; }
      onSaved(r); setMsg(done); return true;
    } catch (e) { setMsg(String(e)); return false; } finally { setBusy(false); }
  };
  const given = Object.entries(counts).filter(([, v]) => v !== '');
  return (
    <div className="card">
      <h2>{p.place}</h2>
      <p className="note">{unitId ? <>{p.cleansAhead} clean{p.cleansAhead === 1 ? '' : 's'} in the next {inv.aheadDays} days. Per clean: the item's estimate,
          until 3 cleans here have reported uses (then “learned”, over the last {inv.windowDays} days).</>
          : <>The central storage: what is bought goes here; what cleaners take for a clean comes out of here (the
            houses' own records do not change). "Cleans take" is what the next {inv.aheadDays} days of cleans will take out,
            from what each house's cleans took before (or the item's estimate); "To order" adds the minimum to keep and
            subtracts what is here — once the storage has been counted.</>}</p>
      <div className="grid-scroll">
        <table className="units compact">
          <thead><tr><th>Item</th><th className="n">On record</th><th>Counted</th>{unitId && <th className="n">Per clean</th>}
            {!unitId && <th className="n">Cleans take ({inv.aheadDays} d)</th>}<th className="n">To order</th>{counting && <><th className="n">Counted now</th><th className="n">Gap</th></>}</tr></thead>
          <tbody>
            {items.map(i => {
              const l = levelOf(i.id);
              const c = counts[i.id] ?? '';
              const gap = c !== '' ? reconcile(l?.qty ?? null, Number(c)).gap : null;
              return (
                <tr key={i.id}>
                  <td><b>{i.name}</b> <span className="sub-n">{i.measure}</span>
                    {l?.missingSince && <div className="breach">⚠ reported not there {short(l.missingSince)} — count it</div>}</td>
                  <td className="n">{fmt(l?.qty)}</td>
                  <td>{l?.countedAt ? short(l.countedAt) : <span className="sub-n">never</span>}</td>
                  {unitId && <td className="n">{fmt(l?.perClean)}{l?.perClean != null && <span className="sub-n">{l.learned ? ' learned' : ' est.'}</span>}</td>}
                  {!unitId && <td className="n">{l?.need ? l.need : '—'}</td>}
                  <td className="n">{l?.toOrder ? <b>{l.toOrder}</b> : '—'}</td>
                  {counting && <>
                    <td className="n"><input className="inv-qty" type="number" inputMode="decimal" min="0" step="any" value={c}
                                             onChange={e => setCounts(m => ({ ...m, [i.id]: e.target.value }))} /></td>
                    <td className="n">{gap == null ? (c !== '' ? 'first count' : '') : gap === 0 ? '✓ 0' : <span className="breach">{gap > 0 ? `+${gap}` : gap}</span>}</td>
                  </>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="button-row">
          {!counting ? <button onClick={() => { setCounting(true); setMsg(''); }}>▣ Count {p.place}</button> : <>
            <button disabled={busy || !given.length}
                    onClick={async () => { if (await send({ action: 'count', unitId, counts: given.map(([itemId, qty]) => ({ itemId, qty })) },
                                                      `Counted ${given.length} item${given.length === 1 ? '' : 's'}.`)) { setCounting(false); setCounts({}); } }}>
              Save the count ({given.length})</button>
            <button className="secondary" onClick={() => { setCounting(false); setCounts({}); }}>Cancel</button>
            <span className="note">Only the items you fill in are counted; the rest keep their record.</span>
          </>}
          {msg && <span className="note">{msg}</span>}
        </div>
      )}
      {canEdit && !counting && (
        <>
          <h3>Record a move here</h3>
          <div className="row">
            <label>What<select value={move.kind} onChange={e => setMove(m => ({ ...m, kind: e.target.value }))}>
              <option value="purchase">Bought / brought in</option><option value="used">Used</option><option value="adjust">Correct (+ or −)</option>
            </select></label>
            <label>Item<select value={move.itemId} onChange={e => setMove(m => ({ ...m, itemId: e.target.value }))}>
              <option value="">—</option>{items.map(i => <option key={i.id} value={i.id}>{i.name} ({i.measure})</option>)}</select></label>
            <label>Quantity<input type="number" inputMode="decimal" step="any" value={move.qty} onChange={e => setMove(m => ({ ...m, qty: e.target.value }))} /></label>
            <label>Note<input value={move.note} maxLength={500} onChange={e => setMove(m => ({ ...m, note: e.target.value }))} /></label>
            {move.kind === 'purchase' && <label>Cost ($) <span className="sub-n">→ Costs, Restock</span>
              <input type="number" inputMode="decimal" min="0" step="0.01" value={move.cost} onChange={e => setMove(m => ({ ...m, cost: e.target.value }))} /></label>}
          </div>
          <div className="button-row">
            <button disabled={busy || !move.itemId || move.qty === ''}
                    onClick={async () => { if (await send({ action: 'move', ...move, unitId }, 'Saved.')) setMove(m => ({ ...m, itemId: '', qty: '', note: '', cost: '' })); }}>Save</button>
          </div>
        </>
      )}
    </div>
  );
}

/** What the coming cleans need, every unit at once — chosen lines become one shopping to-do. */
function OrderPlan({ inv, canEdit, onSaved }: { inv: Inventory; canEdit: boolean; onSaved: (i: Inventory) => void }) {
  // The storage first (what the cleans will take out of it), then any counted house short of its minimum.
  const lines = useMemo(() => inv.places.flatMap(p => p.items.filter(l => l.toOrder > 0)
    .map(l => ({ key: `${p.unitId}|${l.itemId}`, unitId: p.unitId, place: p.place, itemId: l.itemId, qty: l.toOrder }))), [inv]);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [off, setOff] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const name = (id: string) => inv.items.find(i => i.id === id);
  const chosen = lines.filter(l => !off.has(l.key)).map(l => ({ ...l, qty: Number(pick[l.key] ?? l.qty) || 0 })).filter(l => l.qty > 0);
  // Nothing is ordered for the storage until it has been counted: its record would be a guess.
  const storageUncounted = inv.places.find(p => !p.unitId)?.items.every(l => !l.countedAt) ?? true;
  const totals = new Map<string, number>();
  for (const l of chosen) totals.set(l.itemId, (totals.get(l.itemId) ?? 0) + l.qty);
  return (
    <div className="card">
      <h2>To order — next {inv.aheadDays} days</h2>
      <p className="note">Storage: what the next {inv.aheadDays} days of cleans will take out of it, plus the minimum, minus what
        it holds (once counted). A counted house short of its own minimum also gets a line. Houses never counted are not guessed at.</p>
      {storageUncounted && <p className="note">▲ Count the storage first (choose Storage above → ▣ Count) — until then nothing is ordered for it.</p>}
      {!lines.length ? <p className="note">Nothing to order from what has been counted.</p> : <>
        <div className="grid-scroll">
          <table className="units compact">
            <thead><tr><th></th><th>Unit</th><th>Item</th><th className="n">Quantity</th></tr></thead>
            <tbody>
              {lines.map(l => (
                <tr key={l.key} className={off.has(l.key) ? 'muted-row' : undefined}>
                  <td><input type="checkbox" checked={!off.has(l.key)} aria-label="Include"
                             onChange={() => setOff(s => { const n = new Set(s); if (n.has(l.key)) n.delete(l.key); else n.add(l.key); return n; })} /></td>
                  <td>{l.place}</td><td>{name(l.itemId)?.name} <span className="sub-n">{name(l.itemId)?.measure}</span></td>
                  <td className="n"><input className="inv-qty" type="number" min="0" step="1" value={pick[l.key] ?? String(l.qty)}
                                           onChange={e => setPick(m => ({ ...m, [l.key]: e.target.value }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note"><b>Totals to buy:</b> {[...totals].map(([id, q]) => `${name(id)?.name} × ${q}`).join(' · ') || '—'}</p>
        {canEdit && <div className="button-row">
          <button disabled={busy || !chosen.length} onClick={async () => {
            setBusy(true); setMsg('');
            try {
              const r = await inventoryAction({ action: 'order', lines: chosen.map(l => ({ itemId: l.itemId, unitId: l.unitId, qty: l.qty })) });
              if (!r.ok) setMsg(r.message ?? 'Not saved.'); else { onSaved(r); setMsg('✓ Shopping to-do created — see Operations → To-do.'); setPick({}); setOff(new Set()); }
            } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
          }}>Create the shopping to-do ({chosen.length} line{chosen.length === 1 ? '' : 's'})</button>
          {msg && <span className="note">{msg}</span>}
        </div>}
      </>}
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
                  <td>{m.kind === 'taken' ? <>Storage → {m.place}</> : m.place}</td><td>{m.item}</td>
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

/** Operations → Setup → Inventory (§134): the supplies list, with the rest of the setup. */
export function InventorySetup() {
  const [items, setItems] = useState<InvItemRow[] | null>(null);
  const load = () => void getInventory().then(r => { if (r.ok) setItems(r.items); });
  useEffect(load, []);
  if (!items) return <div className="card"><h2>Supplies list</h2><p className="note loading-dot">Loading…</p></div>;
  return <Catalog items={items} onSaved={load} />;
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
      <p className="note">What is tracked, how it is counted, the starting estimate per clean, and the minimum to keep in a unit.</p>
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
