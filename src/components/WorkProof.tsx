/**
 * A handyman's work, audited (owner, 2026-10-28: "you upload photos — see them from the task and from Handymen").
 * `WorkPhotos`: a job's photos before / after, small, each opening in Drive (read through /api/comment-image, as
 * Kaizen's Drive asks every other viewer to sign in). `WorkProof`: in an open work order or a "Validate pay"
 * sub-task, each job it holds — status, estimate and cost, photos, charges with receipts — and the team's
 * decisions on them (approve / deny a charge, ⚑ flag a job), the same ones Operations → Handymen has.
 */
import { useState } from 'react';
import { crewAdminAction, vendorAdminAction, type ProofJob } from '../api.ts';
import { money2 } from '../lib/format.ts';
import { Hint } from './Hint.tsx';
import { Icon, ic } from './Icon.tsx';

const driveId = (url: string) => /\/d\/([\w-]{10,200})/.exec(url)?.[1] ?? null;

export function WorkPhotos({ photos }: { photos: { stage: 'before' | 'after'; name: string; url: string }[] }) {
  if (!photos.length) return null;
  return (
    <div className="work-photos">
      {(['before', 'after'] as const).map(stage => {
        const mine = photos.filter(p => p.stage === stage);
        return mine.length > 0 && (
          <div key={stage} className="work-photos-row">
            <span className="sub-n">{stage === 'before' ? 'Before' : 'After'} · {mine.length}</span>
            <span className="work-photos-strip">
              {mine.map((p, i) => {
                const id = driveId(p.url);
                return <a key={i} className="note-photo" href={p.url} target="_blank" rel="noreferrer" title={`${p.name} — open in Drive`} onClick={e => e.stopPropagation()}>
                  {id ? <img src={`/api/comment-image?id=${id}`} alt={p.name} loading="lazy" /> : ic(p.name)}</a>;
              })}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A handyman's charge: the same decision as Operations → Cleaners' approvals (crew-admin decideField). */
export function ChargeDecide({ id, onDone }: { id: string; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const go = async (status: 'approved' | 'denied') => {
    const r = await crewAdminAction({ action: 'decideField', id, status, note }).catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return; }
    onDone();
  };
  return (
    <div className="crew-decide">
      <input value={note} maxLength={500} placeholder="Note for the handyman (needed to deny)" onChange={e => setNote(e.target.value)} />
      <button className="small" onClick={() => void go('approved')}>✓ Approve</button>
      <button className="small secondary" disabled={!note.trim()} onClick={() => void go('denied')}>■ Deny</button>
      {msg && <span className="breach">{ic(msg)}</span>}
    </div>
  );
}

const STATUS: Record<string, string> = { pending: 'New', confirmed: 'Accepted', in_progress: 'In progress', completed: 'Done', cancelled: 'Cancelled' };
const CHARGE: Record<string, string> = { pending: 'waiting', approved: 'approved', denied: 'denied' };

export function WorkProof({ jobs, payCheck, reload }: { jobs: ProofJob[]; payCheck: boolean; reload: () => void }) {
  if (!jobs.length) return null;
  return (
    <section className="work-proof">
      <div className="todo-files-head">
        <b><Icon n="wrench" /> {payCheck ? 'To validate' : 'Handyman’s work'}</b> <span className="sub-n">{jobs.length === 1 ? jobs[0]!.vendor : `${jobs.length} jobs`}</span>
        <Hint label="The handyman's work">The handyman's photos (before / after) and charges, with their receipts. Their charges fill the job's
          Estimate; approved, they are its Cost — on their invoice and, once the job is done, in Costs. A job done gets a "Validate pay"
          sub-task: check the photos and the price, then ✓ Done on it approves every charge still waiting. A job ⚑ flagged with charges
          waiting, or one with no price, holds it — decide those here one by one, or set the job's Cost. Deciding them all here or in
          Operations → Handymen closes the pay check by itself.</Hint>
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
          {ic(STATUS[j.status] ?? j.status)}
          {j.estimate != null && <> · {ic(`Estimate ${money2(j.estimate)}`)}</>}
          {' · '}{ic(j.cost != null ? `Cost ${money2(j.cost)}` : waiting.length ? `${money2(waiting.reduce((a, c) => a + c.amount, 0))} waiting` : 'no price yet')}
        </span>
      </div>
      {j.resolution && <div className="sub-n">{ic(`Done: ${j.resolution}`)}</div>}
      {j.flag && <div className="breach"><Icon n="alert" /> {ic(`Flagged: ${j.flag}`)}
        <button className="link tiny" onClick={() => void flag({ action: 'unflag', id: j.id })}>Remove flag</button></div>}
      <WorkPhotos photos={j.photos} />
      {!j.photos.length && <div className="sub-n">No photos.</div>}
      {j.charges.map(c => (
        <div key={c.id} className={`crew-extra ${c.status}`}>
          <span title={c.description}>{ic(`${money2(c.amount)} · ${CHARGE[c.status] ?? c.status} — ${c.description.replace(/ — repair #\d+.*$/, '')}`)}</span>
          {c.decisionNote && <span className="sub-n"> · “{ic(c.decisionNote)}”</span>}
          {c.photos.map((p, i) => <a key={i} className="link tiny" href={p.url} target="_blank" rel="noreferrer"> <Icon n="clip" /> {ic(p.name)}</a>)}
          {!c.photos.length && <span className="sub-n"> · no receipt</span>}
          {c.status === 'pending' && <ChargeDecide id={c.id} onDone={reload} />}
        </div>
      ))}
      {!j.flag && (flagging ? (
        <div className="crew-decide">
          <input value={text} maxLength={500} placeholder="What is wrong (the handyman reads it)" onChange={e => setText(e.target.value)} />
          <button className="small" disabled={!text.trim()} onClick={() => void flag({ action: 'flag', id: j.id, note: text, how: 'none' })}>⚑ Flag</button>
          <button className="small secondary" onClick={() => setFlagging(false)}>Cancel</button>
        </div>
      ) : <button className="link tiny" onClick={() => setFlagging(true)}>⚑ Flag…</button>)}
      {msg && <div className="breach">{ic(msg)}</div>}
    </div>
  );
}
