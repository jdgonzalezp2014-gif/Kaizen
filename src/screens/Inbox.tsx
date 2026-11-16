/**
 * Guest Services → Inbox, the CRM (owner, 2026-11-16): a reservation and everything about its guest in one place —
 * the conversation (Hostaway), SMS (Quo), the to-dos tied to the stay, what is scheduled, the guest portal, and an AI
 * draft written from the Repository and the SOPs. Three panes, as a host's inbox reads: who · what was said · the stay.
 *
 * Hostaway and Quo keep the conversations; Kaizen keeps only its own outbox. Nothing here explains itself in
 * paragraphs — the how-to sits behind each "?" (CLAUDE.md); what a state or a limit says stays on screen.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getInbox, getInboxSms, getInboxThread, inboxAction, inboxSuggest, saveInboxSettings, todoAction,
  type InboxList, type InboxSms, type InboxThread } from '../api.ts';
import { FILTERS, MAX_BODY, STAGE_LABEL, TRIGGERS, VARS, channelLabel, fill, matchesFilter, searchHit, stageOf, varsFor, whenWords,
  type Channel, type InboxFilter, type InboxRow, type Planned, type Suggestion, type Template, type ThreadMsg, type Trigger } from '../lib/inbox.ts';
import { segments } from '../lib/sms.ts';
import { Hint } from '../components/Hint.tsx';
import { Icon } from '../components/Icon.tsx';
import { Modal } from '../components/Modal.tsx';
import { param, setParams } from '../components/useUrlState.ts';

const TZ = 'America/Chicago';
const fmt = (iso: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...o }).format(new Date(iso));
const dayKey = (iso: string) => fmt(iso, { year: 'numeric', month: '2-digit', day: '2-digit' });
const clock = (iso: string) => fmt(iso, { hour: 'numeric', minute: '2-digit' });
const shortWhen = (iso: string | null) => !iso ? '' : dayKey(iso) === dayKey(new Date().toISOString()) ? clock(iso) : fmt(iso, { month: 'short', day: 'numeric' });
const md = (d: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${d}T12:00:00Z`));
const range = (a: string | null, b: string | null) => !a || !b ? 'No dates' : a.slice(0, 7) === b.slice(0, 7) ? `${md(a)} – ${Number(b.slice(8))}` : `${md(a)} – ${md(b)}`;
const nightsOf = (a: string | null, b: string | null) => a && b ? Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000) : 0;
const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('') || 'G';

function Avatar({ row, size = 40 }: { row: Pick<InboxRow, 'guest' | 'photo'>; size?: number }) {
  const [broken, setBroken] = useState(false);
  return row.photo && !broken
    ? <img className="ix-avatar" src={row.photo} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    : <span className="ix-avatar ix-initials" style={{ width: size, height: size }} aria-hidden="true">{initials(row.guest)}</span>;
}

export function Inbox({ canSend, canSetup, canTodos, onTodo, onSettings }: {
  canSend: boolean; canSetup: boolean; canTodos: boolean;
  /** Open a to-do where to-dos live (Operations → To-do). */
  onTodo: (id: string) => void;
  /** Settings → Integrations → Guest messages & AI, for whoever may open it. */
  onSettings?: () => void;
}) {
  const [list, setList] = useState<InboxList | null>(null);
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(() => param('c'));
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const load = (more = false) => {
    setLoading(true);
    return getInbox(more ? rows.length : 0)
      .then(r => {
        if (!r.ok) { setErr(r.message ?? 'Could not load the inbox.'); return; }
        setErr(''); setList(r);
        setRows(prev => more ? [...prev, ...r.rows.filter(n => !prev.some(p => p.conversationId === n.conversationId))] : r.rows);
      })
      .catch(e => setErr(String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => { void load(); }, []);
  // New messages while the screen is open: a quiet reload every two minutes, only while someone is looking.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible' && rows.length <= 50) void load(); }, 120_000);
    return () => clearInterval(t);
  }, [rows.length]);

  const today = list?.today ?? '';
  const shown = useMemo(() => rows.filter(r => matchesFilter(r, filter, today) && searchHit(r, q)), [rows, filter, q, today]);
  const open = rows.find(r => r.conversationId === openId) ?? null;
  const pick = (id: string | null) => { setOpenId(id); setParams({ c: id }, { replace: true }); };

  return (
    <div className={`ix ${open ? 'has-open' : ''}`}>
      <aside className="ix-list" aria-label="Conversations">
        <div className="ix-list-head">
          <h2>Inbox <Hint>Every guest conversation from Hostaway, newest first, with its reservation. Open one to read it, answer, schedule a message,
            see the to-dos of that stay and its SMS. <b>Needs reply</b> = the guest wrote last. A <Icon n="list" /> number is open to-dos for the stay;
            a <Icon n="clock" /> number is messages waiting to go.</Hint></h2>
          <span className="ix-head-tools">
            {canSetup && <button type="button" className="ix-icon-btn" title="Message templates" aria-label="Message templates" onClick={() => setTemplatesOpen(true)}><Icon n="gear" /></button>}
            <button type="button" className="ix-icon-btn" title="Refresh" aria-label="Refresh" disabled={loading} onClick={() => void load()}><Icon n="repeat" /></button>
          </span>
        </div>
        <label className="ix-search"><Icon n="search" /><input type="search" value={q} placeholder="Guest or listing" aria-label="Search guest or listing" onChange={e => setQ(e.target.value)} /></label>
        <div className="ix-filters" role="tablist" aria-label="Filter">
          {FILTERS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={filter === k} className={`ix-pill ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
            {l}{k === 'unread' && rows.some(r => r.lastIncoming) && <span className="ix-count">{rows.filter(r => r.lastIncoming).length}</span>}</button>)}
        </div>
        {err && <p className="banner error">{err}</p>}
        {list && !list.live && <p className="ix-state"><Icon n="eye" /> Sending is off — replies are staged.
          <Hint label="What staged means">Until guest messages are turned on (Settings → Integrations → Guest messages &amp; AI), nothing written here reaches a guest:
            each message is kept with the label <b>Staged</b>, so the team can compare it with what Hostaway sent. Hostaway keeps sending its own messages.</Hint></p>}
        <ul className="ix-rows">
          {shown.map(r => <li key={r.conversationId}>
            <button type="button" className={`ix-row ${openId === r.conversationId ? 'on' : ''} ${r.lastIncoming ? 'wait' : ''}`} onClick={() => pick(r.conversationId)}>
              <Avatar row={r} />
              <span className="ix-row-main">
                <span className="ix-row-top"><b>{r.guest}</b><time>{shortWhen(r.lastAt)}</time></span>
                <span className="ix-row-sub">{r.listing} · {range(r.arrival, r.departure)}</span>
                <span className="ix-row-prev">{r.lastIncoming && <span className="ix-dot" aria-label="Needs reply" />}{r.preview || 'No messages yet'}</span>
              </span>
              {(r.tasks > 0 || r.scheduled > 0) && <span className="ix-row-badges">
                {r.tasks > 0 && <span title={`${r.tasks} open to-do${r.tasks === 1 ? '' : 's'}`}><Icon n="list" />{r.tasks}</span>}
                {r.scheduled > 0 && <span title={`${r.scheduled} message${r.scheduled === 1 ? '' : 's'} waiting to go`}><Icon n="clock" />{r.scheduled}</span>}
              </span>}
            </button>
          </li>)}
        </ul>
        {loading && <p className="note ix-pad">Loading…</p>}
        {!loading && !shown.length && !err && <p className="note ix-pad">No conversations here.</p>}
        {!loading && list?.more && filter === 'all' && !q && <button type="button" className="ix-more" onClick={() => void load(true)}>Show older</button>}
      </aside>

      {open && list
        ? <Conversation key={open.conversationId} row={open} list={list} canSend={canSend} canTodos={canTodos} onBack={() => pick(null)}
                        onTodo={onTodo} onSettings={onSettings} onChanged={() => void load()} />
        : <section className="ix-empty"><Icon n="message" /><p>Pick a conversation</p></section>}

      {templatesOpen && list && <TemplatesDialog templates={list.templates} onClose={() => setTemplatesOpen(false)}
                                                 onSaved={t => setList(l => l ? { ...l, templates: t } : l)} />}
    </div>
  );
}

type Pane = 'chat' | 'sms' | 'stay';

function Conversation({ row, list, canSend, canTodos, onBack, onTodo, onSettings, onChanged }: {
  row: InboxRow; list: InboxList; canSend: boolean; canTodos: boolean; onBack: () => void; onTodo: (id: string) => void;
  onSettings?: () => void; onChanged: () => void;
}) {
  const [pane, setPane] = useState<Pane>('chat');
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [sms, setSms] = useState<InboxSms | null>(null);
  const [err, setErr] = useState('');
  const stage = stageOf(row, list.today);

  const loadThread = () => getInboxThread(row.conversationId, row.reservationId)
    .then(r => { if (r.ok) { setThread(r); setErr(''); } else setErr(r.message ?? 'Could not load the conversation.'); })
    .catch(e => setErr(String(e)));
  const loadSms = () => getInboxSms(row.reservationId)
    .then(r => { if (r.ok) setSms(r); else setErr(r.message ?? 'Could not load SMS.'); }).catch(e => setErr(String(e)));
  useEffect(() => { void loadThread(); }, []);
  useEffect(() => { if (pane === 'sms' && !sms && row.reservationId) void loadSms(); }, [pane]);
  const after = () => { void loadThread(); if (sms) void loadSms(); onChanged(); };

  const stay = <StayPanel row={row} stage={stage} thread={thread} canTodos={canTodos} canSend={canSend} onTodo={onTodo} onChanged={after} />;
  return (
    <>
      <section className="ix-thread" aria-label={`Conversation with ${row.guest}`}>
        <div className="ix-thread-head">
          <button type="button" className="ix-icon-btn ix-back" aria-label="Back to the list" onClick={onBack}><Icon n="undo" /></button>
          <Avatar row={row} size={36} />
          <div className="ix-thread-who"><b>{row.guest}</b><span>{row.listing} · {range(row.arrival, row.departure)}</span></div>
          <span className={`ix-stage s-${stage}`}>{STAGE_LABEL[stage]}</span>
        </div>
        <div className="ix-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={pane === 'chat'} className={pane === 'chat' ? 'on' : ''} onClick={() => setPane('chat')}><Icon n="message" /> Chat{row.channel && <span className="ix-via">{channelLabel(row.channel)}</span>}</button>
          <button type="button" role="tab" aria-selected={pane === 'sms'} className={pane === 'sms' ? 'on' : ''} onClick={() => setPane('sms')}><Icon n="phone" /> SMS</button>
          <button type="button" role="tab" aria-selected={pane === 'stay'} className={`ix-tab-stay ${pane === 'stay' ? 'on' : ''}`} onClick={() => setPane('stay')}><Icon n="bed" /> Stay</button>
        </div>
        {err && <p className="banner error">{err}</p>}

        {pane === 'chat' && <>
          <Bubbles msgs={thread?.messages ?? null} canSend={canSend} onChanged={after} empty="No messages in this conversation yet." />
          <Composer row={row} channel="hostaway" list={list} portalLink={thread?.portalLink ?? null} canSend={canSend} onSent={after} />
        </>}
        {pane === 'sms' && (!row.reservationId
          ? <div className="ix-blank"><Icon n="phone" /><p>No reservation yet — SMS starts once the stay is booked.</p></div>
          : sms && !sms.connected
            ? <div className="ix-blank"><Icon n="phone" /><p>Quo is not connected.</p>
                <Hint label="How to connect Quo">SMS goes through this company's Quo number. Add the API key and the sending number in
                  Settings → Integrations → Quo; this tab then shows the texts with the guest's phone and sends from that number.</Hint>
                {onSettings && <button type="button" className="ix-ghost" onClick={onSettings}>Open Integrations</button>}</div>
            : sms && !sms.phone
              ? <div className="ix-blank"><Icon n="phone" /><p>This reservation has no phone number.</p></div>
              : <>
                  {sms?.note && <p className="banner warn">{sms.note}</p>}
                  <Bubbles msgs={sms?.messages ?? null} canSend={canSend} onChanged={after} empty={`No texts with ${sms?.phone ?? 'this guest'} yet.`} />
                  <Composer row={row} channel="sms" list={list} portalLink={thread?.portalLink ?? null} canSend={canSend} onSent={after} />
                </>)}
        {pane === 'stay' && <div className="ix-stay-inline">{stay}</div>}
      </section>
      <aside className="ix-side" aria-label="Stay">{stay}</aside>
    </>
  );
}

const STATUS_WORD: Record<string, string> = { scheduled: 'Scheduled', staged: 'Staged — not sent', failed: 'Not sent', sent: 'Sent' };

function Bubbles({ msgs, canSend, onChanged, empty }: { msgs: ThreadMsg[] | null; canSend: boolean; onChanged: () => void; empty: string }) {
  const end = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs?.length]);
  const act = async (action: 'cancel' | 'retry', id: string) => {
    setBusy(id); setNote('');
    const r = await inboxAction({ action, id }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy('');
    if (!r.ok) setNote(r.message ?? 'That did not work.'); else if (r.status === 'failed' || r.status === 'staged') setNote(r.error ?? '');
    onChanged();
  };
  if (!msgs) return <div className="ix-msgs"><p className="note ix-pad">Loading…</p></div>;
  let last = '';
  return (
    <div className="ix-msgs">
      {!msgs.length && <p className="note ix-pad">{empty}</p>}
      {msgs.map(m => {
        const d = dayKey(m.at), head = d !== last;
        last = d;
        const pending = m.ours && m.status !== 'sent';
        return <div key={m.id} className="ix-msg-wrap">
          {head && <div className="ix-day">{fmt(m.at, { weekday: 'long', month: 'long', day: 'numeric' })}</div>}
          <div className={`ix-msg ${m.incoming ? 'in' : 'out'} ${pending ? `is-${m.status}` : ''}`}>
            <div className="ix-bubble">
              {m.body}
              {m.images?.map(u => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt="Photo from the conversation" loading="lazy" /></a>)}
            </div>
            <div className="ix-meta">
              {pending && <span className={`ix-flag f-${m.status}`}><Icon n={m.status === 'scheduled' ? 'clock' : m.status === 'failed' ? 'alert' : 'eye'} /> {STATUS_WORD[m.status]}</span>}
              <span>{m.status === 'scheduled' ? fmt(m.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : clock(m.at)}</span>
              {m.by && <span>{m.by.split('@')[0]}</span>}
              {m.via && m.via !== 'channel' && <span>{m.via}</span>}
              {m.detail && m.status === 'failed' && <span className="ix-why">{m.detail}</span>}
              {canSend && m.ours && m.status === 'scheduled' && <button type="button" className="link tiny" disabled={busy === m.id} onClick={() => void act('cancel', m.id)}>Cancel</button>}
              {canSend && m.ours && (m.status === 'failed' || m.status === 'staged') && <button type="button" className="link tiny" disabled={busy === m.id} onClick={() => void act('retry', m.id)}>{m.status === 'failed' ? 'Retry' : 'Send now'}</button>}
            </div>
          </div>
        </div>;
      })}
      {note && <p className="ix-state">{note}</p>}
      <div ref={end} />
    </div>
  );
}

function Composer({ row, channel, list, portalLink, canSend, onSent }: {
  row: InboxRow; channel: Channel; list: InboxList; portalLink: string | null; canSend: boolean; onSent: () => void;
}) {
  const [text, setText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [when, setWhen] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [busy, setBusy] = useState<'' | 'send' | 'ai'>('');
  const [msg, setMsg] = useState('');
  const [ai, setAi] = useState<{ s: Suggestion; by: string; sops: string[] } | null>(null);
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  const templates = list.templates.filter(t => t.channel === channel);
  const unfilled = [...new Set([...text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map(m => m[1]!.toLowerCase()))];
  const seg = channel === 'sms' && text ? segments(text) : null;

  if (!canSend) return null;
  if (!row.reservationId) return <p className="ix-state ix-compose-off">No reservation yet — answer this one in Hostaway.</p>;

  const useTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find(x => x.id === id);
    if (t) { setText(fill(t.body, varsFor(row, portalLink)).text); setAiDraft(null); }
  };
  const suggest = async () => {
    setBusy('ai'); setMsg(''); setAi(null);
    const r = await inboxSuggest(row.conversationId).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy('');
    if (r.ok) setAi({ s: r.suggestion, by: r.by, sops: r.sops }); else setMsg(r.message ?? 'No suggestion.');
  };
  const send = async () => {
    setBusy('send'); setMsg('');
    const r = await inboxAction({
      action: scheduling ? 'schedule' : 'send', reservationId: row.reservationId, conversationId: row.conversationId, listingId: row.listingId,
      channel, body: text, templateId: templateId || null, aiDraft, sendAt: scheduling && when ? new Date(when).toISOString() : undefined,
    }).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy('');
    if (!r.ok) { setMsg(r.message ?? 'Not sent.'); return; }
    if (r.status === 'failed') setMsg(r.error ?? 'Not sent.');
    else { setText(''); setTemplateId(''); setAiDraft(null); setAi(null); setScheduling(false); setWhen(''); }
    onSent();
  };

  return (
    <div className="ix-compose">
      {ai && <div className={`ix-ai ${ai.s.handoff ? 'handoff' : ''}`}>
        <div className="ix-ai-head">
          <span><Icon n="sparkles" /> Suggested reply</span>
          <span className={`ix-conf c-${ai.s.confidence}`} title={`Model: ${ai.by}`}>{ai.s.handoff ? <><Icon n="hand" /> Needs a person</> : `${ai.s.confidence} confidence`}</span>
          <Hint label="Where this comes from">Written by {ai.by} from this listing's Repository record, the published SOPs that match and the conversation.
            It is a draft: read it, change it, then send. {ai.s.sources.length ? <>Used: {ai.s.sources.join(' · ')}.</> : 'It named no source.'}
            {ai.sops.length > 0 && <> SOPs it was shown: {ai.sops.join(' · ')}.</>}</Hint>
        </div>
        <p>{ai.s.reply}</p>
        {ai.s.reason && <p className="ix-ai-why">{ai.s.reason}</p>}
        <div className="ix-ai-acts">
          <button type="button" className="ix-ghost" onClick={() => { setText(ai.s.reply); setAiDraft(ai.s.reply); setTemplateId(''); setAi(null); }}>Use</button>
          <button type="button" className="link tiny" onClick={() => setAi(null)}>Dismiss</button>
        </div>
      </div>}
      <textarea className="ix-text" value={text} maxLength={MAX_BODY} rows={3} placeholder={channel === 'sms' ? 'Text message' : 'Write a reply'}
                aria-label={channel === 'sms' ? 'Text message' : 'Reply'} onChange={e => setText(e.target.value)} />
      {unfilled.length > 0 && <p className="ix-state"><Icon n="alert" /> No value for {unfilled.map(u => `{{${u}}}`).join(', ')} — fill it in or remove it.</p>}
      {msg && <p className="ix-state warn"><Icon n="alert" /> {msg}</p>}
      <div className="ix-compose-bar">
        {templates.length > 0 && <select className="ix-select" value={templateId} aria-label="Template" onChange={e => useTemplate(e.target.value)}>
          <option value="">Template…</option>
          {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>}
        {channel === 'hostaway' && list.aiMode === 'suggest' && <button type="button" className="ix-ghost" disabled={busy !== ''} onClick={() => void suggest()}>
          <Icon n="sparkles" /> {busy === 'ai' ? 'Thinking…' : 'Suggest'}</button>}
        <button type="button" className={`ix-ghost ${scheduling ? 'on' : ''}`} aria-pressed={scheduling} onClick={() => setScheduling(v => !v)}><Icon n="clock" /> Later</button>
        {scheduling && <input type="datetime-local" className="ix-when" value={when} aria-label="Send at (your time)" title="Send at (your time)" onChange={e => setWhen(e.target.value)} />}
        <span className="ix-grow" />
        {seg && <span className="note" title={seg.encoding}>{seg.count} SMS</span>}
        <button type="button" className="ix-send" disabled={busy !== '' || !text.trim() || unfilled.length > 0 || (scheduling && !when)} onClick={() => void send()}>
          {busy === 'send' ? 'Sending…' : scheduling ? 'Schedule' : list.live ? 'Send' : 'Stage'}</button>
      </div>
    </div>
  );
}

const PLAN_WORD: Record<Planned['state'], string> = { planned: 'Planned', due: 'Due now', missed: 'Missed', sent: 'Sent', staged: 'Staged', failed: 'Not sent',
  scheduled: 'Retrying', cancelled: 'Cancelled', received: '' };

function StayPanel({ row, stage, thread, canTodos, canSend, onTodo, onChanged }: {
  row: InboxRow; stage: ReturnType<typeof stageOf>; thread: InboxThread | null; canTodos: boolean; canSend: boolean; onTodo: (id: string) => void; onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const nights = nightsOf(row.arrival, row.departure);
  const waiting = thread?.messages.filter(m => m.ours && m.status === 'scheduled') ?? [];
  const add = async () => {
    setBusy(true); setMsg('');
    const r = await todoAction({ action: 'create', title, unitIds: row.listingId ? [row.listingId] : [], dueOn: due || null,
      reservationId: row.reservationId, reservationLabel: `${row.guest} · ${range(row.arrival, row.departure)}` })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not added.'); return; }
    setTitle(''); setDue(''); setAdding(false); onChanged();
  };
  const fact = (icon: string, label: string, value: ReactNode) => <div className="ix-fact"><Icon n={icon} /><span>{label}</span><b>{value}</b></div>;
  return (
    <>
      <div className="ix-card ix-pass">
        <span className={`ix-stage s-${stage}`}>{STAGE_LABEL[stage]}</span>
        <h3>{row.listing}</h3>
        <div className="ix-dates">
          <div><span>Check-in</span><b>{row.arrival ? md(row.arrival) : '—'}</b></div>
          <span className="ix-nights">{nights > 0 ? `${nights} night${nights === 1 ? '' : 's'}` : ''}</span>
          <div><span>Check-out</span><b>{row.departure ? md(row.departure) : '—'}</b></div>
        </div>
        {fact('users', 'Guests', row.guests ?? '—')}
        {fact('globe', 'Channel', row.channel ? channelLabel(row.channel) : '—')}
        {fact('phone', 'Phone', thread?.phone ?? '—')}
        {row.reservationId && fact('clipboard', 'Reservation', `#${row.reservationId}`)}
        {row.reservationId && <div className="ix-done" aria-label="What the guest has done">
          <span className={/^paid$/i.test(row.payment ?? '') ? 'yes' : ''}><Icon n={/^paid$/i.test(row.payment ?? '') ? 'check' : 'card'} /> {row.payment || 'Payment —'}</span>
          <span className={row.agreement === 'signed' ? 'yes' : ''}><Icon n={row.agreement === 'signed' ? 'check' : 'file'} /> {row.agreement === 'signed' ? 'Agreement signed' : 'Agreement —'}</span>
          <span className={row.idVerified ? 'yes' : ''}><Icon n={row.idVerified ? 'check' : 'idcard'} /> {row.idVerified ? 'ID verified' : 'ID —'}</span>
        </div>}
      </div>

      {row.reservationId && canTodos && <div className="ix-card">
        <h4>To-dos <span className="ix-count">{thread?.tasks.filter(t => !t.done).length ?? 0}</span>
          <Hint>The team's to-dos tied to this stay — the same ones as Operations → To-do. Add one here and it is created there, for this listing and this guest.</Hint>
          {!adding && <button type="button" className="ix-add" onClick={() => setAdding(true)} aria-label="Add a to-do">+</button>}</h4>
        {adding && <div className="ix-form">
          <input value={title} autoFocus placeholder="What needs doing?" aria-label="To-do" maxLength={300} onChange={e => setTitle(e.target.value)}
                 onKeyDown={e => { if (e.key === 'Enter' && title.trim()) void add(); }} />
          <div className="ix-form-row">
            <input type="date" value={due} aria-label="Due" title="Due" onChange={e => setDue(e.target.value)} />
            <button type="button" className="ix-send" disabled={busy || !title.trim()} onClick={() => void add()}>Add</button>
            <button type="button" className="link tiny" onClick={() => setAdding(false)}>Cancel</button>
          </div>
          {msg && <p className="ix-state warn">{msg}</p>}
        </div>}
        <ul className="ix-tasks">
          {thread?.tasks.map(t => <li key={t.id}>
            <button type="button" className={t.done ? 'done' : ''} onClick={() => onTodo(t.id)} title="Open in To-do">
              <Icon n={t.done ? 'done' : t.kind === 'work_order' ? 'wrench' : 'list'} /><span>{t.title}</span>
              {t.dueOn && !t.done && <time>{md(t.dueOn)}</time>}
            </button>
          </li>)}
        </ul>
        {thread && !thread.tasks.length && !adding && <p className="note">None for this stay.</p>}
      </div>}

      {row.reservationId && <div className="ix-card">
        <h4>Scheduled <span className="ix-count">{waiting.length + (thread?.plan.filter(p => p.state === 'planned' || p.state === 'due').length ?? 0)}</span>
          <Hint>Messages still to go for this stay: the ones a person scheduled, and the automatic ones from the templates (gear, top of the inbox) with the moment each
            one goes. Each automatic message goes once per stay. A scheduled one can be cancelled from the conversation.</Hint></h4>
        <ul className="ix-plan">
          {waiting.map(m => <li key={m.id}><Icon n="clock" /><span>{m.body.slice(0, 60)}</span><time>{fmt(m.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></li>)}
          {thread?.plan.map(p => <li key={p.templateId} className={`p-${p.state}`}><Icon n={p.channel === 'sms' ? 'phone' : 'message'} /><span>{p.name}</span>
            <time title={PLAN_WORD[p.state]}>{p.state === 'planned' ? fmt(p.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : PLAN_WORD[p.state]}</time></li>)}
        </ul>
        {thread && !waiting.length && !thread.plan.length && <p className="note">Nothing scheduled.</p>}
      </div>}

      {row.reservationId && <div className="ix-card">
        <h4>Guest portal <Hint>This stay's own portal link — online check-in, the arrival guide and extras. It is built from the portal's address in
          Settings → Integrations → Guest messages &amp; AI, and is what {'{{portal_link}}'} puts in a message.</Hint></h4>
        {thread?.portalLink
          ? <div className="ix-portal"><a href={thread.portalLink} target="_blank" rel="noreferrer"><Icon n="link" /> Open</a>
              {canSend && <button type="button" className="ix-ghost" onClick={() => { void navigator.clipboard?.writeText(thread.portalLink!); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy link'}</button>}</div>
          : <p className="note">Not live yet — no portal address set.</p>}
      </div>}
    </>
  );
}

const BLANK: Template = { id: '', name: '', body: '', channel: 'hostaway', trigger: 'manual', offsetHours: 0, active: true };

function TemplatesDialog({ templates, onClose, onSaved }: { templates: Template[]; onClose: () => void; onSaved: (t: Template[]) => void }) {
  const [edit, setEdit] = useState<Template | null>(null);
  const [days, setDays] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const start = (t: Template) => { setEdit(t); setDays(t.offsetHours > 0 && t.offsetHours % 24 === 0); setMsg(''); };
  const send = async (body: Record<string, unknown>) => {
    setBusy(true); setMsg('');
    const r = await saveInboxSettings(body).catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not saved.'); return false; }
    onSaved(r.templates); return true;
  };
  const insert = (v: string) => {
    if (!edit) return;
    const el = area.current, at = el?.selectionStart ?? edit.body.length;
    setEdit({ ...edit, body: `${edit.body.slice(0, at)}{{${v}}}${edit.body.slice(el?.selectionEnd ?? at)}` });
    el?.focus();
  };
  return (
    <Modal title="Message templates" onClose={onClose} wide>
      {!edit && <>
        <div className="ix-tpl-head">
          <Hint label="How templates work">A template is a message with blanks ({'{{first_name}}'}, {'{{checkin}}'}…) that Kaizen fills for each stay. <b>Only when picked</b> templates
            appear in the reply box. The others go on their own at their moment — once per stay, only for confirmed bookings — through the outbox, which
            tries again if a send fails. While guest messages are off they are kept as <b>Staged</b>, not sent.</Hint>
          <button type="button" className="ix-send" onClick={() => start(BLANK)}>New template</button>
        </div>
        <ul className="ix-tpls">
          {templates.map(t => <li key={t.id} className={t.active ? '' : 'off'}>
            <button type="button" className="ix-tpl" onClick={() => start(t)}>
              <Icon n={t.channel === 'sms' ? 'phone' : 'message'} />
              <span><b>{t.name}</b><span>{whenWords(t)}{t.active ? '' : ' · paused'}</span></span>
            </button>
          </li>)}
        </ul>
        {!templates.length && <p className="note">No templates yet.</p>}
        {msg && <p className="ix-state warn">{msg}</p>}
      </>}
      {edit && <div className="ix-form ix-tpl-form">
        <label>Name<input value={edit.name} maxLength={80} onChange={e => setEdit({ ...edit, name: e.target.value })} /></label>
        <div className="ix-form-row">
          <label>Channel<select value={edit.channel} onChange={e => setEdit({ ...edit, channel: e.target.value as Channel })}>
            <option value="hostaway">Chat (Hostaway)</option><option value="sms">SMS (Quo)</option></select></label>
          <label>Goes<select value={edit.trigger} onChange={e => setEdit({ ...edit, trigger: e.target.value as Trigger })}>
            {TRIGGERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {edit.trigger !== 'manual' && <label>How long<span className="ix-offset">
            <input type="number" min={0} max={days ? 30 : 720} value={days ? edit.offsetHours / 24 : edit.offsetHours}
                   onChange={e => setEdit({ ...edit, offsetHours: Math.max(0, Math.round(Number(e.target.value) || 0)) * (days ? 24 : 1) })} />
            <select value={days ? 'd' : 'h'} aria-label="Unit" onChange={e => { const d = e.target.value === 'd'; setDays(d); setEdit({ ...edit, offsetHours: d ? Math.round(edit.offsetHours / 24) * 24 : edit.offsetHours }); }}>
              <option value="h">hours</option><option value="d">days</option></select></span></label>}
        </div>
        <label>Message<textarea ref={area} className="ix-text" rows={6} maxLength={MAX_BODY} value={edit.body} onChange={e => setEdit({ ...edit, body: e.target.value })} /></label>
        <div className="ix-vars" aria-label="Insert a blank">{VARS.map(([k, l]) => <button key={k} type="button" className="ix-pill" title={l} onClick={() => insert(k)}>{k}</button>)}</div>
        <label className="ix-check"><input type="checkbox" checked={edit.active} onChange={e => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
        {msg && <p className="ix-state warn">{msg}</p>}
        <div className="ix-form-row">
          <button type="button" className="ix-send" disabled={busy || !edit.name.trim() || !edit.body.trim()}
                  onClick={() => void send({ action: 'template', ...edit, id: edit.id || undefined }).then(ok => { if (ok) setEdit(null); })}>Save</button>
          <button type="button" className="ix-ghost" onClick={() => setEdit(null)}>Back</button>
          <span className="ix-grow" />
          {edit.id && <button type="button" className="link tiny danger" disabled={busy}
                              onClick={() => void send({ action: 'removeTemplate', id: edit.id }).then(ok => { if (ok) setEdit(null); })}>Delete</button>}
        </div>
      </div>}
    </Modal>
  );
}
