/**
 * Repository → "Guest portal" (2026-11-09, owner: "think of it as a very professional UX designer").
 * Three columns: the guides (◆ one per building, then units) with the record's pills under them · the editor, in the
 * portal's own tabs (Check-in / Stay) · a live phone preview of what the guest sees, "View as" any unit.
 *  · Pills from the record: drag (or tap) a value pill — Unit #, Floor, Lockbox, Address, Check-in time — into a text and
 *    each guest sees their unit's value; drag (or tap) a block pill — Wi-Fi, Parking, Rules… — into Stay to show that part.
 *  · Steps: title, text, up to 3 photos (inline, open full screen), a video link (new tab), an optional map pin.
 *  · Shared guides (109): a unit uses its building's guide and adds its own steps after it.
 * Nothing reaches a guest until Save.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { checkinPhotoUrl, getCheckinGuide, getCheckinUnits, saveCheckinGuide, uploadCheckinPhoto, type CheckinGuide, type CheckinList } from '../api.ts';
import { DEFAULT_FIELDS, DEFAULT_FIELDS_AFTER, FIELDS, MAX_HOUSE, MAX_HOUSE_TEXT, MAX_PHOTOS, MAX_STEPS, MAX_TEXT, MAX_TITLE, SHARED, TOKENS,
  composeGuide, fillTokens, googleDir, isShared, parsePin, pinText, tokenVals, unitNumber, type CheckinStep, type FieldKey, type HouseItem, type Pin } from '../lib/checkin.ts';
import { emptyGuide, type GuestGuide } from '../lib/guest-portal.ts';
import { GuestPortal, demoStay } from '../screens/GuestPortal.tsx';
import { Hint } from './Hint.tsx';

type Draft = { title: string; text: string; where: string; link: string; photos: string[] };
const toDraft = (s: CheckinStep): Draft => ({ title: s.title, text: s.text, where: s.pin ? pinText(s.pin) : '', link: s.link ?? '', photos: s.photos ?? [] });
const blank = (): Draft => ({ title: '', text: '', where: '', link: '', photos: [] });
type State = { drafts: Draft[]; house: HouseItem[]; uses: string | null; title: string };
const fieldItem = (field: FieldKey): HouseItem => ({ title: '', text: '', field });
/** A guide with no record blocks gets the old layout spelled out, so what the editor shows is what the guest sees. */
function stateOf(l: CheckinGuide): State {
  const own = !l.uses;   // a unit that uses a shared guide only adds items after it
  const house = own && !l.house.some(h => h.field)
    ? [...DEFAULT_FIELDS.map(fieldItem), ...l.house, ...DEFAULT_FIELDS_AFTER.map(fieldItem)] : l.house;
  return { drafts: l.steps.map(toDraft), house, uses: l.uses, title: l.shared ? l.unitName : '' };
}
const NEW_SHARED: CheckinGuide = { unitName: '', steps: [], house: [], uses: null, shared: true, users: [], sharedPart: null, record: null, recordRef: null, updatedAt: null, updatedBy: null };
const FIELD_DT = 'application/x-kaizen-field';
const has = (g: GuestGuide | null, f: FieldKey) => !!g && ({ wifi: !!g.wifi, times: !!(g.checkIn || g.checkOut), parking: !!g.parking,
  access: !!g.access, rules: !!g.rules, contact: !!(g.manual || g.phone) })[f];
type Insert = { insert: (tok: string) => void } | null;

export function CheckinBuilder({ canEdit, say, onOpenRecord, findName, onBack }: {
  canEdit: boolean; say: (m: string, bad?: boolean) => void; onOpenRecord: (table: string, id: string) => void; findName?: string | null; onBack?: () => void }) {
  const [list, setList] = useState<CheckinList>({ units: [], shared: [] });
  const [unit, setUnit] = useState(() => new URLSearchParams(location.search).get('unit') ?? '');
  const [data, setData] = useState<CheckinGuide | null>(null);
  const [st, setSt] = useState<State>({ drafts: [], house: [], uses: null, title: '' });
  const [tab, setTab] = useState<'checkin' | 'stay'>('checkin');
  const [viewAs, setViewAs] = useState('');
  const [viewData, setViewData] = useState<CheckinGuide | null>(null);
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const last = useRef<Insert>(null);
  const shared = isShared(unit);

  const load = (l: CheckinGuide) => { setData(l); setSt(stateOf(l)); };
  const loadList = () => getCheckinUnits().then(r => { if (r.ok) setList({ units: r.units, shared: r.shared }); else setErr(r.message ?? 'Could not load.'); }).catch(e => setErr(String(e)));
  useEffect(() => { void loadList(); }, []);
  const go = (v: string) => { setUnit(v); const u = new URL(location.href); if (v) u.searchParams.set('unit', v); else u.searchParams.delete('unit'); history.replaceState(history.state, '', u); };
  // From a record's "Guest portal guide ›": its unit, matched by name or by number (LP-1304 ↔ P2-1304).
  useEffect(() => {
    if (!findName || !list.units.length) return;
    const n = findName.trim().toLowerCase();
    const hit = list.units.find(u => u.name.toLowerCase() === n)
      ?? (/\d{3,}/.test(n) ? list.units.find(u => unitNumber(u.name) === unitNumber(findName)) : undefined);
    if (hit) go(hit.id); else say(`No active unit called ${findName}.`, true);
  }, [findName, list.units.length]);
  useEffect(() => {
    setData(null); setCopied(''); setViewAs('');
    if (!unit) return;
    if (unit === SHARED) { load(NEW_SHARED); return; }
    let live = true;
    getCheckinGuide(unit).then(r => { if (!live) return; if (r.ok) { load(r); setErr(''); if (r.shared && r.users?.[0]) setViewAs(r.users[0].id); } else setErr(r.message ?? 'Could not load.'); })
      .catch(e => setErr(String(e)));
    return () => { live = false; };
  }, [unit]);
  useEffect(() => {
    setViewData(null);
    if (!shared || !viewAs) return;
    let live = true;
    getCheckinGuide(viewAs).then(r => { if (live && r.ok) setViewData(r); }).catch(() => undefined);
    return () => { live = false; };
  }, [viewAs, shared]);

  const pins = st.drafts.map(d => d.where.trim() ? parsePin(d.where) : null);
  const badPin = st.drafts.findIndex((d, i) => d.where.trim() && !pins[i]);
  const dirty = useMemo(() => !!data && JSON.stringify(st) !== JSON.stringify(stateOf(data)), [st, data]);
  const setD = <K extends keyof Draft>(i: number, k: K, v: Draft[K]) => setSt(s => ({ ...s, drafts: s.drafts.map((d, j) => j === i ? { ...d, [k]: v } : d) }));
  const setH = (f: (h: HouseItem[]) => HouseItem[]) => setSt(s => ({ ...s, house: f(s.house) }));
  const setDrafts = (f: (d: Draft[]) => Draft[]) => setSt(s => ({ ...s, drafts: f(s.drafts) }));
  const move = <T,>(l: T[], i: number, to: number) => { const n = [...l]; const [x] = n.splice(i, 1); n.splice(Math.max(0, Math.min(to, n.length)), 0, x!); return n; };
  const steps = (): CheckinStep[] => st.drafts.map((d, i) => ({ title: d.title, text: d.text, pin: pins[i] as Pin | null, link: d.link.trim() || null, photos: d.photos }));

  // What the preview shows: the record and values of the unit being viewed; the guide as it is being edited.
  const subject = shared ? viewData : data;
  const vals = useMemo(() => tokenVals(subject?.recordVals ?? null, String(subject?.recordVals?.name ?? subject?.unitName ?? '')), [subject]);
  const preview = useMemo(() => {
    if (!data) return null;
    const mine = { steps: steps(), house: st.house };
    const composed = shared ? composeGuide(mine, viewData ? { steps: viewData.steps, house: viewData.house } : null, vals)
      : composeGuide(st.uses && data.sharedPart?.id === st.uses ? data.sharedPart : null, mine, vals);
    const rec = subject?.record ?? null;
    const guide: GuestGuide = { ...(rec ?? emptyGuide()), ...composed };
    return { ...demoStay('paid'), unitName: subject?.unitName || st.title || 'Your stay', address: rec?.address ?? null, guide };
  }, [data, st, viewData, vals, subject]);

  const copyFrom = async (id: string) => {
    if (!id) return;
    const r = await getCheckinGuide(id).catch(() => null);
    if (!r?.ok) { say('Could not read that guide.', true); return; }
    const c = stateOf(r);
    setSt(s => ({ ...s, drafts: c.drafts, house: c.house })); setCopied(r.unitName);
    say(`Copied from ${r.unitName}: ${r.steps.length} steps, ${r.house.filter(h => !h.field).length} own items — edit them, then Save.`);
  };
  const photoUnit = shared ? (data?.users?.[0]?.id ?? '') : unit;
  const addPhotos = async (i: number, files: FileList | File[] | null) => {
    const pick = [...(files ?? [])].filter(f => f.type.startsWith('image/')).slice(0, MAX_PHOTOS - st.drafts[i]!.photos.length);
    if (!pick.length) return;
    if (!photoUnit) { say('A shared guide keeps its photos with one of its units — link a unit to it first.', true); return; }
    setUploading(i);
    for (const f of pick) {
      const r = await uploadCheckinPhoto(photoUnit, f).catch(e => ({ ok: false as const, message: String(e) }));
      if (r.ok) setDrafts(ds => ds.map((d, j) => j === i ? { ...d, photos: [...d.photos, r.id] } : d));
      else { say(r.message ?? 'Photo not uploaded.', true); break; }
    }
    setUploading(null);
    say('Photo added — Save to keep it.');
  };
  const addField = (f: FieldKey, at?: number) => setH(hs => {
    if (hs.some(h => h.field === f)) { const i = hs.findIndex(h => h.field === f); return at == null ? hs : move(hs, i, at); }
    const n = [...hs]; n.splice(at ?? n.length, 0, fieldItem(f)); return n;
  });

  const save = async () => {
    if (badPin >= 0) { say(`Step ${badPin + 1}: the location is not coordinates or a long Maps link.`, true); return; }
    setBusy(true);
    const r = await saveCheckinGuide({ unit, steps: steps(), house: st.house, uses: shared ? null : st.uses, title: shared ? st.title : undefined, copiedFrom: copied || undefined })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { say(r.message ?? 'Not saved.', true); return; }
    setCopied(''); say('Saved — guests see it now.'); void loadList();
    if (r.unit !== unit) go(r.unit);
    else { const fresh = await getCheckinGuide(unit).catch(() => null); if (fresh?.ok) load(fresh); }
  };

  const sharedTitle = (id: string | null) => list.shared.find(s => s.id === id)?.title ?? id ?? '';
  const others = [...list.shared.filter(s => s.id !== unit).map(s => ({ id: s.id, label: `◆ ${s.title}` })),
                  ...list.units.filter(u => u.steps > 0 && u.id !== unit).map(u => ({ id: u.id, label: u.name }))];
  const ownSteps = !shared && !!st.uses;

  return <div className="gp">
    {/* ── left: the guides, then the record's pills ── */}
    <aside className="gp-side">
      {onBack && <button className="link gp-back" onClick={onBack}>‹ Repository</button>}
      {data && <Pills vals={vals} record={subject?.record ?? null} who={subject?.unitName ?? ''} onToken={t => last.current?.insert(t)}
        onField={f => { addField(f); setTab('stay'); }} canEdit={canEdit} />}
    </aside>

    {/* ── middle: the editor ── */}
    <section className="gp-edit">
      {err && <p className="breach" role="alert">{err}</p>}
      {!unit ? <div className="gp-empty"><p className="note">Open <b>◆ Guide</b> on a unit's row to edit what its guest sees.</p></div>
        : !data ? <p className="note loading-dot">Loading</p> : <>
        <header className="gp-head">
          {shared ? <input className="gp-title" value={st.title} maxLength={MAX_TITLE} placeholder="Building guide name — e.g. The Links · Building 4" onChange={e => setSt(s => ({ ...s, title: e.target.value }))} disabled={!canEdit} aria-label="Shared guide name" />
            : <h3>{data.unitName}</h3>}
          {!shared && <label className="gp-uses">Building guide
            <select value={st.uses ?? ''} onChange={e => setSt(s => ({ ...s, uses: e.target.value || null }))} disabled={!canEdit}>
              <option value="">None — own guide</option>
              {list.shared.map(s => <option key={s.id} value={s.id}>◆ {s.title}</option>)}
            </select></label>}
          {canEdit && !shared && <button className="link" onClick={() => go(SHARED)} title="One guide for every unit of a building">+ New building guide</button>}
          {canEdit && others.length > 0 && <select className="gp-copy" value="" onChange={e => void copyFrom(e.target.value)} aria-label="Copy steps from another guide">
            <option value="">Copy from…</option>
            {others.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>}
        </header>
        {shared && <p className="note">{data.users?.length ? <>Used by {data.users.map((u, i) => <span key={u.id}>{i ? ', ' : ''}<button className="link" onClick={() => go(u.id)}>{u.name}</button></span>)}.</> : 'No unit uses it yet — open a unit and pick it as its building guide.'}</p>}

        <div className="v-seg gp-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'checkin'} className={tab === 'checkin' ? 'on' : ''} onClick={() => setTab('checkin')}>Check-in · {(preview?.guide?.steps?.length ?? st.drafts.length)}</button>
          <button role="tab" aria-selected={tab === 'stay'} className={tab === 'stay' ? 'on' : ''} onClick={() => setTab('stay')}>Stay · {(preview?.guide?.house?.length ?? st.house.length)}</button>
        </div>

        {tab === 'checkin' ? <>
          {ownSteps && data.sharedPart && st.uses === data.sharedPart.id && <div className="gp-inherited">
            {data.sharedPart.steps.map((s, i) => <div key={i} className="gp-step ghost"><span className="cb-n">{i + 1}</span><span>{fillTokens(s.title, vals)}</span></div>)}
            <button className="link" onClick={() => go(data.sharedPart!.id)}>From ◆ {data.sharedPart.title} — edit there ›</button>
          </div>}
          {st.drafts.map((d, i) => <StepCard key={i} n={(ownSteps ? (data.sharedPart?.steps.length ?? 0) : 0) + i + 1} d={d} pin={pins[i] ?? null} canEdit={canEdit}
            set={(k, v) => setD(i, k, v)} last={last} uploading={uploading === i} busyAny={uploading !== null} onPhotos={f => void addPhotos(i, f)}
            onDrop={from => setDrafts(ds => move(ds, from, i))} index={i} remove={() => setDrafts(ds => ds.filter((_, j) => j !== i))} />)}
          {st.drafts.length === 0 && <p className="note">{ownSteps ? 'No extra steps — the building guide is enough.' : 'No steps yet.'}</p>}
          {canEdit && st.drafts.length < MAX_STEPS && <button className="secondary small gp-add" onClick={() => setDrafts(ds => [...ds, blank()])}>+ Add step</button>}
        </> : <StayEditor house={st.house} setH={setH} record={subject?.record ?? null} canEdit={canEdit} addField={addField} last={last} inherited={ownSteps && data.sharedPart?.id === st.uses ? data.sharedPart?.house ?? [] : []}
          openRecord={!shared && data.recordRef ? () => onOpenRecord(data.recordRef!.table, data.recordRef!.id) : null} />}

        {canEdit && <div className="cb-actions cb-save">
          {data.updatedAt && <span className="note">Saved {new Date(data.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{data.updatedBy ? ` by ${data.updatedBy}` : ''}</span>}
          <span className="rb-spacer" />
          {dirty && <button className="secondary small" onClick={() => { setSt(stateOf(data)); setCopied(''); }}>Undo changes</button>}
          <button className="small" disabled={(!dirty && unit !== SHARED) || busy || uploading !== null} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>}
      </>}
    </section>

    {/* ── right: what the guest sees ── */}
    <aside className="gp-preview">
      <div className="gp-preview-h"><b>Guest view</b>
        {shared && (data?.users?.length ?? 0) > 0 && <select value={viewAs} onChange={e => setViewAs(e.target.value)} aria-label="View as unit">
          {data!.users!.map(u => <option key={u.id} value={u.id}>as {u.name}</option>)}</select>}
        {!shared && unit && <a className="link" href={`/guest/demo?stay=paid&unit=${encodeURIComponent(unit)}`} target="_blank" rel="noopener">Open ↗</a>}
      </div>
      {preview ? <div className="gp-phone g-scope"><GuestPortal key={tab} embedded startSec={tab} stay={preview} send={async () => ({ ok: true })} /></div>
        : <div className="gp-phone g-scope gp-phone-empty"><p className="note">The guest's page shows here.</p></div>}
    </aside>
  </div>;
}

/** The record's values and blocks as pills: drag into a text / into Stay, or tap. Empty ones are dashed. */
function Pills({ vals, record, who, onToken, onField, canEdit }: { vals: Record<string, unknown>; record: GuestGuide | null; who: string;
  onToken: (t: string) => void; onField: (f: FieldKey) => void; canEdit: boolean }) {
  return <div className="gp-pills">
    <div className="gp-list-h">From the record <Hint>Drag a pill into a text — or tap it to add it where you were typing. Each guest sees their own unit's value. Block pills add that part of the record to Stay.{who ? ` Values shown: ${who}.` : ''}</Hint></div>
    <div className="gp-pillset">{Object.entries(TOKENS).map(([k, label]) => {
      const v = String(fillTokens(`{${k}}`, vals)); const empty = v === `{${k}}`;
      return <button key={k} className={`pill ${empty ? 'empty' : ''}`} draggable={canEdit} disabled={!canEdit} title={empty ? `${label}: empty in this unit's record` : `${label}: ${v}`}
        onDragStart={e => { e.dataTransfer.setData('text/plain', `{${k}}`); e.dataTransfer.effectAllowed = 'copy'; }}
        onMouseDown={e => e.preventDefault()} onClick={() => onToken(`{${k}}`)}>{label}{!empty && k !== 'lockbox' && <em>{v.length > 18 ? `${v.slice(0, 18)}…` : v}</em>}{k === 'lockbox' && !empty && <em>🔒</em>}</button>;
    })}</div>
    <div className="gp-pillset">{(Object.keys(FIELDS) as FieldKey[]).map(f =>
      <button key={f} className={`pill block ${has(record, f) ? '' : 'empty'}`} draggable={canEdit} disabled={!canEdit} title={has(record, f) ? `Add ${FIELDS[f]} to Stay` : `${FIELDS[f]}: empty in this unit's record`}
        onDragStart={e => { e.dataTransfer.setData(FIELD_DT, f); e.dataTransfer.effectAllowed = 'copy'; }} onClick={() => onField(f)}>▤ {FIELDS[f]}</button>)}</div>
  </div>;
}

/** An input / textarea that shows {tokens} as pills behind the text, accepts dropped pills, and remembers the caret. */
function TokenText({ value, onChange, rows, placeholder, maxLength, disabled, label, last }: {
  value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; maxLength?: number; disabled?: boolean; label: string; last: React.MutableRefObject<Insert> }) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const back = useRef<HTMLDivElement>(null);
  const parts = value.split(/(\{\w+\})/g);
  // Grows with its text: no scrollbar, so the pills behind line up with the words.
  useLayoutEffect(() => { const el = ref.current; if (el && rows) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; } }, [value, rows]);
  const focus = () => { last.current = { insert: tok => {
    const el = ref.current; const a = el?.selectionStart ?? value.length, b = el?.selectionEnd ?? value.length;
    const v = value.slice(0, a) + tok + value.slice(b); onChange(v);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(a + tok.length, a + tok.length); });
  } }; };
  const props = { ref, value, placeholder, maxLength, disabled, 'aria-label': label, onFocus: focus, onSelect: focus,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => onChange(e.target.value),
    onScroll: (e: React.UIEvent<HTMLTextAreaElement | HTMLInputElement>) => { if (back.current) { back.current.scrollTop = e.currentTarget.scrollTop; back.current.scrollLeft = e.currentTarget.scrollLeft; } } };
  return <div className={`tt ${rows ? '' : 'tt-1'}`}>
    <div className="tt-back" ref={back} aria-hidden>{parts.map((p, i) => /^\{\w+\}$/.test(p) && p.slice(1, -1) in TOKENS ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>)}{'​'}</div>
    {rows ? <textarea {...props} rows={rows} /> : <input {...props} />}
  </div>;
}

function StepCard({ n, d, pin, canEdit, set, last, uploading, busyAny, onPhotos, onDrop, index, remove }: {
  n: number; d: Draft; pin: Pin | null; canEdit: boolean; set: <K extends keyof Draft>(k: K, v: Draft[K]) => void; last: React.MutableRefObject<Insert>;
  uploading: boolean; busyAny: boolean; onPhotos: (f: FileList | File[]) => void; onDrop: (from: number) => void; index: number; remove: () => void }) {
  const [over, setOver] = useState(false);
  return <div className={`gp-step ${over ? 'over' : ''}`}
    onDragOver={e => { if (e.dataTransfer.types.includes('application/x-kaizen-step') || e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
    onDragLeave={() => setOver(false)}
    onDrop={e => { setOver(false);
      const from = e.dataTransfer.getData('application/x-kaizen-step');
      if (from !== '') { e.preventDefault(); onDrop(Number(from)); return; }
      if (e.dataTransfer.files.length) { e.preventDefault(); onPhotos(e.dataTransfer.files); } }}>
    <span className="gp-grip" draggable={canEdit} title="Drag to reorder" aria-label={`Step ${n} — drag to reorder`}
      onDragStart={e => { e.dataTransfer.setData('application/x-kaizen-step', String(index)); e.dataTransfer.effectAllowed = 'move'; }}>⠿</span>
    <span className="cb-n">{n}</span>
    <div className="cb-fields">
      <TokenText value={d.title} onChange={v => set('title', v)} maxLength={MAX_TITLE} placeholder="Title — e.g. Get your key fob" disabled={!canEdit} label={`Step ${n} title`} last={last} />
      <TokenText value={d.text} onChange={v => set('text', v)} rows={2} maxLength={MAX_TEXT} placeholder="What to do there — drop pills from the left for the unit's own values" disabled={!canEdit} label={`Step ${n} text`} last={last} />
      <div className="cb-photos">
        {d.photos.map(id => <span key={id} className="cb-photo">
          <img src={checkinPhotoUrl(id)} alt="" loading="lazy" />
          {canEdit && <button className="chip" onClick={() => set('photos', d.photos.filter(p => p !== id))} aria-label="Remove photo">✕</button>}
        </span>)}
        {canEdit && d.photos.length < MAX_PHOTOS && <label className="cb-add-photo gp-drop">
          {uploading ? 'Uploading…' : '+ Photo — or drop it here'}
          <input type="file" accept="image/*" multiple hidden disabled={busyAny} onChange={e => { if (e.target.files) onPhotos(e.target.files); e.target.value = ''; }} />
        </label>}
      </div>
      <div className="gp-row2">
        <input value={d.where} placeholder="📍 Location: 33.1507, -96.8236 or a Maps link" onChange={e => set('where', e.target.value)} disabled={!canEdit} aria-label={`Step ${n} location`} />
        <input value={d.link} placeholder="▶ Video link (opens in a new tab)" onChange={e => set('link', e.target.value)} disabled={!canEdit} aria-label={`Step ${n} video link`} />
      </div>
      {pin ? <a className="note" href={googleDir(pin)} target="_blank" rel="noopener noreferrer">✓ {pinText(pin)} · check on map</a>
        : d.where.trim() ? <span className="note cb-bad">▲ Not a point — hold the spot in Google Maps and copy the numbers, or paste a long link</span> : null}
    </div>
    {canEdit && <button className="chip gp-x" onClick={remove} aria-label={`Remove step ${n}`}>✕</button>}
  </div>;
}

/** Stay: record blocks (drag from the pills, reorder, remove) and the house's own text blocks. */
function StayEditor({ house, setH, record, canEdit, addField, last, inherited, openRecord }: {
  house: HouseItem[]; setH: (f: (h: HouseItem[]) => HouseItem[]) => void; record: GuestGuide | null; canEdit: boolean;
  addField: (f: FieldKey, at?: number) => void; last: React.MutableRefObject<Insert>; inherited: HouseItem[]; openRecord: (() => void) | null }) {
  const [over, setOver] = useState<number | null>(null);
  const move = (from: number, to: number) => setH(hs => { const n = [...hs]; const [x] = n.splice(from, 1); n.splice(to, 0, x!); return n; });
  const drop = (e: React.DragEvent, at: number) => {
    setOver(null);
    const f = e.dataTransfer.getData(FIELD_DT); if (f) { e.preventDefault(); addField(f as FieldKey, at); return; }
    const from = e.dataTransfer.getData('application/x-kaizen-block'); if (from !== '') { e.preventDefault(); move(Number(from), at); }
  };
  const ok = (e: React.DragEvent, i: number) => { if (e.dataTransfer.types.includes(FIELD_DT) || e.dataTransfer.types.includes('application/x-kaizen-block')) { e.preventDefault(); setOver(i); } };
  const value = (f: FieldKey): string => {
    const g = record; if (!g) return '';
    switch (f) {
      case 'wifi': return g.wifi ? `${g.wifi.network}${g.wifi.password ? ' · password' : ''}` : '';
      case 'times': return g.checkIn || g.checkOut ? `${g.checkIn ?? '—'} → ${g.checkOut ?? '—'}` : '';
      case 'parking': return g.parking ? [g.parking.notes, g.parking.freeStreet ? 'free street' : null].filter(Boolean).join(' · ') : '';
      case 'access': return g.access ?? '';
      case 'rules': return g.rules ? `${g.rules.split('\n').filter(Boolean).length} rules` : '';
      case 'contact': return [g.manual ? 'full guide' : null, g.phone].filter(Boolean).join(' · ');
    }
  };
  return <div className="gp-stay" onDragOver={e => ok(e, house.length)} onDrop={e => drop(e, house.length)}>
    <p className="note">What the guest has at hand during the stay, in this order. Drag ▤ blocks from the left to show a part of the record; add the house's own notes (Trash, Pool, Thermostat…).{openRecord && <> <button className="link" onClick={openRecord}>Open the record ›</button></>}</p>
    {inherited.length > 0 && <div className="gp-inherited">{inherited.map((h, i) => <div key={i} className="gp-step ghost"><span>{h.field ? `▤ ${FIELDS[h.field]}` : h.title}</span></div>)}
      <span className="note">From the building guide</span></div>}
    {house.map((h, i) => <div key={i} className={`gp-block ${h.field ? 'rec' : ''} ${over === i ? 'over' : ''}`} onDragOver={e => { e.stopPropagation(); ok(e, i); }} onDrop={e => { e.stopPropagation(); drop(e, i); }}>
      <span className="gp-grip" draggable={canEdit} title="Drag to reorder" onDragStart={e => { e.dataTransfer.setData('application/x-kaizen-block', String(i)); e.dataTransfer.effectAllowed = 'move'; }}>⠿</span>
      {h.field ? <div className="gp-block-b"><b>▤ {FIELDS[h.field]}</b><span className={`note ${value(h.field) ? '' : 'cb-empty'}`}>{value(h.field) ? (value(h.field).length > 90 ? `${value(h.field).slice(0, 90)}…` : value(h.field)) : '○ empty in the record — the guest sees nothing here'}</span></div>
        : <div className="cb-fields">
          <TokenText value={h.title} onChange={v => setH(hs => hs.map((x, j) => j === i ? { ...x, title: v } : x))} maxLength={MAX_TITLE} placeholder="Title — e.g. Trash" disabled={!canEdit} label={`Block ${i + 1} title`} last={last} />
          <TokenText value={h.text} onChange={v => setH(hs => hs.map((x, j) => j === i ? { ...x, text: v } : x))} rows={3} maxLength={MAX_HOUSE_TEXT} disabled={!canEdit} label={`Block ${i + 1} text`} last={last} />
        </div>}
      {canEdit && <button className="chip gp-x" onClick={() => setH(hs => hs.filter((_, j) => j !== i))} aria-label="Remove block">✕</button>}
    </div>)}
    {canEdit && house.filter(h => !h.field).length < MAX_HOUSE && <button className="secondary small gp-add" onClick={() => setH(hs => [...hs, { title: '', text: '' }])}>+ Own block</button>}
  </div>;
}
