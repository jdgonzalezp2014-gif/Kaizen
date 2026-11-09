/**
 * Repository → "Check-in builder" (2026-11-09). Per unit: the arrival steps the guest portal shows first
 * (title, a line or two, an optional map pin opened in Google Maps / Apple Maps), then — read from the unit's
 * own record, never copied here — address, Wi-Fi, check-in times, guest access, parking, manual, rules, phone.
 * "Copy from" loads another unit's steps into the editor; nothing is saved until Save.
 */
import { useEffect, useMemo, useState } from 'react';
import { getCheckinGuide, getCheckinUnits, saveCheckinGuide } from '../api.ts';
import { MAX_STEPS, MAX_TEXT, MAX_TITLE, TOKENS, googleDir, parsePin, pinText, type CheckinStep, type Pin } from '../lib/checkin.ts';
import type { GuestGuide } from '../lib/guest-portal.ts';
import { Hint } from './Hint.tsx';

type Draft = { title: string; text: string; where: string; link: string };
const toDraft = (s: CheckinStep): Draft => ({ title: s.title, text: s.text, where: s.pin ? pinText(s.pin) : '', link: s.link ?? '' });
const blank = (): Draft => ({ title: '', text: '', where: '', link: '' });
type Loaded = { unitName: string; steps: CheckinStep[]; record: GuestGuide | null; recordRef: { table: string; id: string } | null; updatedAt: string | null; updatedBy: string | null };

export function CheckinBuilder({ canEdit, say, onOpenRecord }: { canEdit: boolean; say: (m: string, bad?: boolean) => void; onOpenRecord: (table: string, id: string) => void }) {
  const [units, setUnits] = useState<{ id: string; name: string; steps: number }[]>([]);
  const [unit, setUnit] = useState(() => new URLSearchParams(location.search).get('unit') ?? '');
  const [data, setData] = useState<Loaded | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const loadUnits = () => getCheckinUnits().then(r => { if (r.ok) setUnits(r.units); else setErr(r.message ?? 'Could not load.'); }).catch(e => setErr(String(e)));
  useEffect(() => { void loadUnits(); }, []);
  useEffect(() => {
    setData(null); setCopied('');
    if (!unit) return;
    let live = true;
    getCheckinGuide(unit).then(r => { if (!live) return; if (r.ok) { setData(r); setDrafts(r.steps.map(toDraft)); setErr(''); } else setErr(r.message ?? 'Could not load.'); })
      .catch(e => setErr(String(e)));
    return () => { live = false; };
  }, [unit]);

  const pins = drafts.map(d => d.where.trim() ? parsePin(d.where) : null);
  const badPin = drafts.findIndex((d, i) => d.where.trim() && !pins[i]);
  const dirty = useMemo(() => !!data && JSON.stringify(drafts) !== JSON.stringify(data.steps.map(toDraft)), [drafts, data]);
  const set = (i: number, k: keyof Draft, v: string) => setDrafts(ds => ds.map((d, j) => j === i ? { ...d, [k]: v } : d));
  const move = (i: number, by: number) => setDrafts(ds => { const n = [...ds]; const [x] = n.splice(i, 1); n.splice(i + by, 0, x!); return n; });

  const copyFrom = async (id: string) => {
    if (!id) return;
    const r = await getCheckinGuide(id).catch(() => null);
    if (!r?.ok) { say('Could not read that unit.', true); return; }
    setDrafts(r.steps.map(toDraft)); setCopied(r.unitName);
    say(`${r.steps.length} step${r.steps.length === 1 ? '' : 's'} copied from ${r.unitName} — edit them, then Save.`);
  };

  const save = async () => {
    if (badPin >= 0) { say(`Step ${badPin + 1}: the location is not coordinates or a long Maps link.`, true); return; }
    setBusy(true);
    const steps = drafts.map((d, i) => ({ title: d.title, text: d.text, pin: pins[i] as Pin | null, link: d.link.trim() || null }));
    const r = await saveCheckinGuide({ unit, steps, copiedFrom: copied || undefined }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { say(r.message ?? 'Not saved.', true); return; }
    setData(d => d && { ...d, steps: r.steps }); setDrafts(r.steps.map(toDraft)); setCopied('');
    say('Check-in steps saved.'); void loadUnits();
  };

  const withSteps = units.filter(u => u.steps > 0 && u.id !== unit);
  return <div className="cb">
    <div className="cb-top">
      <label>Unit
        <select value={unit} onChange={e => { const v = e.target.value; setUnit(v); const u = new URL(location.href); if (v) u.searchParams.set('unit', v); else u.searchParams.delete('unit'); history.replaceState(history.state, '', u); }}>
          <option value="">Pick a unit…</option>
          {units.map(u => <option key={u.id} value={u.id}>{u.name}{u.steps ? ` · ${u.steps} step${u.steps === 1 ? '' : 's'}` : ''}</option>)}
        </select></label>
      {unit && canEdit && withSteps.length > 0 && <label>Copy steps from
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
        <h3>Arrival steps <Hint>What the guest follows to reach the building: e.g. 1 · Pick up your key fob (lockbox by the office), 2 · Building entrance. A location opens in Google Maps or Apple Maps. To get one: in Google Maps hold your finger on the exact spot and copy the numbers at the top (33.1507, -96.8236) — or paste a long Maps link. Short share links (maps.app.goo.gl) do not carry the point.</Hint></h3>
        {drafts.length === 0 && <p className="note">No steps — the guest sees the address and the record's fields only.</p>}
        {drafts.map((d, i) => <div key={i} className="cb-step">
          <span className="cb-n">{i + 1}</span>
          <div className="cb-fields">
            <input value={d.title} maxLength={MAX_TITLE} placeholder="Title — e.g. Pick up your key fob" onChange={e => set(i, 'title', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} title`} />
            <textarea value={d.text} maxLength={MAX_TEXT} rows={2} placeholder="What to do there — e.g. Lockbox next to the leasing office door" onChange={e => set(i, 'text', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} text`} />
            {canEdit && <span className="cb-tokens">{Object.entries(TOKENS).map(([k, label]) =>
              <button key={k} className="chip" onClick={() => set(i, 'text', `${d.text}${d.text && !d.text.endsWith(' ') ? ' ' : ''}{${k}}`)} title={`Inserts {${k}}: the guest sees the record's ${label.toLowerCase()}, so a new code is changed once, in the record.`}>+ {label}</button>)}</span>}
            <input value={d.link} placeholder="Video or photo link (optional): https://drive.google.com/…" onChange={e => set(i, 'link', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} link`} />
            <div className="cb-where">
              <input value={d.where} placeholder="Location (optional): 33.1507, -96.8236 or a Maps link" onChange={e => set(i, 'where', e.target.value)} disabled={!canEdit} aria-label={`Step ${i + 1} location`} />
              {pins[i] ? <a className="note" href={googleDir(pins[i]!)} target="_blank" rel="noopener noreferrer">✓ {pinText(pins[i]!)} · check on map</a>
                : d.where.trim() ? <span className="note cb-bad">▲ Not a point — paste the numbers or a long link</span> : null}
            </div>
          </div>
          {canEdit && <span className="cb-ctl">
            <button className="chip" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}>↑</button>
            <button className="chip" disabled={i === drafts.length - 1} onClick={() => move(i, 1)} aria-label={`Move step ${i + 1} down`}>↓</button>
            <button className="chip" onClick={() => setDrafts(ds => ds.filter((_, j) => j !== i))} aria-label={`Remove step ${i + 1}`}>✕</button>
          </span>}
        </div>)}
        {canEdit && <div className="cb-actions">
          {drafts.length < MAX_STEPS && <button className="secondary small" onClick={() => setDrafts(ds => [...ds, blank()])}>+ Add step</button>}
          <span className="rb-spacer" />
          {dirty && <button className="secondary small" onClick={() => { setDrafts(data.steps.map(toDraft)); setCopied(''); }}>Undo changes</button>}
          <button className="small" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
        </div>}
        {data.updatedAt && <p className="note">Saved {new Date(data.updatedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{data.updatedBy ? ` by ${data.updatedBy}` : ''}</p>}
      </section>
      <RecordPart g={data.record} open={data.recordRef ? () => onOpenRecord(data.recordRef!.table, data.recordRef!.id) : null} />
    </>}
  </div>;
}

/** What the guest also sees, straight from the Units record — edited there, so it is never out of step. */
function RecordPart({ g, open }: { g: GuestGuide | null; open: (() => void) | null }) {
  const rows: [string, string | null][] = [
    ['Address', g?.address ?? null],
    ['Check-in from / out by', g && (g.checkIn || g.checkOut) ? `${g.checkIn ?? '—'} / ${g.checkOut ?? '—'}` : null],
    ['Wi-Fi', g?.wifi ? `${g.wifi.network}${g.wifi.password ? ' · password set' : ' · no password'}` : null],
    ['Guest access', g?.access ?? null],
    ['Parking', g?.parking ? [g.parking.notes, g.parking.freeStreet ? 'free street' : null, g.parking.coveredPerNight != null ? `covered $${g.parking.coveredPerNight}/night` : null].filter(Boolean).join(' · ') : null],
    ['House manual', g?.manual ?? null],
    ['House rules', g?.rules ? `${g.rules.split('\n').filter(Boolean).length} lines` : null],
    ['Contact phone', g?.phone ?? null],
  ];
  return <section className="card cb-card">
    <h3>From the record <Hint>Shown to the guest after the steps. Edit these in the unit's record — the builder only reads them. Door codes never go to the guest.</Hint></h3>
    {!g && <p className="note">▲ This unit has no Repository record.</p>}
    <dl className="cb-rec">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={v ? '' : 'cb-empty'}>{v ? (v.length > 120 ? `${v.slice(0, 120)}…` : v) : '○ empty'}</dd></div>)}</dl>
    {open && <button className="secondary small" onClick={open}>Open the record ›</button>}
  </section>;
}
