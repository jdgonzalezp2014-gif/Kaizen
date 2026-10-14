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
import { Hint } from '../components/Hint.tsx';
import { Fragment, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getInventory, inventoryAction, inventoryItemAction, inventoryUpload, type InvItemRow, type InvPlace, type Inventory } from '../api.ts';
import { CATEGORIES, reconcile } from '../lib/inventory.ts';
import { Sheet } from '../components/InspectionRun.tsx';

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
type InvResult = ({ ok: true; todoId?: string; itemId?: string } & Inventory) | { ok: false; message?: string };
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
        <h2>Inventory <Hint>Supplies are kept in places — a storage, or a house's own closet — never in each unit. Each unit draws
          from the place its Repository record names (⚙ Setup → Inventory shows the map). The stock is the last count plus what was bought,
          minus what cleaners took. Counting a place resets its record and shows how far off it was. Cleaners and their helpers
          report from their pages; they cannot count or correct.</Hint></h2>
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

/**
 * One place: what the record says, what its units' cleans take, and — on a
 * desk — everything about it in one edit (§150, owner: "no reprocess"):
 * corrections with − [n] + on the record, its settings (name, measure,
 * estimate per clean, minimum here), items added, kept elsewhere or removed;
 * and a draft order for what is short.
 */
type ItemEdit = { name?: string; measure?: string; perClean?: string; min?: string };
function PlaceStock({ inv, p, canEdit, onSaved }: { inv: Inventory; p: InvPlace; canEdit: boolean; onSaved: (i: Inventory) => void }) {
  const api = useContext(InvApi);
  // What this place keeps — "not kept here" items are off its list (§150).
  const items = p.items.map(l => inv.items.find(i => i.id === l.itemId)).filter((i): i is InvItemRow => !!i);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  // §150, owner: counting is done onsite, on a phone — a sheet like the inspection's.
  const [onsite, setOnsite] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // "On record" corrected in place (something brought from outside, a loss…) — staged, then saved with why,
  // so a stray tap never moves the stock.
  const [fix, setFix] = useState<Record<string, number>>({});
  const [why, setWhy] = useState('');
  const fixes = Object.entries(fix).filter(([, d]) => d !== 0);
  const setTo = (id: string, n: number, now: number) => setFix(m => ({ ...m, [id]: Math.max(0, Math.round(n * 100) / 100) - now }));
  // Edit settings: every change staged, one save.
  const [eds, setEds] = useState<Record<string, ItemEdit>>({});
  const [adding, setAdding] = useState<{ name: string; measure: string; category: string } | null>(null);
  const [sure, setSure] = useState<string | null>(null);
  const edited = Object.entries(eds).filter(([, e]) => Object.keys(e).length);
  const ed = (id: string, k: keyof ItemEdit, v: string) => setEds(m => ({ ...m, [id]: { ...m[id], [k]: v } }));
  const levelOf = (id: string) => p.items.find(l => l.itemId === id);
  const send = async (body: Record<string, unknown>, done: string) => {
    setBusy(true); setMsg('');
    try {
      const r = await api.act(body);
      if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return false; }
      onSaved(r); setMsg(done); return true;
    } catch (e) { setMsg(String(e)); return false; } finally { setBusy(false); }
  };
  // §150, owner: "draft order for missing items" — what is short here (or reported not there) into the draft order.
  const shortItems = p.items.filter(l => l.toOrder > 0 || l.missingSince);
  const draftShort = async () => {
    const mine = shortItems.map(l => ({ itemId: l.itemId, place: p.place!, qty: l.toOrder || Math.max(1, Math.ceil(l.min ?? 1)) }));
    const keep = (inv.draft?.lines ?? []).filter(x => !(x.place === p.place && mine.some(m => m.itemId === x.itemId)));
    await send({ action: 'draft', lines: [...keep, ...mine], forTodo: inv.draft?.forTodo ?? undefined },
               `📝 ${mine.length} line${mine.length === 1 ? '' : 's'} in the draft order — see To order below.`);
  };
  const ahead = p.units.reduce((a, u) => a + u.cleansAhead, 0);
  const edit = canEdit && !!p.place;
  return (
    <div className="card">
      {onsite && <OnsiteCount inv={inv} p={p} onSaved={onSaved} onClose={() => setOnsite(false)} />}
      <h2>{placeTitle(p)}</h2>
      <p className="note">
        {!p.place ? <>▲ What cleaners took for units that had no place at the time. Give those units a place in the Repository; these
          moves stay here.</>
          : !p.units.length ? <>No active unit draws from here now.</>
          : <>Supplies {p.units.map(u => u.name).join(', ')} — {ahead} clean{ahead === 1 ? '' : 's'} in the next {inv.aheadDays} days.</>}
        {' '}<Hint label="What the columns mean"><b>Per clean</b> is the average of what cleaners reported taking (over the last {inv.windowDays} days, every clean that
        answered, “nothing” included) — the item's estimate until 3 cleans have reported. <b>To order</b> = what those cleans
        will take + the minimum to keep − what is here, once the place has been counted.</Hint></p>
      <div className="grid-scroll">
        <table className="units compact">
          <thead><tr><th>Item</th><th className="n">On record</th><th>Counted</th><th className="n">Per clean</th>
            <th className="n">Cleans take ({inv.aheadDays} d)</th><th className="n">Keep at least</th><th className="n">To order</th>
            {mode === 'edit' && <th></th>}</tr></thead>
          <tbody>
            {items.map(i => {
              const l = levelOf(i.id);
              const e = eds[i.id] ?? {};
              const now = l?.qty ?? 0;
              const val = now + (fix[i.id] ?? 0);
              return (
                <tr key={i.id}>
                  <td>{mode === 'edit' ? <span className="inv-edit">
                      <input value={e.name ?? i.name} maxLength={120} aria-label="Name" onChange={x => ed(i.id, 'name', x.target.value)} />
                      <input value={e.measure ?? i.measure} maxLength={20} aria-label="Counted in" className="inv-measure" onChange={x => ed(i.id, 'measure', x.target.value)} />
                    </span> : <><b>{i.name}</b> <span className="sub-n">{i.measure}</span></>}
                    {l?.missingSince && <div className="breach">⚠ reported not there {short(l.missingSince)} — count it</div>}</td>
                  <td className="n">{edit && mode === 'view' ? (
                    <span className="inv-adj">
                      <button type="button" aria-label={`One less ${i.name}`} disabled={busy || val <= 0} onClick={() => setTo(i.id, val - 1, now)}>−</button>
                      <input type="number" inputMode="decimal" min="0" step="any" aria-label={`${i.name} on record`} value={fmt(val) === '—' ? '0' : String(Math.round(val * 100) / 100)}
                             onChange={x => setTo(i.id, Number(x.target.value) || 0, now)} />
                      <button type="button" aria-label={`One more ${i.name}`} disabled={busy} onClick={() => setTo(i.id, val + 1, now)}>+</button>
                      <span className="inv-delta">{fix[i.id] ? (fix[i.id]! > 0 ? `+${fix[i.id]}` : fix[i.id]) : ''}</span>
                    </span>) : fmt(l?.qty)}</td>
                  <td>{l?.countedAt ? short(l.countedAt) : <span className="sub-n">never</span>}</td>
                  <td className="n">{mode === 'edit'
                    ? <input className="inv-qty" type="number" min="0" step="any" aria-label="Estimate per clean" value={e.perClean ?? (i.perClean == null ? '' : String(i.perClean))}
                             onChange={x => ed(i.id, 'perClean', x.target.value)} />
                    : <>{fmt(l?.perClean)}{l?.perClean != null && <span className="sub-n">{l.learned ? ` avg of ${l.reportedCleans}` : ' est.'}</span>}</>}</td>
                  <td className="n">{l?.need ? l.need : '—'}</td>
                  <td className="n">{mode === 'edit'
                    ? <input className="inv-qty" type="number" min="0" step="any" aria-label="Keep at least here" placeholder={fmt(i.reorderAt)}
                             value={e.min ?? (l?.minOwn ? String(l.min) : '')} onChange={x => ed(i.id, 'min', x.target.value)} />
                    : <>{fmt(l?.min)}{l?.min != null && <span className="sub-n">{l.minOwn ? ' here' : ' item'}</span>}</>}</td>
                  <td className="n">{l?.toOrder ? <b>{l.toOrder}</b> : '—'}</td>
                  {mode === 'edit' && <td className="n nowrap">
                    <button className="link tiny" disabled={busy} onClick={() => void send({ action: 'hide', place: p.place, itemId: i.id, hide: true }, `${i.name}: not kept here.`)}>🙈 Not here</button>{' '}
                    {sure === i.id
                      ? <>Remove from every place? <button className="link tiny danger" disabled={busy} onClick={async () => { if (await send({ action: 'removeItem', itemId: i.id }, `${i.name} removed from the list (its history stays).`)) setSure(null); }}>Yes, remove</button>{' '}
                          <button className="link tiny" onClick={() => setSure(null)}>No</button></>
                      : <button className="link tiny danger" onClick={() => setSure(i.id)}>🗑 Remove</button>}
                  </td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {mode === 'edit' && <>
        {!adding ? <button className="secondary" onClick={() => setAdding({ name: '', measure: 'unit', category: 'other' })}>+ Add an item</button> : (
          <div className="row">
            <label>Name<input autoFocus value={adding.name} maxLength={120} onChange={x => setAdding(a => a && { ...a, name: x.target.value })} /></label>
            <label>Counted in<input value={adding.measure} maxLength={20} placeholder="roll, bottle, pod…" onChange={x => setAdding(a => a && { ...a, measure: x.target.value })} /></label>
            <label>Category<select value={adding.category} onChange={x => setAdding(a => a && { ...a, category: x.target.value })}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
            <div className="button-row">
              <button disabled={busy || !adding.name.trim()} onClick={async () => { if (await send({ action: 'newItem', ...adding, place: p.place }, `${adding.name.trim()} added.`)) setAdding(null); }}>Add it</button>
              <button className="secondary" onClick={() => setAdding(null)}>Cancel</button>
            </div>
          </div>)}
        {p.hidden.length > 0 && <p className="sub-n">Not kept here: {p.hidden.map((id, k) => <Fragment key={id}>{k ? ' · ' : ''}<button type="button" className="link tiny" disabled={busy}
          onClick={() => void send({ action: 'hide', place: p.place, itemId: id, hide: false }, 'Back on this place.')}>↺ {inv.items.find(x => x.id === id)?.name ?? id}</button></Fragment>)}</p>}
      </>}
      {edit && (
        <div className="button-row">
          {mode === 'view' && fixes.length > 0 && <>
            <input value={why} maxLength={500} placeholder="Why — e.g. brought from outside, broken, lent" onChange={x => setWhy(x.target.value)} />
            <button disabled={busy || !why.trim()}
                    onClick={async () => { if (await send({ action: 'adjusts', place: p.place, note: why, adjusts: fixes.map(([itemId, qty]) => ({ itemId, qty })) },
                                                      `Corrected ${fixes.length} item${fixes.length === 1 ? '' : 's'}.`)) { setFix({}); setWhy(''); } }}>
              Save corrections ({fixes.length})</button>
            <button className="secondary" onClick={() => { setFix({}); setWhy(''); }}>Undo</button>
          </>}
          {mode === 'view' && !fixes.length && <>
            <button onClick={() => { setOnsite(true); setMsg(''); }}>📱 Count {placeTitle(p)}</button>
            <button className="secondary" disabled={busy || !shortItems.length} title={shortItems.length ? '' : 'Nothing short here (counted places only)'}
                    onClick={() => void draftShort()}>📝 Draft order for what's short{shortItems.length ? ` (${shortItems.length})` : ''}</button>
            <button className="secondary" onClick={() => { setMode('edit'); setEds({}); setMsg(''); }}>✎ Edit settings</button>
          </>}
          {mode === 'edit' && <>
            <button disabled={busy || !edited.length} onClick={async () => {
              const body = { action: 'settings', place: p.place, items: edited.map(([itemId, x]) => ({ itemId, ...x })) };
              if (await send(body, `Saved ${edited.length} item${edited.length === 1 ? '' : 's'}.`)) { setMode('view'); setEds({}); }
            }}>Save changes ({edited.length})</button>
            <span className="note">How editing works <Hint>Name, “counted in” and the estimate are the item's (every place); “Keep at least” is this place's — blank = the item's.</Hint></span>
            <button className="secondary" onClick={() => { setMode('view'); setEds({}); setAdding(null); setSure(null); }}>Done</button>
          </>}
          {msg && <span className="note">{msg}</span>}
        </div>
      )}
      {edit && mode === 'view' && <p className="note">Correcting a count <Hint>− [n] + on “On record” corrects it (say why); a full count replaces it. What was bought
        goes in 🧾 Record a purchase (below), with its cost.</Hint></p>}
    </div>
  );
}

/**
 * Counting a place ONSITE (§150, owner: "practical for someone onsite, like
 * the inspection"): a full-screen sheet on a phone — 🔍 and the progress stay
 * on top; each item a card with − [n] + (typing works too) starting from the
 * record, "= as recorded" to confirm it untouched; only what was counted or
 * confirmed is saved. "+ Add an item here" creates a supply on the spot;
 * "🙈 Not kept here" takes one off this place (shown again from the foot).
 */
function OnsiteCount({ inv, p, onSaved, onClose }: { inv: Inventory; p: InvPlace; onSaved: (i: Inventory) => void; onClose: () => void }) {
  const api = useContext(InvApi);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState<{ name: string; measure: string; category: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const levelOf = (id: string) => p.items.find(l => l.itemId === id);
  const shown = p.items.map(l => inv.items.find(i => i.id === l.itemId)!).filter(Boolean);
  const list = q.trim() ? shown.filter(i => i.name.toLowerCase().includes(q.trim().toLowerCase())) : shown;
  const done = Object.keys(counts).length;
  const act = async (body: Record<string, unknown>) => {
    setBusy(true); setMsg('');
    try { const r = await api.act(body); if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return null; } onSaved(r); return r; }
    catch (e) { setMsg(String(e)); return null; } finally { setBusy(false); }
  };
  const set = (id: string, n: number) => setCounts(c => ({ ...c, [id]: Math.max(0, Math.min(99999, n)) }));
  const save = async () => {
    const r = await act({ action: 'count', place: p.place, counts: Object.entries(counts).map(([itemId, qty]) => ({ itemId, qty })) });
    if (r) onClose();
  };
  return (
    <Sheet title={`Count · ${placeTitle(p)}`} sub={`${done} of ${shown.length} counted`} onClose={onClose}>
      <div className="insp-body">
        <div className="onsite-top">
          <input value={q} placeholder="🔍 Find an item…" onChange={e => setQ(e.target.value)} />
          <span className="sub-n">Count what is really here. Untouched items keep their record.</span>
        </div>
        {list.map(i => {
          const l = levelOf(i.id);
          const n = counts[i.id];
          const touched = n !== undefined;
          const val = touched ? n : (l?.qty ?? 0);
          const gap = touched && l?.qty != null ? reconcile(l.qty, n!).gap : null;
          return (
            <div key={i.id} className={`onsite-row${touched ? ' done' : ''}`}>
              <div className="onsite-name"><b>{i.name}</b> <span className="sub-n">{i.measure}</span>
                <div className="sub-n">{l?.countedAt ? `record ${fmt(l.qty)} · counted ${short(l.countedAt)}` : 'never counted'}
                  {touched && <> · <b>{gap == null ? '✓ first count' : gap === 0 ? '✓ same' : `${gap > 0 ? '+' : ''}${gap}`}</b></>}</div>
                {l?.missingSince && <div className="breach">⚠ reported not there {short(l.missingSince)}</div>}</div>
              <div className="onsite-step">
                <button type="button" aria-label={`One less ${i.name}`} disabled={busy || val <= 0} onClick={() => set(i.id, val - 1)}>−</button>
                <input type="number" inputMode="numeric" min="0" aria-label={`How many ${i.name}`} value={touched ? String(n) : ''}
                       placeholder={l?.qty != null ? fmt(l.qty) : '0'} onChange={e => e.target.value === '' ? setCounts(c => { const x = { ...c }; delete x[i.id]; return x; }) : set(i.id, Number(e.target.value))} />
                <button type="button" aria-label={`One more ${i.name}`} disabled={busy} onClick={() => set(i.id, val + 1)}>+</button>
              </div>
              <div className="onsite-more">
                {!touched && l?.qty != null && <button type="button" className="link tiny" onClick={() => set(i.id, l.qty!)}>= as recorded</button>}
                <button type="button" className="link tiny" disabled={busy} onClick={() => void act({ action: 'hide', place: p.place, itemId: i.id, hide: true })}>🙈 Not kept here</button>
              </div>
            </div>
          );
        })}
        {q.trim() && !list.length && <p className="note">Nothing here matches “{q.trim()}” — add it below.</p>}
        {!adding ? <button className="secondary" onClick={() => setAdding({ name: q.trim(), measure: 'unit', category: 'other' })}>+ Add an item here</button> : (
          <div className="onsite-add">
            <label>Name<input autoFocus value={adding.name} maxLength={120} onChange={e => setAdding(a => a && { ...a, name: e.target.value })} /></label>
            <label>Counted in<input value={adding.measure} maxLength={20} placeholder="roll, bottle, pod…" onChange={e => setAdding(a => a && { ...a, measure: e.target.value })} /></label>
            <label>Category<select value={adding.category} onChange={e => setAdding(a => a && { ...a, category: e.target.value })}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
            <div className="button-row">
              <button disabled={busy || !adding.name.trim()} onClick={async () => {
                const r = await act({ action: 'newItem', ...adding });
                if (r?.itemId) { setAdding(null); setQ(''); set(r.itemId, 0); }
              }}>Add it</button>
              <button className="secondary" onClick={() => setAdding(null)}>Cancel</button>
            </div>
          </div>)}
        {p.hidden.length > 0 && <p className="sub-n">Not kept here: {p.hidden.map((id, k) => {
          const i = inv.items.find(x => x.id === id);
          return <Fragment key={id}>{k ? ' · ' : ''}<button type="button" className="link tiny" disabled={busy}
            onClick={() => void act({ action: 'hide', place: p.place, itemId: id, hide: false })}>↺ {i?.name ?? id}</button></Fragment>;
        })}</p>}
        {msg && <p className="breach" role="alert">{msg}</p>}
      </div>
      <div className="insp-foot">
        <span className="note">{done ? `${done} counted — saving replaces their record` : 'Nothing counted yet'}</span>
        <button disabled={busy || !done} onClick={() => void save()}>{busy ? 'Saving…' : `Save the count (${done})`}</button>
      </div>
    </Sheet>
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
function ItemLines({ inv, value, onChange, hints, canEdit, defaultPlace, onInv }: {
  inv: Inventory; value: Lines; onChange: (m: Lines) => void; hints?: Lines; canEdit: boolean; defaultPlace?: string | null;
  /** §150, owner: a supply not on the list is added from the 🔍 — the caller takes the new inventory. */
  onInv?: (i: Inventory) => void;
}) {
  const api = useContext(InvApi);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');
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
  // Not on the list (no exact name): one tap adds it — "unit", "other"; corrected later in ✎ Edit settings.
  const exact = inv.items.some(i => i.active && i.name.toLowerCase() === q.trim().toLowerCase());
  const create = async () => {
    const name = q.trim();
    setCreating(true); setErr('');
    try {
      const r = await api.act({ action: 'newItem', name, measure: 'unit', category: 'other', place: busiest || undefined });
      if (!r.ok || !r.itemId) { setErr(r.ok ? 'Not added.' : r.message ?? 'Not added.'); return; }
      onInv?.(r);
      onChange(new Map(value).set(r.itemId, [{ place: busiest, qty: '' }]));
      setQ('');
    } catch (e) { setErr(String(e)); } finally { setCreating(false); }
  };
  return <>
    {canEdit && places.length > 1 && <label>Everything goes to
      <select value={allTo} onChange={e => sendAll(e.target.value)}>
        {places.map(x => <option key={x.place} value={x.place!}>{placeTitle(x)}</option>)}</select>
      <span className="sub-n">items not split follow this; ⑂ splits one part to another place</span></label>}
    {canEdit && <label>🔍 Add an item
      <input value={q} placeholder="Search the supplies list…" onChange={e => setQ(e.target.value)} /></label>}
    {found.length > 0 && <div className="button-row">{found.map(i => (
      <button key={i.id} className="secondary" onClick={() => { set(i.id, [{ place: busiest, qty: '' }]); setQ(''); }}>+ {i.name}</button>))}</div>}
    {canEdit && q.trim() && !exact && onInv && <div className="button-row">
      {!found.length && <span className="note">“{q.trim()}” is not on the supplies list.</span>}
      <button className="secondary" disabled={creating} onClick={() => void create()}>{creating ? 'Adding…' : `+ Add “${q.trim()}” as a new item`}</button>
      {err && <span className="breach">{err}</span>}
    </div>}
    {q.trim() && !found.length && (exact || !onInv) && <p className="note">No other item matches “{q.trim()}”.</p>}
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
  // §150: a saved draft comes back as it was left; else the suggestion.
  const start = () => inv.draft ? linesOf(inv.draft.lines) : new Map(suggested);
  const [order, setOrder] = useState<Lines>(start);
  // Only a new suggestion or draft starts it over — not every reload (adding a new item from the 🔍 reloads).
  const sugKey = JSON.stringify([...suggested]);
  useEffect(() => { setOrder(start()); setForTodo(inv.draft?.forTodo ?? ''); }, [sugKey, inv.draft?.savedAt]);
  // §150: an order can belong to a to-do from the field — a clean's supplies request, a problem.
  const [forTodo, setForTodo] = useState(inv.draft?.forTodo ?? '');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const lines = flat(order);
  const nItems = new Set(lines.map(l => l.itemId)).size;
  // Nothing is suggested for a place until it has been counted: its record would be a guess.
  const uncounted = inv.places.filter(p => p.place && p.units.length && p.items.every(l => !l.countedAt));
  return (
    <div className="card">
      <h2>🛒 To order — next {inv.aheadDays} days <Hint>An order is a shopping to-do: a line per item and where it goes. Suggested: what each place's units will take
        in the next {inv.aheadDays} days, plus its minimum, minus what it holds — places never counted are not guessed at. The stock
        changes only when the purchase is recorded (🧾 below).</Hint></h2>
      {uncounted.length > 0 && <p className="note">▲ Count first (nothing is suggested for them until then): {uncounted.map(placeTitle).join(', ')}.</p>}
      {inv.draft && <p className="note">📝 <b>Draft</b> saved {inv.draft.savedAt} by {inv.draft.savedBy} — it becomes a to-do only when you create the order.</p>}
      {!order.size && <p className="note">Nothing to order from what has been counted. Add an item with 🔍 to order it anyway.</p>}
      <ItemLines inv={inv} value={order} onChange={setOrder} hints={suggested} canEdit={canEdit} onInv={onSaved} />
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
        <button className="secondary" disabled={busy || !lines.length} onClick={async () => {
          setBusy(true); setMsg('');
          try { const r = await api.act({ action: 'draft', lines, forTodo: forTodo || undefined }); if (!r.ok) setMsg(r.message ?? 'Not saved.'); else { onSaved(r); setMsg('📝 Draft saved.'); } }
          catch (e) { setMsg(String(e)); } finally { setBusy(false); }
        }}>💾 Save draft</button>
        {inv.draft && <button className="secondary" disabled={busy} onClick={async () => {
          setBusy(true); setMsg('');
          try { const r = await api.act({ action: 'draft', lines: [] }); if (!r.ok) setMsg(r.message ?? 'Not saved.'); else { onSaved(r); setMsg('Draft discarded.'); } }
          catch (e) { setMsg(String(e)); } finally { setBusy(false); }
        }}>Discard draft</button>}
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
  const [paidBy, setPaidBy] = useState('');
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
      f.append('paidBy', paidBy);
      if (todoId) f.append('todoId', todoId);
      for (const x of files) f.append('file', x);
      const r = await api.upload(f);
      if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
      onSaved(r); setMsg('✓ Purchase recorded: in the stock and in Costs (Restock).');
      setTodoId(''); setLines(new Map()); setTotal(''); setNote(''); setFiles([]); setPaidBy('');
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card">
      <h2>🧾 Record a purchase <Hint>What was really bought: it adds to each place's stock and goes to Costs as one Restock expense with its receipt.
        Start from an open order (its lines come filled in) or add the items with 🔍. Close the order in To-do once everything is bought.</Hint></h2>
      <label>For the order
        <select value={todoId} onChange={e => pick(e.target.value)}>
          <option value="">— none (a purchase on its own)</option>
          {inv.orders.map(o => <option key={o.todoId} value={o.todoId}>{o.at} · {o.title}{o.purchases ? ` · ${o.purchases} purchase${o.purchases === 1 ? '' : 's'} so far` : ''}</option>)}
        </select></label>
      <ItemLines inv={inv} value={lines} onChange={setLines} canEdit onInv={onSaved} />
      <div className="row">
        <label>Total paid ($)<input type="number" inputMode="decimal" min="0" step="0.01" value={total} onChange={e => setTotal(e.target.value)} /></label>
        <PaidBy value={paidBy} onChange={setPaidBy} />
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
 * Setup → Inventory: which place each unit draws from (§150) — and where it
 * is changed: drag a unit to another place (or tap it → "Move to", which works
 * on a phone), to its own closet, or to Not assigned. Each move is written to
 * the Repository's `storage` column — still the one source — and audited.
 * Past moves stay where they happened.
 */
function PlacesMap({ inv, onChanged }: { inv: Inventory; onChanged: () => void }) {
  type U = { id: string; name: string; recordId: string | null };
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pick, setPick] = useState<(U & { from: string }) | null>(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const zones: { key: string; title: string; hint?: string; units: U[] }[] = [
    ...inv.places.filter(p => p.place && !p.self).map(p => ({ key: p.place!, title: p.name, units: p.units })),
    { key: 'self', title: '🏠 Own closet (self storage)', hint: 'the unit keeps its supplies in its own closet', units: inv.places.filter(p => p.self).flatMap(p => p.units) },
    { key: '', title: '▲ Not assigned', hint: 'what its cleaners take is recorded with no place', units: inv.unassigned }
  ];
  const nameOf = (key: string) => zones.find(z => z.key === key)?.title ?? key;
  const move = async (u: U, from: string, dest: string) => {
    if (from === dest) return;
    setBusy(true); setMsg('');
    try {
      const r = await inventoryItemAction({ action: 'assign', unitId: u.id, to: dest });
      if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
      setMsg(`✓ ${u.name} → ${nameOf(dest)} (saved in the Repository).`); setPick(null); onChanged();
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); setDrag(null); setOver(null); }
  };
  return (
    <div className="card">
      <h2>Places &amp; who draws from them <Hint>A unit's supplies come from the place its Repository record names in <b>Storage</b>. Drag a unit to another
        place — or tap it and choose — and Kaizen writes it there; past moves stay where they happened. A new storage = a new record with
        Property type “Storage” in a Units table.</Hint></h2>
      <div className="map-zones">
        {zones.map(z => (
          <div key={z.key || 'none'} className={`map-zone${over === z.key ? ' over' : ''}${z.key === '' && z.units.length ? ' warn' : ''}`}
               onDragOver={e => { if (drag) { e.preventDefault(); setOver(z.key); } }} onDragLeave={() => setOver(o => o === z.key ? null : o)}
               onDrop={e => { e.preventDefault(); const from = zones.find(x => x.units.some(u => u.id === drag)); const u = from?.units.find(x => x.id === drag);
                              if (u && from) void move(u, from.key, z.key); }}>
            <div className="map-zone-head"><b>{z.title}</b> <span className="sub-n">{z.units.length} unit{z.units.length === 1 ? '' : 's'}{z.hint ? ` · ${z.hint}` : ''}</span></div>
            <div className="fr-chips">
              {z.units.map(u => (
                <button key={u.id} type="button" className={`chip${pick?.id === u.id ? ' active' : ''}`} draggable={!busy}
                        onDragStart={() => setDrag(u.id)} onDragEnd={() => { setDrag(null); setOver(null); }}
                        onClick={() => { setPick({ ...u, from: z.key }); setTo(z.key); setMsg(''); }}>⠿ {u.name}</button>))}
              {!z.units.length && <span className="sub-n">{drag ? 'drop here' : 'none now'}</span>}
            </div>
          </div>
        ))}
      </div>
      {pick && (
        <div className="button-row">
          <label>Move <b>{pick.name}</b> to
            <select value={to} onChange={e => setTo(e.target.value)}>
              {zones.map(z => <option key={z.key || 'none'} value={z.key}>{z.title}</option>)}</select></label>
          <button disabled={busy || to === pick.from} onClick={() => void move(pick, pick.from, to)}>{busy ? 'Saving…' : 'Move'}</button>
          {pick.recordId && <a href={repoHref(pick.recordId)} target="_blank" rel="noreferrer">Open in Repository</a>}
          <button className="secondary" onClick={() => setPick(null)}>Cancel</button>
        </div>
      )}
      {msg && <p className={msg.startsWith('✓') ? 'note' : 'breach'} role="status">{msg}</p>}
    </div>
  );
}

/** Setup → Inventory: a "Low stock at <place>" to-do on its own (§150, owner) — off until the places are counted. */
function LowStockSetting({ inv, onChanged }: { inv: Inventory; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  return (
    <div className="card">
      <h2>Low stock to-dos</h2>
      <label className="check"><input type="checkbox" checked={inv.lowStockTasks} disabled={busy} onChange={async e => {
        setBusy(true); setMsg('');
        const r = await inventoryItemAction({ action: 'lowStock', on: e.target.checked }).catch(x => ({ ok: false as const, message: String(x) }));
        setBusy(false);
        if (!r.ok) setMsg(r.message ?? 'Not saved.'); else onChanged();
      }} /> {inv.lowStockTasks ? '✓ On' : '○ Off'} — create a to-do when a counted place falls below an item's minimum</label>
      <p className="note">What it creates <Hint>One open “Low stock at S1105” to-do per place, a sub-task per item (never twice while it is open), with its order
        filled in — so 🧾 Record a purchase starts from it. Checked after every count, correction and take. Places never counted never
        trigger it.</Hint></p>
      {msg && <p className="breach">{msg}</p>}
    </div>
  );
}

/**
 * Who paid (§150, owner: someone may bring the things with their own money —
 * "it will serve to give the money back"): blank = the company; a name puts
 * the purchase on Costs → 💵 To pay back until it is marked paid.
 */
function PaidBy({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [own, setOwn] = useState(!!value);
  return (
    <label>Paid by
      <select value={own ? 'person' : 'company'} onChange={e => { const p = e.target.value === 'person'; setOwn(p); if (!p) onChange(''); }}>
        <option value="company">Kaizen (company card)</option><option value="person">Someone — to pay back</option></select>
      {own && <input value={value} maxLength={120} placeholder="Who? e.g. Irene, the inspector" onChange={e => onChange(e.target.value)} />}
    </label>
  );
}

/**
 * A to-do's own purchase (§150, owner: "the tasks should carry the purchase,
 * to record what was brought into the inventory and Costs, and close the
 * cleaner's request"): from the to-do, its order (filled in if it has one) —
 * saved as its order to buy later, or recorded as bought (stock + one Restock
 * expense, receipt) and the to-do closed.
 */
export function TaskPurchase({ todoId, unitIds, onClose, onBought }: {
  todoId: string; unitIds: string[]; onClose: () => void; onBought: (closeIt: boolean) => void;
}) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [lines, setLines] = useState<Lines>(new Map());
  const [total, setTotal] = useState('');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [closeIt, setCloseIt] = useState(true);
  const [paidBy, setPaidBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // Owner, Oct 2026: an order is a purchase with no price yet — what, how many, where. The money,
  // who paid and the receipt appear only once someone says it was bought.
  const [paying, setPaying] = useState(false);
  useEffect(() => { void getInventory().then(r => {
    if (!r.ok) { setMsg(r.message ?? 'Could not load the inventory.'); return; }
    setInv(r);
    const o = r.orders.find(x => x.todoId === todoId);
    if (o) setLines(linesOf(o.lines));
  }); }, [todoId]);
  if (!inv) return <p className={msg ? 'breach' : 'note loading-dot'}>{msg || 'Loading the supplies…'}</p>;
  const out = flat(lines);
  const home = inv.places.find(p => p.units.some(u => unitIds.includes(u.id)))?.place ?? null;
  const hadOrder = inv.orders.some(o => o.todoId === todoId);
  // Not finished? Kept as this to-do's order — a draft it carries, replaced on every save, until it is bought.
  const draft = async () => {
    setBusy(true); setMsg('');
    try { const r = await inventoryAction({ action: 'todoOrder', todoId, lines: out }); if (!r.ok) setMsg(r.message ?? 'Not saved.'); else onBought(false); }
    catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };
  const bought = async () => {
    setBusy(true); setMsg('');
    try {
      const f = new FormData();
      f.append('action', 'purchase'); f.append('lines', JSON.stringify(out)); f.append('total', total); f.append('note', note); f.append('todoId', todoId);
      f.append('paidBy', paidBy);
      for (const x of files) f.append('file', x);
      const r = await inventoryUpload(f);
      if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
      onBought(closeIt);
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="card task-buy">
      <h3>{paying ? '🧾 Record the purchase' : '🛒 Purchase order'}</h3>
      <p className="note">{paying ? 'What was bought goes into the stock of each place and into Costs (Restock) with the receipt.'
        : <>{hadOrder ? 'The order as it was left.' : 'Add what is to buy with 🔍.'} No price yet — 💾 Save order keeps it on this to-do;
          when it is bought, “🧾 Bought” asks for the total and the receipt.</>}</p>
      <ItemLines inv={inv} value={lines} onChange={setLines} canEdit defaultPlace={home} onInv={setInv} />
      {!paying ? (
        <div className="button-row">
          <button disabled={busy || (!out.length && !hadOrder)} onClick={() => void draft()}>{busy ? 'Saving…' : '💾 Save order'}</button>
          <button className="secondary" disabled={busy || !out.length} onClick={() => setPaying(true)}>🧾 Bought — record it</button>
          <button className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      ) : <>
      <div className="row">
        <label>Total paid ($)<input type="number" inputMode="decimal" min="0" step="0.01" value={total} onChange={e => setTotal(e.target.value)} /></label>
        <PaidBy value={paidBy} onChange={setPaidBy} />
        <label>Note<input value={note} maxLength={500} placeholder="Store, card…" onChange={e => setNote(e.target.value)} /></label>
        <label className="chip">📎 {files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'Receipt'}
          <input type="file" accept="image/*,application/pdf" multiple hidden onChange={e => setFiles([...(e.target.files ?? [])].slice(0, 5))} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={closeIt} onChange={e => setCloseIt(e.target.checked)} /> ✓ and close this to-do</label>
      <div className="button-row">
        <button disabled={busy || !out.length || !(Number(total) > 0)} onClick={() => void bought()}>{busy ? 'Saving…' : '🧾 Record the purchase'}</button>
        <button className="secondary" disabled={busy} onClick={() => setPaying(false)}>← Back to the order</button>
        {!(Number(total) > 0) && out.length > 0 && <span className="note">The total paid is needed to record it.</span>}
      </div>
      </>}
      {msg && <p className={msg.startsWith('✓') ? 'note' : 'breach'} role="status">{msg}</p>}
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
      <ItemLines inv={inv} value={lines} onChange={setLines} canEdit defaultPlace={home} onInv={setInv} />
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
  return <><PlacesMap inv={inv} onChanged={load} /><LowStockSetting inv={inv} onChanged={load} /><Catalog items={inv.items} onSaved={load} /></>;
}

/** The supplies the team keeps track of. Switching one off keeps its history. */
type Kind = 'supply' | 'furniture';
const TYPE_WORD: Record<Kind, string> = { supply: '🧴 Supplies', furniture: '🪑 Furniture' };
/**
 * The items list (§150, owner): first what each thing is — 🧴 supplies (what
 * cleans consume; the only ones a cleaner sees, per unit and clean) or 🪑
 * furniture (linens, dishes, equipment: counted, never handed out) — and, last,
 * where to buy it: as many options as there are, each with its link.
 */
function Catalog({ items, onSaved }: { items: InvItemRow[]; onSaved: () => void }) {
  const blank = { id: '', kind: 'supply' as Kind, name: '', category: 'other', measure: 'unit', perClean: '', reorderAt: '', active: true,
                  buyOptions: [] as { label: string; url: string }[] };
  const [form, setForm] = useState(blank);
  const [show, setShow] = useState<'all' | Kind>('all');
  const [msg, setMsg] = useState('');
  const send = async (body: Record<string, unknown>, done: string) => {
    const r = await inventoryItemAction(body).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return false; }
    setMsg(done); onSaved(); return true;
  };
  const whole = (i: InvItemRow) => ({ action: 'save', id: i.id, name: i.name, category: i.category, measure: i.measure, perClean: i.perClean ?? '',
                                      reorderAt: i.reorderAt ?? '', active: i.active, kind: i.kind ?? 'supply', buyOptions: i.buyOptions ?? [] });
  const shown = items.filter(i => show === 'all' || (i.kind ?? 'supply') === show);
  const setOpt = (k: number, patch: Partial<{ label: string; url: string }>) =>
    setForm(f => ({ ...f, buyOptions: f.buyOptions.map((o, j) => j === k ? { ...o, ...patch } : o) }));
  return (
    <div className="card">
      <h2>Items list <Hint>🧴 <b>Supplies</b> are what cleans consume — cleaners see only these, and only those their unit's place keeps. 🪑 <b>Furniture</b> is
        the house's things (linens, dishes, equipment): counted, never handed out. Per clean is the starting estimate (until 3 cleans have reported);
        Keep at least is the minimum unless a place sets its own. <b>Buy at</b>: where to buy it, with the link.</Hint></h2>
      <div className="chip-row">{(['all', 'supply', 'furniture'] as const).map(k =>
        <button key={k} className={show === k ? 'chip active' : 'chip'} onClick={() => setShow(k)}>{k === 'all' ? `All (${items.length})` : `${TYPE_WORD[k]} (${items.filter(i => (i.kind ?? 'supply') === k).length})`}</button>)}</div>
      <div className="grid-scroll">
        <table className="units compact">
          <thead><tr><th>Type</th><th>Item</th><th>Category</th><th>Counted in</th><th className="n">Per clean (est.)</th><th className="n">Keep at least</th><th>Buy at</th><th></th></tr></thead>
          <tbody>
            {shown.map(i => (
              <tr key={i.id} className={i.active ? undefined : 'muted-row'}>
                <td><select value={i.kind ?? 'supply'} aria-label={`Type of ${i.name}`}
                            onChange={e => void send({ ...whole(i), kind: e.target.value }, `${i.name}: ${TYPE_WORD[e.target.value as Kind]}.`)}>
                  <option value="supply">🧴 Supplies</option><option value="furniture">🪑 Furniture</option></select></td>
                <td><b>{i.name}</b>{!i.active && <span className="sub-n"> · off</span>}</td><td>{i.category}</td><td>{i.measure}</td>
                <td className="n">{fmt(i.perClean)}</td><td className="n">{fmt(i.reorderAt)}</td>
                <td>{(i.buyOptions ?? []).length ? (i.buyOptions ?? []).map((o, k) => <Fragment key={k}>{k ? ' · ' : ''}<a href={o.url} target="_blank" rel="noreferrer">{o.label} ↗</a></Fragment>)
                  : <span className="sub-n">—</span>}</td>
                <td className="n nowrap">
                  <button className="link tiny" onClick={() => setForm({ id: i.id, kind: i.kind ?? 'supply', name: i.name, category: i.category, measure: i.measure,
                    perClean: i.perClean == null ? '' : String(i.perClean), reorderAt: i.reorderAt == null ? '' : String(i.reorderAt), active: i.active,
                    buyOptions: (i.buyOptions ?? []).map(o => ({ ...o })) })}>edit</button>{' '}
                  {i.active && <button className="link tiny danger" onClick={() => void send({ action: 'delete', id: i.id }, `${i.name} switched off.`)}>remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>{form.id ? `Edit ${form.name}` : 'Add an item'}</h3>
      <div className="row">
        <label>Type<select value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value as Kind }))}>
          <option value="supply">🧴 Supplies</option><option value="furniture">🪑 Furniture</option></select></label>
        <label>Name<input value={form.name} maxLength={120} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></label>
        <label>Category<select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Counted in<input value={form.measure} maxLength={20} placeholder="roll, bottle, pod…" onChange={e => setForm(f => ({ ...f, measure: e.target.value }))} /></label>
        <label>Per clean (est.)<input type="number" min="0" step="any" value={form.perClean} onChange={e => setForm(f => ({ ...f, perClean: e.target.value }))} /></label>
        <label>Keep at least<input type="number" min="0" step="any" value={form.reorderAt} onChange={e => setForm(f => ({ ...f, reorderAt: e.target.value }))} /></label>
      </div>
      <div className="buy-opts">
        <b>Buy at</b> <span className="sub-n">— where to buy it; each option with its link</span>
        {form.buyOptions.map((o, k) => (
          <div key={k} className="row" style={{ gap: 6, alignItems: 'center' }}>
            <input value={o.label} maxLength={60} placeholder="Store, e.g. Costco" aria-label="Store" onChange={e => setOpt(k, { label: e.target.value })} />
            <input value={o.url} maxLength={500} placeholder="https://…" aria-label="Link" style={{ flex: 1 }} onChange={e => setOpt(k, { url: e.target.value })} />
            <button className="link tiny danger" onClick={() => setForm(f => ({ ...f, buyOptions: f.buyOptions.filter((_, j) => j !== k) }))}>✕</button>
          </div>))}
        <button className="link tiny" onClick={() => setForm(f => ({ ...f, buyOptions: [...f.buyOptions, { label: '', url: '' }] }))}>+ a buying option</button>
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
