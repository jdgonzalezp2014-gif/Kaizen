/**
 * A handyman's work, audited (owner, 2026-10-28: "you upload photos — see them from the task and from Handymen").
 * `WorkPhotos`: a job's photos before / after, small, each opening in Drive (read through /api/comment-image, as
 * Kaizen's Drive asks every other viewer to sign in). `WorkProof`: in an open work order, each job it holds — status, estimate and cost, photos, charges with receipts — and the team's
 * decisions on them (approve / deny a charge, ⚑ flag a job), the same ones Operations → Handymen has.
 */
import { useState } from 'react';
import { crewAdminAction, vendorAdminAction, type ProofJob } from '../api.ts';
import { money2 } from '../lib/format.ts';
import { Hint } from './Hint.tsx';
import { Icon, ic } from './Icon.tsx';

const driveId = (url: string) => /\/d\/([\w-]{10,200})/.exec(url)?.[1] ?? null;

/**
 * Photos and receipts, the same strip everywhere they are audited (owner, 2026-10-28: Costs, the repair, Approvals). `serve`:
 * Kaizen can read the file (a handyman's photo, a field receipt, a purchase's) — drawn small; else a chip that opens Drive.
 */
export function PhotoStrip({ photos, serve = true }: { photos: { name: string; url: string }[]; serve?: boolean }) {
  if (!photos.length) return null;
  return (
    <span className="work-photos-strip">
      {photos.map((p, i) => {
        const id = serve ? driveId(p.url) : null;
        return <a key={i} className={id ? 'note-photo' : 'desc-link'} href={p.url} target="_blank" rel="noreferrer" title={`${p.name} — open in Drive`}
                  onClick={e => e.stopPropagation()}>
          {id ? <img src={`/api/comment-image?id=${id}`} alt={p.name} loading="lazy" /> : <><Icon n="clip" /> {ic(p.name)}</>}</a>;
      })}
    </span>
  );
}

export function WorkPhotos({ photos }: { photos: { stage: 'before' | 'after'; name: string; url: string }[] }) {
  if (!photos.length) return null;
  return (
    <div className="work-photos">
      {(['before', 'after'] as const).map(stage => {
        const mine = photos.filter(p => p.stage === stage);
        return mine.length > 0 && (
          <div key={stage} className="work-photos-row">
            <span className="sub-n">{stage === 'before' ? 'Before' : 'After'} · {mine.length}</span>
            <PhotoStrip photos={mine} />
          </div>
        );
      })}
    </div>
  );
}

/** A handyman's charge: the same decision as Operations → Approvals (crew-admin decideField). */
// Owner, 2026-10-28: minimal — two small buttons; denying asks for the note the handyman reads, only then.
export function ChargeDecide({ id, onDone }: { id: string; onDone: () => void }) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const go = async (status: 'approved' | 'denied') => {
    setBusy(true);
    const r = await crewAdminAction({ action: 'decideField', id, status, note }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
    onDone();
  };
  return (
    <span className="charge-decide">
      {!denying ? <>
        <button className="mini" disabled={busy} title="Approve — it becomes the job's pay" onClick={() => void go('approved')}><Icon n="done" /> Approve</button>
        <button className="mini secondary" disabled={busy} title="Deny — you write why; the handyman reads it" onClick={() => setDenying(true)}>Deny…</button>
      </> : <>
        <input value={note} maxLength={500} autoFocus placeholder="Why — the handyman reads it" onChange={e => setNote(e.target.value)} />
        <button className="mini secondary" disabled={busy || !note.trim()} onClick={() => void go('denied')}>Deny</button>
        <button className="link tiny" onClick={() => { setDenying(false); setNote(''); }}>Cancel</button>
      </>}
      {msg && <span className="breach">{ic(msg)}</span>}
    </span>
  );
}

const STATUS: Record<string, string> = { pending: 'New', confirmed: 'Accepted', in_progress: 'In progress', completed: 'Done', cancelled: 'Cancelled' };
const CHARGE: Record<string, string> = { pending: 'waiting', approved: 'approved', denied: 'denied' };

export function WorkProof({ jobs, reload }: { jobs: ProofJob[]; reload: () => void }) {
  if (!jobs.length) return null;
  return (
    <section className="work-proof">
      <div className="todo-files-head">
        <b><Icon n="wrench" /> Handyman’s work</b> <span className="sub-n">{jobs.length === 1 ? jobs[0]!.vendor : `${jobs.length} jobs`}</span>
        <Hint label="The handyman's work">Their photos (before / after) and charges, with receipts. A charge fills the job's
          Estimate; approved — here, or in Operations → Approvals — it is the job's Cost, on their invoice and, once done, in
          Costs. Closing the repair with charges waiting asks to approve them all. ⚑ Flag: its charges wait for a decision one by one;
          the handyman reads the note.</Hint>
      </div>
      {jobs.map(j => <ProofRow key={j.id} j={j} many={jobs.length > 1} reload={reload} />)}
    </section>
  );
}

function ProofRow({ j, many, reload }: { j: ProofJob; many: boolean; reload: () => void }) {
  const [flagging, setFlagging] = useState(false);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const flag = async (body: Record<string, unknown>) => {
    const r = await vendorAdminAction(body).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
    setFlagging(false); setText(''); setMsg(''); reload();
  };
  const waiting = j.charges.filter(c => c.status === 'pending');
  return (
    <div className="proof-job">
      <div className="proof-head">
        {many && <b>#{j.id} {ic(j.title)}</b>}
        <span className="sub-n">
          {many && <>{ic(STATUS[j.status] ?? j.status)} · </>}
          {j.estimate != null && <>{ic(`Estimate ${money2(j.estimate)}`)} · </>}
          {ic(j.cost != null ? `Cost ${money2(j.cost)}` : waiting.length ? `${money2(waiting.reduce((a, c) => a + c.amount, 0))} waiting` : 'no price yet')}
        </span>
      </div>
      {j.resolution && <div className="sub-n" title="What the handyman said when done">“{ic(j.resolution)}”</div>}
      {j.flag && <div className="breach"><Icon n="alert" /> {ic(`Flagged: ${j.flag}`)}
        {' '}<button className="link tiny" title="Remove the flag" onClick={() => void flag({ action: 'unflag', id: j.id })}>✕</button></div>}
      <WorkPhotos photos={j.photos} />
      {!j.photos.length && <div className="sub-n">No photos yet.</div>}
      {j.charges.map(c => (
        <div key={c.id} className={`crew-extra ${c.status}`}>
          <span title={[c.description, c.decisionNote].filter(Boolean).join(' — ')}>{ic(`${money2(c.amount)} · ${CHARGE[c.status] ?? c.status} — ${c.description.replace(/ — repair #\d+.*$/, '')}`)}</span>
          {c.status === 'denied' && c.decisionNote && <span className="sub-n"> · “{ic(c.decisionNote)}”</span>}
          {!c.photos.length && <span className="sub-n" title="Sent without a receipt"> · no receipt</span>}
          <PhotoStrip photos={c.photos} />
          {c.status === 'pending' && <ChargeDecide id={c.id} onDone={reload} />}
        </div>
      ))}
      {!j.flag && (flagging ? (
        <div className="crew-decide">
          <input value={text} maxLength={500} placeholder="What is wrong (the handyman reads it)" onChange={e => setText(e.target.value)} />
          <button className="mini" disabled={!text.trim()} onClick={() => void flag({ action: 'flag', id: j.id, note: text, how: 'none' })}>Flag</button>
          <button className="link tiny" onClick={() => setFlagging(false)}>Cancel</button>
        </div>
      ) : <button className="link tiny proof-flag" title="Flag this job — its charges wait for a decision one by one; the handyman reads the note" onClick={() => setFlagging(true)}><Icon n="alert" /> Flag</button>)}
      {msg && <div className="breach">{ic(msg)}</div>}
    </div>
  );
}
