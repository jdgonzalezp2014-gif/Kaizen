/**
 * The help assistant's button and panel (owner, 2026-11-17): above the "?" of each screen's SOPs. One box for
 * "how do we…?" (answered from the published SOPs by a light model) and "wifi of Amber Valley" (answered from the
 * Repository by rules — no AI). A secret is a Reveal button: the Repository's own reveal, its permission and its log.
 * The talk lives only in this panel; nothing is stored.
 */
import { useEffect, useRef, useState } from 'react';
import { askAssistant, revealRepoSecret, type AssistantAnswer } from '../api.ts';
import { Hint } from './Hint.tsx';
import { Icon } from './Icon.tsx';

type Turn = { q: string; a: AssistantAnswer | null; err?: string };

function Secret({ table, id, column, label, can }: { table: string; id: string; column: string; label: string; can: boolean }) {
  const [v, setV] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  // A revealed value leaves the screen by itself: a panel left open is not a password left on show.
  useEffect(() => { if (v == null) return; const t = setTimeout(() => setV(null), 30_000); return () => clearTimeout(t); }, [v]);
  const reveal = async () => {
    setMsg('');
    const r = await revealRepoSecret(table, id, column).catch(e => ({ ok: false as const, message: String(e) }));
    if (r.ok) setV(r.value); else setMsg(r.message ?? 'Could not reveal.');
  };
  return <div className="as-field"><span>{label}</span>
    {v != null
      ? <b className="as-secret">{v} <button type="button" className="link tiny" onClick={() => void navigator.clipboard?.writeText(v)}>Copy</button></b>
      : can ? <button type="button" className="ix-ghost" onClick={() => void reveal()}><Icon n="eye" /> Reveal</button> : <b className="note">Hidden — your role cannot reveal</b>}
    {msg && <em className="note warn">{msg}</em>}</div>;
}

export function Assistant({ lifted, onSop, onRecord }: {
  /** The screen has its own "?" below: the button sits above it. */
  lifted: boolean; onSop: (id: string) => void; onRecord?: (table: string, id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [turns.length, busy]);
  const ask = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setQ(''); setBusy(true);
    setTurns(t => [...t, { q: question, a: null }]);
    const r = await askAssistant(question).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    setTurns(t => t.map((x, i) => i === t.length - 1 ? (r.ok ? { ...x, a: r } : { ...x, err: r.message ?? 'No answer.' }) : x));
  };
  if (!open) return <button type="button" className={`as-fab ${lifted ? 'lifted' : ''}`} title="Ask Kaizen" aria-label="Ask Kaizen" onClick={() => setOpen(true)}><Icon n="message" /></button>;
  return (
    <section className="as-panel" aria-label="Ask Kaizen">
      <header><b><Icon n="sparkles" /> Ask Kaizen</b>
        <Hint label="What it can answer">Two things. <b>How do we…?</b> — answered from the published SOPs by a light AI model, with the SOPs it used.
          <b> A listing, tool or account by name</b> ("wifi Amber Valley", "password Airbnb", "check-in Preston") — read straight from the Repository, no AI; a password or code
          is a Reveal button that needs your role's permission and is logged, like in the Repository. A question no field answers by name
          ("does Napa Valley have a pool table?") is read from that record by a light AI model, in a sentence above the card. Nothing typed here is saved.</Hint>
        <button type="button" className="ix-icon-btn" aria-label="Close" onClick={() => setOpen(false)}>✕</button></header>
      <div className="as-talk">
        {!turns.length && <p className="note">Try: “wifi Amber Valley” · “password Airbnb” · “how do I record a receipt?”</p>}
        {turns.map((t, i) => <div key={i} className="as-turn">
          <p className="as-q">{t.q}</p>
          {t.err && <p className="ix-state warn"><Icon n="alert" /> {t.err}</p>}
          {t.a?.ok && t.a.kind === 'records' && t.a.answer && <div className="as-card">
            <p>{t.a.found === false && <Icon n="alert" />} {t.a.answer}</p>
            {t.a.by && <p className="note tiny">{t.a.by.split(' (')[0]} · from the record below</p>}
          </div>}
          {t.a?.ok && t.a.kind === 'records' && t.a.hits.map(h => <div key={`${h.table}${h.id}`} className="as-card">
            <h4>{h.name} <span>{h.tableTitle}</span>{onRecord && <button type="button" className="link tiny" onClick={() => onRecord(h.table, h.id)}>Open</button>}</h4>
            {h.fields.map(f => <div key={f.label} className="as-field"><span>{f.label}</span><b>{f.value}</b></div>)}
            {h.secrets.map(s => <Secret key={s.column} table={h.table} id={h.id} column={s.column} label={s.label} can={t.a!.ok && t.a!.kind === 'records' && t.a!.canReveal} />)}
            {!h.fields.length && !h.secrets.length && <p className="note">Nothing filled in on this record.</p>}
          </div>)}
          {t.a?.ok && t.a.kind !== 'records' && <div className="as-card">
            <p>{t.a.answer}</p>
            {t.a.missing && <p className="note">Not in the SOPs: {t.a.missing}</p>}
            {t.a.sops?.map(s => <button key={s.id} type="button" className="as-sop" onClick={() => onSop(s.id)}><Icon n="book" /> {s.title}</button>)}
            {t.a.by && <p className="note tiny">{t.a.by.split(' (')[0]}</p>}
          </div>}
        </div>)}
        {busy && <p className="note">Looking…</p>}
        <div ref={end} />
      </div>
      <form className="as-ask" onSubmit={e => { e.preventDefault(); void ask(); }}>
        <input value={q} autoFocus maxLength={600} placeholder="Ask about a process, a listing or an account" aria-label="Your question" onChange={e => setQ(e.target.value)} />
        <button type="submit" className="ix-send" disabled={busy || !q.trim()}>Ask</button>
      </form>
    </section>
  );
}
