/**
 * A clean, step by step (§134): 1 photos BEFORE, 2 what was taken from the
 * STORAGE (not what was already in the house), 3 photos AFTER, 4 mark it
 * done — or reopen it. The same on the cleaner's page and on the link their
 * helpers open; several people can work one clean, each photo and mark is
 * theirs.
 *
 * Mistake-proofing, for people not at home on a phone:
 *  - the steps are numbered and in the order they are done, each saying
 *    what it has (✓ 3 photos) — nothing to remember;
 *  - "done" cannot happen without step 2 answered — lines, or an explicit
 *    "I took nothing from storage", never a skip — and an AFTER photo; the
 *    screen says which is missing;
 *  - reopening asks "Yes, reopen" on the spot — no tap undoes a clean by accident;
 *  - photos go one at a time, made smaller on the phone first (fast on weak
 *    signal), with "Sending 2 of 5…"; a failure keeps what is left to retry.
 */
import { useState } from 'react';
import type { CleanFieldState as StepState, SupplyItem } from '../api.ts';
import { SupplyCounter } from './FieldReport.tsx';
import type { Tx } from '../lib/crew-i18n.ts';
import { PhotoPicker, shrink } from './PhotoPicker.tsx';

export type Result = { ok: boolean; message?: string; state?: StepState };
export type SendPhoto = (stage: 'before' | 'after', file: File) => Promise<Result>;
export type Mark = (kind: 'done' | 'reopened') => Promise<Result>;
/** What was taken from the storage: lines, or null = nothing. */
export type Taken = (lines: { itemId: string; qty: number }[] | null) => Promise<Result>;

const EMPTY: StepState = { before: 0, after: 0, folderUrl: null, done: null, supplies: null };

export function CleanSteps({ tx, items, state, sendPhoto, taken, mark, onState }: {
  tx: Tx; items: SupplyItem[]; state?: StepState; sendPhoto: SendPhoto; taken: Taken; mark: Mark; onState?: (s: StepState) => void;
}) {
  const [st, setSt] = useState<StepState>(state ?? EMPTY);
  const [stage, setStage] = useState<'before' | 'after' | 'taken' | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const take = (s?: StepState) => { if (s) { setSt(s); onState?.(s); } };

  if (stage === 'taken') return <TakenStep tx={tx} items={items} send={taken}
                                          onDone={s => { take(s); setStage(null); }} onBack={() => setStage(null)} />;
  if (stage) return <PhotoStep tx={tx} stage={stage} send={f => sendPhoto(stage, f)}
                               onDone={s => { take(s); setStage(null); }} onBack={() => setStage(null)} />;
  const needs = !st.supplies ? tx.stepNeedTaken : !st.after ? tx.stepNeedAfter : '';

  const doMark = async (kind: 'done' | 'reopened') => {
    setBusy(true); setMsg('');
    try { const r = await mark(kind); if (!r.ok) setMsg(r.message ?? tx.notSaved); else { take(r.state); setAsking(false); } }
    catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="fr">
      <p className="fr-q">{tx.stepsTitle}</p>
      <button className="fr-btn fr-choice fr-stepbtn" onClick={() => setStage('before')}>
        <span className="fr-num">1</span><span>{tx.stepBefore}<small>{tx.stepCount(st.before)}</small></span></button>
      <button className="fr-btn fr-choice fr-stepbtn" onClick={() => setStage('taken')}>
        <span className="fr-num">2</span><span>{tx.stepTaken}<small>{!st.supplies ? tx.takenNotYet
          : st.supplies.none ? tx.takenNone : tx.takenCount(st.supplies.lines)}</small></span></button>
      <button className="fr-btn fr-choice fr-stepbtn" onClick={() => setStage('after')}>
        <span className="fr-num">3</span><span>{tx.stepAfter}<small>{tx.stepCount(st.after)}</small></span></button>
      {st.done ? <>
        {/* The helper's own name, not "<cleaner>'s team: <name>" — that is for the team's records. */}
        <p className="fr-done-line">{tx.doneBy(st.done.by.replace(/^.*'s team: /, ''), st.done.at.slice(11, 16))}</p>
        {!asking ? <button className="fr-btn secondary" onClick={() => setAsking(true)}>{tx.reopen}</button> : (
          <div className="fr-confirm">
            <p>{tx.reopenAsk}</p>
            <button className="fr-btn" disabled={busy} onClick={() => void doMark('reopened')}>{busy ? tx.sending : tx.reopenYes}</button>
            <button className="fr-btn secondary" onClick={() => setAsking(false)}>{tx.reopenNo}</button>
          </div>
        )}
      </> : <>
        <button className="fr-btn fr-go fr-stepbtn" disabled={busy || !!needs} onClick={() => void doMark('done')}>
          <span className="fr-num">4</span><span>{busy ? tx.sending : tx.stepDone}</span></button>
        {needs && <p className="fr-missing">{needs}</p>}
      </>}
      {st.folderUrl && <a className="fr-tip" href={st.folderUrl} target="_blank" rel="noreferrer">📁 {tx.stepFolder}</a>}
      {msg && <p className="breach" role="alert">{msg}</p>}
    </div>
  );
}

/**
 * Step 2: + on each thing taken OUT OF THE STORAGE for this house — what was
 * already in the house does not count. "I took nothing" is a button of its
 * own, so the answer is always said, never skipped. Adding more later (a
 * second helper, something forgotten) adds to what was sent.
 */
function TakenStep({ tx, items, send, onDone, onBack }: {
  tx: Tx; items: SupplyItem[]; send: Taken; onDone: (s?: StepState) => void; onBack: () => void;
}) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const picked = Object.entries(counts).filter(([, n]) => n > 0);
  const go = async (lines: { itemId: string; qty: number }[] | null) => {
    setBusy(true); setErr('');
    try { const r = await send(lines); if (!r.ok) setErr(r.message ?? tx.notSaved); else onDone(r.state); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <div className="fr">
      <button className="link fr-back" onClick={onBack} disabled={busy}>{tx.supBack}</button>
      <p className="fr-q">{tx.stepTaken}</p>
      <p className="fr-tip">{tx.takenQ}</p>
      <SupplyCounter tx={tx} items={items} counts={counts} onCounts={setCounts} />
      <div className="fr-send">
        <button className="fr-btn fr-go" disabled={busy || !picked.length}
                onClick={() => void go(picked.map(([itemId, qty]) => ({ itemId, qty })))}>
          {busy ? tx.sending : picked.length ? tx.supSendCount(picked.length) : tx.sendTeam}</button>
        {!picked.length && <button className="fr-btn secondary" disabled={busy} onClick={() => void go(null)}>{tx.takenNothing}</button>}
        {err && <p className="breach" role="alert">{err}</p>}
      </div>
    </div>
  );
}

function PhotoStep({ tx, stage, send, onDone, onBack }: {
  tx: Tx; stage: 'before' | 'after'; send: (f: File) => Promise<Result>; onDone: (s?: StepState) => void; onBack: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [sent, setSent] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState<{ n: number; state?: StepState } | null>(null);

  if (saved) return (
    <div className="fr fr-done" role="status">
      <p className="fr-big">{tx.photoSaved(saved.n)}</p>
      <button className="fr-btn" onClick={() => onDone(saved.state)}>{tx.photoContinue}</button>
    </div>
  );

  async function upload() {
    setBusy(true); setErr('');
    let last: StepState | undefined, n = 0;
    const left = [...files];
    try {
      while (left.length) {
        setSent(n + 1);
        const r = await send(await shrink(left[0]!));
        if (!r.ok) { setErr(r.message ?? tx.notSaved); break; }
        last = r.state; n++; left.shift();
      }
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setFiles(left); setBusy(false); setSent(0);
    if (!left.length) setSaved({ n, state: last });
  }

  return (
    <div className="fr">
      <button className="link fr-back" onClick={onBack} disabled={busy}>{tx.supBack}</button>
      <p className="fr-q">{stage === 'before' ? tx.stepBefore : tx.stepAfter}</p>
      <p className="fr-tip">{tx.photoTip}</p>
      <PhotoPicker tx={tx} files={files} onChange={setFiles} disabled={busy} />
      <div className="fr-send">
        <button className="fr-btn fr-go" disabled={busy || !files.length} onClick={() => void upload()}>
          {busy ? tx.photoSending(sent, files.length) : tx.photoSend(files.length)}</button>
        {!files.length && <p className="fr-missing">{tx.photoNeed}</p>}
        {err && <p className="breach" role="alert">{err}</p>}
      </div>
    </div>
  );
}
