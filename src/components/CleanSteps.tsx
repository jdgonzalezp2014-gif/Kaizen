/**
 * A clean, step by step (§134): 1 photos BEFORE, 2 photos AFTER, 3 mark it
 * done — or reopen it. The same on the cleaner's page and on the link their
 * helpers open; several people can work one clean, each photo and mark is
 * theirs.
 *
 * Mistake-proofing, for people not at home on a phone:
 *  - the steps are numbered and in the order they are done, each saying
 *    what it has (✓ 3 photos) — nothing to remember;
 *  - "done" cannot happen without an AFTER photo, and says so;
 *  - reopening asks "Yes, reopen" on the spot — no tap undoes a clean by accident;
 *  - photos go one at a time, made smaller on the phone first (fast on weak
 *    signal), with "Sending 2 of 5…"; a failure keeps what is left to retry.
 */
import { useState } from 'react';
import type { CleanFieldState as StepState } from '../api.ts';
import type { Tx } from '../lib/crew-i18n.ts';

export type Result = { ok: boolean; message?: string; state?: StepState };
export type SendPhoto = (stage: 'before' | 'after', file: File) => Promise<Result>;
export type Mark = (kind: 'done' | 'reopened') => Promise<Result>;

const EMPTY: StepState = { before: 0, after: 0, folderUrl: null, done: null };

export function CleanSteps({ tx, state, sendPhoto, mark, onState }: {
  tx: Tx; state?: StepState; sendPhoto: SendPhoto; mark: Mark; onState?: (s: StepState) => void;
}) {
  const [st, setSt] = useState<StepState>(state ?? EMPTY);
  const [stage, setStage] = useState<'before' | 'after' | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const take = (s?: StepState) => { if (s) { setSt(s); onState?.(s); } };

  if (stage) return <PhotoStep tx={tx} stage={stage} send={f => sendPhoto(stage, f)}
                               onDone={s => { take(s); setStage(null); }} onBack={() => setStage(null)} />;

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
      <button className="fr-btn fr-choice fr-stepbtn" onClick={() => setStage('after')}>
        <span className="fr-num">2</span><span>{tx.stepAfter}<small>{tx.stepCount(st.after)}</small></span></button>
      {st.done ? <>
        <p className="fr-done-line">{tx.doneBy(st.done.by, st.done.at.slice(11, 16))}</p>
        {!asking ? <button className="fr-btn secondary" onClick={() => setAsking(true)}>{tx.reopen}</button> : (
          <div className="fr-confirm">
            <p>{tx.reopenAsk}</p>
            <button className="fr-btn" disabled={busy} onClick={() => void doMark('reopened')}>{busy ? tx.sending : tx.reopenYes}</button>
            <button className="fr-btn secondary" onClick={() => setAsking(false)}>{tx.reopenNo}</button>
          </div>
        )}
      </> : <>
        <button className="fr-btn fr-go fr-stepbtn" disabled={busy || !st.after} onClick={() => void doMark('done')}>
          <span className="fr-num">3</span><span>{busy ? tx.sending : tx.stepDone}</span></button>
        {!st.after && <p className="fr-missing">{tx.stepNeedAfter}</p>}
      </>}
      {st.folderUrl && <a className="fr-tip" href={st.folderUrl} target="_blank" rel="noreferrer">📁 {tx.stepFolder}</a>}
      {msg && <p className="breach" role="alert">{msg}</p>}
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
      <label className="fr-btn fr-pick">{tx.photoPick}
        <input type="file" accept="image/*" multiple hidden disabled={busy}
               onChange={e => { setFiles(f => [...f, ...(e.target.files ?? [])].slice(0, 20)); e.target.value = ''; }} /></label>
      {!!files.length && (
        <div className="fr-thumbs">
          {files.map((f, i) => <img key={i} src={URL.createObjectURL(f)} alt="" />)}
        </div>
      )}
      <div className="fr-send">
        <button className="fr-btn fr-go" disabled={busy || !files.length} onClick={() => void upload()}>
          {busy ? tx.photoSending(sent, files.length) : tx.photoSend(files.length)}</button>
        {!files.length && <p className="fr-missing">{tx.photoNeed}</p>}
        {err && <p className="breach" role="alert">{err}</p>}
      </div>
    </div>
  );
}

/** A phone photo made smaller (longest side 2000 px, JPEG) before it travels; the original when the browser cannot. */
async function shrink(f: File): Promise<File> {
  try {
    const img = await createImageBitmap(f);
    const k = Math.min(1, 2000 / Math.max(img.width, img.height));
    if (k === 1 && f.size < 1_500_000) return f;
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>(r => c.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], f.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : f;
  } catch { return f; }
}
