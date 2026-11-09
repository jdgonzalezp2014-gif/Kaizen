/**
 * Repository → "Check-in builder" (2026-11-09). What the guest portal shows, in two parts:
 *  · Check-in instructions — arrival steps: title, a line or two, an optional map pin (Google Maps / Apple Maps),
 *    up to 3 photos (inline) and a video link (opens in a new tab).
 *  · House manual — the record's Wi-Fi, times, parking, rules, phone (read here, edited in the record) + own items (e.g. Trash).
 * Shared guides (109): one per building, used by all its units — {unit}, {floor}, {lockbox} come from each unit's record.
 * A unit shows its shared guide's steps first, then its own extra steps. Nothing is saved until Save.
 */
import { useEffect, useMemo, useState } from 'react';
import { checkinPhotoUrl, getCheckinGuide, getCheckinUnits, saveCheckinGuide, uploadCheckinPhoto, type CheckinGuide, type CheckinList } from '../api.ts';
import { MAX_HOUSE, MAX_HOUSE_TEXT, MAX_PHOTOS, MAX_STEPS, MAX_TEXT, MAX_TITLE, SHARED, TOKENS, googleDir, isShared, parsePin, pinText,
  type CheckinStep, type HouseItem, type Pin } from '../lib/checkin.ts';
import type { GuestGuide } from '../lib/guest-portal.ts';
import { Hint } from './Hint.tsx';

type Draft = { title: string; text: string; where: string; link: string; photos: string[] };
const toDraft = (s: CheckinStep): Draft => ({ title: s.title, text: s.text, where: s.pin ? pinText(s.pin) : '', link: s.link ?? '', photos: s.photos ?? [] });
const blank = (): Draft => ({ title: '', text: '', where: '', link: '', photos: [] });
type State = { drafts: Draft[]; house: HouseItem[]; uses: string | null; title: string };
const stateOf = (l: CheckinGuide): State => ({ drafts: l.steps.map(toDraft), house: l.house, uses: l.uses, title: l.shared ? l.unitName : '' });
const NEW_SHARED: CheckinGuide = { unitName: '', steps: [], house: [], uses: null, shared: true, users: [], sharedPart: null, record: null, recordRef: null, updatedAt: null, updatedBy: null };

export function CheckinBuilder({ canEdit, say, onOpenRecord }: { canEdit: boolean; say: (m: string, bad?: boolean) => void; onOpenRecord: (table: string, id: string) => void }) {
  const [list, setList] = useState<CheckinList>({ units: [], shared: [] });
  const [unit, setUnit] = useState(() => new URLSearchParams(location.search).get('unit') ?? '');
  const [data, setData] = useState<CheckinGuide | null>(null);
  const [st, setSt] = useState<State>({ drafts: [], house: [], uses: null, title: '' });
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const shared = isShared(unit);
  const photoUnit = shared ? (data?.users?.[0]?.id ?? '') : unit;

  const load = (l: CheckinGuide) => { setData(l); setSt(stateOf(l)); };
  const loadList = () => getCheckinUnits().then(r => { if (r.ok) setList({ units: r.units, shared: r.shared }); else setErr(r.message ?? 'Could not load.'); }).catch(e => setErr(String(e)));
  useEffect(() => { void loadList(); }, []);
  useEffect(() => {
    setData(null); setCopied('');
    if (!unit) return;
    if (unit === SHARED) { load(NEW_SHARED); return; }
    let live = true;
    getCheckinGuide(unit).then(r => { if (!live) return; if (r.ok) { load(r); setErr(''); } else setErr(r.message ?? 'Could not load.'); })
      .catch(e => setErr(String(e)));
    return () => { live = false; };
  }, [unit]);
  const go = (v: string) => { setUnit(v); const u = new URL(location.href); if (v) u.searchParams.set('unit', v); else u.searchParams.delete('unit'); history.replaceState(history.state, '', u); };

  const pins = st.drafts.map(d => d.where.trim() ? parsePin(d.where) : null);
  const badPin = st.drafts.findIndex((d, i) => d.where.trim() && !pins[i]);
  const dirty = useMemo(() => !!data && JSON.stringify(st) !== JSON.stringify(stateOf(data)), [st, data]);
  const setD = <K extends keyof Draft>(i: number, k: K, v: Draft[K]) => setSt(s => ({ ...s, drafts: s.drafts.map((d, j) => j === i ? { ...d, [k]: v } : d) }));
  const setH = (f: (h: HouseItem[]) => HouseItem[]) => setSt(s => ({ ...s, house: f(s.house) }));
  const setDrafts = (f: (d: Draft[]) => Draft[]) => setSt(s => ({ ...s, drafts: f(s.drafts) }));
  const move = <T,>(l: T[], i: number, by: number) => { const n = [...l]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x!); return n; };

  const copyFrom = async (id: string) => {
    if (!id) return;
    const r = await getCheckinGuide(id).catch(() => null);
    if (!r?.ok) { say('Could not read that guide.', true); return; }
    setSt(s => ({ ...s, drafts: r.steps.map(toDraft), house: r.house })); setCopied(r.unitName);
    say(`Copied from ${r.unitName}: ${r.steps.length} steps, ${r.house.length} house manual items — edit them, then Save.`);
  };

  const addPhotos = async (i: number, files: FileList | null) => {
    const room = MAX_PHOTOS - st.drafts[i]!.photos.length;
    const pick = [...(files ?? [])].slice(0, room);
    if (!pick.length) return;
    if (!photoUnit) { say('A shared guide keeps its photos with one of its units — link a unit to it first.', true); return; }
    setUploading(i);
    for (const f of pick) {
      const r = await uploadCheckinPhoto(photoUnit, f).catch(e => ({ ok: false as const, message: String(e) }));
      if (r.ok) setDrafts(ds => ds.map((d, j) => j === i ? { ...d, photos: [...d.photos, r.id] } : d));
      else { say(r.message ?? 'Photo not uploaded.', true); break; }
    }
    setUploading(null);
    say('Photo added — Save to keep it on the step.');
  };

  const save = async () => {
    if (badPin >= 0) { say(`Step ${badPin + 1}: the location is not coordinates or a long Maps link.`, true); return; }
    setBusy(true);
    const steps = st.drafts.map((d, i) => ({ title: d.title, text: d.text, pin: pins[i] as Pin | null, link: d.link.trim() || null, photos: d.photos }));
    const r = await saveCheckinGuide({ unit, steps, house: st.house, uses: shared ? null : st.uses, title: shared ? st.title : undefined, copiedFrom: copied || undefined })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { say(r.message ?? 'Not saved.', true); return; }
    setCopied(''); say('Check-in guide saved.'); void loadList();
    if (r.unit !== unit) go(r.unit);
    else { const fresh = await getCheckinGuide(unit).catch(() => null); if (fresh?.ok) load(fresh); }
  };

  const others = [...list.shared.filter(s => s.id !== unit).map(s => ({ id: s.id, label: `◆ ${s.title}` })),
                  ...list.units.filter(u => u.steps > 0 && u.id !== unit).map(u => ({ id: u.id, label: `${u.name} · ${u.steps}` }))];
  const sharedTitle = (id: string | null) => list.shared.find(s => s.id === id)?.title ?? id ?? '';
  const preview = shared ? data?.users?.[0]?.id : unit;

  return <div className="cb">
    <div className="cb-top">
      <label>Guide
        <select value={unit} onChange={e => go(e.target.value)}>
          <option value="">Pick a unit or a building…</option>
          {list.shared.length > 0 && <optgroup label="Shared — one per building">
            {list.shared.map(s => <option key={s.id} value={s.id}>◆ {s.title} · {s.users} unit{s.users === 1 ? '' : 's'}</option>)}</optgroup>}
          <optgroup label="Units">
            {list.units.map(u => <option key={u.id} value={u.id}>{u.name}{u.uses ? ` · ◆ ${sharedTitle(u.uses)}` : ''}{u.steps ? ` · ${u.steps} own` : ''}</option>)}</optgroup>
        </select></label>
      {canEdit && <button className="secondary small" onClick={() => go(SHARED)}>+ New shared guide</button>}
      {unit && canEdit && others.length > 0 && <label>Copy from
        <select value="" onChange={e => void copyFrom(e.target.value)}>
          <option value="">Another guide…</option>
          {others.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select></label>}
      {preview && <a className="chip cb-preview" href={`/guest/demo?stay=paid&unit=${encodeURIComponent(preview)}`} target="_blank" rel="noopener">Preview as guest ›</a>}
    </div>
    {err && <p className="breach" role="alert">{err}</p>}
    {!unit ? <p className="note">Pick a unit, or a building's shared guide — edit it once and every unit that uses it changes.</p>
      : !data ? <p className="note loading-dot">Loading</p> : <>
      {shared ? <section className="card cb-card">
        <h3>Shared guide <Hint>One guide for every unit of a building. Write {'{unit}'}, {'{floor}'} and {'{lockbox}'} where a unit's own value goes — each guest sees their unit's number, floor and lockbox code from its record.</Hint></h3>
        <label>Name<input value={st.title} maxLength={MAX_TITLE} placeholder="e.g. The Links · Building 4" onChange={e => setSt(s => ({ ...s, title: e.target.value }))} disabled={!canEdit} /></label>
        <p className="note">{data.users?.length ? <>Used by {data.users.map((u, i) => <span key={u.id}>{i ? ', ' : ''}<button className="link" onClick={() => go(u.id)}>{u.name}</button></span>)}.</>
          : 'No unit uses it yet — open a unit and pick it under "Uses shared guide".'}</p>
      </section> : <section className="card cb-card">
        <h3>Uses shared guide <Hint>The building's guide comes first; this unit's own steps and items below are added after it.</Hint></h3>
        <select value={st.uses ?? ''} onChange={e => setSt(s => ({ ...s, uses: e.target.value || null }))} disabled={!canEdit} aria-label="Shared guide">
          <option value="">None — this unit's own guide only</option>
          {list.shared.map(s => <option key={s.id} value={s.id}>◆ {s.title}</option>)}
        </select>
        {data.sharedPart && st.uses === data.sharedPart.id && <div className="cb-shared">
          <ol>{data.sharedPart.steps.map((s, i) => <li key={i}>{s.title}{s.photos?.length ? ` · ${s.photos.length} photo${s.photos.length === 1 ? '' : 's'}` : ''}</li>)}</ol>
          {data.sharedPart.house.length > 0 && <p className="note">House manual: {data.sharedPart.house.map(h => h.title).join(' · ')}</p>}
          <button className="secondary small" onClick={() => go(data.sharedPart!.id)}>Edit shared guide ›</button>
        </div>}
        {data.recordVals && <p className="note">This unit fills in: {'{unit}'} = {data.unitName.match(/(\d{3,})\D*$/)?.[1] ?? data.unitName} · {'{floor}'} = {String(data.recordVals.floor ?? '○ empty').toLowerCase()} · {'{lockbox}'} = {data.recordVals.lockbox ? 'set' : '○ empty'}</p>}
      </section>}

      <section className="card cb-card">
        <h3>{!shared && st.uses ? 'Extra steps for this unit' : 'Check-in instructions'} <Hint>What the guest follows to reach the unit. A location opens in Google Maps or Apple Maps — in Google Maps hold your finger on the exact spot and copy the numbers at the top (33.1507, -96.8236), or paste a long Maps link. Photos show on the step; a video link opens in a new tab.</Hint></h3>
        {st.drafts.length === 0 && <p className="note">{!shared && st.uses ? 'None — the shared steps are enough.' : 'No steps — the guest sees the address only.'}</p>}
        {st.drafts.map((d, i) => <div key={i} className="cb-step">
          <span className="cb-n">{i + 1}</span>
          <div className="cb-fields">
            <input value={d.title} maxLength={MAX_TITLE} placeholder="Title — e.g. Get your key fob from lockbox {unit}" onChange={e => setD(i, 'title', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} title`} />
            <textarea value={d.text} maxLength={MAX_TEXT} rows={2} placeholder="What to do there" onChange={e => setD(i, 'text', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} text`} />
            {canEdit && <span className="cb-tokens">{Object.entries(TOKENS).map(([k, label]) =>
              <button key={k} className="chip" onClick={() => setD(i, 'text', `${d.text}${d.text && !d.text.endsWith(' ') ? ' ' : ''}{${k}}`)} title={`Inserts {${k}}: each guest sees their unit's ${label.toLowerCase()} from its record.`}>+ {label}</button>)}</span>}
            <div className="cb-photos">
              {d.photos.map(id => <span key={id} className="cb-photo">
                <img src={checkinPhotoUrl(id)} alt="" loading="lazy" />
                {canEdit && <button className="chip" onClick={() => setD(i, 'photos', d.photos.filter(p => p !== id))} aria-label="Remove photo">✕</button>}
              </span>)}
              {canEdit && d.photos.length < MAX_PHOTOS && <label className="chip cb-add-photo">
                {uploading === i ? 'Uploading…' : '+ Photo'}
                <input type="file" accept="image/*" multiple hidden disabled={uploading !== null} onChange={e => { void addPhotos(i, e.target.files); e.target.value = ''; }} />
              </label>}
            </div>
            <input value={d.link} placeholder="Video link (optional, opens in a new tab): https://drive.google.com/…" onChange={e => setD(i, 'link', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} video link`} />
            <div className="cb-where">
              <input value={d.where} placeholder="Location (optional): 33.1507, -96.8236 or a Maps link" onChange={e => setD(i, 'where', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} location`} />
              {pins[i] ? <a className="note" href={googleDir(pins[i]!)} target="_blank" rel="noopener noreferrer">✓ {pinText(pins[i]!)} · check on map</a>
                : d.where.trim() ? <span className="note cb-bad">▲ Not a point — paste the numbers or a long link</span> : null}
            </div>
          </div>
          {canEdit && <span className="cb-ctl">
            <button className="chip" disabled={i === 0} onClick={() => setDrafts(ds => move(ds, i, -1))} aria-label={`Move step ${i + 1} up`}>↑</button>
            <button className="chip" disabled={i === st.drafts.length - 1} onClick={() => setDrafts(ds => move(ds, i, 1))} aria-label={`Move step ${i + 1} down`}>↓</button>
            <button className="chip" onClick={() => setDrafts(ds => ds.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>✕</button>
          </span>}
        </div>)}
        {canEdit && st.drafts.length < MAX_STEPS && <div className="cb-actions"><button className="secondary small" onClick={() => setDrafts(ds => [...ds, blank()])}>+ Add step</button></div>}
      </section>

      <section className="card cb-card">
        <h3>House manual <Hint>The guest's reference for the stay: first what the unit's record says (Wi-Fi, times, parking, rules, phone — edit those in the record), then the building's items and this unit's own, e.g. Trash, Pool, Thermostat.</Hint></h3>
        {!shared && <RecordPart g={data.record} open={data.recordRef ? () => onOpenRecord(data.recordRef!.table, data.recordRef!.id) : null} />}
        {st.house.map((h, i) => <div key={i} className="cb-step">
          <span className="cb-n">•</span>
          <div className="cb-fields">
            <input value={h.title} maxLength={MAX_TITLE} placeholder="Title — e.g. Trash" onChange={e => setH(hs => hs.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} disabled={!canEdit} aria-label={`House manual item ${i + 1} title`} />
            <textarea value={h.text} maxLength={MAX_HOUSE_TEXT} rows={3} onChange={e => setH(hs => hs.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} disabled={!canEdit} aria-label={`House manual item ${i + 1} text`} />
          </div>
          {canEdit && <span className="cb-ctl">
            <button className="chip" disabled={i === 0} onClick={() => setH(hs => move(hs, i, -1))} aria-label={`Move item ${i + 1} up`}>↑</button>
            <button className="chip" disabled={i === st.house.length - 1} onClick={() => setH(hs => move(hs, i, 1))} aria-label={`Move item ${i + 1} down`}>↓</button>
            <button className="chip" onClick={() => setH(hs => hs.filter((_, j) => j !== i))} aria-label={`Remove item ${i + 1}`}>✕</button>
          </span>}
        </div>)}
        {canEdit && st.house.length < MAX_HOUSE && <div className="cb-actions"><button className="secondary small" onClick={() => setH(hs => [...hs, { title: '', text: '' }])}>+ Add item</button></div>}
      </section>

      {canEdit && <div className="cb-actions cb-save">
        {data.updatedAt && <span className="note">Saved {new Date(data.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{data.updatedBy ? ` by ${data.updatedBy}` : ''}</span>}
        <span className="rb-spacer" />
        {dirty && <button className="secondary small" onClick={() => { setSt(stateOf(data)); setCopied(''); }}>Undo changes</button>}
        <button className="small" disabled={(!dirty && unit !== SHARED) || busy || uploading !== null} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>}
    </>}
  </div>;
}

/** What the guest also sees, straight from the Units record — edited there, so it is never out of step. */
function RecordPart({ g, open }: { g: GuestGuide | null; open: (() => void) | null }) {
  const rows: [string, string | null][] = [
    ['Address', g?.address ?? null],
    ['Check-in from / out by', g && (g.checkIn || g.checkOut) ? `${g.checkIn ?? '—'} / ${g.checkOut ?? '—'}` : null],
    ['Wi-Fi', g?.wifi ? `${g.wifi.network}${g.wifi.password ? ' · password set' : ' · no password'}` : null],
    ['Parking', g?.parking ? [g.parking.notes, g.parking.freeStreet ? 'free street' : null, g.parking.coveredPerNight != null ? `covered $${g.parking.coveredPerNight}/night` : null].filter(Boolean).join(' · ') : null],
    ['Guest access', g?.access ?? null],
    ['House rules', g?.rules ? `${g.rules.split('\n').filter(Boolean).length} lines` : null],
    ['Full guide (link)', g?.manual ?? null],
    ['Contact phone', g?.phone ?? null],
  ];
  return <div className="cb-recwrap">
    {!g && <p className="note">▲ This unit has no Repository record.</p>}
    <dl className="cb-rec">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={v ? '' : 'cb-empty'}>{v ? (v.length > 120 ? `${v.slice(0, 120)}…` : v) : '○ empty'}</dd></div>)}</dl>
    {open && <button className="secondary small" onClick={open}>Open the record ›</button>}
  </div>;
}
