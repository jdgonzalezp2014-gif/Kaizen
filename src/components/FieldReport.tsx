/**
 * Reports from the field for ONE clean (§134) — the cleaner's Options on a
 * clean, and the link they send to whoever helps them (/report, no account).
 * What is wrong, what supplies are needed, what was bought. The server
 * decides what each becomes: a move in the inventory, and a to-do when
 * someone has to act.
 *
 * Built for people who are not at home on a phone (the owner: "personas
 * mayores"), mistake-proof by design:
 *  - one question per screen, and the clean always fixed by where it was
 *    opened — nobody chooses a unit or a day, so nobody picks the wrong one;
 *  - their own words for what is wrong, needed or bought (§150, owner: one
 *    "Request supplies" instead of "missing" and "need" — the two confused),
 *    with the keyboard's microphone suggested; the camera for a receipt;
 *  - big targets, an icon AND a word on each, the Send button saying what is
 *    still missing instead of just going grey;
 *  - one tap sends everything (all lines or none), a second tap cannot send
 *    twice, and a full-screen ✓ says it arrived.
 */
import { useState } from 'react';
import type { SupplyItem } from '../api.ts';
import type { Tx } from '../lib/crew-i18n.ts';
import { PhotoPicker, shrink } from './PhotoPicker.tsx';
import { ic } from './Icon.tsx';

// What was taken from the storage is not here: it is a required step of the clean (CleanSteps, §134).
export type Kind = 'purchase' | 'problem' | 'request';
// The owner's order: what is wrong first, then the supplies needed, then what was bought.
export const KINDS: Kind[] = ['problem', 'request', 'purchase'];
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
  const [cost, setCost] = useState('');
  const [text, setText] = useState('');
  // §162 (owner, 2026-10-15): the reporter is no longer asked how urgent — the team decides it (Slack / Kaizen).
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const reset = (k: Kind | null) => {
    setKind(k); setDone(null); setCost(''); setText(''); setFiles([]); setErr('');
  };
  const back = () => (start || !kind ? onClose?.() : reset(null));

  if (done) return (
    <div className="fr fr-done" role="status">
      <p className="fr-big">{ic(tx.supDone)}</p>
      {done.task && <p>{ic(tx.supDoneTask)}</p>}
      <button className="fr-btn" onClick={() => reset(null)}>{ic(tx.supAnother)}</button>
      {onClose && <button className="fr-btn secondary" onClick={onClose}>{ic(tx.supClose)}</button>}
    </div>
  );

  if (!kind) return (
    <div className="fr">
      <p className="fr-q">{ic(tx.supMenuQ)}</p>
      {kinds.map(k => <button key={k} className="fr-btn fr-choice" onClick={() => reset(k)}>{ic(tx.supKind[k])}</button>)}
      {onClose && <button className="fr-btn secondary" onClick={onClose}>{ic(tx.supClose)}</button>}
    </div>
  );

  // What is still missing — said on the Send button's line, never only by a greyed-out button.
  // §137: a purchase reaches Costs only with what it cost — so the total is required (the team approves it).
  // §150: what they bought is said in their own words; the team records it in Inventory when approving it.
  const missing = kind === 'purchase' ? (!text.trim() ? tx.supNeedText : !(Number(cost) > 0) ? tx.supNeedCost : '')
    : (!text.trim() ? tx.supNeedText : '');

  async function submit() {
    if (missing || busy) return;
    setBusy(true); setErr('');
    try {
      const r = kind === 'purchase'
          ? await send({ action: 'supply', kind: 'purchase', text: text.trim(), cost }, await Promise.all(files.map(shrink)))
          : await send({ action: kind!, kind: kind!, text: text.trim() }, await Promise.all(files.map(shrink)));
      if (!r.ok) { setErr(r.message ?? tx.notSaved); return; }
      setDone({ task: true });
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }

  // The same photo buttons as everywhere else (PhotoPicker); five at most with one report.
  const photo = (label: string) => <>
    <p className="fr-q">{ic(label)}</p>
    <PhotoPicker tx={tx} files={files} onChange={setFiles} max={5} disabled={busy} />
  </>;

  return (
    <div className="fr">
      <button className="link fr-back" onClick={back}>{ic(start ? tx.supClose : tx.supBack)}</button>
      <p className="fr-kind">{ic(tx.supKind[kind])}</p>

      {kind === 'purchase' && <>
        <p className="fr-q">{ic(tx.supBuyQ)}</p>
        <textarea className="fr-text" rows={3} maxLength={300} value={text} placeholder={tx.supBuyEg} onChange={e => setText(e.target.value)} />
        <p className="fr-tip">{ic(tx.supSpeakTip)}</p>
        {photo(tx.supReceiptBtn)}
        <label className="fr-field">{ic(tx.supCost)}
          <input type="number" inputMode="decimal" min="0" step="0.01" value={cost} onChange={e => setCost(e.target.value)} /></label>
      </>}

      {(kind === 'problem' || kind === 'request') && <>
        <p className="fr-q">{ic(kind === 'problem' ? tx.supProblemQ : tx.supRequestQ)}</p>
        <textarea className="fr-text" rows={4} maxLength={300} value={text} onChange={e => setText(e.target.value)} />
        <p className="fr-tip">{ic(tx.supSpeakTip)}</p>
        {photo(tx.supPhotoBtn)}
      </>}

      <div className="fr-send">
        <button className="fr-btn fr-go" disabled={busy || !!missing} onClick={() => void submit()}>
          {ic(busy ? tx.sending : tx.sendTeam)}</button>
        {missing && <p className="fr-missing">{ic(missing)}</p>}
        {err && <p className="breach" role="alert">{ic(err)}</p>}
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
      <p className="fr-cat">{ic(tx.supCat[c] ?? c)}</p>
      {list.map(i => {
        const n = counts[i.id] ?? 0;
        return (
          <div key={i.id} className={n ? 'fr-line on' : 'fr-line'}>
            <span>{ic(i.name)} <small>({ic(i.measure)})</small></span>
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
