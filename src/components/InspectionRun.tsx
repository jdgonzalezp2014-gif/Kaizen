/**
 * An inspection, walked on a phone (§133).
 *
 * Fixed at the top: Cleaning · Repair · Purchase — something seen on the
 * spot, written down in two taps. Below, the unit room by room (its
 * bedrooms and bathrooms come from the unit), each item ✓ OK, ▲ needs
 * attention or N/A. A finding asks for a photo (required) and what it
 * becomes. Every tap is saved at once: a phone that loses signal in a
 * bathroom loses nothing, and the inspection can be closed and continued.
 *
 * Then a review: each finding's outcome — a repair (work order + "Assign and
 * schedule"), a purchase (to-do), a task for the next clean, or a new clean —
 * and the overall result. Finishing makes the work.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getRun, runAction, runPhotos, type InspectionRunData, type RunCheck } from '../api.ts';
import { checkKey, overallResult, progress, readyToFinish, reviewSteps, type Area, type Outcome, type Section } from '../lib/inspection.ts';

const OUTCOME_LABEL: Record<Outcome, string> = {
  repair: '🔧 Repair (work order)', purchase: '🛒 Purchase (to-do)', clean_next: '🧽 Task for the next clean',
  clean_new: '🧽 A new clean', none: 'No action — report only'
};
const QUICK: { kind: 'clean' | 'repair' | 'purchase'; label: string }[] = [
  { kind: 'clean', label: '🧽 Cleaning' }, { kind: 'repair', label: '🔧 Repair' }, { kind: 'purchase', label: '🛒 Purchase' }
];
const RESULTS = ['OK', 'Minor issues', 'Maintenance needed', 'Urgent'];
const secKey = (s: { area: Area; n: number }) => `${s.area}:${s.n}`;

export function InspectionRun({ id, onClose, canEdit }: { id: string; onClose: (changed: boolean) => void; canEdit: boolean }) {
  const [data, setData] = useState<InspectionRunData | null>(null);
  const [err, setErr] = useState('');
  const [step, setStep] = useState<'walk' | 'review' | 'done'>('walk');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [quick, setQuick] = useState<null | { kind: 'clean' | 'repair' | 'purchase' }>(null);
  const [made, setMade] = useState<{ kind: string; title: string }[]>([]);
  const changed = useRef(false);

  const load = () => getRun(id).then(r => {
    if (!r.ok) { setErr(r.message ?? 'Could not load the inspection.'); return; }
    setData(r);
    // The first room with something left to check opens by itself.
    setOpen(o => {
      if (o.size) return o;
      const by = new Map(r.checks.map(c => [checkKey(c), c]));
      const first = r.sections.find(s => s.items.some(i => !by.get(`${i.id}:${s.n}`)?.result)) ?? r.sections[0];
      return new Set(first ? [secKey(first)] : []);
    });
  }).catch(e => setErr(String(e)));
  useEffect(() => { void load(); }, [id]);

  const byKey = useMemo(() => new Map((data?.checks ?? []).map(c => [checkKey(c), c])), [data]);
  if (err && !data) return <Sheet title="Inspection" onClose={() => onClose(false)}><p className="banner error">{err}</p></Sheet>;
  if (!data) return <Sheet title="Inspection" onClose={() => onClose(false)}><p className="note loading-dot">Loading the checklist…</p></Sheet>;

  const ins = data.inspection;
  const readOnly = ins.finished || !canEdit;
  const prog = progress(data.sections, data.checks);
  const patchLocal = (key: string, c: Partial<RunCheck>) => setData(d => d && {
    ...d, checks: d.checks.some(x => checkKey(x) === key) ? d.checks.map(x => checkKey(x) === key ? { ...x, ...c } : x)
      : [...d.checks, c as RunCheck]
  });
  const fail = (m?: string) => setErr(m ?? 'Not saved — check the signal and try again.');

  /** Save one answer: shown at once, sent at once. */
  const answer = async (s: Section, itemId: string, label: string, patch: Partial<RunCheck>) => {
    const key = `${itemId}:${s.n}`;
    const cur = byKey.get(key);
    patchLocal(key, { itemId, area: s.area, n: s.n, label, note: null, photos: [], outcome: null, result: null, ...cur, ...patch, id: cur?.id ?? '' });
    changed.current = true;
    const r = await runAction<{ checkId: string }>({ action: 'check', inspectionId: ins.id, itemId, n: s.n, ...patch }).catch(() => null);
    if (!r?.ok) { fail(r && !r.ok ? r.message : undefined); return null; }
    setErr('');
    // The server picks the item's usual outcome for a new finding: read it back once.
    if (patch.result === 'attention' && !cur?.outcome) await load();
    else patchLocal(key, { id: r.checkId });
    return r.checkId;
  };
  const saveExisting = async (c: RunCheck, patch: Partial<RunCheck>) => {
    patchLocal(checkKey(c), patch);
    changed.current = true;
    const r = await runAction({ action: 'check', inspectionId: ins.id, checkId: c.id, ...patch }).catch(() => null);
    if (!r?.ok) fail(r && !r.ok ? r.message : undefined); else setErr('');
  };
  const photos = async (checkId: string, files: FileList | null) => {
    if (!files?.length) return;
    setErr('Uploading the photo…');
    const r = await runPhotos(ins.id, checkId, [...files]).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { fail(r.message); return; }
    setErr(''); changed.current = true; await load();
  };
  const allOk = async (s: Section) => {
    changed.current = true;
    const r = await runAction({ action: 'allOk', inspectionId: ins.id, area: s.area, n: s.n }).catch(() => null);
    if (!r?.ok) { fail(r && !r.ok ? r.message : undefined); return; }
    await load();
    // On to the next room still to check.
    const idx = data.sections.findIndex(x => secKey(x) === secKey(s));
    const next = data.sections[idx + 1];
    setOpen(new Set(next ? [secKey(next)] : []));
  };

  if (step === 'done') {
    return (
      <Sheet title={`Inspection · ${ins.unit}`} onClose={() => onClose(true)}>
        <div className="insp-body">
          <p className="banner ok">✓ Inspection finished{made.length ? '' : ' — everything checked OK'}.</p>
          {made.length > 0 && <>
            <h3>What it made</h3>
            <ul className="insp-made">{made.map((m, i) => <li key={i}>{m.kind === 'repair' ? '🔧' : m.kind === 'purchase' ? '🛒' : '🧽'} {m.title}</li>)}</ul>
            <p className="note">Repairs and purchases are in Operations → To-do (and Hostaway). Each repair starts with “Assign and schedule”.
              Cleaning tasks show on the board's row and on the cleaner's page.</p>
          </>}
          <div className="button-row"><button onClick={() => onClose(true)}>Close</button></div>
        </div>
      </Sheet>
    );
  }

  if (step === 'review') {
    return <Review data={data} onBack={() => setStep('walk')} onSave={saveExisting} onPhotos={photos}
                   onFinished={m => { setMade(m); changed.current = true; setStep('done'); }} />;
  }

  return (
    <Sheet title={`${readOnly ? 'Inspection' : 'Inspecting'} · ${ins.unit}`} sub={`${ins.date}${ins.inspector ? ` · ${ins.inspector}` : ''}${ins.finished ? ` · ${ins.result}` : ''}`}
           onClose={() => onClose(changed.current)}>
      {!readOnly && (
        <div className="insp-quick">
          {QUICK.map(q => <button key={q.kind} className="chip" onClick={() => setQuick(q)}>{q.label}</button>)}
        </div>
      )}
      <div className="insp-progress" aria-label="Progress">
        <div className="insp-bar"><span style={{ width: `${prog.total ? Math.round(prog.done / prog.total * 100) : 0}%` }} /></div>
        <span className="note">{prog.done} of {prog.total} checked{prog.attention ? ` · ▲ ${prog.attention} need attention` : ''}</span>
      </div>
      {err && <p className={err.startsWith('Uploading') ? 'note' : 'banner warn'}>{err}</p>}
      {quick && <QuickAdd data={data} kind={quick.kind} onCancel={() => setQuick(null)}
                          onDone={async () => { setQuick(null); changed.current = true; await load(); }} />}

      <div className="insp-body">
        {data.sections.map(s => {
          const k = secKey(s);
          const isOpen = open.has(k);
          const answered = s.items.filter(i => byKey.get(`${i.id}:${s.n}`)?.result).length;
          const flags = s.items.filter(i => byKey.get(`${i.id}:${s.n}`)?.result === 'attention').length
            + data.checks.filter(c => !c.itemId && c.area === s.area && c.n === s.n).length;
          const extra = data.checks.filter(c => !c.itemId && c.area === s.area && c.n === s.n);
          return (
            <section key={k} className="insp-sec">
              <button className="insp-sec-head" onClick={() => setOpen(o => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>
                <b>{s.title}</b>
                <span className="note">{answered}/{s.items.length}{flags ? ` · ▲ ${flags}` : answered === s.items.length ? ' ✓' : ''}</span>
                <span>{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && (
                <div className="insp-items">
                  {!readOnly && answered < s.items.length &&
                    <button className="link tiny" onClick={() => void allOk(s)}>✓ Everything else here is OK</button>}
                  {s.items.map(i => {
                    const c = byKey.get(`${i.id}:${s.n}`);
                    return <ItemRow key={i.id} label={i.label} c={c} readOnly={readOnly}
                                    onResult={r => void answer(s, i.id, i.label, { result: r })}
                                    onNote={t => c?.id ? void saveExisting(c, { note: t }) : void answer(s, i.id, i.label, { note: t })}
                                    onPhotos={async files => { const id2 = c?.id || await answer(s, i.id, i.label, { result: 'attention' }); if (id2) await photos(id2, files); }} />;
                  })}
                  {extra.map(c => (
                    <ItemRow key={c.id} label={`${c.label} (added)`} c={c} readOnly={readOnly} adhoc
                             onResult={() => {}} onNote={t => void saveExisting(c, { note: t })} onPhotos={files => photos(c.id, files)}
                             onRemove={async () => { await runAction({ action: 'remove', inspectionId: ins.id, checkId: c.id }); changed.current = true; await load(); }} />
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {!data.sections.length && <p className="note">The checklist is empty — add items in Operations → Setup → Inspection checklist.
          Findings can still be added with the buttons above.</p>}
      </div>

      {!readOnly && (
        <div className="insp-foot">
          <span className="note">Saved as you go{prog.total - prog.done ? ` · ${prog.total - prog.done} not checked yet` : ''}</span>
          <button onClick={() => setStep('review')}>Review & finish →</button>
        </div>
      )}
    </Sheet>
  );
}

/** One checklist item: three buttons, and — when it needs attention — a note, a photo and the decision. */
function ItemRow({ label, c, readOnly, adhoc, onResult, onNote, onPhotos, onRemove }: {
  label: string; c: RunCheck | undefined; readOnly: boolean; adhoc?: boolean;
  onResult: (r: 'ok' | 'attention' | 'na') => void; onNote: (t: string) => void;
  onPhotos: (files: FileList | null) => void | Promise<void>; onRemove?: () => void;
}) {
  const [note, setNote] = useState(c?.note ?? '');
  useEffect(() => setNote(c?.note ?? ''), [c?.note]);
  const r = c?.result ?? null;
  return (
    <div className={`insp-item ${r === 'attention' ? 'att' : r === 'ok' ? 'ok' : ''}`}>
      <div className="insp-item-top">
        <span className="insp-label">{label}</span>
        {!adhoc && (
          <div className="insp-seg" role="group" aria-label={label}>
            {(['ok', 'attention', 'na'] as const).map(v => (
              <button key={v} disabled={readOnly} className={r === v ? `on ${v}` : ''} onClick={() => onResult(v)}>
                {v === 'ok' ? '✓ OK' : v === 'attention' ? '▲ Fix' : 'N/A'}</button>
            ))}
          </div>
        )}
      </div>
      {r === 'attention' && (
        <div className="insp-att">
          <input value={note} disabled={readOnly} maxLength={1000} placeholder="What is wrong (optional)" onChange={e => setNote(e.target.value)}
                 onBlur={() => { if (note !== (c?.note ?? '')) onNote(note); }} />
          <div className="insp-photos">
            {(c?.photos ?? []).map((p, i) => <a key={i} href={p.url} target="_blank" rel="noreferrer">📷 {p.name}</a>)}
            {!readOnly && (
              <label className={`chip ${c?.photos?.length ? '' : 'need'}`}>📷 {c?.photos?.length ? 'Add photo' : 'Photo (required)'}
                <input type="file" accept="image/*" capture="environment" multiple hidden onChange={e => void onPhotos(e.target.files)} /></label>
            )}
            {!readOnly && onRemove && <button className="link tiny danger" onClick={onRemove}>remove</button>}
          </div>
          {c?.outcome && <div className="sub-n">→ {OUTCOME_LABEL[c.outcome]}</div>}
        </div>
      )}
    </div>
  );
}

/** The fixed buttons: a finding written down on the spot, with its photo. */
function QuickAdd({ data, kind, onCancel, onDone }: {
  data: InspectionRunData; kind: 'clean' | 'repair' | 'purchase'; onCancel: () => void; onDone: () => void;
}) {
  const [label, setLabel] = useState('');
  const [where, setWhere] = useState(data.sections[0] ? secKey(data.sections[0]) : 'general:1');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const word = kind === 'clean' ? 'to clean' : kind === 'repair' ? 'to repair' : 'to buy';
  const save = async () => {
    setBusy(true); setMsg('');
    const [area, n] = where.split(':');
    const r = await runAction<{ checkId: string }>({ action: 'add', inspectionId: data.inspection.id, kind, label, area, n: Number(n) }).catch(() => null);
    if (!r?.ok) { setBusy(false); setMsg(r && !r.ok ? r.message ?? 'Not saved.' : 'Not saved.'); return; }
    if (files.length) {
      const p = await runPhotos(data.inspection.id, r.checkId, files).catch(e => ({ ok: false as const, message: String(e) }));
      if (!p.ok) { setBusy(false); setMsg(`Saved, but the photo did not upload: ${p.message}`); return; }
    }
    setBusy(false); onDone();
  };
  return (
    <div className="insp-quick-form">
      <b>{QUICK.find(q => q.kind === kind)!.label}</b>
      <input autoFocus value={label} maxLength={200} placeholder={`What ${word}`} onChange={e => setLabel(e.target.value)} />
      <select value={where} onChange={e => setWhere(e.target.value)}>
        {data.sections.map(s => <option key={secKey(s)} value={secKey(s)}>{s.title}</option>)}
        {!data.sections.length && <option value="general:1">General</option>}
      </select>
      <label className={`chip ${files.length ? '' : 'need'}`}>📷 {files.length ? `${files.length} photo${files.length === 1 ? '' : 's'}` : 'Photo (required)'}
        <input type="file" accept="image/*" capture="environment" multiple hidden onChange={e => setFiles([...(e.target.files ?? [])])} /></label>
      <div className="button-row">
        <button className="small" disabled={busy || !label.trim() || !files.length} onClick={() => void save()}>{busy ? 'Saving…' : 'Add'}</button>
        <button className="small secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {msg && <p className="breach">{msg}</p>}
    </div>
  );
}

/**
 * Review & finish, step by step (the owner's flow): Repairs → Purchases →
 * Cleaning → Finish. Each step shows its findings with their notes (editable),
 * lets one move to another kind, and goes on with "Confirm & continue".
 * Repairs become one work order each; purchases ONE to-do, a shopping list;
 * cleaning findings go to the next clean or one new clean — one choice for all.
 */
function Review({ data, onBack, onSave, onPhotos, onFinished }: {
  data: InspectionRunData; onBack: () => void;
  onSave: (c: RunCheck, patch: Partial<RunCheck>) => Promise<void>;
  onPhotos: (checkId: string, files: FileList | null) => Promise<void>;
  onFinished: (made: { kind: string; title: string }[]) => void;
}) {
  const ins = data.inspection;
  const findings = data.checks.filter(c => c.result === 'attention');
  const steps = reviewSteps(findings);
  const [idx, setIdx] = useState(0);
  const step = steps[Math.min(idx, steps.length - 1)]!;
  const suggested = overallResult(findings);
  const [result, setResult] = useState<string>(suggested);
  useEffect(() => setResult(suggested), [suggested]);
  const [notes, setNotes] = useState('');
  const [cleanMode, setCleanMode] = useState<'next' | 'new'>(data.nextClean ? 'next' : 'new');
  const [cleanDate, setCleanDate] = useState(() => { const t = new Date(`${data.today}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + 1); return t.toISOString().slice(0, 10); });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const sectionTitle = (c: RunCheck) => data.sections.find(s => s.area === c.area && s.n === c.n)?.title ?? c.area;
  const prog = progress(data.sections, data.checks);
  const isClean = (c: RunCheck) => c.outcome === 'clean_next' || c.outcome === 'clean_new';
  const group = findings.filter(c => step === 'repair' ? c.outcome === 'repair' : step === 'purchase' ? c.outcome === 'purchase' : step === 'clean' ? isClean(c) : false);
  const needPhoto = group.filter(c => !c.photos.length);
  const go = (d: number) => { setMsg(''); setIdx(i => Math.max(0, Math.min(steps.length - 1, i + d))); };
  const finish = async () => {
    setBusy(true); setMsg('');
    const r = await runAction<{ made: { kind: string; title: string }[] }>({ action: 'finish', inspectionId: ins.id, result, notes, cleanMode, cleanDate })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not finished.'); return; }
    onFinished(r.made);
  };
  const count = (f: (c: RunCheck) => boolean) => findings.filter(f).length;
  const HEAD: Record<string, [string, string]> = {
    repair: ['🔧 Repairs', 'Each becomes a work order — nobody on it yet — with the sub-task “Assign and schedule”.'],
    purchase: ['🛒 Purchases', 'All of them become ONE to-do: a shopping list, an item per sub-task to tick off.'],
    clean: ['🧽 Cleaning', 'One choice for all of them: tasks for the unit’s next clean, or one new clean.']
  };

  return (
    <Sheet title={`Review · ${ins.unit}`} sub={`Step ${Math.min(idx, steps.length - 1) + 1} of ${steps.length}`} onClose={onBack} closeLabel="← Rooms">
      <div className="insp-steps">{steps.map((s2, i) => <span key={s2} className={i === Math.min(idx, steps.length - 1) ? 'on' : i < idx ? 'done' : ''}>
        {s2 === 'repair' ? '🔧' : s2 === 'purchase' ? '🛒' : s2 === 'clean' ? '🧽' : '✓'}</span>)}</div>
      <div className="insp-body">
        {step !== 'finish' && <>
          <h3>{HEAD[step]![0]} <span className="count">{group.length}</span></h3>
          <p className="note">{HEAD[step]![1]}</p>
          {group.map(c => <FindingCard key={c.id} c={c} title={sectionTitle(c)} onSave={onSave} onPhotos={onPhotos} />)}
          {step === 'clean' && (
            <div className="insp-finding">
              <label className="check"><input type="radio" checked={cleanMode === 'next'} disabled={!data.nextClean} onChange={() => setCleanMode('next')} />
                Notes for the next clean{data.nextClean ? ` — ${data.nextClean.date}${data.nextClean.cleaner ? ` · ${data.nextClean.cleaner}` : ''}` : ' (none scheduled)'}</label>
              <label className="check"><input type="radio" checked={cleanMode === 'new'} onChange={() => setCleanMode('new')} /> A new clean, unassigned — the team gives it to a cleaner</label>
              {cleanMode === 'new' && <label>Day<input type="date" value={cleanDate} min={data.today} onChange={e => setCleanDate(e.target.value)} /></label>}
            </div>
          )}
          {needPhoto.length > 0 && <p className="breach">▲ {needPhoto.length} need{needPhoto.length === 1 ? 's' : ''} a photo before you continue.</p>}
        </>}
        {step === 'finish' && <>
          {prog.total - prog.done > 0 && <p className="banner warn">▲ {prog.total - prog.done} item{prog.total - prog.done === 1 ? ' is' : 's are'} not checked —
            {' '}they stay out of the report. <button className="link" onClick={onBack}>Back to the rooms</button></p>}
          {!findings.length ? <p className="banner ok">✓ Nothing needs attention.</p> : (
            <ul className="insp-made">
              {count(c => c.outcome === 'repair') > 0 && <li>🔧 {count(c => c.outcome === 'repair')} work order{count(c => c.outcome === 'repair') === 1 ? '' : 's'}, each with “Assign and schedule”</li>}
              {count(c => c.outcome === 'purchase') > 0 && <li>🛒 1 to-do: buy {count(c => c.outcome === 'purchase')} item{count(c => c.outcome === 'purchase') === 1 ? '' : 's'}</li>}
              {count(isClean) > 0 && <li>🧽 {cleanMode === 'next' && data.nextClean
                ? `${count(isClean)} task${count(isClean) === 1 ? '' : 's'} for the next clean (${data.nextClean.date})`
                : `1 new clean on ${cleanDate} with ${count(isClean)} task${count(isClean) === 1 ? '' : 's'}`}</li>}
              {count(c => c.outcome === 'none') > 0 && <li>— {count(c => c.outcome === 'none')} in the report only</li>}
            </ul>
          )}
          <label>Overall result
            <select value={result} onChange={e => setResult(e.target.value)}>
              {RESULTS.map(r => <option key={r} value={r}>{r}{r === suggested ? ' (suggested)' : ''}</option>)}
            </select></label>
          <label>Notes for the report (optional)
            <textarea rows={2} value={notes} maxLength={1500} onChange={e => setNotes(e.target.value)} /></label>
        </>}
        {msg && <p className="banner error">{msg}</p>}
      </div>
      <div className="insp-foot">
        <button className="secondary" onClick={() => (idx === 0 ? onBack() : go(-1))}>{idx === 0 ? '← Rooms' : '← Back'}</button>
        {step !== 'finish'
          ? <button disabled={needPhoto.length > 0} onClick={() => go(1)}>Confirm & continue →</button>
          : <button disabled={busy || !readyToFinish(findings).ok} onClick={() => void finish()}>{busy ? 'Finishing…' : 'Finish inspection'}</button>}
      </div>
    </Sheet>
  );
}

/** One finding in the review: where, its photos, its notes (editable), and a move to another kind. */
function FindingCard({ c, title, onSave, onPhotos }: {
  c: RunCheck; title: string; onSave: (c: RunCheck, patch: Partial<RunCheck>) => Promise<void>;
  onPhotos: (checkId: string, files: FileList | null) => Promise<void>;
}) {
  const [note, setNote] = useState(c.note ?? '');
  useEffect(() => setNote(c.note ?? ''), [c.note]);
  const kind = c.outcome === 'clean_next' || c.outcome === 'clean_new' ? 'clean' : c.outcome ?? 'repair';
  return (
    <div className="insp-finding">
      <div><b>{title}</b> · {c.label}</div>
      <div className="insp-photos">
        {c.photos.map((p, i) => <a key={i} href={p.url} target="_blank" rel="noreferrer">📷 {p.name}</a>)}
        <label className={`chip ${c.photos.length ? '' : 'need'}`}>📷 {c.photos.length ? 'Add photo' : 'Photo (required)'}
          <input type="file" accept="image/*" capture="environment" multiple hidden onChange={e => void onPhotos(c.id, e.target.files)} /></label>
      </div>
      <textarea rows={2} value={note} maxLength={1000} placeholder="Notes — what exactly, where, what to bring…"
                onChange={e => setNote(e.target.value)} onBlur={() => { if (note !== (c.note ?? '')) void onSave(c, { note }); }} />
      <label className="sub-n">Kind
        <select value={kind} onChange={e => void onSave(c, { outcome: (e.target.value === 'clean' ? 'clean_next' : e.target.value) as Outcome })}>
          <option value="repair">🔧 Repair</option><option value="purchase">🛒 Purchase</option>
          <option value="clean">🧽 Cleaning</option><option value="none">No action — report only</option>
        </select></label>
    </div>
  );
}

/** Full screen on a phone, a centred panel on a desk. */
function Sheet({ title, sub, onClose, closeLabel = '✕', children }: {
  title: string; sub?: string; onClose: () => void; closeLabel?: string; children: ReactNode;
}) {
  useEffect(() => {
    const was = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = was; };
  }, []);
  return (
    <div className="insp-backdrop">
      <div className="insp-sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="insp-head">
          <div><h2>{title}</h2>{sub && <div className="sub-n">{sub}</div>}</div>
          <button className="link" onClick={onClose} aria-label="Close">{closeLabel}</button>
        </div>
        {children}
      </div>
    </div>
  );
}
