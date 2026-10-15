/**
 * Reports (owner, 2026-10-15): "something is wrong" or "I need something" about Kaizen
 * itself — opened from the rail's foot on a computer and from the menu on a phone; the
 * same form as /kaizen bug and @Kaizen bug in Slack. Each member follows their own;
 * who holds Settings sees them all and moves them along. New ones go to the reports
 * channel in Slack, whose thread is the conversation.
 */
import { useEffect, useState } from 'react';
import { Modal } from './Modal.tsx';
import { Hint } from './Hint.tsx';
import { Icon } from './Icon.tsx';
import { getReports, postReport } from '../api.ts';
import { KIND_LABEL, REPORT_STATUS, REPORT_STATUSES, URGENCY_LABEL, reportTitle,
         type ReportKind, type ReportRow, type ReportStatus, type ReportUrgency } from '../lib/reports.ts';

/** A phone photo is several MB; a screenshot of a bug needs far less. */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = url; });
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } finally { URL.revokeObjectURL(url); }
}

const device = () => `${innerWidth <= 720 ? 'Phone' : 'Computer'} · ${innerWidth}×${innerHeight}`;
const when = (s: string) => new Date(s).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const STATUS_ICON: Record<ReportStatus, string> = { new: 'alert', seen: 'eye', doing: 'wrench', done: 'done', wontfix: 'ban' };

export function ReportsDialog({ where, onClose, initial = 'new' }: { where: string; onClose: () => void; initial?: 'new' | 'list' }) {
  const [view, setView] = useState<'new' | 'list'>(initial);
  const [sent, setSent] = useState<string | null>(null);
  return (
    <Modal title="Report / request" onClose={onClose} wide={view === 'list'}>
      <div className="report-switch">
        <button className={view === 'new' ? 'chip active' : 'chip'} onClick={() => setView('new')}>New</button>
        <button className={view === 'list' ? 'chip active' : 'chip'} onClick={() => setView('list')}>Sent</button>
        <Hint>
          A <b>bug</b> is something in Kaizen that is wrong; a <b>request</b> is something new or a change. Kaizen records which screen you
          were on. Each report goes to the reports channel in Slack; you see its status and replies under <b>Sent</b>, and get a Slack
          message when it is done. In Slack: <b>/kaizen bug</b> or <b>@Kaizen bug</b> <i>what happened</i> opens the same form.
        </Hint>
      </div>
      {view === 'new'
        ? <ReportForm where={where} sent={sent} onSent={id => setSent(id)} onAnother={() => setSent(null)} />
        : <ReportList />}
    </Modal>
  );
}

function ReportForm({ where, sent, onSent, onAnother }: { where: string; sent: string | null; onSent: (id: string) => void; onAnother: () => void }) {
  const [kind, setKind] = useState<ReportKind>('bug');
  const [body, setBody] = useState('');
  const [urgency, setUrgency] = useState<ReportUrgency>('normal');
  const [photo, setPhoto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (sent) return (
    <>
      <p className="banner ok"><Icon n="done" /> Sent as #{sent}. You will see its status under Sent.</p>
      <button className="secondary" onClick={() => { setBody(''); setPhoto(null); onAnother(); }}>Send another</button>
    </>
  );
  const send = async () => {
    setBusy(true); setErr('');
    try {
      const r = await postReport({ action: 'create', kind, body, urgency, whereFrom: where, device: device(), photo });
      if (r.ok && r.id) onSent(r.id); else setErr(r.message ?? 'Not sent.');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  };
  return (
    <form onSubmit={e => { e.preventDefault(); void send(); }}>
      <div className="report-kinds" role="radiogroup" aria-label="What is it?">
        {(['bug', 'request'] as ReportKind[]).map(k => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'chip active' : 'chip'} onClick={() => setKind(k)}>
            <Icon n={k === 'bug' ? 'warning' : 'sparkles'} /> {k === 'bug' ? 'Something is wrong' : 'I need something'}
          </button>
        ))}
      </div>
      <label>{kind === 'bug' ? 'What happened? What did you expect?' : 'What do you need, and why?'}
        <textarea className="rb-input" rows={5} maxLength={4000} value={body} onChange={e => setBody(e.target.value)} autoFocus required />
      </label>
      <label>How urgent?
        <select value={urgency} onChange={e => setUrgency(e.target.value as ReportUrgency)}>
          {(Object.keys(URGENCY_LABEL) as ReportUrgency[]).map(u => <option key={u} value={u}>{URGENCY_LABEL[u]}</option>)}
        </select>
      </label>
      <label>Screenshot or photo (optional)
        <input type="file" accept="image/*" onChange={async e => {
          const f = e.target.files?.[0];
          setPhoto(f ? await shrink(f).catch(() => { setErr('Could not read that image.'); return null; }) : null);
        }} />
      </label>
      {photo && <img className="report-photo" src={photo} alt="The photo to send" />}
      <p className="note">From: {where}</p>
      {err && <p className="banner error">{err}</p>}
      <button type="submit" disabled={busy || !body.trim()}>{busy ? 'Sending…' : `Send ${KIND_LABEL[kind].toLowerCase()}`}</button>
    </form>
  );
}

function ReportList() {
  const [data, setData] = useState<{ all: boolean; me: string; reports: ReportRow[] } | null>(null);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const load = () => getReports().then(r => r.ok ? setData(r) : setErr(r.message ?? 'Could not read the reports.'))
                                 .catch(e => setErr(e instanceof Error ? e.message : String(e)));
  useEffect(() => { void load(); }, []);
  if (err) return <p className="banner error">{err}</p>;
  if (!data) return <p className="note">Loading…</p>;
  const closed = (r: ReportRow) => r.status === 'done' || r.status === 'wontfix';
  const rows = data.reports.filter(r => showClosed || !closed(r));
  const hidden = data.reports.length - rows.length;
  return (
    <>
      <p className="note">{data.all ? 'Everyone\'s reports — you can move them along.' : 'Your reports.'}</p>
      {rows.length === 0 && <p className="note">Nothing open.</p>}
      <ul className="report-list">
        {rows.map(r => (
          <li key={r.id} className={closed(r) ? 'closed' : ''}>
            <button className="report-row" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
              <Icon n={r.kind === 'bug' ? 'warning' : 'sparkles'} />
              <span className="report-title">#{r.id} {reportTitle(r.body)}</span>
              <span className="report-status"><Icon n={STATUS_ICON[r.status]} /> {REPORT_STATUS[r.status]}</span>
            </button>
            {open === r.id && <ReportDetail r={r} canMove={data.all} onChanged={load} />}
          </li>
        ))}
      </ul>
      {hidden > 0 && <button className="link" onClick={() => setShowClosed(true)}>Show {hidden} closed</button>}
    </>
  );
}

function ReportDetail({ r, canMove, onChanged }: { r: ReportRow; canMove: boolean; onChanged: () => void }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const act = async (body: Record<string, unknown>) => {
    setBusy(true); setErr('');
    const res = await postReport({ ...body, id: r.id }).catch(e => ({ ok: false, message: String(e) }));
    setBusy(false);
    if (!res.ok) { setErr(res.message ?? 'Not saved.'); return false; }
    onChanged(); return true;
  };
  return (
    <div className="report-detail">
      <p className="report-body">{r.body}</p>
      <p className="note">
        {KIND_LABEL[r.kind]} · {URGENCY_LABEL[r.urgency]} · {r.reporter.split('@')[0]} · {when(r.createdAt)}
        {r.whereFrom ? ` · from ${r.whereFrom}` : ''}{r.source === 'slack' ? ' · via Slack' : r.device ? ` · ${r.device}` : ''}
      </p>
      {r.hasPhoto && <a href={`/api/reports?photo=${r.id}`} target="_blank" rel="noreferrer"><img className="report-photo" src={`/api/reports?photo=${r.id}`} alt="Photo sent with the report" /></a>}
      {canMove && (
        <label>Status
          <select value={r.status} disabled={busy} onChange={e => void act({ action: 'status', status: e.target.value })}>
            {REPORT_STATUSES.map(s => <option key={s} value={s}>{REPORT_STATUS[s]}</option>)}
          </select>
        </label>
      )}
      {(r.comments ?? []).map((c, i) => (
        <p key={i} className="report-comment"><b>{c.author.split('@')[0]}</b> · {when(c.createdAt)}<br />{c.body}</p>
      ))}
      <form className="report-reply" onSubmit={async e => { e.preventDefault(); if (await act({ action: 'comment', body: comment })) setComment(''); }}>
        <input value={comment} onChange={e => setComment(e.target.value)} placeholder="Add a comment" aria-label="Add a comment" />
        <button className="secondary small" disabled={busy || !comment.trim()}>Send</button>
      </form>
      {err && <p className="banner error">{err}</p>}
    </div>
  );
}
