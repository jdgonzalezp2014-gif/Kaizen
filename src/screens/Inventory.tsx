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
import { Hint, Peek } from '../components/Hint.tsx';
import { Fragment, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getInventory, inventoryAction, inventoryItemAction, inventoryUpload, type InvItemRow, type InvPlace, type Inventory } from '../api.ts';
import { CATEGORIES, onHand, reconcile } from '../lib/inventory.ts';
import { destFor, placeLabel } from '../lib/unit-access.ts';
import { orderFor, receiptSum, similarItems, splitTotal, type Receipt, type ReceiptLine } from '../lib/receipt.ts';
import { Sheet } from '../components/InspectionRun.tsx';
import { PhotoPicker, shrink } from '../components/PhotoPicker.tsx';
import { againstOrder, cartLinks, STORE_NAME } from '../lib/store-order.ts';
import { TX } from '../lib/crew-i18n.ts';
import { Icon, ic } from '../components/Icon.tsx';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-12 …" → "Oct 12". */
const short = (at: string) => `${MON[Number(at.slice(5, 7)) - 1]} ${Number(at.slice(8, 10))}`;
const fmt = (n: number | null | undefined) => n == null ? '—' : String(Math.round(n * 100) / 100);
const KIND_WORD: Record<string, string> = { count: '▣ counted', used: '− used', purchase: '+ bought', adjust: '± corrected', missing: '⚠ not there',
                                             taken: '↗ taken for a clean' };
const SOURCE_WORD: Record<string, string> = { team: 'team', cleaner: 'cleaner', link: 'cleaner’s helper' };
/** A house's own place reads as its closet in the storage view; in the houses view it is the house. */
const placeTitle = (p: Pick<InvPlace, 'name' | 'self' | 'view'>) => p.view === 'house' ? p.name : p.self ? `${p.name} — closet` : p.name;
const pk = (place: string | null) => place ?? '';
type View = 'storage' | 'house';
const viewOf = (p: Pick<InvPlace, 'view'>): View => p.view === 'house' ? 'house' : 'storage';
/** One key can be two views (a house that keeps its own closet): the view is part of what is picked. */
const vk = (p: InvPlace) => `${viewOf(p)}|${pk(p.place)}`;
const housesOf = (inv: Inventory) => inv.places.filter(p => p.place && p.view === 'house').map(p => ({ key: p.place!, supplies: p.supplies ?? null }));
/**
 * Where a line can go (owner, 2026-10-15: "not such a long list"): the storages and closets, then the houses.
 * Supplies live only in a storage or a closet — a supply's own picker has no houses.
 */
function destinations(inv: Inventory) {
  return { storages: inv.places.filter(p => p.place && p.view !== 'house'), houses: inv.places.filter(p => p.place && p.view === 'house') };
}
/** A place as a line shows it: "Napa Valley — closet", "Napa Valley (house)", "S13…". */
function lineTitle(inv: Inventory, key: string) {
  const p = inv.places.find(x => x.place === key);
  return p ? p.view === 'house' ? `${p.name} (house)` : placeTitle(p) : key;
}
const shortPlace = (inv: Inventory, key: string) => { const p = inv.places.find(x => x.place === key && x.view !== 'house'); return p ? p.self ? 'its closet' : p.name : key; };
const houseOption = (inv: Inventory, h: InvPlace) => `${h.name} (house)${h.supplies ? ` · supplies at ${shortPlace(inv, h.supplies)}` : ''}`;
/** `kind` 'supply' leaves the houses out; none (the "Goes to" for every line) keeps them — a house routes by type. */
function PlaceSelect({ inv, value, onChange, label, kind, except }: {
  inv: Inventory; value: string; onChange: (key: string) => void; label: string; kind?: 'supply' | 'furniture'; except?: string | null }) {
  const d = destinations(inv);
  const houses = kind === 'supply' ? [] : d.houses.filter(h => h.place !== except);
  return <select value={value} aria-label={label} onChange={e => onChange(e.target.value)}>
    {!value && <option value="">▲ choose a place</option>}
    <optgroup label="Storage & closets">{d.storages.filter(p => p.place !== except).map(p => <option key={p.place} value={p.place!}>{placeTitle(p)}</option>)}</optgroup>
    {houses.length > 0 && <optgroup label="Houses">{houses.map(h => <option key={h.place} value={h.place!}>{kind === 'furniture' ? `${h.name} (house)` : houseOption(inv, h)}</option>)}</optgroup>}
  </select>;
}
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
  // Owner, 2026-10-15: storage and houses apart, so neither list is overwhelming. Remembered per viewer.
  const [view, setViewRaw] = useState<View>(() => { try { return localStorage.getItem('invView') === 'house' ? 'house' : 'storage'; } catch { return 'storage'; } });
  const setView = (v: View) => { setViewRaw(v); setPlace(null); try { localStorage.setItem('invView', v); } catch { /* private window */ } };
  const load = () => api.get().then(r => { if (r.ok) { setInv(r); setErr(''); } else setErr(r.message ?? 'Could not load.'); })
    .catch(e => setErr(String(e)));
  useEffect(() => { void load(); }, []);
  if (err) return <p className="banner error">{err}</p>;
  if (!inv) return <p className="note loading-dot">Loading the inventory…</p>;

  const shown = inv.places.filter(p => viewOf(p) === view);
  const flagged = shown.filter(p => p.items.some(i => i.missingSince));
  const never = shown.filter(p => p.place && p.items.length && p.items.every(i => !i.countedAt));
  // Storage: the busiest place first (the one most units draw from). Houses: by name.
  const current = shown.find(p => vk(p) === place) ?? (view === 'storage' ? [...shown].sort((a, b) => b.units.length - a.units.length)[0] : shown[0]);
  const nHouses = inv.places.filter(p => p.view === 'house').length;
  return (
    <div className="inv">
      <div className="card">
        <h2>Inventory <Hint>Two views. <b>Storage</b>: the supplies cleans use, kept in places — a storage, or a house's own closet — never in each unit.
          Each unit draws from the place its Repository record names (<Icon n="gear" /> Setup → Inventory shows the map). <b>Houses</b>: each house's
          furniture and equipment (linens, dishes, appliances) — it lives in the house, so it is counted and ordered there. Both are counted the same way.
          The stock is the last count plus what was bought, minus what cleaners took. Counting resets the record and shows how far off it was.
          Cleaners and their helpers report from their pages; they cannot count or correct.</Hint></h2>
        <span className="seg" role="group" aria-label="Inventory view">
          <button aria-pressed={view === 'storage'} className={view === 'storage' ? 'chip active' : 'chip'} onClick={() => setView('storage')}><Icon n="box" /> Storage · supplies</button>
          <button aria-pressed={view === 'house'} className={view === 'house' ? 'chip active' : 'chip'} onClick={() => setView('house')}><Icon n="home" /> Houses · furniture{nHouses ? ` (${nHouses})` : ''}</button>
        </span>
        <p className="note">
          {flagged.length ? <span className="breach"><Icon n="warning" /> {flagged.length} place{flagged.length === 1 ? '' : 's'} with something reported not there: {flagged.map(placeTitle).join(', ')}</span>
                          : '✓ Nothing reported missing.'}
          {' · '}{never.length} of {shown.filter(p => p.place).length} {view === 'house' ? 'houses' : 'places'} never counted.
          {view === 'storage' && inv.unassigned.length > 0 && <> · <span className="breach">▲ {inv.unassigned.length} unit{inv.unassigned.length === 1 ? '' : 's'} with no
            place: {inv.unassigned.map(u => u.name).join(', ')}</span></>}
        </p>
        {current && <label>{view === 'house' ? 'House' : 'Place'}
          <select value={vk(current)} onChange={e => setPlace(e.target.value)}>
            {shown.map(p => <option key={vk(p)} value={vk(p)}>
              {placeTitle(p)}{view === 'storage' && p.units.length && !p.self ? ` · ${p.units.length} unit${p.units.length === 1 ? '' : 's'}` : ''}{p.items.some(i => i.missingSince) ? ' ⚠' : ''}</option>)}
          </select></label>}
        {!current && view === 'house' && <p className="note">No house has a Repository record yet — add them in Repository → Units.</p>}
      </div>
      {current && <PlaceStock key={vk(current)} inv={inv} p={current} canEdit={canEdit} onSaved={setInv} />}
      <OrderPlan inv={inv} canEdit={canEdit} onSaved={setInv} />
      {canEdit && <RecordPurchase inv={inv} onSaved={setInv} />}
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
  // Supplies first; in a storage or a closet, the furniture kept there after them (owner, 2026-10-15).
  const items = p.items.map(l => inv.items.find(i => i.id === l.itemId)).filter((i): i is InvItemRow => !!i)
    .sort((a, b) => Number(a.kind === 'furniture') - Number(b.kind === 'furniture'));
  const firstFurniture = p.view !== 'house' ? items.find(i => i.kind === 'furniture')?.id : undefined;
  // ⇄ Move: furniture between the house and a storage (a supply only between storages and closets).
  const [moving, setMoving] = useState<{ id: string; qty: string; to: string } | null>(null);
  // ⇄ Refill (owner, 2026-10-15): a closet refilled from its storage — what it is short, filled in.
  const [refill, setRefill] = useState<Record<string, string> | null>(null);
  const fromPlace = p.from ? inv.places.find(x => x.place === p.from && x.view !== 'house') ?? null : null;
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
  // A closet refilled from a storage is refilled, not bought for: its storage is what gets ordered.
  const shortItems = p.from ? [] : p.items.filter(l => l.toOrder > 0 || l.missingSince);
  const toRefill = p.items.filter(l => (l.toRefill ?? 0) > 0 || (p.from && l.missingSince));
  const startRefill = () => setRefill(Object.fromEntries(items.filter(i => i.kind !== 'furniture')
    .map(i => [i.id, String(levelOf(i.id)?.toRefill || '')])));
  const refillLines = Object.entries(refill ?? {}).filter(([, q]) => Number(q) > 0).map(([itemId, q]) => ({ itemId, qty: Number(q) }));
  const atFrom = (id: string) => fromPlace?.items.find(l => l.itemId === id)?.qty ?? null;
  const draftShort = async () => {
    const mine = shortItems.map(l => ({ itemId: l.itemId, place: p.place!, qty: l.toOrder || Math.max(1, Math.ceil(l.min ?? 1)) }));
    const keep = (inv.draft?.lines ?? []).filter(x => !(x.place === p.place && mine.some(m => m.itemId === x.itemId)));
    await send({ action: 'draft', lines: [...keep, ...mine], forTodo: inv.draft?.forTodo ?? undefined },
               `📝 ${mine.length} line${mine.length === 1 ? '' : 's'} in the draft order — see To order below.`);
  };
  const ahead = p.units.reduce((a, u) => a + u.cleansAhead, 0);
  const edit = canEdit && !!p.place;
  // A house's furniture is not used up by cleans: no per-clean columns there.
  const house = p.view === 'house';
  return (
    <div className="card">
      {onsite && <OnsiteCount inv={inv} p={p} onSaved={onSaved} onClose={() => setOnsite(false)} />}
      <h2>{placeTitle(p)}</h2>
      <p className="note">
        {!p.place ? <>▲ What cleaners took for units that had no place at the time. Give those units a place in the Repository; these
          moves stay here.</>
          : house ? <>The house's furniture and equipment.{p.supplies ? <> Its supplies are under Storage → {lineTitle(inv, p.supplies)}.</> : <> ▲ It has no supplies place.</>}</>
          : !p.units.length && !p.refills?.length ? <>No active unit draws from here now.</>
          : <>{p.units.length > 0 && <>Supplies {p.units.map(u => u.name).join(', ')} — {ahead} clean{ahead === 1 ? '' : 's'} in the next {inv.aheadDays} days. </>}
            {p.from && <>Cleaners take from this closet only; it is refilled from <b>{fromPlace?.name ?? lineTitle(inv, p.from)}</b>. </>}
            {!!p.refills?.length && <>Refills the closet{p.refills.length === 1 ? '' : 's'} of {p.refills.map(k => inv.places.find(x => x.place === k)?.name ?? k).join(', ')} — what they are short counts here. </>}</>}
        {' '}{house ? <Hint label="What the columns mean"><b>Keep at least</b> is what the house should have (8 towels, 6 glasses…); <b>To order</b> = that minus
        what is here, once the house has been counted. Something of another type bought or counted here shows too, so nothing recorded is lost.</Hint>
        : <Hint label="What the columns mean"><b>Per clean</b> is the average of what cleaners reported taking (over the last {inv.windowDays} days, every clean that
        answered, “nothing” included) — the item's estimate until 3 cleans have reported. <b>To order</b> = what those cleans
        will take + the minimum to keep − what is here, once the place has been counted.{p.from && <> Here it reads <b>To refill</b>: this closet is
        refilled from {fromPlace?.name ?? 'its storage'}, not bought for — ⇄ Refill records what was moved; the storage's To order includes it.</>}
        {!!p.refills?.length && <> A storage that refills closets also counts what those closets are short.</>}</Hint>}</p>
      {p.look && <p className="sub-n"><Icon n="camera" /> How it looked {short(p.look.at)}{p.look.counted ? '' : ' (no count)'} · {p.look.byName}
        {p.look.note && <> — “{p.look.note}”</>}
        {p.look.photos.map((f, k) => <Fragment key={f.url}> · <a href={f.url} target="_blank" rel="noreferrer">photo {k + 1}</a></Fragment>)}</p>}
      <div className="grid-scroll">
        <table className="units compact">
          <thead><tr><th>Item</th><th className="n">On record</th><th>Counted</th>{!house && <><th className="n">Per clean</th>
            <th className="n">Cleans take ({inv.aheadDays} d)</th></>}<th className="n">Keep at least</th><th className="n">{p.from ? 'To refill' : 'To order'}</th>
            {mode === 'edit' && <th></th>}</tr></thead>
          <tbody>
            {items.map(i => {
              const l = levelOf(i.id);
              const e = eds[i.id] ?? {};
              const now = l?.qty ?? 0;
              const val = now + (fix[i.id] ?? 0);
              const mv = moving?.id === i.id ? moving : null;
              return (
                <Fragment key={i.id}>
                {i.id === firstFurniture && <tr><td colSpan={9} className="sub-n"><b>Furniture here</b> — kept in this {p.self ? 'closet' : 'storage'}; ⇄ moves it to a house or elsewhere.</td></tr>}
                <tr>
                  <td>{mode === 'edit' ? <span className="inv-edit">
                      <input value={e.name ?? i.baseName ?? i.name} maxLength={120} aria-label="Name" onChange={x => ed(i.id, 'name', x.target.value)} />
                      <input value={e.measure ?? i.measure} maxLength={20} aria-label="Counted in" className="inv-measure" onChange={x => ed(i.id, 'measure', x.target.value)} />
                    </span> : <><b>{i.name}</b> <span className="sub-n">{i.measure}</span>{(i.kind === 'furniture') !== house && <span className="sub-n"> · {i.kind === 'furniture' ? 'furniture' : 'supply'}</span>}</>}
                    {l?.missingSince && <div className="breach"><Icon n="warning" /> reported not there {short(l.missingSince)} — count it</div>}
                    {edit && mode === 'view' && !mv && (l?.qty ?? 0) > 0 && <div><button className="link tiny" disabled={busy}
                      onClick={() => setMoving({ id: i.id, qty: '', to: '' })}>⇄ move</button></div>}
                    {mv && <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                      <input className="inv-qty" type="number" min="0" step="1" placeholder="How many" aria-label="How many to move" value={mv.qty}
                             onChange={x => setMoving({ ...mv, qty: x.target.value })} />
                      <PlaceSelect inv={inv} value={mv.to} label="Move to" kind={i.kind ?? 'supply'} except={p.place} onChange={v => setMoving({ ...mv, to: v })} />
                      <button className="small" disabled={busy || !mv.to || !(Number(mv.qty) > 0)} onClick={async () => {
                        if (await send({ action: 'transfer', itemId: i.id, from: p.place, to: mv.to, qty: Number(mv.qty) },
                                       `${i.name}: ${mv.qty} moved to ${lineTitle(inv, mv.to)}.`)) setMoving(null);
                      }}>Move</button>
                      <button className="link tiny" onClick={() => setMoving(null)}>Cancel</button>
                    </div>}</td>
                  <td className="n">{edit && mode === 'view' ? (
                    <span className="inv-adj">
                      <button type="button" aria-label={`One less ${i.name}`} disabled={busy || val <= 0} onClick={() => setTo(i.id, val - 1, now)}>−</button>
                      <input type="number" inputMode="decimal" min="0" step="any" aria-label={`${i.name} on record`} value={fmt(val) === '—' ? '0' : String(Math.round(val * 100) / 100)}
                             onChange={x => setTo(i.id, Number(x.target.value) || 0, now)} />
                      <button type="button" aria-label={`One more ${i.name}`} disabled={busy} onClick={() => setTo(i.id, val + 1, now)}>+</button>
                      <span className="inv-delta">{fix[i.id] ? (fix[i.id]! > 0 ? `+${fix[i.id]}` : fix[i.id]) : ''}</span>
                    </span>) : fmt(l?.qty)}</td>
                  <td>{l?.countedAt ? short(l.countedAt) : <span className="sub-n">never</span>}</td>
                  {!house && <><td className="n">{mode === 'edit'
                    ? <input className="inv-qty" type="number" min="0" step="any" aria-label="Estimate per clean" value={e.perClean ?? (i.perClean == null ? '' : String(i.perClean))}
                             onChange={x => ed(i.id, 'perClean', x.target.value)} />
                    : <>{fmt(l?.perClean)}{l?.perClean != null && <span className="sub-n">{l.learned ? ` avg of ${l.reportedCleans}` : ' est.'}</span>}</>}</td>
                  <td className="n">{l?.need ? l.need : '—'}</td></>}
                  <td className="n">{mode === 'edit'
                    ? <input className="inv-qty" type="number" min="0" step="any" aria-label="Keep at least here" placeholder={fmt(i.reorderAt)}
                             value={e.min ?? (l?.minOwn ? String(l.min) : '')} onChange={x => ed(i.id, 'min', x.target.value)} />
                    : <>{fmt(l?.min)}{l?.min != null && <span className="sub-n">{l.minOwn ? ' here' : ' item'}</span>}</>}</td>
                  <td className="n">{l?.toOrder ? <b>{l.toOrder}</b> : l?.toRefill ? <b>{l.toRefill}</b> : '—'}</td>
                  {mode === 'edit' && <td className="n nowrap">
                    <button className="link tiny" disabled={busy} onClick={() => void send({ action: 'hide', place: p.place, itemId: i.id, hide: true }, `${i.name}: not kept here.`)}><Icon n="eyeOff" /> Not here</button>{' '}
                    {sure === i.id
                      ? <>Remove from every place? <button className="link tiny danger" disabled={busy} onClick={async () => { if (await send({ action: 'removeItem', itemId: i.id }, `${i.name} removed from the list (its history stays).`)) setSure(null); }}>Yes, remove</button>{' '}
                          <button className="link tiny" onClick={() => setSure(null)}>No</button></>
                      : <button className="link tiny danger" onClick={() => setSure(i.id)}><Icon n="trash" /> Remove</button>}
                  </td>}
                </tr>
                </Fragment>
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
              <button disabled={busy || !adding.name.trim()} onClick={async () => { if (await send({ action: 'newItem', ...adding, kind: house ? 'furniture' : 'supply', place: p.place }, `${adding.name.trim()} added.`)) setAdding(null); }}>Add it</button>
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
            <button onClick={() => { setOnsite(true); setMsg(''); }}><Icon n="phone" /> Count {placeTitle(p)}</button>
            {p.from && !refill && <button className="secondary" disabled={busy} onClick={() => { startRefill(); setMsg(''); }}>
              ⇄ Refill from {fromPlace ? placeLabel(fromPlace.name) : 'storage'}{toRefill.length ? ` (${toRefill.length})` : ''}</button>}
            {!p.from && <button className="secondary" disabled={busy || !shortItems.length} title={shortItems.length ? '' : 'Nothing short here (counted places only)'}
                    onClick={() => void draftShort()}><Icon n="note" /> Draft order for what's short{shortItems.length ? ` (${shortItems.length})` : ''}</button>}
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
      {refill && <div>
        <h3>⇄ Refill from {fromPlace?.name ?? 'storage'} <Hint>What was moved (or someone is sent to move) from the storage into this closet: it leaves the
          storage's record and enters this one. Filled in with what the closet is short (its cleans ahead + its minimum − what it holds, once counted);
          change any number, blank = not moved. Never more than the storage has on record — count it first if there is more.</Hint></h3>
        <div className="grid-scroll"><table className="units compact">
          <thead><tr><th>Item</th><th className="n">Here</th><th className="n">In {fromPlace ? placeLabel(fromPlace.name) : 'storage'}</th><th className="n">Move</th></tr></thead>
          <tbody>{items.filter(i => i.kind !== 'furniture').map(i => (
            <tr key={i.id}><td><b>{i.name}</b> <span className="sub-n">{i.measure}</span>{levelOf(i.id)?.missingSince && <span className="breach"> <Icon n="warning" /> not there</span>}</td>
              <td className="n">{fmt(levelOf(i.id)?.qty)}</td><td className="n">{fmt(atFrom(i.id))}</td>
              <td className="n"><input className="inv-qty" type="number" min="0" step="1" aria-label={`${i.name} to move`} value={refill[i.id] ?? ''}
                                       onChange={x => setRefill(r => ({ ...r, [i.id]: x.target.value }))} /></td></tr>))}</tbody>
        </table></div>
        <div className="button-row">
          <button disabled={busy || !refillLines.length} onClick={async () => {
            if (await send({ action: 'refill', to: p.place, lines: refillLines }, `⇄ ${refillLines.length} item${refillLines.length === 1 ? '' : 's'} moved in from ${fromPlace?.name ?? 'storage'}.`)) setRefill(null);
          }}>Record the refill ({refillLines.length})</button>
          <button className="secondary" onClick={() => setRefill(null)}>Cancel</button>
          {msg && <span className="note">{msg}</span>}
        </div>
      </div>}
      {edit && mode === 'view' && <p className="note">Correcting a count <Hint>− [n] + on “On record” corrects it (say why); a full count replaces it. What was bought
        goes in <Icon n="receipt" /> Record a purchase (below), with its cost.</Hint></p>}
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
  // Owner, 2026-10-14: how the storage looks (damp, mess, a broken shelf) — optional, saved with the count.
  const [files, setFiles] = useState<File[]>([]);
  const [look, setLook] = useState('');
  const levelOf = (id: string) => p.items.find(l => l.itemId === id);
  // An item of the other type added here (furniture kept in a storage, a supply in a house) is counted like the rest;
  // once counted it has a record here and stays on this place's list.
  const extra = Object.keys(counts).filter(id => !p.items.some(l => l.itemId === id)).map(id => inv.items.find(i => i.id === id)!).filter(Boolean);
  const shown = [...p.items.map(l => inv.items.find(i => i.id === l.itemId)!).filter(Boolean), ...extra];
  // Already on the list elsewhere (the other type): count it here, not a new item.
  const other = q.trim() ? inv.items.filter(i => i.active && !shown.includes(i) && !p.hidden.includes(i.id) && (p.view !== 'house' || i.kind === 'furniture') && i.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 5) : [];
  const list = q.trim() ? shown.filter(i => i.name.toLowerCase().includes(q.trim().toLowerCase())) : shown;
  const done = Object.keys(counts).length;
  const act = async (body: Record<string, unknown>, photos: File[] = []) => {
    setBusy(true); setMsg('');
    try {
      let r: InvResult;
      if (photos.length) {
        const form = new FormData();
        for (const [k, v] of Object.entries(body)) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
        for (const f of await Promise.all(photos.map(shrink))) form.append('file', f);
        r = await api.upload(form);
      } else r = await api.act(body); if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return null; } onSaved(r); return r; }
    catch (e) { setMsg(String(e)); return null; } finally { setBusy(false); }
  };
  const set = (id: string, n: number) => setCounts(c => ({ ...c, [id]: Math.max(0, Math.min(99999, n)) }));
  const save = async () => {
    const r = await act({ action: 'count', place: p.place, view: viewOf(p), counts: Object.entries(counts).map(([itemId, qty]) => ({ itemId, qty })), look: look.trim() }, files);
    if (r) onClose();
  };
  return (
    <Sheet title={`Count · ${placeTitle(p)}`} sub={`${done} of ${shown.length} counted`} onClose={onClose}>
      <div className="insp-body">
        <div className="onsite-top">
          <input value={q} placeholder="Find an item…" onChange={e => setQ(e.target.value)} />
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
                {l?.missingSince && <div className="breach"><Icon n="warning" /> reported not there {short(l.missingSince)}</div>}</div>
              <div className="onsite-step">
                <button type="button" aria-label={`One less ${i.name}`} disabled={busy || val <= 0} onClick={() => set(i.id, val - 1)}>−</button>
                <input type="number" inputMode="numeric" min="0" aria-label={`How many ${i.name}`} value={touched ? String(n) : ''}
                       placeholder={l?.qty != null ? fmt(l.qty) : '0'} onChange={e => e.target.value === '' ? setCounts(c => { const x = { ...c }; delete x[i.id]; return x; }) : set(i.id, Number(e.target.value))} />
                <button type="button" aria-label={`One more ${i.name}`} disabled={busy} onClick={() => set(i.id, val + 1)}>+</button>
              </div>
              <div className="onsite-more">
                {!touched && l?.qty != null && <button type="button" className="link tiny" onClick={() => set(i.id, l.qty!)}>= as recorded</button>}
                <button type="button" className="link tiny" disabled={busy} onClick={() => void act({ action: 'hide', place: p.place, itemId: i.id, hide: true })}><Icon n="eyeOff" /> Not kept here</button>
              </div>
            </div>
          );
        })}
        {q.trim() && !list.length && <p className="note">Nothing here matches “{q.trim()}” — add it below.</p>}
        {other.length > 0 && <div className="button-row"><span className="sub-n">On the list, not here:</span>
          {other.map(i => <button key={i.id} className="secondary small" onClick={() => { set(i.id, 0); setQ(''); }}>+ count {i.name} here</button>)}</div>}
        {!adding ? <button className="secondary" onClick={() => setAdding({ name: q.trim(), measure: 'unit', category: 'other' })}>+ Add an item here</button> : (
          <div className="onsite-add">
            <label>Name<input autoFocus value={adding.name} maxLength={120} onChange={e => setAdding(a => a && { ...a, name: e.target.value })} /></label>
            <label>Counted in<input value={adding.measure} maxLength={20} placeholder="roll, bottle, pod…" onChange={e => setAdding(a => a && { ...a, measure: e.target.value })} /></label>
            <label>Category<select value={adding.category} onChange={e => setAdding(a => a && { ...a, category: e.target.value })}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
            <div className="button-row">
              <button disabled={busy || !adding.name.trim()} onClick={async () => {
                const r = await act({ action: 'newItem', ...adding, kind: p.view === 'house' ? 'furniture' : 'supply' });
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
        <div className="onsite-look">
          <b><Icon n="camera" /> How the {p.view === 'house' ? 'house' : 'storage'} looks</b>
          <span className="sub-n">Optional — {p.view === 'house' ? 'damage, stains, something broken or missing' : 'damp, a mess, a broken shelf, pests'}. Up to 5 photos, kept in Drive with this count;
            the place shows the latest.</span>
          <PhotoPicker tx={TX.en} files={files} onChange={setFiles} max={5} disabled={busy} />
          <textarea rows={2} maxLength={1000} value={look} placeholder={`A note on the ${p.view === 'house' ? 'house' : 'storage'} (optional)`} onChange={e => setLook(e.target.value)} />
        </div>
        {msg && <p className="breach" role="alert">{msg}</p>}
      </div>
      <div className="insp-foot">
        <span className="note">{done ? `${done} counted — saving replaces their record` : 'Nothing counted yet'}
          {ic((files.length > 0 || look.trim()) && ` · 📷 ${files.length} photo${files.length === 1 ? '' : 's'}${look.trim() ? ' + note' : ''}`)}</span>
        <button disabled={busy || (!done && !files.length && !look.trim())} onClick={() => void save()}>
          {busy ? 'Saving…' : done ? `Save the count (${done})` : 'Save photos & note'}</button>
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
/** Where lines go when nobody said: the storage most units draw from. */
const busiestPlace = (inv: Inventory) => [...inv.places.filter(p => p.place && p.view !== 'house')].sort((a, b) => b.units.length - a.units.length)[0]?.place ?? '';
const MEASURES = ['unit', 'pack', 'kit', 'pod', 'roll', 'bottle', 'box', 'bag', 'set', 'pair', 'gallon'];
/**
 * "Counted in" fixed where it shows (owner, 2026-10-15: the default "unit" stuck and could not be changed from a
 * purchase): ✎ beside it, any item, any time — the label only; no quantity is converted.
 */
function MeasureEdit({ it, canEdit, onInv }: { it: InvItemRow; canEdit: boolean; onInv?: (i: Inventory) => void }) {
  const api = useContext(InvApi);
  const [v, setV] = useState<string | null>(null);
  const [err, setErr] = useState('');
  if (!canEdit || !onInv) return <span className="sub-n">{it.measure}</span>;
  if (v === null) return <><span className="sub-n">{it.measure}</span> <button type="button" className="link tiny" title="Change how it is counted (pack, roll, box…)"
    aria-label={`Change how ${it.name} is counted`} onClick={() => { setV(it.measure); setErr(''); }}>✎</button></>;
  const save = async () => {
    try {
      const r = await api.act({ action: 'measure', itemId: it.id, measure: v });
      if (!r.ok) { setErr(r.message ?? 'Not saved.'); return; }
      onInv(r); setV(null);
    } catch (e) { setErr(String(e)); }
  };
  return <span className="nowrap"><input autoFocus value={v} maxLength={20} list="inv-measures" aria-label="Counted in" className="inv-measure"
    onChange={e => setV(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setV(null); }} />
    {' '}<button type="button" className="small" disabled={!v.trim() || v.trim() === it.measure} onClick={() => void save()}>Save</button>
    {' '}<button type="button" className="link tiny" onClick={() => setV(null)}>Cancel</button>
    {err && <span className="breach"> {err}</span>}</span>;
}
const TYPE_OF: Record<'supply' | 'furniture', string> = { supply: 'Supplies (storage)', furniture: 'Furniture (house)' };
type NewEdit = { name: string; size: string; measure: string; kind: 'supply' | 'furniture' };
function ItemLines({ inv, value, onChange, hints, canEdit, defaultPlace, onInv, tags, orderCol, fresh }: {
  inv: Inventory; value: Lines; onChange: (m: Lines) => void; hints?: Lines; canEdit: boolean; defaultPlace?: string | null;
  /** §150, owner: a supply not on the list is added from the 🔍 — the caller takes the new inventory. */
  onInv?: (i: Inventory) => void;
  /** A word under an item's name — "✨ from the receipt", "▲ not on the receipt". */
  tags?: Map<string, string[]>;
  /** One receipt, several orders: which order each item is for. */
  orderCol?: { options: { id: string; label: string }[]; value: Map<string, string>; onChange: (id: string, order: string) => void };
  /** Items made in this form (a receipt's new line): still correctable — name, size, counted in, type. */
  fresh?: Set<string>;
}) {
  const api = useContext(InvApi);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');
  const [made, setMade] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string } & NewEdit | null>(null);
  const d = destinations(inv);
  const keys = [...d.storages, ...d.houses].map(p => p.place!);
  const houses = housesOf(inv);
  const [q, setQ] = useState('');
  const item = (id: string) => inv.items.find(i => i.id === id);
  const kindOf = (id: string) => item(id)?.kind;
  // Owner, 2026-10-15: pick a unit or a storage — a unit sends its furniture to the house and its supplies to the
  // place it draws from. Until someone says otherwise, where it was asked for, else the busiest storage.
  const [allTo, setAllTo] = useState(defaultPlace ?? busiestPlace(inv));
  const to = (id: string, kind = kindOf(id)) => destFor(allTo, kind, houses);
  const set = (id: string, parts: Part[] | null) => { const n = new Map(value); if (parts?.length) n.set(id, parts); else n.delete(id); onChange(n); };
  // Lines not split follow "Goes to"; a split line keeps its parts.
  const sendAll = (place: string) => {
    setAllTo(place);
    onChange(new Map([...value].map(([id, parts]) => [id, parts.length === 1 ? [{ ...parts[0]!, place: destFor(place, kindOf(id), houses) }] : parts])));
  };
  const splitPart = (id: string, parts: Part[], k: number) => {
    const p = parts[k]!, n = Math.ceil(Number(p.qty) || 0);
    const fits = kindOf(id) === 'furniture' ? keys : d.storages.map(x => x.place!);
    const other = fits.find(x => !parts.some(q => q.place === x)) ?? p.place;
    const half = Math.floor(n / 2);
    set(id, [...parts.slice(0, k), { ...p, qty: n ? String(n - half) : p.qty }, { place: other, qty: n ? String(half) : '' }, ...parts.slice(k + 1)]);
  };
  const found = q.trim() ? inv.items.filter(i => i.active && !value.has(i.id) && i.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];
  // Not on the list (no exact name): one tap adds it, then ✎ says how it is counted and whether it is the house's.
  const exact = inv.items.some(i => i.active && i.name.toLowerCase() === q.trim().toLowerCase());
  const create = async () => {
    const name = q.trim();
    setCreating(true); setErr('');
    try {
      const r = await api.act({ action: 'newItem', name, measure: 'unit', category: 'other' });
      if (!r.ok || !r.itemId) { setErr(r.ok ? 'Not added.' : r.message ?? 'Not added.'); return; }
      onInv?.(r);
      setMade(m => new Set(m).add(r.itemId!));
      onChange(new Map(value).set(r.itemId, [{ place: to(r.itemId, 'supply'), qty: '' }]));
      setQ('');
      setEditing({ id: r.itemId, name, size: '', measure: 'unit', kind: 'supply' });
    } catch (e) { setErr(String(e)); } finally { setCreating(false); }
  };
  const saveEdit = async () => {
    if (!editing) return;
    setCreating(true); setErr('');
    try {
      const r = await api.act({ action: 'editItem', itemId: editing.id, name: editing.name, size: editing.size, measure: editing.measure, kind: editing.kind });
      if (!r.ok) { setErr(r.message ?? 'Not saved.'); return; }
      onInv?.(r);
      // The type decides where it goes: a line in one place moves with it.
      const parts = value.get(editing.id);
      if (parts?.length === 1 && editing.kind !== kindOf(editing.id)) set(editing.id, [{ ...parts[0]!, place: destFor(allTo, editing.kind, houses) }]);
      setEditing(null);
    } catch (e) { setErr(String(e)); } finally { setCreating(false); }
  };
  const isNew = (id: string) => made.has(id) || !!fresh?.has(id);
  return <>
    <datalist id="inv-measures">{MEASURES.map(m => <option key={m} value={m} />)}</datalist>
    {canEdit && keys.length > 1 && <label>Goes to
      <PlaceSelect inv={inv} value={allTo} onChange={sendAll} label="Everything goes to" />
      <span className="sub-n">a house: its furniture there, its supplies to its storage or closet (supplies never stay in a house) · ⑂ splits a part</span></label>}
    {canEdit && <label><Icon n="search" /> Add an item
      <input value={q} placeholder="Search the supplies and furniture…" onChange={e => setQ(e.target.value)} /></label>}
    {found.length > 0 && <div className="button-row">{found.map(i => (
      <button key={i.id} className="secondary" onClick={() => { set(i.id, [{ place: to(i.id), qty: '' }]); setQ(''); }}>+ {i.name}</button>))}</div>}
    {canEdit && q.trim() && !exact && onInv && <div className="button-row">
      {!found.length && <span className="note">“{q.trim()}” is not on the list.</span>}
      <button className="secondary" disabled={creating} onClick={() => void create()}>{creating ? 'Adding…' : `+ Add “${q.trim()}” as a new item`}</button>
    </div>}
    {err && <p className="breach" role="alert">{err}</p>}
    {q.trim() && !found.length && (exact || !onInv) && <p className="note">No other item matches “{q.trim()}”.</p>}
    {value.size > 0 && (
      <div className="grid-scroll">
        <table className="units compact">
          <thead><tr><th>Item</th><th className="n">Total</th><th>Goes to</th>{orderCol && <th>For the order</th>}<th></th></tr></thead>
          <tbody>
            {[...value].map(([id, parts]) => {
              const total = parts.reduce((a, p) => a + Math.ceil(Number(p.qty) || 0), 0);
              const hint = hints?.get(id);
              const it = item(id);
              const ed = editing?.id === id ? editing : null;
              return (
                <tr key={id}>
                  <td>{ed ? <div className="rc-new">
                      <input value={ed.name} maxLength={120} placeholder="Name" aria-label="Name" onChange={e => setEditing({ ...ed, name: e.target.value })} />
                      <input value={ed.size} maxLength={30} placeholder="Size (optional)" aria-label="Size" className="rc-size" onChange={e => setEditing({ ...ed, size: e.target.value })} />
                      <input value={ed.measure} maxLength={20} list="inv-measures" placeholder="unit, pack, pod…" aria-label="Counted in" className="inv-measure" onChange={e => setEditing({ ...ed, measure: e.target.value })} />
                      <select value={ed.kind} aria-label="Type" onChange={e => setEditing({ ...ed, kind: e.target.value as NewEdit['kind'] })}>
                        <option value="supply">{TYPE_OF.supply}</option><option value="furniture">{TYPE_OF.furniture}</option></select>
                      <button className="small" disabled={creating || !ed.name.trim()} onClick={() => void saveEdit()}>Save</button>
                      <button className="link tiny" onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                    : <><b>{it?.name}</b> {it && <MeasureEdit it={it} canEdit={canEdit && !isNew(id)} onInv={onInv} />}{it?.kind === 'furniture' && <span className="sub-n"> · furniture</span>}
                      {canEdit && isNew(id) && it && <> <button className="link tiny" title="New item: correct its name, how it is counted, its type"
                        onClick={() => setEditing({ id, name: it.baseName ?? it.name, size: it.size ?? '', measure: it.measure, kind: it.kind ?? 'supply' })}>✎ new item</button></>}</>}
                    {hint && <div className="sub-n">suggested: {hint.map(h => `${h.place ? lineTitle(inv, h.place) : '▲ no place'} ${h.qty}`).join(' · ')}</div>}
                    {tags?.get(id)?.map(t => <div key={t} className="sub-n">{t}</div>)}</td>
                  <td className="n"><b>{total || '—'}</b></td>
                  <td>
                    {parts.map((p, k) => (
                      <div key={k} className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <PlaceSelect inv={inv} value={p.place} label="Place" kind={it?.kind ?? 'supply'} onChange={v => set(id, parts.map((x, j) => j === k ? { ...x, place: v } : x))} />
                        <input className="inv-qty" type="number" min="0" step="1" value={p.qty} aria-label="Quantity"
                               onChange={e => set(id, parts.map((x, j) => j === k ? { ...x, qty: e.target.value } : x))} />
                        {canEdit && <button className="link tiny" title="Split this part: half to another place" onClick={() => splitPart(id, parts, k)}>⑂ split</button>}
                        {parts.length > 1 && <button className="link tiny" aria-label="Remove this place" onClick={() => set(id, parts.filter((_, j) => j !== k))}>✕</button>}
                      </div>))}
                    {canEdit && parts.length > 1 && <button className="link tiny" onClick={() => set(id, [{ place: parts[0]!.place, qty: String(total) }])}>⇢ one place</button>}
                  </td>
                  {orderCol && <td><select aria-label="For the order" value={orderCol.value.get(id) ?? ''} onChange={e => orderCol.onChange(id, e.target.value)}>
                    <option value="">no order</option>
                    {orderCol.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></td>}
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
  // Storages only: a house with nothing counted simply has no furniture order yet (listing 20 houses would bury the rest).
  const uncounted = inv.places.filter(p => p.place && p.view !== 'house' && p.units.length && p.items.every(l => !l.countedAt));
  return (
    <div className="card">
      <h2><Icon n="cart" /> To order — next {inv.aheadDays} days <Hint>An order is a shopping to-do: a line per item and where it goes. Suggested: what each place's units will take
        in the next {inv.aheadDays} days, plus its minimum, minus what it holds — places never counted are not guessed at. The stock
        changes only when the purchase is recorded (<Icon n="receipt" /> below).</Hint></h2>
      {uncounted.length > 0 && <p className="note">▲ Count first (nothing is suggested for them until then): {uncounted.map(placeTitle).join(', ')}.</p>}
      {inv.draft && <p className="note"><Icon n="note" /> <b>Draft</b> saved {inv.draft.savedAt} by {inv.draft.savedBy} — it becomes a to-do only when you create the order.</p>}
      {!order.size && <p className="note">Nothing to order from what has been counted. Add an item with <Icon n="search" /> to order it anyway.</p>}
      <ItemLines inv={inv} value={order} onChange={setOrder} hints={suggested} canEdit={canEdit} onInv={onSaved} />
      <CartLinks inv={inv} lines={lines} />
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
          try { const r = await api.act({ action: 'draft', lines, forTodo: forTodo || undefined }); if (!r.ok) setMsg(r.message ?? 'Not saved.'); else { onSaved(r); setMsg('Draft saved.'); } }
          catch (e) { setMsg(String(e)); } finally { setBusy(false); }
        }}><Icon n="save" /> Save draft</button>
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
 * The PURCHASE form (§150, owner) — ONE form for the three places a purchase is
 * recorded (owner, 2026-10-14): Inventory → 🧾 Record a purchase, a to-do's 🛒
 * purchase order, and a cleaner's purchase approved by recording it. Items and
 * where each went, total, paid by, note, receipt. Each caller keeps what is its
 * own (`head`, `extra`, the buttons beside Record) and says what recording does.
 *
 * ✨ Read receipt: the AI reads the attached receipt (Gemini; nothing else can
 * read a photo) and FILLS IN the form — supplies it is sure of, the total, the
 * store, the date; a line it is not sure of asks the person. Everything it
 * filled reads "✨ from the receipt" until someone touches it, and nothing is
 * saved until the usual button.
 */
export type PurchaseOut = {
  lines: { itemId: string; place: string; qty: number }[]; total: string; paidBy: string; note: string; files: File[]; date: string;
  /** One receipt, several orders: a purchase each, its share of the total. */
  splits?: { todoId: string; lines: { itemId: string; place: string; qty: number }[]; total: number }[];
  /** Every line moved to another order: the purchase is that order's. */
  forTodo?: string;
  /** Receipt lines a person decided — learned, so the next receipt with that text matches by itself. */
  aliases: { text: string; itemId: string }[];
  /** The Walmart/Amazon products bought, and how many of the supply's measure come in one — kept on the supply. */
  products?: { itemId: string; url: string; pack: number | null }[];
};
/** A receipt line in the form: which receipt (`rc`), the supply it went to, and whether a person decided it. */
type Row = { rc: number; line: ReceiptLine; got: string | null; skip: boolean; open: boolean; name: string; size: string; decided: boolean;
  /** How many of the item's measure this line is — the AI's reading until the person corrects it (owner, 2026-10-15). */
  qty: string;
  /** A new item: what it is counted in and whether it is the house's (furniture) — the AI's guess, corrected here. */
  measure: string; kind: 'supply' | 'furniture' };
const AI = '✨ from the receipt';
const money = (n: number) => `$${n.toFixed(2)}`;

function PurchaseForm({ inv, onInv, todoId = '', start, defaultPlace, fixedTotal, fieldExpenseId, hasReceipt, canSplit, head, extra,
                        recordLabel = '🧾 Record the purchase', onRecord, buttons }: {
  inv: Inventory; onInv: (i: Inventory) => void;
  /** The order this purchase is for, if any ('' = none). */
  todoId?: string; start?: Lines; defaultPlace?: string | null;
  /** A cleaner's purchase: what they paid is the total, their receipt is the receipt. */
  fixedTotal?: number; fieldExpenseId?: string; hasReceipt?: boolean;
  /** Whether one receipt may be split across the open orders. */
  canSplit?: boolean;
  head?: React.ReactNode; extra?: React.ReactNode; recordLabel?: string;
  /** Records it; a message back = not saved. `true` = clear the form for the next one. */
  onRecord: (p: PurchaseOut) => Promise<string | true | null>;
  buttons?: (p: { lines: PurchaseOut['lines']; busy: boolean }) => React.ReactNode;
}) {
  const api = useContext(InvApi);
  const [lines, setLinesRaw] = useState<Lines>(start ?? new Map());
  const [total, setTotal] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');
  // Owner, 2026-10-15: the team's receipts are Walmart/Amazon orders saved with MarkDownload (.md) — nothing else.
  const [files, setFiles] = useState<File[]>([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  // What the AI filled and nobody has touched since: 'total', 'note', 'date', 'item:<id>'.
  const [ai, setAi] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Row[]>([]);
  // Owner, 2026-10-14: more than one receipt for one purchase — each read adds its lines and its total.
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  // How many attached files were read; the lines as they were before the first read ("Read it again" starts there).
  const [readN, setReadN] = useState(0);
  const [before, setBefore] = useState<Lines | null>(null);
  const [reading, setReading] = useState(false);
  const [readMsg, setReadMsg] = useState('');
  const [orderOf, setOrderOf] = useState<Map<string, string>>(new Map());
  const [shares, setShares] = useState<Map<string, string>>(new Map());
  // A new order picked (Inventory) starts the lines over from it — unless a receipt already filled them in.
  useEffect(() => { if (!receipts.length) setLinesRaw(start ?? new Map()); }, [todoId]);
  const untouch = (...keys: string[]) => setAi(a => { if (!keys.some(k => a.has(k))) return a; const n = new Set(a); keys.forEach(k => n.delete(k)); return n; });
  // A line someone changes is theirs now — its ✨ goes.
  const setLines = (m: Lines) => {
    untouch(...[...new Set([...m.keys(), ...lines.keys()])].filter(id => JSON.stringify(m.get(id)) !== JSON.stringify(lines.get(id))).map(id => `item:${id}`));
    setLinesRaw(m);
  };
  const place0 = defaultPlace ?? busiestPlace(inv);
  const name = (id: string) => inv.items.find(i => i.id === id)?.name ?? id;
  const measureOf = (id: string) => inv.items.find(i => i.id === id)?.measure ?? '';
  // Items made from a receipt line in this form: still correctable in the lines (✎ new item).
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  /** Adds (or takes back) a receipt line's quantity on its item — a new line goes where its type belongs (furniture: the house). */
  const addQty = (m: Lines, id: string, q: number, kind = inv.items.find(i => i.id === id)?.kind) => {
    const parts = m.get(id) ?? [];
    const first = parts[0] ?? { place: start?.get(id)?.[0]?.place || destFor(place0, kind, housesOf(inv)), qty: '' };
    const n = Math.max(0, Math.round(((Number(first.qty) || 0) + q) * 100) / 100);
    if (!n && parts.length <= 1) m.delete(id); else m.set(id, [{ ...first, qty: String(n) }, ...parts.slice(1)]);
  };
  const qtyOf = (l: ReceiptLine) => l.itemQty ?? l.qty ?? 1;
  const rowQty = (r: Row) => Math.max(0, Number(r.qty) || 0);

  /**
   * `fresh`: read only the receipts attached since the last read and add them; else read them all again from the start.
   * The team's .md orders are read as printed (one receipt each); a cleaner's receipt photos (from Drive) by the AI.
   */
  const read = async (fresh: boolean) => {
    setReading(true); setReadMsg('');
    try {
      const f = new FormData();
      f.append('action', 'readReceipt');
      if (!canSplit) f.append('orders', 'no');
      type Repeat = { at: string; orderNo: string | null } | null;
      let got: Receipt[], repeats: Repeat[], by: string;
      if (!files.length && fieldExpenseId) {
        f.append('fieldExpenseId', fieldExpenseId);
        const r = await api.upload(f) as unknown as { ok: true; receipt: Receipt; by: string; repeat: Repeat } | { ok: false; message?: string };
        if (!r.ok) { setReadMsg(`Could not read the receipt — fill it in by hand. (${r.message ?? 'no answer'})`); return; }
        got = [r.receipt]; repeats = [r.repeat]; by = `✨ Read by ${r.by}`;
      } else {
        f.append('mds', JSON.stringify(await Promise.all((fresh ? files.slice(readN) : files).map(x => x.text()))));
        const r = await api.upload(f) as unknown as { ok: true; receipts: Receipt[]; repeats: Repeat[]; warnings: string[] } | { ok: false; message?: string };
        if (!r.ok) { setReadMsg(`Could not read the order — fill it in by hand. (${r.message ?? 'no answer'})`); return; }
        got = r.receipts; repeats = r.repeats;
        by = `Read from the order page as printed${r.warnings.map(w => ` ▲ ${w}`).join('')}`;
      }
      if (!got.some(rc => rc.lines.length || rc.total != null)) { setReadMsg('Could not read the receipt — fill it in by hand. (nothing found on it)'); return; }
      const first = !fresh || !receipts.length;
      const base = first ? before ?? lines : lines;
      if (first) setBefore(base);
      const m = new Map(base);
      const sure = got.flatMap(rc => rc.lines).filter(l => l.itemId);
      // The first receipt says what was bought: its supplies replace the order's quantities. A later one adds.
      // Owner, 2026-10-15: what was ordered and is on no receipt was not bought — off the lines, named under "Against the order".
      if (first) for (const id of new Set([...sure.map(l => l.itemId!), ...start?.keys() ?? []])) m.delete(id);
      for (const l of sure) addQty(m, l.itemId!, qtyOf(l));
      setLinesRaw(m);
      const marks = new Set(first ? [] : ai);
      sure.forEach(l => marks.add(`item:${l.itemId}`));
      const paid = got.filter(rc => rc.total != null);
      if (fixedTotal == null && paid.length) {
        // Adding a receipt adds its total — unless someone typed the total themselves.
        if (first || ai.has('total') || !total) {
          setTotal(String(Math.round(((first ? 0 : Number(total) || 0) + paid.reduce((a, rc) => a + rc.total!, 0)) * 100) / 100)); marks.add('total');
        }
      }
      const stores = [...new Set(got.map(rc => rc.orderNo ? `${rc.store ?? 'Order'} #${rc.orderNo}` : rc.store).filter(Boolean))].join(' + ');
      if (stores && (first ? !note.trim() || ai.has('note') : ai.has('note'))) { setNote(first ? stores : `${note} + ${stores}`); marks.add('note'); }
      const day = got.find(rc => rc.date)?.date;
      if (day && (first || !date)) { setDate(day); marks.add('date'); }
      setAi(marks);
      const k0 = first ? 0 : receipts.length;
      const fresh_ = got.flatMap((rc, j) => rc.lines.map((l): Row => ({ rc: k0 + j, line: l, got: l.itemId, skip: l.kind !== 'item', open: l.kind === 'item' && !l.itemId,
                                                 name: l.newName ?? l.text, size: l.size ?? '', decided: false, qty: String(qtyOf(l)),
                                                 measure: l.newMeasure ?? 'unit', kind: l.newKind ?? 'supply' })));
      setRows(first ? fresh_ : [...rows, ...fresh_]);
      setReceipts(first ? got : [...receipts, ...got]);
      setReadN(files.length);
      setOrderOf(o => { const n = new Map(first ? [] : o); sure.forEach(l => { if (!n.has(l.itemId!)) n.set(l.itemId!, l.orderId ?? todoId); }); return n; });
      setShares(new Map());
      // The same order read before: said, so it is not recorded twice.
      const again = repeats.filter((x): x is NonNullable<Repeat> => !!x)
        .map(x => ` ⚠ ${x.orderNo ? `Order ${x.orderNo}` : 'This receipt'} was already read on ${x.at.slice(0, 10)} — make sure it is not recorded twice.`).join('');
      setReadMsg(`${by} — check every line before recording.${again}`);
    } catch (e) { setReadMsg(`Could not read the receipt — fill it in by hand. (${String(e)})`); } finally { setReading(false); }
  };
  const setRow = (k: number, row: Row) => setRows(rs => rs.map((x, j) => j === k ? row : x));
  /** A doubtful line answered by a person: that supply (its quantity added), or skipped. */
  const choose = (k: number, id: string | null, i2?: Inventory) => {
    const row = rows[k]!;
    const m = new Map(lines);
    if (row.got) addQty(m, row.got, -rowQty(row));
    if (id) addQty(m, id, rowQty(row), (i2 ?? inv).items.find(i => i.id === id)?.kind);
    setLinesRaw(m);
    if (i2) onInv(i2);
    setAi(a => { const n = new Set(a); if (row.got) n.delete(`item:${row.got}`); if (id) n.add(`item:${id}`); return n; });
    if (id && !orderOf.has(id)) setOrderOf(new Map(orderOf).set(id, orderFor(id, inv.orders) ?? todoId));
    setRow(k, { ...row, got: id, skip: !id, open: false, decided: !!id });
  };
  /** The person corrects how many this line is (a pack of 24 pods = 24 pods, or 1 pack): the item's quantity follows. */
  const setRowQty = (k: number, v: string) => {
    const row = rows[k]!;
    if (row.got) { const m = new Map(lines); addQty(m, row.got, Math.max(0, Number(v) || 0) - rowQty(row)); setLines(m); }
    setRow(k, { ...row, qty: v });
  };
  const addNew = async (k: number) => {
    const row = rows[k]!;
    setBusy(true); setMsg('');
    try {
      const r = await api.act({ action: 'newItem', name: row.name.trim(), size: row.size.trim() || undefined, measure: row.measure.trim() || 'unit',
                               kind: row.kind, category: row.kind === 'furniture' ? 'other' : 'cleaning' });
      if (!r.ok || !r.itemId) { setMsg(r.ok ? 'Not added.' : r.message ?? 'Not added.'); return; }
      setFresh(f => new Set(f).add(r.itemId!));
      choose(k, r.itemId, r);
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };

  const out = flat(lines);
  const unplaced = [...lines.values()].some(ps => ps.some(p => !p.place && Number(p.qty) > 0));
  const totalN = fixedTotal ?? Number(total);
  const read1 = receipts.length > 0;
  // The receipts' own lines (tax and fees too) against the total they say was paid.
  const sumLines = read1 ? Math.round(receipts.reduce((a, r) => a + receiptSum(r), 0) * 100) / 100 : null;
  const off = sumLines != null && totalN > 0 && Math.abs(sumLines - totalN) >= 0.01 ? Math.round((totalN - sumLines) * 100) / 100 : null;
  // One receipt, several orders — offered once a receipt was read and some line fits another open order.
  const others = inv.orders.filter(o => o.todoId !== todoId);
  const splitting = !!canSplit && read1 && inv.orders.length > 0 && rows.some(r => r.got && orderFor(r.got, others));
  const orderKey = (id: string) => orderOf.get(id) ?? todoId;
  const groups = splitting ? [...new Set(out.map(l => orderKey(l.itemId)))] : [];
  const amountOf = (id: string) => rows.filter(r => r.got === id).reduce((a, r) => a + (r.line.amount ?? 0), 0);
  const auto = splitTotal(totalN > 0 ? totalN : 0, groups.map(g => ({ key: g, amount: [...new Set(out.filter(l => orderKey(l.itemId) === g).map(l => l.itemId))].reduce((a, id) => a + amountOf(id), 0) })));
  const shareOf = (g: string) => shares.get(g) ?? String(auto.find(x => x.key === g)?.share ?? 0);
  const shareSum = Math.round(groups.reduce((a, g) => a + (Number(shareOf(g)) || 0), 0) * 100) / 100;
  const shareLeft = groups.length > 1 && totalN > 0 ? Math.round((totalN - shareSum) * 100) / 100 : 0;
  const orderTitle = (g: string) => g ? inv.orders.find(o => o.todoId === g)?.title ?? `to-do #${g}` : 'no order';
  const pending = rows.filter(r => r.open).length;

  const clear = () => {
    setLinesRaw(new Map()); setTotal(''); setNote(''); setDate(''); setFiles([]); setPaidBy(''); setAi(new Set());
    setRows([]); setFresh(new Set()); setReceipts([]); setReadN(0); setBefore(null); setReadMsg(''); setOrderOf(new Map()); setShares(new Map());
  };
  const record = async () => {
    setBusy(true); setMsg('');
    try {
      const splits = groups.length > 1 ? groups.map(g => ({ todoId: g, lines: out.filter(l => orderKey(l.itemId) === g), total: Number(shareOf(g)) || 0 })) : undefined;
      const aliases = rows.filter(r => r.decided && r.got).map(r => ({ text: r.line.text, itemId: r.got! }));
      // The store's product on each line kept: next time it matches by number and opens in the store's cart.
      const products = rows.filter(r => r.got && !r.skip && r.line.product).map(r => ({ itemId: r.got!, url: r.line.product!.url,
        pack: r.line.qty ? Math.round(rowQty(r) / r.line.qty * 100) / 100 : null }));
      // One order left after the split → the purchase is that order's.
      const r = await onRecord({ lines: out, total: fixedTotal != null ? String(fixedTotal) : total, paidBy, note, files, date, splits, aliases, products,
                                 ...(groups.length === 1 && groups[0] !== todoId ? { forTodo: groups[0] } : {}) });
      if (typeof r === 'string') { setMsg(r); return; }
      if (r === true) { clear(); setMsg('✓ Purchase recorded: in the stock and in Costs (Restock). Attach the next receipt to record another.'); }
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };
  const unread = files.length - readN;
  const canRead = files.length > 0 || !!hasReceipt;
  // Owner, 2026-10-15: the receipt checked against the order — what is missing, short, extra, not exact, not matched.
  const ordered = new Map<string, number>();
  for (const [id, ps] of start ?? []) ordered.set(id, ps.reduce((a, p) => a + (Number(p.qty) || 0), 0));
  const bought = new Map<string, number>();
  for (const r of rows) if (r.got && !r.skip && !r.open) bought.set(r.got, (bought.get(r.got) ?? 0) + rowQty(r));
  const vs = againstOrder(ordered, bought);
  const notExact = rows.filter(r => r.open && r.line.kind === 'item' && r.line.candidates.length > 0);
  const noMatch = rows.filter(r => r.open && r.line.kind === 'item' && !r.line.candidates.length);
  const exact = rows.filter(r => r.got && !r.open && (r.line.match === 'product' || r.line.match === 'alias'));
  const qn = (id: string, q: number | undefined) => `${name(id)} — ${fmt(q ?? 0)} ${measureOf(id)}`;
  const tags = new Map<string, string[]>();
  for (const id of lines.keys()) {
    const t: string[] = [];
    if (ai.has(`item:${id}`)) t.push(AI);
    else if (read1 && !rows.some(r => r.got === id)) t.push('▲ not on the receipt');
    if (read1 && ordered.size && !ordered.has(id)) t.push('+ not in the order');
    else if (read1 && ordered.has(id) && bought.has(id) && bought.get(id) !== ordered.get(id)) t.push(`≠ ordered ${fmt(ordered.get(id))}`);
    if (t.length) tags.set(id, t);
  }
  const mark = (k: string) => ai.has(k) ? <span className="sub-n"> {ic(AI)}</span> : null;
  return <>
    {head}
    {read1 && <div className="receipt-lines">
      {receipts.map((rc, i) => <Fragment key={i}>
        <p className="note"><b>On the receipt{receipts.length > 1 ? ` ${i + 1}` : ''}</b>{rc.store ? ` — ${rc.store}` : ''}{rc.date ? ` · ${rc.date}` : ''}
          {rc.total != null ? ` · ${money(rc.total)}` : ''}
          {(() => { const n = rows.filter(r => r.rc === i && r.open).length;
            return n > 0 && <> · <span className="breach">▲ {n} line{n === 1 ? '' : 's'} to decide</span></>; })()}</p>
        <div className="grid-scroll"><table className="units compact"><tbody>
          {rows.map((r, k) => r.rc !== i ? null : (
            <Fragment key={k}>
            <tr className={r.open ? 'rc-open' : undefined}>
              <td><RowFlag r={r} name={name} ordered={ordered} />{r.line.text}
                {r.line.size && <span className="chip tiny"> {r.line.size}</span>}
                {r.line.qty != null && r.line.qty !== 1 && <div className="sub-n">{r.line.qty} × {r.line.unitPrice != null ? money(r.line.unitPrice)
                  : r.line.amount != null ? money(Math.round(r.line.amount / r.line.qty * 100) / 100) : '—'}</div>}</td>
              <td className="n">{r.line.amount != null ? money(r.line.amount) : '—'}</td>
              <td className="nowrap">
                {r.got && !r.open && <>→ <b>{name(r.got)}</b>{' '}
                  <input className="inv-qty" type="number" min="0" step="any" value={r.qty} aria-label={`How many ${name(r.got)}`} onChange={e => setRowQty(k, e.target.value)} />
                  {' '}{(() => { const it = inv.items.find(i => i.id === r.got); return it ? <MeasureEdit it={it} canEdit onInv={onInv} /> : <span className="sub-n">{measureOf(r.got)}</span>; })()}{Number(r.qty) !== qtyOf(r.line) && <span className="sub-n"> (read {qtyOf(r.line)})</span>}
                  {' '}<button className="link tiny" onClick={() => setRow(k, { ...r, open: true })}>change</button></>}
                {r.skip && !r.open && <span className="sub-n">{r.line.kind === 'item' ? 'skipped' : r.line.kind} — not a supply{' '}
                  <button className="link tiny" onClick={() => setRow(k, { ...r, open: true })}>it is one</button></span>}
                {r.open && <span className="warn-text">▲ which supply?</span>}
              </td>
            </tr>
            {r.open && <tr className="rc-open"><td colSpan={3}>
              <div className="rc-decide">
                {(() => { const c = [...new Set([...r.line.candidates, ...similarItems(`${r.line.text} ${r.line.size ?? ''}`, inv.items, 6)])].filter(id => id !== r.got).slice(0, 4);
                  return c.length > 0 && <div className="rc-step">
                    <span className="rc-label">Is it one of these?</span>
                    <div className="rc-picks">{c.map(id => <button key={id} className="secondary small" onClick={() => choose(k, id)}>{name(id)}</button>)}</div>
                  </div>; })()}
                <div className="rc-step">
                  <span className="rc-label">{r.line.candidates.length ? 'Or a new item' : 'A new item'} <Hint>What the AI read is only a start — fix the name, how it is
                    counted once opened (a pack of 24 pods: counted in pods, 24 — or in packs, 1) and the type: furniture goes to the house, supplies to the storage.</Hint></span>
                  <div className="rc-new">
                    <input value={r.name} maxLength={80} placeholder="Name" aria-label="New item name" onChange={e => setRow(k, { ...r, name: e.target.value })} />
                    <input value={r.size} maxLength={30} placeholder="Size (optional)" aria-label="Size" className="rc-size" onChange={e => setRow(k, { ...r, size: e.target.value })} />
                  </div>
                  <div className="rc-new">
                    <label>How many<input className="inv-qty" type="number" min="0" step="any" value={r.qty} onChange={e => setRow(k, { ...r, qty: e.target.value })} /></label>
                    <label>Counted in<input value={r.measure} maxLength={20} list="inv-measures" placeholder="unit, pack, pod…" className="inv-measure" onChange={e => setRow(k, { ...r, measure: e.target.value })} /></label>
                    <label>Type<select value={r.kind} onChange={e => setRow(k, { ...r, kind: e.target.value as Row['kind'] })}>
                      <option value="supply">{TYPE_OF.supply}</option><option value="furniture">{TYPE_OF.furniture}</option></select></label>
                    <button className="small" disabled={busy || !r.name.trim() || !(Number(r.qty) > 0)} onClick={() => void addNew(k)}>+ Add as a new item</button>
                  </div>
                  <span className="sub-n">On the receipt: {r.line.qty ?? 1} × “{r.line.text}”{r.line.newName || r.line.newMeasure ? ` · the AI read ${qtyOf(r.line)} ${r.line.newMeasure ?? 'unit'}` : ''}{r.line.newKind === 'furniture' ? ', furniture' : ''}</span>
                </div>
                <div className="rc-foot">
                  {r.got && <button className="link" onClick={() => setRow(k, { ...r, open: false })}>keep {name(r.got)}</button>}
                  <button className="link" onClick={() => choose(k, null)}>Skip — not a supply (tax, bag…)</button>
                </div>
              </div>
            </td></tr>}
            </Fragment>))}
        </tbody></table></div>
      </Fragment>)}
    </div>}
    {read1 && <div className="rc-check">
      <b>{ordered.size ? 'Against the order' : 'Matching'}</b>
      {ordered.size > 0 && vs.ok.length > 0 && <Flag label={`✓ ${vs.ok.length} as ordered`} title="Bought as ordered" list={vs.ok.map(id => qn(id, bought.get(id)))} />}
      {vs.missing.length > 0 && <Flag tone="attn" label={`▲ ${vs.missing.length} missing`} title="Ordered, not on the receipt — not recorded as bought; the order stays open for them"
        list={vs.missing.map(id => qn(id, ordered.get(id)))} />}
      {vs.fewer.length > 0 && <Flag tone="attn" label={`≠ ${vs.fewer.length} fewer`} title="Fewer than ordered" list={vs.fewer.map(id => `${name(id)} — ordered ${fmt(ordered.get(id))}, bought ${fmt(bought.get(id))}`)} />}
      {vs.more.length > 0 && <Flag label={`≠ ${vs.more.length} more`} title="More than ordered" list={vs.more.map(id => `${name(id)} — ordered ${fmt(ordered.get(id))}, bought ${fmt(bought.get(id))}`)} />}
      {ordered.size > 0 && vs.extra.length > 0 && <Flag tone="attn" label={`+ ${vs.extra.length} not in the order`} title="On the receipt, not in the order" list={vs.extra.map(id => qn(id, bought.get(id)))} />}
      {!ordered.size && exact.length > 0 && <Flag label={`✓ ${exact.length} exact`} title="Matched by the store's product number, or a text decided before" list={exact.map(r => `${r.line.text} → ${name(r.got!)}`)} />}
      {notExact.length > 0 && <Flag tone="attn" label={`≈ ${notExact.length} not exact`} title="Not an exact match — pick the supply on the line" list={notExact.map(r => r.line.text)} />}
      {noMatch.length > 0 && <Flag tone="attn" label={`✕ ${noMatch.length} no match`} title="Nothing on the supplies list is like it — add it as a new item, or skip it" list={noMatch.map(r => r.line.text)} />}
      {!vs.missing.length && !vs.fewer.length && !vs.extra.length && !notExact.length && !noMatch.length && <span className="note">✓ everything checks</span>}
    </div>}
    {!read1 && fixedTotal == null && <CartLinks inv={inv} lines={out} />}
    <ItemLines inv={inv} value={lines} onChange={setLines} canEdit defaultPlace={defaultPlace} onInv={onInv} tags={tags} fresh={fresh}
               orderCol={splitting ? { options: inv.orders.map(o => ({ id: o.todoId, label: o.title })), value: new Map(out.map(l => [l.itemId, orderKey(l.itemId)])),
                                       onChange: (id, o) => { setOrderOf(new Map(orderOf).set(id, o)); setShares(new Map()); } } : undefined} />
    <div className="row">
      {fixedTotal == null
        ? <label>Total paid ($){mark('total')}<input type="number" inputMode="decimal" min="0" step="0.01" value={total} onChange={e => { setTotal(e.target.value); untouch('total'); setShares(new Map()); }} /></label>
        : <label>Total paid ($)<input value={fixedTotal.toFixed(2)} disabled /><span className="sub-n">what they paid</span></label>}
      {fixedTotal == null && <PaidBy value={paidBy} onChange={setPaidBy} />}
      <label>Note{mark('note')}<input value={note} maxLength={500} placeholder="Store, card…" onChange={e => { setNote(e.target.value); untouch('note'); }} /></label>
      {read1 && fixedTotal == null && <label>Bought on{mark('date')}<input type="date" value={date} onChange={e => { setDate(e.target.value); untouch('date'); }} /></label>}
      {/* Each pick ADDS files (another order) — up to 5. Typed as Markdown: the browser often gives a .md no type at all. */}
      {fixedTotal == null && <label className="chip"><Icon n="clip" /> {files.length ? `${files.length} order${files.length === 1 ? '' : 's'} · + another` : 'Receipt (.md)'}
        <input type="file" accept=".md,text/markdown" multiple hidden
               onChange={e => {
                 const picked = [...(e.target.files ?? [])];
                 const bad = picked.filter(x => !/\.(md|markdown)$/i.test(x.name));
                 setReadMsg(bad.length ? `Only orders saved as Markdown (.md) are read — ${bad.map(x => x.name).join(', ')} left out.` : '');
                 setFiles([...files, ...picked.filter(x => !bad.includes(x)).map(x => new File([x], x.name, { type: 'text/markdown' }))].slice(0, 5));
                 e.target.value = '';
               }} /></label>}
      {fixedTotal == null && <Hint>On walmart.com → Purchase history → the order: select from its title ("Oct 15, 2026 order") down to Total, then MarkDownload →
        download the selection (the whole page leaves the products out). On Amazon: Your orders → Order details → MarkDownload. Kaizen checks each file:
        no order number or date, or products that do not add up to the subtotal, is said. Each product's link is its store number: the next receipt matches it by itself.</Hint>}
      {files.length > 0 && !read1 && <button className="link tiny" onClick={() => { setFiles([]); setReadN(0); }}>✕ files</button>}
      {canRead && (read1 && unread > 0
        ? <button className="secondary" disabled={reading || busy} onClick={() => void read(true)}>{ic(reading ? 'Reading…' : `✨ Read the new receipt${unread > 1 ? 's' : ''}`)}</button>
        : <button className="secondary" disabled={reading || busy} onClick={() => void read(false)}>{ic(reading ? 'Reading…' : read1 ? '✨ Read it again' : '✨ Read receipt')}</button>)}
    </div>
    {readMsg && <p className={readMsg.startsWith('') ? 'note' : 'breach'} role="status">{readMsg}</p>}
    {off != null && <p className="note">▲ The receipt's lines add up to {money(sumLines!)} — {money(Math.abs(off))} {off > 0 ? 'less' : 'more'} than the total.</p>}
    {groups.length > 1 && <div className="receipt-split">
      <p className="note"><b>One receipt, {groups.length} purchases</b> <Hint>Each order gets its share of the total, by what its lines cost (tax spread the same way).
        Edit a share if needed — they must add up to the total. The receipt file goes with each.</Hint></p>
      {groups.map(g => <label key={g}>{orderTitle(g)} ($)
        <input type="number" inputMode="decimal" min="0" step="0.01" value={shareOf(g)} onChange={e => setShares(new Map(shares).set(g, e.target.value))} /></label>)}
      <p className={shareLeft ? 'breach' : 'note'}>{shareLeft ? `▲ ${money(Math.abs(shareLeft))} ${shareLeft > 0 ? 'left to assign' : 'too much'} — the parts must add up to the total.` : '✓ The parts add up to the total.'}
        {shares.size > 0 && <> <button className="link tiny" onClick={() => setShares(new Map())}>↺ split by the lines again</button></>}</p>
    </div>}
    {extra}
    <div className="button-row">
      {buttons?.({ lines: out, busy })}
      <button disabled={busy || !out.length || unplaced || !(totalN > 0) || pending > 0 || !!shareLeft} onClick={() => void record()}>{ic(busy ? 'Saving…' : recordLabel)}</button>
      {unplaced && <span className="note">▲ Say which place each item went to.</span>}
      {pending > 0 && <span className="note">▲ Decide the receipt's lines first.</span>}
      {unread > 0 && read1 && <span className="note">▲ {unread} receipt file{unread === 1 ? '' : 's'} not read yet.</span>}
      {lines.size > 0 && !out.length && <span className="note">Write how many of each item.</span>}
      {out.length > 0 && !(totalN > 0) && <span className="note">The total paid is needed to record it.</span>}
    </div>
    {msg && <p className={msg.startsWith('✓') ? 'note' : 'breach'} role="status">{msg}</p>}
  </>;
}

/** A word whose detail (the items) shows on hover or a tap — the receipt's checks against the order. */
function Flag({ label, title, list, tone }: { label: string; title: string; list: string[]; tone?: 'attn' }) {
  return <Peek className={`rc-flag ${tone ?? ''}`} label={label} ariaLabel={`${label}: ${title}`}><b>{title}</b>{list.map(x => <Fragment key={x}><br />{x}</Fragment>)}</Peek>;
}
/** How a receipt line was matched, on its row: exact (the store's number), learned, not exact, no match, not in the order. */
function RowFlag({ r, name, ordered }: { r: Row; name: (id: string) => string; ordered: Map<string, number> }) {
  if (r.line.kind !== 'item' || r.skip) return null;
  const p = r.line.product;
  if (r.open) return r.line.candidates.length
    ? <Flag tone="attn" label="≈" title="Not an exact match" list={[`Looks like: ${r.line.candidates.map(name).join(', ')}`, 'Pick the supply below — it is remembered.']} />
    : <Flag tone="attn" label="✕" title="No match" list={['Nothing on the supplies list is like it.', 'Add it as a new item, or skip it.']} />;
  if (r.got && ordered.size && !ordered.has(r.got)) return <Flag tone="attn" label="+" title="Not in the order" list={[`${name(r.got)} was not ordered.`]} />;
  if (r.line.match === 'product' && p) return <Flag label="✓" title="Exact" list={[`${STORE_NAME[p.store]} ${p.store === 'amazon' ? 'ASIN' : 'item'} ${p.id} is ${name(r.got!)}'s product.`]} />;
  if (r.line.match === 'alias') return <Flag label="✓" title="Learned" list={['This text was matched by a person before.']} />;
  return null;
}

/**
 * The order's store carts (owner, 2026-10-15): one link per store with every supply whose first Walmart/Amazon
 * buying option is there, as many as cover the order. Kaizen never pays — the person checks the cart and pays.
 */
function CartLinks({ inv, lines }: { inv: Inventory; lines: { itemId: string; qty: number }[] }) {
  const c = cartLinks(lines, inv.items);
  if (!lines.length || (!c.walmart.url && !c.amazon.length && !c.none.length)) return null;
  const name = (id: string) => inv.items.find(i => i.id === id)?.name ?? id;
  return <div className="button-row cart-links">
    {c.walmart.url && <a className="chip" href={c.walmart.url} target="_blank" rel="noreferrer"><Icon n="cart" /> Open cart at Walmart ({c.walmart.items.length}) ↗</a>}
    {c.amazon.map(a => <a key={a.itemId} className="chip" href={a.url} target="_blank" rel="noreferrer">Amazon: {name(a.itemId)} ×{a.qty} ↗</a>)}
    {(c.walmart.url || c.amazon.length > 0) && <Hint>Walmart: opens the cart with these items added. Amazon has no cart link that works, so each item opens its page — add it there.
      Check the cart and pay in the store; Kaizen never pays. How many = what is ordered ÷ how many come in one (Setup → Items list → Buy at ×), rounded up.</Hint>}
    {c.none.length > 0 && <Flag tone="attn" label={`No store link: ${c.none.length}`} title="No Walmart or Amazon product yet — buy them by hand"
      list={[...c.none.map(name), 'A receipt (.md) that has them remembers their product.']} />}
  </div>;
}

/** The form's purchase to the server: one, or one per order from one receipt (uploaded once). */
async function sendPurchase(api: InvTransport, p: PurchaseOut, todoId: string) {
  const f = new FormData();
  f.append('action', 'purchase'); f.append('note', p.note); f.append('paidBy', p.paidBy);
  if (p.date) f.append('date', p.date);
  if (p.aliases.length) f.append('aliases', JSON.stringify(p.aliases));
  if (p.products?.length) f.append('products', JSON.stringify(p.products));
  if (p.splits) f.append('splits', JSON.stringify(p.splits));
  else {
    f.append('lines', JSON.stringify(p.lines)); f.append('total', p.total);
    const forTodo = p.forTodo ?? todoId;
    if (forTodo) f.append('todoId', forTodo);
  }
  for (const x of p.files) f.append('file', x);
  return await api.upload(f);
}

/** Inventory → 🧾 Record a purchase: from an open order (its lines filled in) or from scratch. */
function RecordPurchase({ inv, onSaved }: { inv: Inventory; onSaved: (i: Inventory) => void }) {
  const api = useContext(InvApi);
  const [todoId, setTodoId] = useState('');
  const o = inv.orders.find(x => x.todoId === todoId);
  return (
    <div className="card">
      <h2><Icon n="receipt" /> Record a purchase <Hint>What was really bought: it adds to each place's stock and goes to Costs as one Restock expense with its receipt.
        Start from an open order (its lines come filled in) or add the items with <Icon n="search" />. Attach the Walmart/Amazon order saved with MarkDownload (.md) →
        <Icon n="sparkles" /> Read receipt fills the form in and checks it against the order (missing, fewer, not ordered, not exact) — check it, then record it.
        More than one order: <Icon n="clip" /> + another → <Icon n="sparkles" /> Read the new receipt adds its lines and total. Close the order in To-do once everything is bought.</Hint></h2>
      <PurchaseForm inv={inv} onInv={onSaved} todoId={todoId} start={o ? linesOf(o.lines) : undefined} canSplit recordLabel="Record the purchase"
        head={<label>For the order
          <select value={todoId} onChange={e => setTodoId(e.target.value)}>
            <option value="">— none (a purchase on its own)</option>
            {inv.orders.map(o => <option key={o.todoId} value={o.todoId}>{o.at} · {o.title}{o.purchases ? ` · ${o.purchases} purchase${o.purchases === 1 ? '' : 's'} so far` : ''}</option>)}
          </select></label>}
        onRecord={async p => {
          const r = await sendPurchase(api, p, todoId);
          if (!r.ok) return r.message ?? 'Not saved.';
          onSaved(r); setTodoId(''); return true;
        }} />
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
                  <td className={m.kind === 'missing' ? 'breach' : undefined}>{ic(KIND_WORD[m.kind])}</td><td className="n">{fmt(m.qty)}</td>
                  <td className="ops-note">{m.note}{m.photos?.map((p, i) => <Fragment key={i}> <a href={p.url} target="_blank" rel="noreferrer"><Icon n="clip" /></a></Fragment>)}</td>
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
  type U = { id: string; name: string; recordId: string | null; closet?: boolean };
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pick, setPick] = useState<(U & { from: string }) | null>(null);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  // Owner, 2026-10-15: a unit with a closet takes from it; a storage it sits under REFILLS that closet.
  const closets = inv.places.filter(p => p.self && p.view !== 'house');
  const zones: { key: string; title: string; hint?: string; units: U[] }[] = [
    ...inv.places.filter(p => p.place && !p.self && p.view !== 'house').map(p => ({ key: p.place!, title: p.name,
      units: [...p.units, ...closets.filter(c => c.from === p.place).flatMap(c => c.units.map(u => ({ ...u, closet: true })))] })),
    { key: 'self', title: 'Own closet, nothing refills it', hint: 'the unit keeps its supplies in its own closet',
      units: closets.filter(c => !c.from).flatMap(c => c.units.map(u => ({ ...u, closet: true }))) },
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
      <h2>Places &amp; who draws from them <Hint>A unit's supplies come from the place its Repository record names in <b>Storage</b>. A unit that
        <b> Has closet</b> (Repository; every house, the P2 apartments) keeps them in its own closet — cleaners take from there only — and the storage
        it sits under here is what <b>refills</b> that closet (“· closet”). Drag a unit to another place — or tap it and choose — and Kaizen writes it
        there; tap a unit to switch “Has closet”. Past moves stay where they happened. A new storage = a new record with Property type “Storage”
        in a Units table.</Hint></h2>
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
                        onClick={() => { setPick({ ...u, from: z.key }); setTo(z.key); setMsg(''); }}>⠿ {u.name}{u.closet && z.key !== 'self' && <span className="sub-n"> · closet</span>}</button>))}
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
          <label className="check"><input type="checkbox" checked={!!pick.closet} disabled={busy} onChange={async e => {
            const on = e.target.checked;
            setBusy(true); setMsg('');
            try {
              const r = await inventoryItemAction({ action: 'closet', unitId: pick.id, on });
              if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
              setMsg(`✓ ${pick.name}: ${on ? 'has a closet — cleaners take from it' : 'no closet — cleaners take from its storage'} (saved in the Repository).`); setPick(null); onChanged();
            } catch (x) { setMsg(String(x)); } finally { setBusy(false); }
          }} /> Has closet</label>
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
        filled in — so <Icon n="receipt" /> Record a purchase starts from it. Checked after every count, correction and take. Places never counted never
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
export function TaskPurchase({ todoId, unitIds, onClose, onBought, asked }: {
  todoId: string; unitIds: string[]; onClose: () => void; onBought: (closeIt: boolean) => void;
  /** §159: what was asked, in the asker's words (the to-do's description) — ✨ builds the cart from it. */
  asked?: string | null;
}) {
  const [inv, setInv] = useState<Inventory | null>(null);
  const [startArr, setStartArr] = useState<{ itemId: string; place: string; qty: number }[]>([]);
  const [formKey, setFormKey] = useState(0);
  const [closeIt, setCloseIt] = useState(true);
  const [msg, setMsg] = useState('');
  const [building, setBuilding] = useState(false);
  const [unsure, setUnsure] = useState<{ text: string; candidates: string[] }[]>([]);
  // Owner, 2026-10-14: the to-do's order IS the "Record a purchase" form — items, total, paid by, note,
  // receipt in one place; 💾 Save order keeps it as a draft (no price needed) until it is bought.
  useEffect(() => { void getInventory().then(r => {
    if (!r.ok) { setMsg(r.message ?? 'Could not load the inventory.'); return; }
    const o = r.orders.find(x => x.todoId === todoId);
    if (o) setStartArr(o.lines);
    setInv(r);
  }); }, [todoId]);
  if (!inv) return <p className={msg ? 'breach' : 'note loading-dot'}>{msg || 'Loading the supplies…'}</p>;
  // The unit's house: its furniture goes there, its supplies to the place it draws from (owner, 2026-10-15).
  const home = inv.places.find(p => p.view === 'house' && p.units.some(u => unitIds.includes(u.id)))?.place
    ?? inv.places.find(p => p.units.some(u => unitIds.includes(u.id)))?.place ?? null;
  const hadOrder = inv.orders.some(o => o.todoId === todoId && o.lines.length > 0);
  const nameOf = (id: string) => inv.items.find(i => i.id === id)?.name ?? 'item';
  const addLines = (ls: { itemId: string; qty: number }[]) => {
    setStartArr(a => [...a, ...ls.filter(l => !a.some(x => x.itemId === l.itemId))
      .map(l => ({ itemId: l.itemId, place: home ? destFor(home, inv.items.find(i => i.id === l.itemId)?.kind, housesOf(inv)) : '', qty: l.qty }))]);
    setFormKey(k => k + 1);
  };
  // §159 (owner): the AI reads what was asked and fills the cart — sure lines in, the rest as "is it one of these?".
  const build = async () => {
    setBuilding(true); setMsg('');
    const r = await inventoryAction({ action: 'readRequest', text: asked ?? '' }).catch(e => ({ ok: false as const, message: String(e) })) as
      { ok: true; lines: ReceiptLine[] } | { ok: false; message?: string };
    setBuilding(false);
    if (!r.ok) { setMsg(`${r.message ?? 'Could not read it'} — build the cart by hand.`); return; }
    addLines(r.lines.filter(l => l.itemId).map(l => ({ itemId: l.itemId!, qty: Math.max(1, Math.ceil(l.itemQty ?? l.qty ?? 1)) })));
    setUnsure(r.lines.filter(l => !l.itemId).map(l => ({ text: l.text, candidates: l.candidates })));
    if (!r.lines.length) setMsg('Nothing in it read as something to buy — build the cart by hand.');
  };
  const start = startArr.length ? linesOf(startArr) : undefined;
  return (
    <div className="card task-buy">
      <h3><Icon n="cart" /> Purchase order <Hint><Icon n="sparkles" /> Build the cart reads what was asked and adds the supplies it is sure of.
        <Icon n="save" /> Save order keeps it on this to-do, with or without a price. <Icon n="cart" /> Open cart puts it in the Walmart/Amazon cart — the person pays there.
        Once it is bought, attach the order saved with MarkDownload (.md) → <Icon n="sparkles" /> Read receipt fills it in and checks it against the order (check every line) →
        <Icon n="receipt" /> Record the purchase puts it into each place's stock and into Costs (Restock). More than one order? <Icon n="clip" /> + another, then <Icon n="sparkles" /> Read the new receipt.</Hint></h3>
      {(asked ?? '').trim() && (
        <div className="buy-asked">
          <button className="secondary small" disabled={building} onClick={() => void build()}><Icon n="sparkles" /> {building ? 'Reading what was asked…' : 'Build the cart from what was asked'}</button>
          {unsure.length > 0 && (
            <div className="buy-unsure">
              <span className="note">Not sure — is it one of these?</span>
              {unsure.map((u, k) => (
                <div key={k} className="buy-unsure-line"><b>“{u.text}”</b>
                  {u.candidates.length ? u.candidates.map(c => <button key={c} className="chip" onClick={() => { addLines([{ itemId: c, qty: 1 }]); setUnsure(x => x.filter((_, n) => n !== k)); }}>{nameOf(c)}</button>)
                    : <span className="note"> nothing like it in the supplies list — add it from the form</span>}
                  <button className="link tiny" onClick={() => setUnsure(x => x.filter((_, n) => n !== k))}>Skip</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {hadOrder && <p className="note">The order as it was left.</p>}
      <PurchaseForm key={formKey} inv={inv} onInv={setInv} todoId={todoId} start={start} defaultPlace={home} canSplit
        extra={<label className="check"><input type="checkbox" checked={closeIt} onChange={e => setCloseIt(e.target.checked)} /> ✓ and close this to-do when recorded</label>}
        onRecord={async p => {
          const r = await sendPurchase(REAL, p, todoId);
          if (!r.ok) return r.message ?? 'Not saved.';
          onBought(closeIt); return null;
        }}
        buttons={({ lines, busy }) => {
          // §159: what is already on hand somewhere — ops sends the cleaner to look before anyone buys it.
          const hand = onHand(lines.map(l => l.itemId), inv.places.map(p => ({ name: placeTitle(p), items: p.items })));
          return <>
            {hand.size > 0 && (
              <div className="buy-onhand">
                {[...hand].map(([id, at]) => (
                  <Peek key={id} className="onhand" label={<><b className="bang" aria-hidden="true">!</b>{nameOf(id)}</>} ariaLabel={`${nameOf(id)} is already on hand`}>
                    <b>Already on hand</b><br />{at.map(a => `${a.place}: ${a.qty}`).join(' · ')}<br />Ask the cleaner to look there before buying.
                  </Peek>))}
              </div>
            )}
            {/* Not finished? Kept as this to-do's order — a draft it carries, replaced on every save, until it is bought. */}
            <button className="secondary" disabled={busy || (!lines.length && !hadOrder)} onClick={async () => {
              setMsg('');
              try { const r = await inventoryAction({ action: 'todoOrder', todoId, lines }); if (!r.ok) setMsg(r.message ?? 'Not saved.'); else onBought(false); }
              catch (e) { setMsg(String(e)); }
            }}><Icon n="save" /> Save order</button>
            <button className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
          </>;
        }} />
      {msg && <p className="breach" role="status">{msg}</p>}
    </div>
  );
}

/**
 * A cleaner's "I bought something" approved by recording it (§150, owner):
 * they said it in their own words; the team says which items and where each
 * went — new lines start at the place of the unit it was for. Their amount is
 * the total and their receipt the receipt (✨ reads it from Drive).
 */
export function FieldPurchaseLines({ id, unitId, said, amount, hasReceipt, onSave, onCancel }: {
  id: string; unitId: string | null; said: string; amount: number; hasReceipt: boolean;
  onSave: (lines: { itemId: string; place: string; qty: number }[], aliases: { text: string; itemId: string }[]) => Promise<void>; onCancel: () => void;
}) {
  const [inv, setInv] = useState<Inventory | null>(null);
  useEffect(() => { void getInventory().then(r => { if (r.ok) setInv(r); }); }, []);
  if (!inv) return <p className="note loading-dot">Loading the supplies…</p>;
  const home = inv.places.find(p => p.view === 'house' && p.units.some(u => u.id === unitId))?.place
    ?? inv.places.find(p => p.units.some(u => u.id === unitId))?.place ?? null;
  return (
    <div className="card">
      <p className="note">They wrote: <b>“{said.replace(/^Bought: /, '')}”</b> <Hint>Approving it records it in the inventory: say the items and where
        each went (<Icon n="sparkles" /> Read receipt fills them in from their receipt — check every line). It adds to the stock and goes to Costs (Restock) with their receipt.</Hint></p>
      <PurchaseForm inv={inv} onInv={setInv} defaultPlace={home} fixedTotal={amount} fieldExpenseId={id} hasReceipt={hasReceipt}
        recordLabel="✓ Approve and record" onRecord={async p => { await onSave(p.lines, p.aliases); return null; }}
        buttons={({ busy }) => <button className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>} />
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
  const blank = { id: '', kind: 'supply' as Kind, name: '', size: '', category: 'other', measure: 'unit', perClean: '', reorderAt: '', active: true,
                  buyOptions: [] as { label: string; url: string; pack?: number | string | null }[] };
  const [form, setForm] = useState(blank);
  const [show, setShow] = useState<'all' | Kind>('all');
  const [msg, setMsg] = useState('');
  const send = async (body: Record<string, unknown>, done: string) => {
    const r = await inventoryItemAction(body).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return false; }
    setMsg(done); onSaved(); return true;
  };
  const whole = (i: InvItemRow) => ({ action: 'save', id: i.id, name: i.baseName ?? i.name, size: i.size ?? '', category: i.category, measure: i.measure, perClean: i.perClean ?? '',
                                      reorderAt: i.reorderAt ?? '', active: i.active, kind: i.kind ?? 'supply', buyOptions: i.buyOptions ?? [] });
  const shown = items.filter(i => show === 'all' || (i.kind ?? 'supply') === show);
  const setOpt = (k: number, patch: Partial<{ label: string; url: string; pack: string }>) =>
    setForm(f => ({ ...f, buyOptions: f.buyOptions.map((o, j) => j === k ? { ...o, ...patch } : o) }));
  return (
    <div className="card">
      <h2>Items list <Hint><Icon n="bottle" /> <b>Supplies</b> are what cleans consume — cleaners see only these, and only those their unit's place keeps. <Icon n="chair" /> <b>Furniture</b> is
        the house's things (linens, dishes, equipment): counted, never handed out. Per clean is the starting estimate (until 3 cleans have reported);
        Keep at least is the minimum unless a place sets its own. <b>Buy at</b>: where to buy it, with the link.</Hint></h2>
      <div className="chip-row">{(['all', 'supply', 'furniture'] as const).map(k =>
        <button key={k} className={show === k ? 'chip active' : 'chip'} onClick={() => setShow(k)}>{ic(k === 'all' ? `All (${items.length})` : `${TYPE_WORD[k]} (${items.filter(i => (i.kind ?? 'supply') === k).length})`)}</button>)}</div>
      <div className="grid-scroll">
        <table className="units compact">
          <thead><tr><th>Type</th><th>Item</th><th>Size</th><th>Category</th><th>Counted in</th><th className="n">Per clean (est.)</th><th className="n">Keep at least</th><th>Buy at</th><th></th></tr></thead>
          <tbody>
            {shown.map(i => (
              <tr key={i.id} className={i.active ? undefined : 'muted-row'}>
                <td><select value={i.kind ?? 'supply'} aria-label={`Type of ${i.name}`}
                            onChange={e => void send({ ...whole(i), kind: e.target.value }, `${i.name}: ${TYPE_WORD[e.target.value as Kind]}.`)}>
                  <option value="supply">Supplies</option><option value="furniture">Furniture</option></select></td>
                <td><b>{i.baseName ?? i.name}</b>{!i.active && <span className="sub-n"> · off</span>}</td><td>{i.size ?? <span className="sub-n">—</span>}</td><td>{i.category}</td><td>{i.measure}</td>
                <td className="n">{fmt(i.perClean)}</td><td className="n">{fmt(i.reorderAt)}</td>
                <td>{(i.buyOptions ?? []).length ? (i.buyOptions ?? []).map((o, k) => <Fragment key={k}>{k ? ' · ' : ''}<a href={o.url} target="_blank" rel="noreferrer">{o.label} ↗</a>{o.pack ? <span className="sub-n"> ×{o.pack}</span> : null}</Fragment>)
                  : <span className="sub-n">—</span>}</td>
                <td className="n nowrap">
                  <button className="link tiny" onClick={() => setForm({ id: i.id, kind: i.kind ?? 'supply', name: i.baseName ?? i.name, size: i.size ?? '', category: i.category, measure: i.measure,
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
          <option value="supply">Supplies</option><option value="furniture">Furniture</option></select></label>
        <label>Name<input value={form.name} maxLength={120} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></label>
        <label>Size<input value={form.size} maxLength={30} placeholder="King, Queen, 13 gal… (optional)" onChange={e => setForm(f => ({ ...f, size: e.target.value }))} /></label>
        <label>Category<select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Counted in<input value={form.measure} maxLength={20} placeholder="roll, bottle, pod…" onChange={e => setForm(f => ({ ...f, measure: e.target.value }))} /></label>
        <label>Per clean (est.)<input type="number" min="0" step="any" value={form.perClean} onChange={e => setForm(f => ({ ...f, perClean: e.target.value }))} /></label>
        <label>Keep at least<input type="number" min="0" step="any" value={form.reorderAt} onChange={e => setForm(f => ({ ...f, reorderAt: e.target.value }))} /></label>
      </div>
      <div className="buy-opts">
        <b>Buy at</b> <span className="sub-n">— where to buy it; each option with its link and how many come in one (×)</span>
        <Hint>ONE Walmart (walmart.com/ip/…) or Amazon (amazon.com/dp/…) link per item: it is the store's product — receipts match it by number and an order
          opens it (Walmart: in the cart). Recording a receipt (.md) sets it, with its ×; bought at the other store, that one replaces it.</Hint>
        {form.buyOptions.map((o, k) => (
          <div key={k} className="row" style={{ gap: 6, alignItems: 'center' }}>
            <input value={o.label} maxLength={60} placeholder="Store, e.g. Costco" aria-label="Store" onChange={e => setOpt(k, { label: e.target.value })} />
            <input value={o.url} maxLength={500} placeholder="https://…" aria-label="Link" style={{ flex: 1 }} onChange={e => setOpt(k, { url: e.target.value })} />
            <input className="inv-qty" type="number" min="0" step="any" value={o.pack ?? ''} placeholder="×" aria-label={`How many ${form.measure || 'units'} come in one`}
                   title={`How many ${form.measure || 'units'} come in one`} onChange={e => setOpt(k, { pack: e.target.value })} />
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
