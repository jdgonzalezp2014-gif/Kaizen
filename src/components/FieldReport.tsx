/**
 * Reports from the field (§134) — one form, two doors: the cleaner's own
 * page, and the link a cleaner shares with the people they hire (/report,
 * no account). What they took for a clean, what they bought, what is not
 * there, a problem, or something they need. The server decides what each
 * becomes: a move in the inventory, and a to-do when someone has to act.
 *
 * Phone first and light: one choice at a time, big targets, the place
 * remembered between reports.
 */
import { useState } from 'react';
import type { SupplyItem } from '../api.ts';
import type { Tx } from '../lib/crew-i18n.ts';

type Kind = 'used' | 'purchase' | 'missing' | 'problem' | 'request';
const KINDS: Kind[] = ['used', 'purchase', 'missing', 'problem', 'request'];
const CATS = ['kitchen', 'bathroom', 'cleaning', 'linens', 'other'];
export type Send = (fields: Record<string, string>, files: File[]) => Promise<{ ok: boolean; message?: string }>;
/** A clean of theirs to report against: its key, how it reads, and its unit's id when known. */
export interface CleanPick { key: string; label: string; unitId: string | null }

export function FieldReport({ tx, items, units, cleans = [], send, guard }: {
  tx: Tx; items: SupplyItem[]; units: { id: string; name: string }[];
  cleans?: CleanPick[];
  send: Send;
  /** Something to fix before anything is sent (the link's reporter name), or null. */
  guard?: () => string | null;
}) {
  const [kind, setKind] = useState<Kind>('used');
  // The place: `c:<key>` a clean of theirs, `u:<id>` a unit, `s` the storage.
  const [where, setWhere] = useState(cleans[0] ? `c:${cleans[0].key}` : '');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [many, setMany] = useState<Record<string, string>>({});
  const [cost, setCost] = useState('');
  const [note, setNote] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const supply = kind === 'used' || kind === 'purchase' || kind === 'missing';

  const place = () => {
    if (where.startsWith('c:')) { const c = cleans.find(x => `c:${x.key}` === where); return { unitId: c?.unitId ?? '', cleaningKey: c?.key ?? '' }; }
    if (where.startsWith('u:')) return { unitId: where.slice(2), cleaningKey: '' };
    return { unitId: '', cleaningKey: '' };
  };
  const reset = () => { setItemId(''); setQty(''); setMany({}); setCost(''); setNote(''); setText(''); setFiles([]); };

  async function submit() {
    setMsg(null);
    const g = guard?.();
    if (g) { setMsg({ ok: false, text: g }); return; }
    if (!where && kind !== 'request') { setMsg({ ok: false, text: tx.supNeedPlace }); return; }
    const p = place();
    if (where.startsWith('c:') && !p.unitId) { setMsg({ ok: false, text: tx.supNeedPlace }); return; }
    setBusy(true);
    try {
      if (kind === 'used') {
        const lines = Object.entries(many).filter(([, v]) => Number(v) > 0);
        if (!lines.length) { setMsg({ ok: false, text: tx.supNeedAny }); return; }
        let sent = 0;
        for (const [id, v] of lines) {
          const r = await send({ action: 'supply', kind, itemId: id, qty: v, ...p, note }, []);
          if (!r.ok) { setMsg({ ok: false, text: sent ? tx.supPartial(sent, r.message ?? tx.notSaved) : r.message ?? tx.notSaved });
                       setMany(m => Object.fromEntries(Object.entries(m).filter(([k]) => !lines.slice(0, sent).some(([d]) => d === k)))); return; }
          sent++;
        }
        reset(); setMsg({ ok: true, text: tx.supSentMany(sent) });
      } else if (supply) {
        if (!itemId) { setMsg({ ok: false, text: tx.supNeedItem }); return; }
        if (qty === '' || (kind === 'purchase' && !(Number(qty) > 0))) { setMsg({ ok: false, text: tx.supNeedQty }); return; }
        const r = await send({ action: 'supply', kind, itemId, qty, ...p, note, ...(kind === 'purchase' && cost ? { cost } : {}) }, files);
        if (!r.ok) { setMsg({ ok: false, text: r.message ?? tx.notSaved }); return; }
        reset(); setMsg({ ok: true, text: kind === 'missing' ? tx.supSentTask : tx.supSent });
      } else {
        if (!text.trim()) { setMsg({ ok: false, text: tx.supNeedText }); return; }
        const r = await send({ action: kind, kind, text: text.trim(), unitId: p.unitId }, files);
        if (!r.ok) { setMsg({ ok: false, text: r.message ?? tx.notSaved }); return; }
        reset(); setMsg({ ok: true, text: tx.supSentTask });
      }
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  }

  const byCat = CATS.map(c => [c, items.filter(i => (CATS.includes(i.category) ? i.category : 'other') === c)] as const).filter(([, l]) => l.length);
  return (
    <div className="field-report">
      <div className="todo-kind field-kinds" role="group" aria-label={tx.supTitle}>
        {KINDS.map(k => <button key={k} type="button" className={k === kind ? 'chip active' : 'chip'}
                                onClick={() => { setKind(k); setMsg(null); }}>{tx.supKind[k]}</button>)}
      </div>

      <label>{tx.supWhere}
        <select value={where} onChange={e => setWhere(e.target.value)}>
          <option value="">{tx.supPickClean}</option>
          {!!cleans.length && <optgroup label={tx.supCleansGroup}>
            {cleans.map(c => <option key={c.key} value={`c:${c.key}`}>{c.label}</option>)}</optgroup>}
          <optgroup label={tx.supUnitsGroup}>
            {units.map(u => <option key={u.id} value={`u:${u.id}`}>{u.name}</option>)}
          </optgroup>
          {(kind === 'purchase' || kind === 'missing' || kind === 'request') && <option value="s">{tx.supStorage}</option>}
        </select></label>

      {kind === 'used' && (
        <>
          <p className="note">{tx.supUsedHint}</p>
          {byCat.map(([c, list]) => (
            <fieldset key={c} className="field-items">
              <legend>{tx.supCat[c] ?? c}</legend>
              {list.map(i => (
                <label key={i.id} className="field-item">
                  <span>{i.name} <span className="note">({i.measure})</span></span>
                  <input type="number" inputMode="decimal" min="0" step="any" value={many[i.id] ?? ''} placeholder="0"
                         onChange={e => setMany(m => ({ ...m, [i.id]: e.target.value }))} />
                </label>
              ))}
            </fieldset>
          ))}
        </>
      )}

      {(kind === 'purchase' || kind === 'missing') && (
        <>
          <label>{tx.supItem}
            <select value={itemId} onChange={e => setItemId(e.target.value)}>
              <option value="">—</option>
              {byCat.map(([c, list]) => <optgroup key={c} label={tx.supCat[c] ?? c}>
                {list.map(i => <option key={i.id} value={i.id}>{i.name} ({i.measure})</option>)}</optgroup>)}
            </select></label>
          <label>{kind === 'missing' ? tx.supFound : tx.supQty}
            <input type="number" inputMode="decimal" min="0" step="any" value={qty} placeholder={kind === 'missing' ? '0' : ''}
                   onChange={e => setQty(e.target.value)} /></label>
          {kind === 'purchase' && <label>{tx.supCost}
            <input type="number" inputMode="decimal" min="0" step="0.01" value={cost} onChange={e => setCost(e.target.value)} /></label>}
        </>
      )}

      {(kind === 'problem' || kind === 'request') && (
        <label>{kind === 'problem' ? tx.supProblem : tx.supRequest}
          <textarea rows={3} maxLength={300} value={text} onChange={e => setText(e.target.value)} /></label>
      )}

      {supply && <label>{tx.supNoteField}<input value={note} maxLength={500} onChange={e => setNote(e.target.value)} /></label>}
      {kind !== 'used' && (
        <label>{kind === 'purchase' ? tx.supReceipt : tx.supPhoto}
          <input type="file" accept="image/*,application/pdf" multiple onChange={e => setFiles([...(e.target.files ?? [])].slice(0, 5))} />
        </label>
      )}

      <div className="row">
        <button disabled={busy} onClick={() => void submit()}>{busy ? tx.sending : tx.sendTeam}</button>
        {msg && <span className={msg.ok ? 'field-ok' : 'breach'} role="status">{msg.text}</span>}
      </div>
    </div>
  );
}
