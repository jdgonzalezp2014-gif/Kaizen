/**
 * Guest Services → Inbox, the CRM (owner, 2026-11-16): a reservation and everything about its guest in one place —
 * the conversation (Hostaway), SMS (Quo), the to-dos tied to the stay, what is scheduled, the guest portal, and an AI
 * draft written from the Repository and the SOPs. Three panes, as a host's inbox reads: who · what was said · the stay.
 *
 * Hostaway and Quo keep the conversations; Kaizen keeps only its own outbox. Nothing here explains itself in
 * paragraphs — the how-to sits behind each "?" (CLAUDE.md); what a state or a limit says stays on screen.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getInbox, getInboxSms, getInboxThread, inboxAction, inboxSuggest, saveClaim, todoAction,
  type InboxList, type InboxSms, type InboxThread } from '../api.ts';
import { FILTERS, MAX_BODY, STAGE_LABEL, channelLabel, fill, matchesFilter, searchHit, stageOf, tabOf, threadTabs, varsFor, waits,
  type Channel, type InboxFilter, type InboxRow, type Planned, type Suggestion, type ThreadMsg, type ThreadTab, type Via } from '../lib/inbox.ts';
import { segments } from '../lib/sms.ts';
import { Hint } from '../components/Hint.tsx';
import { Modal } from '../components/Modal.tsx';
import { CASE_CATEGORIES, UPSELL_CATEGORIES } from '../lib/claims.ts';
import { Icon } from '../components/Icon.tsx';
import { GUEST_EVENT } from '../components/GuestPing.tsx';
import { Automations } from './Automations.tsx';
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

export function Inbox({ canSend, canSetup, canTodos, canClaims = false, onTodo, onSettings }: {
  canSend: boolean; canSetup: boolean; canTodos: boolean;
  /** May open a case in Claims & upselling (the chat's + offers an upsell). */
  canClaims?: boolean;
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
  const [auto, setAuto] = useState(() => param('v') === 'auto');
  const [notify, setNotify] = useState<NotificationPermission | 'none'>(typeof Notification === 'undefined' ? 'none' : Notification.permission);

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
  // A guest wrote (Hostaway's webhook → GuestPing): the list is read again at once. And the address may name a
  // conversation after the screen is open — a notice's click, a link from Slack.
  useEffect(() => {
    const fresh = () => { if (rows.length <= 50) void load(); };
    const moved = () => { const c = param('c'); if (c) setOpenId(c); setAuto(param('v') === 'auto'); };
    window.addEventListener(GUEST_EVENT, fresh); window.addEventListener('popstate', moved);
    return () => { window.removeEventListener(GUEST_EVENT, fresh); window.removeEventListener('popstate', moved); };
  }, [rows.length]);
  // New messages while the screen is open: a quiet reload every two minutes, only while someone is looking.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible' && rows.length <= 50) void load(); }, 120_000);
    return () => clearInterval(t);
  }, [rows.length]);

  const today = list?.today ?? '';
  const shown = useMemo(() => rows.filter(r => matchesFilter(r, filter, today) && searchHit(r, q)), [rows, filter, q, today]);
  const open = rows.find(r => r.conversationId === openId) ?? null;
  const pick = (id: string | null) => { setOpenId(id); setParams({ c: id }, { replace: true }); };
  const showAuto = (on: boolean) => { setAuto(on); setParams({ v: on ? 'auto' : null }, { replace: true }); if (!on) void load(); };
  const nWait = rows.filter(waits).length;

  if (auto && canSetup) return <Automations onBack={() => showAuto(false)} />;

  return (
    <div className={`ix ${open ? 'has-open' : ''}`}>
      <aside className="ix-list" aria-label="Conversations">
        <div className="ix-list-head">
          <h2>Inbox <Hint>Every guest conversation from Hostaway, newest first, with its reservation. Open one to read it, answer, schedule a message,
            see the to-dos of that stay and its SMS. <b>Needs reply</b> = the guest wrote last — and, once Hostaway's live messages are connected (Settings →
            Integrations → Guest messages &amp; AI), not just to say thanks. A <Icon n="list" /> number is open to-dos for the stay; a <Icon n="clock" /> number is
            messages waiting to go. <Icon n="zap" /> opens the automations; <Icon n="bell" /> turns on this computer's notice when a guest writes.</Hint></h2>
          <span className="ix-head-tools">
            {notify === 'default' && <button type="button" className="ix-icon-btn" title="Notify me on this computer when a guest writes" aria-label="Turn on notifications"
                                              onClick={() => void Notification.requestPermission().then(setNotify)}><Icon n="bell" /></button>}
            {canSetup && <button type="button" className="ix-icon-btn" title="Automations and quick replies" aria-label="Automations and quick replies" onClick={() => showAuto(true)}><Icon n="zap" /></button>}
            <button type="button" className="ix-icon-btn" title="Refresh" aria-label="Refresh" disabled={loading} onClick={() => void load()}><Icon n="repeat" /></button>
          </span>
        </div>
        <label className="ix-search"><Icon n="search" /><input type="search" value={q} placeholder="Guest or listing" aria-label="Search guest or listing" onChange={e => setQ(e.target.value)} /></label>
        <div className="ix-filters" role="tablist" aria-label="Filter">
          {FILTERS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={filter === k} className={`ix-pill ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>
            {l}{k === 'unread' && nWait > 0 && <span className="ix-count">{nWait}</span>}</button>)}
        </div>
        {err && <p className="banner error">{err}</p>}
        {list && !list.live && <p className="ix-state"><Icon n="eye" /> Sending is off — replies are staged.
          <Hint label="What staged means">Until guest messages are turned on (Settings → Integrations → Guest messages &amp; AI), nothing written here reaches a guest:
            each message is kept with the label <b>Staged</b>, so the team can compare it with what Hostaway sent. Hostaway keeps sending its own messages.</Hint></p>}
        <ul className="ix-rows">
          {shown.map(r => <li key={r.conversationId}>
            <button type="button" className={`ix-row ${openId === r.conversationId ? 'on' : ''} ${waits(r) ? 'wait' : ''}`} onClick={() => pick(r.conversationId)}>
              <Avatar row={r} />
              <span className="ix-row-main">
                <span className="ix-row-top"><b>{r.guest}</b><time>{shortWhen(r.lastAt)}</time></span>
                <span className="ix-row-sub">{r.listing} · {range(r.arrival, r.departure)}</span>
                <span className="ix-row-prev">{waits(r) && <span className="ix-dot" aria-label="Needs reply" />}{r.preview || 'No messages yet'}</span>
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
        ? <Conversation key={open.conversationId} row={open} list={list} canSend={canSend} canTodos={canTodos} canClaims={canClaims} onBack={() => pick(null)}
                        onTodo={onTodo} onSettings={onSettings} onChanged={() => void load()} />
        : <section className="ix-empty"><Icon n="message" /><p>Pick a conversation</p></section>}

    </div>
  );
}

type Pane = ThreadTab | 'stay';
const TAB: Record<ThreadTab, { icon: string; label: string }> = { all: { icon: 'layers', label: 'All' }, chat: { icon: 'message', label: 'Chat' },
  email: { icon: 'mail', label: 'Email' }, sms: { icon: 'phone', label: 'SMS' } };

function Conversation({ row, list, canSend, canTodos, canClaims, onBack, onTodo, onSettings, onChanged }: {
  row: InboxRow; list: InboxList; canSend: boolean; canTodos: boolean; canClaims: boolean; onBack: () => void; onTodo: (id: string) => void;
  onSettings?: () => void; onChanged: () => void;
}) {
  const [pane, setPane] = useState<Pane>('all');
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

  const tabs = threadTabs(row, thread?.messages ?? []);
  // Texts Hostaway itself sent (its automations) live in its thread, not in Quo: the SMS tab shows both, in order.
  const hostSms = thread?.messages.filter(m => m.channel === 'hostaway' && tabOf(m) === 'sms') ?? [];
  const stay = <StayPanel row={row} stage={stage} thread={thread} canTodos={canTodos} canClaims={canClaims} canSend={canSend} onTodo={onTodo} onChanged={after} />;
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
          {tabs.map(t => <button key={t} type="button" role="tab" aria-selected={pane === t} className={pane === t ? 'on' : ''} onClick={() => setPane(t)}>
            <Icon n={TAB[t].icon} /> {t === 'chat' && row.channel ? channelLabel(row.channel) : TAB[t].label}</button>)}
          <button type="button" role="tab" aria-selected={pane === 'stay'} className={`ix-tab-stay ${pane === 'stay' ? 'on' : ''}`} onClick={() => setPane('stay')}><Icon n="bed" /> Stay</button>
          <Hint label="What the tabs are">One tab per way of reaching this guest. <b>All</b> is everything in Hostaway's thread; a reply from it travels the way the
            thread already talks. <b>{row.channel ? channelLabel(row.channel) : 'Chat'}</b> answers on the booking channel; <b>Email</b> sends an email through Hostaway to the
            address it has for the guest; <b>SMS</b> is this company's Quo number. A tab only shows when that way exists for this guest.</Hint>
        </div>
        {err && <p className="banner error">{err}</p>}

        {(pane === 'all' || pane === 'chat' || pane === 'email') && <>
          <Bubbles msgs={thread ? (pane === 'all' ? thread.messages : thread.messages.filter(m => tabOf(m) === pane)) : null} canSend={canSend} onChanged={after}
                   empty={pane === 'email' ? 'No emails with this guest yet.' : 'No messages in this conversation yet.'} />
          <Composer row={row} channel="hostaway" via={pane === 'all' ? null : pane === 'email' ? 'email' : 'channel'} list={list} portalLink={thread?.portalLink ?? null} canSend={canSend} onSent={after} />
        </>}
        {pane === 'sms' && (!row.reservationId
          ? <div className="ix-blank"><Icon n="phone" /><p>No reservation yet — SMS starts once the stay is booked.</p></div>
          : sms && !sms.connected
            ? <div className="ix-blank">{hostSms.length > 0 && <p className="note">{hostSms.length} text{hostSms.length === 1 ? '' : 's'} sent by Hostaway's own automations — in the All tab.</p>}
                <Icon n="phone" /><p>Quo is not connected.</p>
                <Hint label="How to connect Quo">SMS goes through this company's Quo number. Add the API key and the sending number in
                  Settings → Integrations → Quo; this tab then shows the texts with the guest's phone and sends from that number.</Hint>
                {onSettings && <button type="button" className="ix-ghost" onClick={onSettings}>Open Integrations</button>}</div>
            : sms && !sms.phone
              ? <div className="ix-blank"><Icon n="phone" /><p>This reservation has no phone number.</p></div>
              : <>
                  {sms?.note && <p className="banner warn">{sms.note}</p>}
                  <Bubbles msgs={sms ? [...hostSms, ...sms.messages].sort((a, b) => a.at < b.at ? -1 : 1) : null} canSend={canSend} onChanged={after}
                           empty={`No texts with ${sms?.phone ?? 'this guest'} yet.`} />
                  <Composer row={row} channel="sms" via={null} list={list} portalLink={thread?.portalLink ?? null} canSend={canSend} onSent={after} />
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

function Composer({ row, channel, via, list, portalLink, canSend, onSent }: {
  row: InboxRow; channel: Channel;
  /** The tab it was written in: email or the booking channel's chat. Null = the way the thread already talks. */
  via: Via | null; list: InboxList; portalLink: string | null; canSend: boolean; onSent: () => void;
}) {
  const [text, setText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [when, setWhen] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [busy, setBusy] = useState<'' | 'send' | 'ai'>('');
  const [msg, setMsg] = useState('');
  const [ai, setAi] = useState<{ s: Suggestion; by: string; sops: string[] } | null>(null);
  const [aiDraft, setAiDraft] = useState<string | null>(null);
  const templates = list.templates.filter(t => t.channel === channel && t.active);
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
      channel, via, body: text, templateId: templateId || null, aiDraft, sendAt: scheduling && when ? new Date(when).toISOString() : undefined,
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
      <textarea className="ix-text" value={text} maxLength={MAX_BODY} rows={3} placeholder={channel === 'sms' ? 'Text message' : via === 'email' ? 'Write an email' : 'Write a reply'}
                aria-label={channel === 'sms' ? 'Text message' : via === 'email' ? 'Email' : 'Reply'} onChange={e => setText(e.target.value)} />
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
          {busy === 'send' ? 'Sending…' : scheduling ? 'Schedule' : !list.live ? 'Stage' : via === 'email' ? 'Send email' : 'Send'}</button>
      </div>
    </div>
  );
}

/** What an automation still has ahead of it for this stay — what Cancel / Cancel all stop. */
const PENDING: Planned['state'][] = ['planned', 'due', 'waiting'];
const PLAN_WORD: Record<Planned['state'], string> = { planned: 'Planned', due: 'Due now', missed: 'Missed', sent: 'Sent', staged: 'Staged', failed: 'Not sent',
  scheduled: 'Retrying', cancelled: 'Cancelled', received: '', waiting: 'After check-in', skipped: 'Not needed' };

type NewKind = 'task' | 'repair' | 'purchase' | 'claim' | 'upsell';
const NEW_KINDS: { key: NewKind; label: string; icon: string; hint: string; placeholder: string }[] = [
  { key: 'task', label: 'Task', icon: 'list', hint: 'Something to do', placeholder: 'What needs doing?' },
  { key: 'repair', label: 'Repair', icon: 'wrench', hint: 'Work order', placeholder: 'What is broken?' },
  { key: 'purchase', label: 'Purchase', icon: 'cart', hint: 'Purchase order', placeholder: 'What to buy?' },
  { key: 'claim', label: 'Claim', icon: 'alert', hint: 'Claims & upselling', placeholder: 'What happened?' },
  { key: 'upsell', label: 'Upsell', icon: 'card', hint: 'Claims & upselling', placeholder: 'Details (amount, time…)' },
];

function StayPanel({ row, stage, thread, canTodos, canClaims, canSend, onTodo, onChanged }: {
  row: InboxRow; stage: ReturnType<typeof stageOf>; thread: InboxThread | null; canTodos: boolean; canClaims: boolean; canSend: boolean; onTodo: (id: string) => void; onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [ciBusy, setCiBusy] = useState(false);
  const [ciMsg, setCiMsg] = useState('');
  const ci = thread?.checkin ?? null;
  const markCheckin = async (done: boolean) => {
    setCiBusy(true); setCiMsg('');
    const r = await inboxAction({ action: 'checkin', reservationId: row.reservationId, listingId: row.listingId, done }).catch(e => ({ ok: false as const, message: String(e) }));
    setCiBusy(false);
    if (!r.ok) setCiMsg(r.message ?? 'Not saved.');
    onChanged();
  };
  const nights = nightsOf(row.arrival, row.departure);
  const waiting = thread?.messages.filter(m => m.ours && m.status === 'scheduled') ?? [];
  const pending = thread?.plan.filter(p => PENDING.includes(p.state)) ?? [];
  const [sure, setSure] = useState(false);
  const [holdBusy, setHoldBusy] = useState(false);
  const [holdMsg, setHoldMsg] = useState('');
  const hold = async (templateIds: string[], messageIds: string[], resume = false) => {
    setHoldBusy(true); setHoldMsg('');
    const r = await inboxAction({ action: resume ? 'resume' : 'hold', reservationId: row.reservationId, conversationId: row.conversationId,
      listingId: row.listingId, templateIds, messageIds }).catch(e => ({ ok: false as const, message: String(e) }));
    setHoldBusy(false); setSure(false);
    if (!r.ok) setHoldMsg(('message' in r && r.message) || 'Not saved.');
    onChanged();
  };
  const [kind, setKind] = useState<NewKind>('task');
  const [category, setCategory] = useState('');
  const isCase = kind === 'claim' || kind === 'upsell';
  const cats = kind === 'claim' ? CASE_CATEGORIES : UPSELL_CATEGORIES;
  const kinds = NEW_KINDS.filter(k => k.key === 'claim' || k.key === 'upsell' ? canClaims : canTodos);
  const stay = `${row.guest} · ${range(row.arrival, row.departure)}`;
  const add = async () => {
    setBusy(true); setMsg('');
    // 2026-11-17 (owner): one + for what a chat turns into — a to-do, a repair, a purchase, or an upsell (a case in
    // Claims & upselling, not a to-do: it carries money asked and received). A claim (damage, noise…) the same.
    const r = isCase
      ? await saveClaim({ unitId: row.listingId ?? null, category: category || cats[0], status: 'Open', source: 'Guest message',
          description: title, reservationId: row.reservationId, reservationLabel: stay })
          .then(x => ({ ok: x.ok, message: x.error })).catch(e => ({ ok: false, message: String(e) }))
      : await todoAction({ action: 'create', title, unitIds: row.listingId ? [row.listingId] : [], dueOn: due || null,
          kind: kind === 'repair' ? 'work_order' : 'task', asOrder: kind === 'purchase',
          reservationId: row.reservationId, reservationLabel: stay })
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

      {row.reservationId && <div className="ix-card">
        <h4>Online check-in <Hint>Whether this guest finished the online check-in. The guest portal records it by itself once its real link is live; until then a
          person marks it here. Marking it done is what sends the automations that go <b>After online check-in</b> (the door code) — at once, or at their
          "not before" moment — and stops the reminders meant for guests who have not done it.</Hint></h4>
        {ci
          ? <p className="ix-ci yes"><Icon n="check" /> Done {fmt(ci.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              <span>{ci.source === 'team' ? `marked by ${(ci.by ?? 'the team').split('@')[0]}` : 'by the guest'}</span>
              {canSend && ci.source === 'team' && <button type="button" className="link tiny" disabled={ciBusy} onClick={() => void markCheckin(false)}>Undo</button>}</p>
          : <p className="ix-ci"><Icon n="clock" /> Not done yet
              {canSend && thread && <button type="button" className="ix-ghost" disabled={ciBusy} onClick={() => void markCheckin(true)}>{ciBusy ? 'Saving…' : 'Mark done'}</button>}</p>}
        {ciMsg && <p className="ix-state warn">{ciMsg}</p>}
      </div>}

      {row.reservationId && (canTodos || canClaims) && <div className="ix-card">
        <h4>To-dos <span className="ix-count">{thread?.tasks.filter(t => !t.done).length ?? 0}</span>
          <Hint>The team's to-dos tied to this stay — the same ones as Operations → To-do. The + makes one for this listing and this guest: a <b>Task</b>, a <b>Repair</b> (work order), a <b>Purchase</b> (purchase order) — all in Operations → To-do — or a <b>Claim</b> (damage, noise…) or an <b>Upsell</b> (pet fee, early check-in…), which open a case in Claims &amp; upselling.</Hint>
          <button type="button" className="ix-add" onClick={() => { setKind(kinds[0]!.key); setAdding(true); }} aria-label="Add a task, repair, purchase, claim or upsell">+</button></h4>
        {adding && <Modal title="New from this chat" onClose={() => setAdding(false)}>
          <div className="ix-form ix-new">
            <div className="ix-kinds" role="radiogroup" aria-label="What is it">
              {kinds.map(k => <button key={k.key} type="button" role="radio" aria-checked={kind === k.key}
                                      className={kind === k.key ? 'ix-kind on' : 'ix-kind'} onClick={() => { setKind(k.key); setCategory(''); }}>
                <Icon n={k.icon} /><b>{k.label}</b><span>{k.hint}</span></button>)}
            </div>
            {isCase && <select value={category || cats[0]} aria-label="Category" onChange={e => setCategory(e.target.value)}>
              {cats.map(c => <option key={c}>{c}</option>)}</select>}
            <input value={title} autoFocus placeholder={NEW_KINDS.find(k => k.key === kind)!.placeholder} aria-label="What" maxLength={300}
                   onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && title.trim()) void add(); }} />
            <div className="ix-form-row">
              {!isCase && <input type="date" value={due} aria-label="Due" title="Due" onChange={e => setDue(e.target.value)} />}
              <button type="button" className="ix-send" disabled={busy || !title.trim()} onClick={() => void add()}>{busy ? 'Adding…' : 'Add'}</button>
              <button type="button" className="link tiny" onClick={() => setAdding(false)}>Cancel</button>
            </div>
            {msg && <p className="ix-state warn">{msg}</p>}
          </div>
        </Modal>}
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
        <h4>Scheduled <span className="ix-count">{waiting.length + pending.length}</span>
          <Hint>Messages still to go for this stay: the ones a person scheduled, and the active automations (<Icon n="zap" />, top of the inbox) that apply to this
            listing, with the moment each one goes. <b>After check-in</b> = it waits for the guest's online check-in; <b>Not needed</b> = its condition does not hold.
            Each automatic message goes once per stay. <b>Cancel</b> stops one for this stay only (the automation stays on for everyone else); <b>Cancel all</b> stops
            everything still to go — for when something happened (a cancellation, a change of plan). A cancelled automation can be put back with <b>Undo</b>.</Hint>
          {canSend && waiting.length + pending.length > 1 && (sure
            ? <span className="ix-hold-all"><button type="button" className="ix-ghost danger" disabled={holdBusy} onClick={() => void hold(pending.map(p => p.templateId), waiting.map(m => m.id))}>{holdBusy ? 'Cancelling…' : `Cancel ${waiting.length + pending.length}`}</button>
                <button type="button" className="link tiny" onClick={() => setSure(false)}>Keep</button></span>
            : <button type="button" className="ix-ghost" onClick={() => setSure(true)}>Cancel all</button>)}</h4>
        <ul className="ix-plan">
          {waiting.map(m => <li key={m.id}><Icon n="clock" /><span>{m.body.slice(0, 60)}</span><time>{fmt(m.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
            {canSend && <button type="button" className="link tiny" disabled={holdBusy} onClick={() => void hold([], [m.id])}>Cancel</button>}</li>)}
          {thread?.plan.map(p => <li key={p.templateId} className={`p-${p.state}`}><Icon n={p.channel === 'sms' ? 'phone' : 'message'} /><span>{p.name}</span>
            <time title={PLAN_WORD[p.state]}>{p.state === 'planned' && p.at ? fmt(p.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : PLAN_WORD[p.state]}</time>
            {canSend && PENDING.includes(p.state) && <button type="button" className="link tiny" disabled={holdBusy} onClick={() => void hold([p.templateId], [])}>Cancel</button>}
            {canSend && p.state === 'cancelled' && <button type="button" className="link tiny" disabled={holdBusy} onClick={() => void hold([p.templateId], [], true)}>Undo</button>}</li>)}
        </ul>
        {holdMsg && <p className="ix-state warn">{holdMsg}</p>}
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
