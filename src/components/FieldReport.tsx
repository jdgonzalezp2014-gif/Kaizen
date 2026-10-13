/**
 * Reports from the field for ONE clean (§134) — the cleaner's Options on a
 * clean, and the link they send to whoever helps them (/report, no account).
 * What was taken, bought, is missing, is wrong, or is needed. The server
 * decides what each becomes: a move in the inventory, and a to-do when
 * someone has to act.
 *
 * Built for people who are not at home on a phone (the owner: "personas
 * mayores"), mistake-proof by design:
 *  - one question per screen, and the clean always fixed by where it was
 *    opened — nobody chooses a unit or a day, so nobody picks the wrong one;
 *  - choices to tap, not things to type: + / − instead of a keyboard, a list
 *    of the supplies, the camera for a receipt; typing only for a problem,
 *    with the keyboard's microphone suggested;
 *  - big targets, an icon AND a word on each, the Send button saying what is
 *    still missing instead of just going grey;
 *  - one tap sends everything (all lines or none), a second tap cannot send
 *    twice, and a full-screen ✓ says it arrived.
 */
import { useState } from 'react';
import type { SupplyItem } from '../api.ts';
import type { Tx } from '../lib/crew-i18n.ts';
import { PhotoPicker, shrink } from './PhotoPicker.tsx';

// What was taken from the storage is not here: it is a required step of the clean (CleanSteps, §134).
export type Kind = 'purchase' | 'missing' | 'problem' | 'request';
// The owner's order: what is wrong first, then what is needed, missing, bought.
export const KINDS: Kind[] = ['problem', 'request', 'missing', 'purchase'];
const CATS = ['kitchen', 'bathroom', 'cleaning', 'linens', 'other'];
export type Send = (fields: Record<string, string>, files: File[]) => Promise<{ ok: boolean; message?: string }>;

export function FieldReport({ tx, items, start, send, onClose, kinds = KINDS }: {
  tx: Tx; items: SupplyItem[];
  /** Which reports the menu offers. The helper's page leaves out "I bought something" (§141). */
  kinds?: Kind[];
  /** Open straight on one report (the cleaner chose it from Options); else the menu. */
  start?: Kind;
  /** The clean's fields (unit, key) are the caller's to add. */
  send: Send;
  /** The cleaner's panel closes; the helper's page goes back to the menu. */
  onClose?: () => void;
}) {
  const [kind, setKind] = useState<Kind | null>(start ?? null);
  const [done, setDone] = useState<null | { task: boolean }>(null);
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState(start === 'missing' ? 0 : 1);
  const [cost, setCost] = useState('');
  const [text, setText] = useState('');
  // §134: how urgent a problem or a need is — asked every time, never assumed.
  const [prio, setPrio] = useState<'' | 'urgent' | 'high' | 'low'>('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const reset = (k: Kind | null) => {
    setKind(k); setDone(null); setItemId(''); setQty(k === 'missing' ? 0 : 1); setCost(''); setText(''); setPrio(''); setFiles([]); setErr('');
  };
  const back = () => (start || !kind ? onClose?.() : reset(null));
  const byCat = CATS.map(c => [c, items.filter(i => (CATS.includes(i.category) ? i.category : 'other') === c)] as const).filter(([, l]) => l.length);

  if (done) return (
    <div className="fr fr-done" role="status">
      <p className="fr-big">{tx.supDone}</p>
      {done.task && <p>{tx.supDoneTask}</p>}
      <button className="fr-btn" onClick={() => reset(null)}>{tx.supAnother}</button>
      {onClose && <button className="fr-btn secondary" onClick={onClose}>{tx.supClose}</button>}
    </div>
  );

  if (!kind) return (
    <div className="fr">
      <p className="fr-q">{tx.supMenuQ}</p>
      {kinds.map(k => <button key={k} className="fr-btn fr-choice" onClick={() => reset(k)}>{tx.supKind[k]}</button>)}
      {onClose && <button className="fr-btn secondary" onClick={onClose}>{tx.supClose}</button>}
    </div>
  );

  // What is still missing — said on the Send button's line, never only by a greyed-out button.
  // §137: a purchase reaches Costs only with what it cost — so the total is required (the team approves it).
  // §150: what they bought is said in their own words; the team records it in Inventory when approving it.
  const missing = kind === 'purchase' ? (!text.trim() ? tx.supNeedText : !(Number(cost) > 0) ? tx.supNeedCost : '')
    : kind === 'missing' ? (!itemId ? tx.supNeedItem : '')
    : (!text.trim() ? tx.supNeedText : !prio ? tx.urgNeed : '');

  async function submit() {
    if (missing || busy) return;
    setBusy(true); setErr('');
    try {
      const r = kind === 'purchase'
          ? await send({ action: 'supply', kind: 'purchase', text: text.trim(), cost }, await Promise.all(files.map(shrink)))
          : kind === 'missing'
          ? await send({ action: 'supply', kind: 'missing', itemId, qty: String(qty) }, await Promise.all(files.map(shrink)))
          : await send({ action: kind!, kind: kind!, text: text.trim(), priority: prio }, await Promise.all(files.map(shrink)));
      if (!r.ok) { setErr(r.message ?? tx.notSaved); return; }
      setDone({ task: true });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  // The same photo buttons as everywhere else (PhotoPicker); five at most with one report.
  const photo = (label: string) => <>
    <p className="fr-q">{label}</p>
    <PhotoPicker tx={tx} files={files} onChange={setFiles} max={5} disabled={busy} />
  </>;
  const itemPick = (
    <select className="fr-select" value={itemId} onChange={e => setItemId(e.target.value)}>
      <option value="">{tx.supPickItem}</option>
      {byCat.map(([c, list]) => <optgroup key={c} label={tx.supCat[c] ?? c}>
        {list.map(i => <option key={i.id} value={i.id}>{i.name} ({i.measure})</option>)}</optgroup>)}
    </select>
  );

  return (
    <div className="fr">
      <button className="link fr-back" onClick={back}>{start ? tx.supClose : tx.supBack}</button>
      <p className="fr-kind">{tx.supKind[kind]}</p>

      {kind === 'missing' && <>
        <p className="fr-q">{tx.supMissQ}</p>
        {itemPick}
        <p className="fr-q">{tx.supFound}</p>
        <Stepper n={qty} min={0} onStep={d => setQty(q => Math.max(0, Math.min(999, q + d)))} />
      </>}

      {kind === 'purchase' && <>
        <p className="fr-q">{tx.supBuyQ}</p>
        <textarea className="fr-text" rows={3} maxLength={300} value={text} placeholder={tx.supBuyEg} onChange={e => setText(e.target.value)} />
        <p className="fr-tip">{tx.supSpeakTip}</p>
        {photo(tx.supReceiptBtn)}
        <label className="fr-field">{tx.supCost}
          <input type="number" inputMode="decimal" min="0" step="0.01" value={cost} onChange={e => setCost(e.target.value)} /></label>
      </>}

      {(kind === 'problem' || kind === 'request') && <>
        <p className="fr-q">{kind === 'problem' ? tx.supProblemQ : tx.supRequestQ}</p>
        <textarea className="fr-text" rows={4} maxLength={300} value={text} onChange={e => setText(e.target.value)} />
        <p className="fr-tip">{tx.supSpeakTip}</p>
        {photo(tx.supPhotoBtn)}
        <p className="fr-q">{tx.urgQ}</p>
        <div className="fr-urg" role="radiogroup" aria-label={tx.urgQ}>
          {(['urgent', 'high', 'low'] as const).map(p => (
            <button key={p} type="button" role="radio" aria-checked={prio === p}
                    className={`fr-btn fr-choice urg-${p}${prio === p ? ' on' : ''}`} onClick={() => setPrio(p)}>
              {prio === p ? '◉' : '○'} {tx.urg[p]}</button>
          ))}
        </div>
      </>}

      <div className="fr-send">
        <button className="fr-btn fr-go" disabled={busy || !!missing} onClick={() => void submit()}>
          {busy ? tx.sending : tx.sendTeam}</button>
        {missing && <p className="fr-missing">{missing}</p>}
        {err && <p className="breach" role="alert">{err}</p>}
      </div>
    </div>
  );
}

/** The supplies, by category, each with − n + — what was taken from the storage for a clean. */
export function SupplyCounter({ tx, items, counts, onCounts }: {
  tx: Tx; items: SupplyItem[]; counts: Record<string, number>; onCounts: (f: (m: Record<string, number>) => Record<string, number>) => void;
}) {
  const byCat = CATS.map(c => [c, items.filter(i => (CATS.includes(i.category) ? i.category : 'other') === c)] as const).filter(([, l]) => l.length);
  return <>{byCat.map(([c, list]) => (
    <div key={c} className="fr-group">
      <p className="fr-cat">{tx.supCat[c] ?? c}</p>
      {list.map(i => {
        const n = counts[i.id] ?? 0;
        return (
          <div key={i.id} className={n ? 'fr-line on' : 'fr-line'}>
            <span>{i.name} <small>({i.measure})</small></span>
            <Stepper n={n} onStep={d => onCounts(m => ({ ...m, [i.id]: Math.max(0, Math.min(999, (m[i.id] ?? 0) + d)) }))} />
          </div>
        );
      })}
    </div>
  ))}</>;
}

/** − n + : no keyboard, no typo, never below the minimum; quick taps all count (each one a step). */
export function Stepper({ n, min = 0, onStep }: { n: number; min?: number; onStep: (delta: number) => void }) {
  return (
    <span className="fr-step">
      <button type="button" aria-label="−" disabled={n <= min} onClick={() => onStep(-1)}>−</button>
      <b aria-live="polite">{n}</b>
      <button type="button" aria-label="+" onClick={() => onStep(1)}>+</button>
    </span>
  );
}
