/**
 * Repository → "Check-in builder" (2026-11-09). Per unit, what the guest portal shows in two sections:
 *  · Check-in instructions — arrival steps: title, a line or two, an optional map pin (Google Maps / Apple Maps),
 *    up to 3 photos (inline) and a video link (opens in a new tab).
 *  · House manual — the record's Wi-Fi, times, parking, rules, phone (read here, edited in the record) + the
 *    house's own items (e.g. Trash).
 * "Copy from" loads another unit's steps and items into the editor; nothing is saved until Save.
 */
import { useEffect, useMemo, useState } from 'react';
import { checkinPhotoUrl, getCheckinGuide, getCheckinUnits, saveCheckinGuide, uploadCheckinPhoto } from '../api.ts';
import { MAX_HOUSE, MAX_HOUSE_TEXT, MAX_PHOTOS, MAX_STEPS, MAX_TEXT, MAX_TITLE, TOKENS, googleDir, parsePin, pinText,
  type CheckinStep, type HouseItem, type Pin } from '../lib/checkin.ts';
import type { GuestGuide } from '../lib/guest-portal.ts';
import { Hint } from './Hint.tsx';

type Draft = { title: string; text: string; where: string; link: string; photos: string[] };
const toDraft = (s: CheckinStep): Draft => ({ title: s.title, text: s.text, where: s.pin ? pinText(s.pin) : '', link: s.link ?? '', photos: s.photos ?? [] });
const blank = (): Draft => ({ title: '', text: '', where: '', link: '', photos: [] });
type Loaded = { unitName: string; steps: CheckinStep[]; house: HouseItem[]; record: GuestGuide | null; recordRef: { table: string; id: string } | null;
  updatedAt: string | null; updatedBy: string | null };
const same = (d: { drafts: Draft[]; house: HouseItem[] }, l: Loaded) =>
  JSON.stringify(d) === JSON.stringify({ drafts: l.steps.map(toDraft), house: l.house });

export function CheckinBuilder({ canEdit, say, onOpenRecord }: { canEdit: boolean; say: (m: string, bad?: boolean) => void; onOpenRecord: (table: string, id: string) => void }) {
  const [units, setUnits] = useState<{ id: string; name: string; steps: number }[]>([]);
  const [unit, setUnit] = useState(() => new URLSearchParams(location.search).get('unit') ?? '');
  const [data, setData] = useState<Loaded | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [house, setHouse] = useState<HouseItem[]>([]);
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [err, setErr] = useState('');

  const load = (l: Loaded) => { setData(l); setDrafts(l.steps.map(toDraft)); setHouse(l.house); };
  const loadUnits = () => getCheckinUnits().then(r => { if (r.ok) setUnits(r.units); else setErr(r.message ?? 'Could not load.'); }).catch(e => setErr(String(e)));
  useEffect(() => { void loadUnits(); }, []);
  useEffect(() => {
    setData(null); setCopied('');
    if (!unit) return;
    let live = true;
    getCheckinGuide(unit).then(r => { if (!live) return; if (r.ok) { load(r); setErr(''); } else setErr(r.message ?? 'Could not load.'); })
      .catch(e => setErr(String(e)));
    return () => { live = false; };
  }, [unit]);

  const pins = drafts.map(d => d.where.trim() ? parsePin(d.where) : null);
  const badPin = drafts.findIndex((d, i) => d.where.trim() && !pins[i]);
  const dirty = useMemo(() => !!data && !same({ drafts, house }, data), [drafts, house, data]);
  const set = <K extends keyof Draft>(i: number, k: K, v: Draft[K]) => setDrafts(ds => ds.map((d, j) => j === i ? { ...d, [k]: v } : d));
  const move = <T,>(list: T[], i: number, by: number) => { const n = [...list]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x!); return n; };

  const copyFrom = async (id: string) => {
    if (!id) return;
    const r = await getCheckinGuide(id).catch(() => null);
    if (!r?.ok) { say('Could not read that unit.', true); return; }
    setDrafts(r.steps.map(toDraft)); setHouse(r.house); setCopied(r.unitName);
    say(`Copied from ${r.unitName}: ${r.steps.length} steps, ${r.house.length} house manual items — edit them, then Save.`);
  };

  const addPhotos = async (i: number, files: FileList | null) => {
    const list = [...(files ?? [])].slice(0, MAX_PHOTOS - drafts[i]!.photos.length);
    if (!list.length) return;
    setUploading(i);
    for (const f of list) {
      const r = await uploadCheckinPhoto(unit, f).catch(e => ({ ok: false as const, message: String(e) }));
      if (r.ok) setDrafts(ds => ds.map((d, j) => j === i ? { ...d, photos: [...d.photos, r.id] } : d));
      else { say(r.message ?? 'Photo not uploaded.', true); break; }
    }
    setUploading(null);
    say('Photo added — Save to keep it on the step.');
  };

  const save = async () => {
    if (badPin >= 0) { say(`Step ${badPin + 1}: the location is not coordinates or a long Maps link.`, true); return; }
    setBusy(true);
    const steps = drafts.map((d, i) => ({ title: d.title, text: d.text, pin: pins[i] as Pin | null, link: d.link.trim() || null, photos: d.photos }));
    const r = await saveCheckinGuide({ unit, steps, house, copiedFrom: copied || undefined }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { say(r.message ?? 'Not saved.', true); return; }
    if (data) load({ ...data, steps: r.steps, house: r.house });
    setCopied(''); say('Check-in guide saved.'); void loadUnits();
  };

  const withSteps = units.filter(u => u.steps > 0 && u.id !== unit);
  return <div className="cb">
    <div className="cb-top">
      <label>Unit
        <select value={unit} onChange={e => { const v = e.target.value; setUnit(v); const u = new URL(location.href); if (v) u.searchParams.set('unit', v); else u.searchParams.delete('unit'); history.replaceState(history.state, '', u); }}>
          <option value="">Pick a unit…</option>
          {units.map(u => <option key={u.id} value={u.id}>{u.name}{u.steps ? ` · ${u.steps} step${u.steps === 1 ? '' : 's'}` : ''}</option>)}
        </select></label>
      {unit && canEdit && withSteps.length > 0 && <label>Copy from
        <select value="" onChange={e => void copyFrom(e.target.value)}>
          <option value="">Another unit…</option>
          {withSteps.map(u => <option key={u.id} value={u.id}>{u.name} · {u.steps}</option>)}
        </select></label>}
      {unit && <a className="chip cb-preview" href={`/guest/demo?stay=paid&unit=${encodeURIComponent(unit)}`} target="_blank" rel="noopener">Preview as guest ›</a>}
    </div>
    {err && <p className="breach" role="alert">{err}</p>}
    {!unit ? <p className="note">Pick a unit to build what its guest sees on arrival. Units with steps show how many.</p>
      : !data ? <p className="note loading-dot">Loading</p> : <>
      <section className="card cb-card">
        <h3>Check-in instructions <Hint>What the guest follows to reach the unit: e.g. 1 · Pick up your key fob (lockbox in the garage), 2 · Building entrance. A location opens in Google Maps or Apple Maps — in Google Maps hold your finger on the exact spot and copy the numbers at the top (33.1507, -96.8236), or paste a long Maps link. Photos show on the step; a video link opens in a new tab.</Hint></h3>
        {drafts.length === 0 && <p className="note">No steps — the guest sees the address only.</p>}
        {drafts.map((d, i) => <div key={i} className="cb-step">
          <span className="cb-n">{i + 1}</span>
          <div className="cb-fields">
            <input value={d.title} maxLength={MAX_TITLE} placeholder="Title — e.g. Pick up your key fob" onChange={e => set(i, 'title', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} title`} />
            <textarea value={d.text} maxLength={MAX_TEXT} rows={2} placeholder="What to do there — e.g. Lockbox labeled 1304 inside the garage" onChange={e => set(i, 'text', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} text`} />
            {canEdit && <span className="cb-tokens">{Object.entries(TOKENS).map(([k, label]) =>
              <button key={k} className="chip" onClick={() => set(i, 'text', `${d.text}${d.text && !d.text.endsWith(' ') ? ' ' : ''}{${k}}`)} title={`Inserts {${k}}: the guest sees the record's ${label.toLowerCase()}, so a new code is changed once, in the record.`}>+ {label}</button>)}</span>}
            <div className="cb-photos">
              {d.photos.map(id => <span key={id} className="cb-photo">
                <img src={checkinPhotoUrl(id)} alt="" loading="lazy" />
                {canEdit && <button className="chip" onClick={() => set(i, 'photos', d.photos.filter(p => p !== id))} aria-label="Remove photo">✕</button>}
              </span>)}
              {canEdit && d.photos.length < MAX_PHOTOS && <label className="chip cb-add-photo">
                {uploading === i ? 'Uploading…' : '+ Photo'}
                <input type="file" accept="image/*" multiple hidden disabled={uploading !== null} onChange={e => { void addPhotos(i, e.target.files); e.target.value = ''; }} />
              </label>}
            </div>
            <input value={d.link} placeholder="Video link (optional, opens in a new tab): https://drive.google.com/…" onChange={e => set(i, 'link', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} video link`} />
            <div className="cb-where">
              <input value={d.where} placeholder="Location (optional): 33.1507, -96.8236 or a Maps link" onChange={e => set(i, 'where', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} location`} />
              {pins[i] ? <a className="note" href={googleDir(pins[i]!)} target="_blank" rel="noopener noreferrer">✓ {pinText(pins[i]!)} · check on map</a>
                : d.where.trim() ? <span className="note cb-bad">▲ Not a point — paste the numbers or a long link</span> : null}
            </div>
          </div>
          {canEdit && <span className="cb-ctl">
            <button className="chip" disabled={i === 0} onClick={() => setDrafts(ds => move(ds, i, -1))} aria-label={`Move step ${i + 1} up`}>↑</button>
            <button className="chip" disabled={i === drafts.length - 1} onClick={() => setDrafts(ds => move(ds, i, 1))} aria-label={`Move step ${i + 1} down`}>↓</button>
            <button className="chip" onClick={() => setDrafts(ds => ds.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>✕</button>
          </span>}
        </div>)}
        {canEdit && drafts.length < MAX_STEPS && <div className="cb-actions"><button className="secondary small" onClick={() => setDrafts(ds => [...ds, blank()])}>+ Add step</button></div>}
      </section>

      <section className="card cb-card">
        <h3>House manual <Hint>The guest's reference for the stay. First what the unit's record says (Wi-Fi, times, parking, rules, phone — edit those in the record), then this house's own items, e.g. Trash, Pool, Thermostat.</Hint></h3>
        <RecordPart g={data.record} open={data.recordRef ? () => onOpenRecord(data.recordRef!.table, data.recordRef!.id) : null} />
        {house.map((h, i) => <div key={i} className="cb-step">
          <span className="cb-n">•</span>
          <div className="cb-fields">
            <input value={h.title} maxLength={MAX_TITLE} placeholder="Title — e.g. Trash" onChange={e => setHouse(hs => hs.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} disabled={!canEdit} aria-label={`House manual item ${i + 1} title`} />
            <textarea value={h.text} maxLength={MAX_HOUSE_TEXT} rows={3} onChange={e => setHouse(hs => hs.map((x, j) => j === i ? { ...x, text: e.target.value } : x))} disabled={!canEdit} aria-label={`House manual item ${i + 1} text`} />
          </div>
          {canEdit && <span className="cb-ctl">
            <button className="chip" disabled={i === 0} onClick={() => setHouse(hs => move(hs, i, -1))} aria-label={`Move item ${i + 1} up`}>↑</button>
            <button className="chip" disabled={i === house.length - 1} onClick={() => setHouse(hs => move(hs, i, 1))} aria-label={`Move item ${i + 1} down`}>↓</button>
            <button className="chip" onClick={() => setHouse(hs => hs.filter((_, j) => j !== i))} aria-label={`Remove item ${i + 1}`}>✕</button>
          </span>}
        </div>)}
        {canEdit && house.length < MAX_HOUSE && <div className="cb-actions"><button className="secondary small" onClick={() => setHouse(hs => [...hs, { title: '', text: '' }])}>+ Add item</button></div>}
      </section>

      {canEdit && <div className="cb-actions cb-save">
        {data.updatedAt && <span className="note">Saved {new Date(data.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{data.updatedBy ? ` by ${data.updatedBy}` : ''}</span>}
        <span className="rb-spacer" />
        {dirty && <button className="secondary small" onClick={() => { load(data); setCopied(''); }}>Undo changes</button>}
        <button className="small" disabled={!dirty || busy || uploading !== null} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
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
