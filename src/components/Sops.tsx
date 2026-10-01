/**
 * SOPs (§92): reading one, writing one, and the "SOPs" button every screen
 * carries — the procedure next to the work it describes.
 *
 * An SOP reads top to bottom the way it is used: why (purpose), when
 * (trigger), who owns it, the steps — each with who does it — and what
 * "done" looks like. An article is just text.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { getSops, getSopVersions, sopAction, type SopsResult } from '../api.ts';
import { FEATURES, featureLabel, forFeature, parseBody, reviewDueOn, reviewOverdue, type Inline, type Sop, type SopSection,
         type SopStep, type SopVersion } from '../lib/sops.ts';
import { todayIn } from '../lib/dates.ts';

const TZ = 'America/New_York';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayOf = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
};
const person = (email: string | null | undefined) => email ? email.split('@')[0] : '';

/** The library, loaded once per use; `reload` after a change. */
export function useSops(enabled = true) {
  const [data, setData] = useState<SopsResult | null>(null);
  const [err, setErr] = useState('');
  const reload = () => getSops().then(r => { if (r.ok) { setData(r); setErr(''); } else setErr(r.error ?? 'Could not load the SOPs.'); })
    .catch(e => setErr(String(e)));
  useEffect(() => { if (enabled) void reload(); }, [enabled]);
  return { data, err, reload };
}

/* ── reading ─────────────────────────────────────────────────────────── */

const inlineNodes = (xs: Inline[]) => xs.map((x, i) => x.t === 'bold' ? <b key={i}>{x.v}</b>
  : x.t === 'link' ? <a key={i} href={x.href} target="_blank" rel="noreferrer">{x.v}</a> : <span key={i}>{x.v}</span>);

/** The body, drawn from parsed data — never as HTML. */
export function SopBody({ text }: { text: string | null }) {
  return (
    <div className="sop-body">
      {parseBody(text).map((b, i) => b.t === 'h' ? <h4 key={i}>{inlineNodes(b.v)}</h4>
        : b.t === 'p' ? <p key={i}>{inlineNodes(b.v)}</p>
        : b.t === 'ul' ? <ul key={i}>{b.items.map((it, j) => <li key={j}>{inlineNodes(it)}</li>)}</ul>
        : <ol key={i}>{b.items.map((it, j) => <li key={j}>{inlineNodes(it)}</li>)}</ol>)}
    </div>
  );
}

export function StatusTag({ sop }: { sop: Sop }) {
  const today = todayIn(TZ);
  return (
    <>
      <span className={`sop-tag kind-${sop.kind}`}>{sop.kind === 'sop' ? 'SOP' : 'Article'}</span>
      {sop.status !== 'published' && <span className={`sop-tag st-${sop.status}`}>{sop.status === 'draft' ? 'Draft' : 'Archived'}</span>}
      {reviewOverdue(sop, today) && <span className="sop-tag st-overdue" title={`Review was due ${dayOf(reviewDueOn(sop))}`}>▲ Review due</span>}
    </>
  );
}

export function SopView({ sop, sections, canEdit, onEdit, onChanged, onRemoved }: {
  sop: Sop; sections: SopSection[]; canEdit: boolean;
  onEdit?: () => void; onChanged?: (s: Sop) => void; onRemoved?: (s: Sop) => void;
}) {
  const [versions, setVersions] = useState<SopVersion[] | null>(null);
  const [old, setOld] = useState<SopVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const section = sections.find(s => s.key === sop.sectionKey)?.label ?? sop.sectionKey;
  const due = reviewDueOn(sop);
  const shown = old ? { ...sop, ...old.snapshot } : sop;

  const review = async () => {
    setBusy(true); setMsg('');
    const r = await sopAction({ action: 'review', id: sop.id });
    setBusy(false);
    if (r.ok && r.sop) { onChanged?.(r.sop); setMsg('Marked as reviewed — still right as written.'); } else setMsg(r.error ?? 'Not saved.');
  };
  // A draft that reads right is published from here, without opening the editor.
  const publish = async () => {
    setBusy(true); setMsg('');
    const r = await sopAction({ action: 'save', id: sop.id, sectionKey: sop.sectionKey, kind: sop.kind, title: sop.title, status: 'published',
      purpose: sop.purpose, trigger: sop.trigger, owner: sop.owner, doneWhen: sop.doneWhen, steps: sop.steps, body: sop.body,
      features: sop.features, reviewDays: sop.reviewDays });
    setBusy(false);
    if (r.ok && r.sop) { onChanged?.(r.sop); setMsg('Published — everyone with SOP access now sees it on its screens.'); } else setMsg(r.error ?? 'Not published.');
  };
  const remove = async () => {
    if (!confirm(`Remove “${sop.title}”? It can be restored right after.`)) return;
    const r = await sopAction({ action: 'delete', id: sop.id });
    if (r.ok) onRemoved?.(sop); else setMsg(r.error ?? 'Not removed.');
  };

  return (
    <article className="sop-view">
      <div className="sop-tags"><StatusTag sop={sop} /></div>
      <h2 className="sop-title">{shown.title}</h2>
      <p className="sop-meta">
        {section}
        {shown.owner && <> · Owner <b>{shown.owner}</b></>}
        {' · '}v{old ? old.version : sop.version} · {old ? `${dayOf(old.editedAt)} by ${person(old.editedBy)}` : `updated ${dayOf(sop.updatedAt)}${sop.updatedBy ? ` by ${person(sop.updatedBy)}` : ''}`}
        {!old && due && <> · next review {dayOf(due)}</>}
      </p>
      {old && (
        <p className="banner warn sop-old">You are reading version {old.version}{old.note ? ` — “${old.note}”` : ''}.
          <button className="link" onClick={() => setOld(null)}>Back to the current version</button></p>
      )}

      {shown.purpose && <Part title="Purpose"><p>{shown.purpose}</p></Part>}
      {shown.trigger && <Part title="When to use it"><p>{shown.trigger}</p></Part>}
      {shown.kind === 'sop' && shown.steps.length > 0 && (
        <Part title="Steps">
          <SopSteps key={`${sop.id}-${old?.version ?? 'now'}`} steps={shown.steps} doneWhen={shown.doneWhen} />
        </Part>
      )}
      {shown.doneWhen && <Part title="Done when"><p className="sop-done">✓ {shown.doneWhen}</p></Part>}
      {shown.body && <Part title={shown.kind === 'sop' ? 'Details' : ''}><SopBody text={shown.body} /></Part>}
      {sop.features.length > 0 && (
        <p className="sop-meta sop-on">Shown on {sop.features.map(f => <span key={f} className="sop-feature">{featureLabel(f)}</span>)}</p>
      )}

      {msg && <p className="note">{msg}</p>}
      <div className="sop-actions">
        {canEdit && sop.status === 'draft' && !old && (
          <button className="small" disabled={busy} onClick={() => void publish()} title="Readers see published SOPs only">Publish</button>
        )}
        {canEdit && onEdit && <button className={sop.status === 'draft' ? 'secondary small' : 'small'} onClick={onEdit}>Edit</button>}
        {canEdit && sop.status === 'published' && (
          <button className="secondary small" disabled={busy} onClick={() => void review()}
                  title="Read it through: still right as written? This restarts the review clock.">✓ Mark reviewed</button>
        )}
        <button className="link" onClick={() => versions ? setVersions(null)
          : void getSopVersions(sop.id).then(r => setVersions(r.versions ?? []))}>{versions ? 'Hide history' : 'History'}</button>
        {canEdit && <button className="link danger" onClick={() => void remove()}>Remove</button>}
      </div>
      {versions && (
        <ol className="sop-versions">
          {versions.map(v => (
            <li key={v.version}>
              <button className="link" onClick={() => setOld(v.version === sop.version ? null : v)}>v{v.version}</button>
              <span className="sub-n">{dayOf(v.editedAt)} · {person(v.editedBy)}</span>
              {v.note && <span className="sop-vnote">{v.note}</span>}
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

/**
 * The steps, the way they are used (§96): a list to scan, each step opening
 * to its detail — and "Step by step", one step at a time with a tick for
 * each, for doing it with a phone in one hand. Ticks are the reader's own,
 * for this run; nothing is saved.
 */
function SopSteps({ steps, doneWhen }: { steps: SopStep[]; doneWhen: string | null }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [at, setAt] = useState<number | null>(null);
  const withDetail = steps.map((s, i) => s.detail ? i : -1).filter(i => i >= 0);
  const toggle = (i: number) => setOpen(o => { const n = new Set(o); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const allOpen = withDetail.length > 0 && withDetail.every(i => open.has(i));

  if (at !== null) {
    const done = at >= steps.length;
    const st = steps[Math.min(at, steps.length - 1)]!;
    return (
      <div className="sop-guide" role="region" aria-label="Step by step">
        <div className="sop-guide-head">
          <span className="sop-guide-count">{done ? `All ${steps.length} steps` : `Step ${at + 1} of ${steps.length}`}</span>
          <button className="link" onClick={() => setAt(null)}>Back to the list</button>
        </div>
        <div className="sop-guide-bar" aria-hidden="true"><span style={{ width: `${(Math.min(at, steps.length) / steps.length) * 100}%` }} /></div>
        {done ? (
          <div className="sop-guide-step">
            <p className="sop-guide-text">✓ Every step is done.</p>
            {doneWhen && <p className="sop-done">Check: {doneWhen}</p>}
            <div className="button-row">
              <button className="secondary small" onClick={() => { setTicked(new Set()); setAt(0); }}>Start again</button>
              <button className="small" onClick={() => setAt(null)}>Close</button>
            </div>
          </div>
        ) : (
          <div className="sop-guide-step">
            <p className="sop-guide-text"><span className="sop-num">{at + 1}</span>{st.text}</p>
            {st.who && <p className="sop-meta">Who: <b>{st.who}</b></p>}
            {st.detail && <SopBody text={st.detail} />}
            <div className="button-row">
              <button className="secondary small" disabled={at === 0} onClick={() => setAt(at - 1)}>← Back</button>
              <button className="small" onClick={() => { setTicked(t => new Set(t).add(at)); setAt(at + 1); }}>
                ✓ Done{at < steps.length - 1 ? ' — next' : ''}</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="sop-steps-tools">
        <button className="small" onClick={() => setAt(Math.max(0, steps.findIndex((_, i) => !ticked.has(i))))}>
          ▶ {ticked.size ? 'Continue step by step' : 'Step by step'}</button>
        {withDetail.length > 0 && (
          <button className="link" onClick={() => setOpen(allOpen ? new Set() : new Set(withDetail))}>{allOpen ? 'Collapse all' : 'Expand all'}</button>
        )}
        {ticked.size > 0 && <span className="sub-n">{ticked.size} of {steps.length} done
          <button className="link tiny" onClick={() => setTicked(new Set())}>clear</button></span>}
      </div>
      <ol className="sop-steps">
        {steps.map((st, i) => (
          <li key={i} className={`${ticked.has(i) ? 'is-ticked' : ''} ${open.has(i) ? 'is-open' : ''}`}>
            <div className="sop-step-head">
              <button className="sop-num" onClick={() => setTicked(t => { const n = new Set(t); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                      aria-label={ticked.has(i) ? `Untick step ${i + 1}` : `Tick step ${i + 1}`}>{ticked.has(i) ? '✓' : i + 1}</button>
              {st.detail
                ? <button className="sop-step-line" aria-expanded={open.has(i)} onClick={() => toggle(i)}>
                    <span>{st.text}</span><span className="sop-chev" aria-hidden="true">{open.has(i) ? '▴' : '▾'}</span></button>
                : <span className="sop-step-line static"><span>{st.text}</span></span>}
              {st.who && <span className="sop-who">{st.who}</span>}
            </div>
            {st.detail && open.has(i) && <div className="sop-step-detail"><SopBody text={st.detail} /></div>}
          </li>
        ))}
      </ol>
    </>
  );
}

const Part = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="sop-part">{title && <h3>{title}</h3>}{children}</section>
);

/* ── writing ─────────────────────────────────────────────────────────── */

export function blankSop(sectionKey: string, features: string[] = []): Sop {
  const now = new Date().toISOString();
  return { id: '', sectionKey, kind: 'sop', title: '', status: 'draft', purpose: null, trigger: null, owner: null, doneWhen: null,
    steps: [{ text: '' }], body: null, features, reviewDays: 180, reviewedAt: null, reviewedBy: null, version: 0,
    createdBy: null, createdAt: now, updatedBy: null, updatedAt: now };
}

const REVIEW = [[30, 'every month'], [90, 'every 3 months'], [180, 'every 6 months'], [365, 'every year']] as const;

export function SopEditor({ initial, sections, onSaved, onCancel }: {
  initial: Sop; sections: SopSection[]; onSaved: (s: Sop) => void; onCancel: () => void;
}) {
  const [s, setS] = useState<Sop>(() => ({ ...initial, steps: initial.steps.length ? initial.steps : [{ text: '' }] }));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = <K extends keyof Sop>(k: K, v: Sop[K]) => setS(p => ({ ...p, [k]: v }));
  const step = (i: number, patch: Partial<SopStep>) => set('steps', s.steps.map((x, j) => j === i ? { ...x, ...patch } : x));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= s.steps.length) return;
    const next = [...s.steps]; [next[i], next[j]] = [next[j]!, next[i]!]; set('steps', next);
  };
  const toggleFeature = (k: string) => set('features', s.features.includes(k) ? s.features.filter(f => f !== k) : [...s.features, k]);

  const save = async (status = s.status) => {
    setBusy(true); setErr('');
    const r = await sopAction({ action: 'save', id: s.id || undefined, sectionKey: s.sectionKey, kind: s.kind, title: s.title, status,
      purpose: s.purpose, trigger: s.trigger, owner: s.owner, doneWhen: s.doneWhen, steps: s.steps, body: s.body,
      features: s.features, reviewDays: s.reviewDays, note }).catch(e => ({ ok: false as const, error: String(e) }));
    setBusy(false);
    if (r.ok && 'sop' in r && r.sop) onSaved(r.sop); else setErr(r.error ?? 'Not saved.');
  };

  return (
    <div className="sop-editor">
      <div className="sop-kind" role="group" aria-label="Kind">
        {(['sop', 'article'] as const).map(k => (
          <button key={k} type="button" className={`chip ${s.kind === k ? 'active' : ''}`} onClick={() => set('kind', k)}>
            {k === 'sop' ? 'SOP — a procedure with steps' : 'Article — reference text'}</button>
        ))}
      </div>
      <label>Title
        <input value={s.title} maxLength={160} autoFocus placeholder={s.kind === 'sop' ? 'e.g. Check-in readiness: agreement and ID' : 'e.g. How our buildings handle guest IDs'}
               onChange={e => set('title', e.target.value)} />
      </label>
      <div className="sop-grid">
        <label>Section
          <select value={s.sectionKey} onChange={e => set('sectionKey', e.target.value)}>
            {sections.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        </label>
        <label>Owner <span className="sub-n">— who keeps it right</span>
          <input value={s.owner ?? ''} maxLength={120} placeholder="e.g. Operations manager" onChange={e => set('owner', e.target.value || null)} />
        </label>
        <label>Review
          <select value={s.reviewDays} onChange={e => set('reviewDays', Number(e.target.value))}>
            {REVIEW.map(([d, l]) => <option key={d} value={d}>{l}</option>)}
            {!REVIEW.some(([d]) => d === s.reviewDays) && <option value={s.reviewDays}>every {s.reviewDays} days</option>}
          </select>
        </label>
      </div>
      <label>Purpose <span className="sub-n">— why it exists, in a sentence or two</span>
        <textarea rows={2} value={s.purpose ?? ''} onChange={e => set('purpose', e.target.value || null)} />
      </label>
      {s.kind === 'sop' && (
        <>
          <label>When to use it <span className="sub-n">— the trigger</span>
            <input value={s.trigger ?? ''} placeholder="e.g. Every arrival, the day before and the morning of"
                   onChange={e => set('trigger', e.target.value || null)} />
          </label>
          <div className="sop-steps-edit">
            <span className="sop-label">Steps <span className="sub-n">— start each with a verb; one action per step</span></span>
            {s.steps.map((st, i) => (
              <div key={i} className="sop-step-row">
                <span className="sop-n">{i + 1}</span>
                {/* Grows with the step: a long step cut off in a one-line field is edited blind. */}
                <textarea className="sop-step-text" value={st.text} placeholder="e.g. Open Home → Check-ins"
                          rows={Math.max(1, Math.ceil(st.text.length / 80))}
                          aria-label={`Step ${i + 1}`} onChange={e => step(i, { text: e.target.value.replace(/\n/g, ' ') })} />
                <input className="sop-step-who" value={st.who ?? ''} placeholder="who" aria-label={`Who does step ${i + 1}`}
                       onChange={e => step(i, { who: e.target.value })} />
                <span className="sop-step-tools">
                  {st.detail === undefined && (
                    <button type="button" className="link sop-howbtn" onClick={() => step(i, { detail: '' })}
                            title="Add how to do it — opens under the step for whoever follows it">+ how</button>
                  )}
                  <button type="button" className="link" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                  <button type="button" className="link" disabled={i === s.steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                  <button type="button" className="link" onClick={() => set('steps', s.steps.filter((_, j) => j !== i))} aria-label="Remove step">✕</button>
                </span>
                {/* §96: the step's detail — what opens under it, and what Step by step shows. */}
                {st.detail !== undefined && (
                  <div className="sop-step-how">
                    <textarea rows={Math.max(2, Math.min(8, st.detail.split('\n').length + 1))} value={st.detail} autoFocus={!st.detail}
                              placeholder="How, exactly — where to click, what to check, what to do if it goes wrong (## heading, - bullet, **bold**, links)"
                              aria-label={`How to do step ${i + 1}`} onChange={e => step(i, { detail: e.target.value })} />
                    <button type="button" className="link tiny" onClick={() => step(i, { detail: undefined })}>remove detail</button>
                  </div>
                )}
              </div>
            ))}
            <button type="button" className="link" onClick={() => set('steps', [...s.steps, { text: '' }])}>+ Add step</button>
          </div>
          <label>Done when <span className="sub-n">— how anyone can tell it was done right</span>
            <input value={s.doneWhen ?? ''} placeholder="e.g. Every arrival shows ✓ Signed, and P2 arrivals ✓ ID in Drive"
                   onChange={e => set('doneWhen', e.target.value || null)} />
          </label>
        </>
      )}
      <label>{s.kind === 'sop' ? 'Details, exceptions and escalation' : 'Text'}
        <span className="sub-n"> — ## heading, - bullet, 1. numbered, **bold**, links</span>
        <textarea rows={s.kind === 'sop' ? 5 : 14} value={s.body ?? ''} onChange={e => set('body', e.target.value || null)} />
      </label>
      <fieldset className="sop-features">
        <legend>Show it on these screens <span className="sub-n">— each screen's “SOPs” button lists it</span></legend>
        {FEATURES.map(f => (
          <label key={f.key} className="check"><input type="checkbox" checked={s.features.includes(f.key)} onChange={() => toggleFeature(f.key)} /> {f.label}</label>
        ))}
      </fieldset>
      {s.id && (
        <label>What changed, and why <span className="sub-n">— kept with the version</span>
          <input value={note} maxLength={300} onChange={e => setNote(e.target.value)} placeholder="e.g. Added the P2 ID step" />
        </label>
      )}
      {err && <p className="banner error">{err}</p>}
      <div className="button-row sop-save">
        <button className="ghost" onClick={onCancel}>Cancel</button>
        {s.status === 'published'
          ? <button disabled={busy || !s.title.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
          : <>
              <button className="secondary" disabled={busy || !s.title.trim()} onClick={() => void save('draft')}>Save draft</button>
              <button disabled={busy || !s.title.trim()} onClick={() => void save('published')}
                      title="Readers see published SOPs only">{busy ? 'Saving…' : 'Publish'}</button>
            </>}
        {s.id && s.status !== 'archived' && (
          <button className="link" disabled={busy} onClick={() => void save('archived')}
                  title="Keeps it, with its history, out of the lists">Archive</button>
        )}
        {s.status === 'published' && (
          <button className="link" disabled={busy} onClick={() => void save('draft')}>Unpublish</button>
        )}
      </div>
    </div>
  );
}

/* ── each screen's button ────────────────────────────────────────────── */

/**
 * "📘 SOPs for this screen · 2", floating bottom right: the procedures for
 * the screen someone is on, one tap away, without leaving it. Opens a side panel; the library
 * tab is one more tap.
 */
export function SopButton({ feature, canEdit, onLibrary }: {
  feature: string; canEdit: boolean;
  /** Open the library tab, optionally at one SOP. */
  onLibrary: (sopId?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data, reload } = useSops(true);
  const count = forFeature(data?.sops ?? [], feature).length;
  return (
    <>
      {/* Bottom right, over the screen (§96): within reach wherever the page is scrolled, and
          not a second "SOPs" beside the library tab. */}
      <button className={`sop-fab ${count ? '' : 'none'}`} onClick={() => { setOpen(true); void reload(); }}
              title={`SOPs for ${featureLabel(feature)}`} aria-haspopup="dialog">
        <span aria-hidden="true">📘</span><span className="sop-fab-word"> SOPs for this screen</span>
        {count ? <span className="sop-count">{count}</span> : null}
      </button>
      {open && <SopDrawer feature={feature} canEdit={canEdit && !!data?.canEdit} data={data} reload={reload}
                          onClose={() => setOpen(false)} onLibrary={id => { setOpen(false); onLibrary(id); }} />}
    </>
  );
}

function SopDrawer({ feature, canEdit, data, reload, onClose, onLibrary }: {
  feature: string; canEdit: boolean; data: SopsResult | null; reload: () => Promise<void>;
  onClose: () => void; onLibrary: (sopId?: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Sop | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, []);
  const sections = data?.sections ?? [];
  const list = forFeature(data?.sops ?? [], feature, canEdit);
  const open = list.find(s => s.id === openId) ?? null;
  const defaultSection = FEATURES.find(f => f.key === feature)?.section ?? sections[0]?.key ?? 'guest';

  return (
    <div className="sop-backdrop" onClick={onClose}>
      <aside className="sop-drawer" role="dialog" aria-label={`SOPs for ${featureLabel(feature)}`} onClick={e => e.stopPropagation()}>
        <div className="sop-drawer-head">
          <div><span className="sop-kicker">📘 SOPs</span><h2>{featureLabel(feature)}</h2></div>
          <button className="link sop-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {editing ? (
          <SopEditor initial={editing} sections={sections} onCancel={() => setEditing(null)}
                     onSaved={s => { setEditing(null); setOpenId(s.id); void reload(); }} />
        ) : open ? (
          <>
            <button className="link sop-back" onClick={() => setOpenId(null)}>← All for this screen</button>
            <SopView sop={open} sections={sections} canEdit={canEdit} onEdit={() => setEditing(open)}
                     onChanged={() => void reload()} onRemoved={() => { setOpenId(null); void reload(); }} />
          </>
        ) : !data ? <p className="note loading-dot">Loading</p> : (
          <>
            {list.length ? (
              <ul className="sop-list">
                {list.map(s => <SopRow key={s.id} sop={s} onOpen={() => setOpenId(s.id)} />)}
              </ul>
            ) : (
              <p className="note">No procedure for this screen yet.{canEdit ? ' Write the first one — it will show here for everyone once published.' : ''}</p>
            )}
            <div className="sop-drawer-foot">
              {canEdit && <button className="small" onClick={() => setEditing(blankSop(defaultSection, [feature]))}>+ New SOP for this screen</button>}
              <button className="link" onClick={() => onLibrary()}>Open the SOP library →</button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

export function SopRow({ sop, onOpen, section }: { sop: Sop; onOpen: () => void; section?: string }) {
  return (
    <li className={`sop-row ${sop.status === 'archived' ? 'is-archived' : ''}`}>
      <button className="sop-row-btn" onClick={onOpen}>
        <span className="sop-row-title">{sop.title}</span>
        <span className="sop-row-tags"><StatusTag sop={sop} /></span>
        <span className="sop-row-meta">
          {[section, sop.kind === 'sop' && sop.steps.length ? `${sop.steps.length} step${sop.steps.length === 1 ? '' : 's'}` : '',
            sop.owner ? `Owner ${sop.owner}` : '', `v${sop.version}`].filter(Boolean).join(' · ')}
        </span>
        {sop.purpose && <span className="sop-row-purpose">{sop.purpose}</span>}
      </button>
    </li>
  );
}
