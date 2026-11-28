/**
 * Guest Services → Inbox, the CRM (owner, 2026-11-16): a reservation and everything about its guest in one place —
 * the conversation (Hostaway), SMS (Quo), the to-dos tied to the stay, what is scheduled, the guest portal, and an AI
 * draft written from the Repository and the SOPs. Three panes, as a host's inbox reads: who · what was said · the stay.
 *
 * Hostaway and Quo keep the conversations; Kaizen keeps only its own outbox. Nothing here explains itself in
 * paragraphs — the how-to sits behind each "?" (CLAUDE.md); what a state or a limit says stays on screen.
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { saveTurnover, getStayPayments, getInbox, getInboxSms, getInboxThread, inboxAction, inboxExtend, inboxSuggest, saveClaim, todoAction, type ExtendFit, type StayCase,
  type InboxList, type InboxSms, type InboxThread } from '../api.ts';
import { FILTERS, MAX_BODY, STAGE_LABEL, bookingLinks, channelLabel, fill, matchesFilter, searchHit, stageOf, tabOf, threadTabs, varsFor, waits,
  type Channel, type InboxFilter, type InboxRow, type Planned, type Suggestion, type ThreadMsg, type ThreadTab, type Via } from '../lib/inbox.ts';
import { segments } from '../lib/sms.ts';
import { HOURS, hourWord, timeOfHour } from '../lib/stay-time.ts';
import { Hint, IconFlag } from '../components/Hint.tsx';
import { Modal } from '../components/Modal.tsx';
import { CASE_CATEGORIES, UPSELL_CATEGORIES, isUpsell } from '../lib/claims.ts';
import { UpsellCharge } from '../components/UpsellCharge.tsx';
import { ClaimPop, TodoList } from '../components/Todos.tsx';
import type { DateStr } from '../lib/dates.ts';
import { Icon } from '../components/Icon.tsx';
import { money2 } from '../lib/format.ts';
import { ActionDialog, type Ask as PayAsk, type DeskPayment, type Pending } from './Payments.tsx';
import { BrandMark } from '../components/BrandMark.tsx';
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

export function Inbox({ canSend, canSetup, canTodos, canClaims = false, canPayments = false, canRefund = false, onSettings }: {
  canSend: boolean; canSetup: boolean; canTodos: boolean;
  /** Guest Services → Payments: see this stay's portal payments; refund / release them (owner, 2026-11-26). */
  canPayments?: boolean; canRefund?: boolean;
  /** May open a case in Claims & upselling (the chat's + offers an upsell). */
  canClaims?: boolean;
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

  // Owner, 2026-11-23: Slack's 🛠 on a check-in names the reservation (`?r=`), not a conversation — open that stay's once the list is in.
  useEffect(() => {
    const r = param('r');
    if (!r || openId) return;
    const hit = rows.find(x => String(x.reservationId ?? '') === r);
    if (hit) { setOpenId(hit.conversationId); setParams({ c: hit.conversationId, r: null }, { replace: true }); }
  }, [rows]);

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
          <h2>CRM <Hint>Every guest conversation from Hostaway, newest first, with its reservation. Open one to read it, answer, schedule a message,
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
                <span className="ix-row-top"><span className="ix-row-name"><b>{r.guest}</b>{!!r.pending?.length && <span className="ix-pending" title={`Pending: ${r.pending.join(' · ')}`}
                  aria-label={`${r.pending.length} pending: ${r.pending.join(', ')}`}><Icon n="alert" />{r.pending.length > 1 ? r.pending.length : ''}</span>}</span><time>{shortWhen(r.lastAt)}</time></span>
                <span className="ix-row-sub">{r.listing} · {range(r.arrival, r.departure)}</span>
                <span className="ix-row-prev">{waits(r) && <span className="ix-dot" aria-label="Needs reply" />}{waits(r) && r.drafted && <span className="ix-drafted" title="A reply is drafted" aria-label="Reply drafted"><Icon n="sparkles" /></span>}{r.issue && <span className="ix-issue" title={`Bad experience: ${typeof r.issue === 'string' ? r.issue : 'on record'}`} aria-label="Bad experience on record"><Icon n="alert" /></span>}{r.preview || 'No messages yet'}</span>
              </span>
              {r.scheduled > 0 && <span className="ix-row-badges">
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
        ? <Conversation key={open.conversationId} row={open} list={list} canSend={canSend} canTodos={canTodos} canClaims={canClaims} canPayments={canPayments} canRefund={canRefund} onBack={() => pick(null)}
                        onSettings={onSettings} onChanged={() => void load()} />
        : <section className="ix-empty"><Icon n="message" /><p>Pick a conversation</p></section>}

    </div>
  );
}

type Pane = ThreadTab | 'stay';
const TAB: Record<ThreadTab, { icon: string; label: string }> = { all: { icon: 'layers', label: 'All' }, chat: { icon: 'message', label: 'Chat' },
  email: { icon: 'mail', label: 'Email' }, sms: { icon: 'phone', label: 'SMS' } };

function Conversation({ row, list, canSend, canTodos, canClaims, canPayments, canRefund, onBack, onSettings, onChanged }: {
  row: InboxRow; list: InboxList; canSend: boolean; canTodos: boolean; canClaims: boolean; canPayments: boolean; canRefund: boolean; onBack: () => void;
  onSettings?: () => void; onChanged: () => void;
}) {
  const [pane, setPane] = useState<Pane>('all');
  const links = bookingLinks(row);
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
  const stay = <StayPanel row={row} stage={stage} thread={thread} canTodos={canTodos} canClaims={canClaims} canSend={canSend} canPayments={canPayments} canRefund={canRefund} today={list.today} onChanged={after} />;
  return (
    <>
      <section className="ix-thread" aria-label={`Conversation with ${row.guest}`}>
        <div className="ix-thread-head">
          <button type="button" className="ix-icon-btn ix-back" aria-label="Back to the list" onClick={onBack}><Icon n="undo" /></button>
          <Avatar row={row} size={36} />
          <div className="ix-thread-who"><b>{row.guest}</b><span>{row.listing} · {range(row.arrival, row.departure)}</span></div>
          <div className="ix-pass-top"><span className={`ix-stage s-${stage}`}>{STAGE_LABEL[stage]}</span>
          {/* Where to change the booking (owner, 2026-11-17): small, beside the stage. */}
          {row.reservationId && <span className="ix-open-in">
            {links.hostaway && <a href={links.hostaway} target="_blank" rel="noreferrer" title="Open the reservation in Hostaway (to change it)" aria-label="Open in Hostaway"><BrandMark brand="hostaway" /></a>}
            {links.channel && <a href={links.channel.url} target="_blank" rel="noreferrer" title={`Open the reservation in ${links.channel.label}`} aria-label={`Open in ${links.channel.label}`}><BrandMark brand="airbnb" /></a>}
            {links.profile && <a href={links.profile} target="_blank" rel="noreferrer" title="The guest's Airbnb profile — the reviews other hosts left them (Airbnb does not share the rating with Hostaway)" aria-label="Guest's Airbnb profile"><Icon n="user" /></a>}
          </span>}</div>
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
          <Composer key={row.conversationId} row={row} channel="hostaway" via={pane === 'all' ? null : pane === 'email' ? 'email' : 'channel'} list={list} portalLink={thread?.portalLink ?? null} draft={thread?.draft ?? null} canSend={canSend} onSent={after} />
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
                  <Composer key={`sms-${row.conversationId}`} row={row} channel="sms" via={null} list={list} portalLink={thread?.portalLink ?? null} canSend={canSend} onSent={after} />
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
              {/* Owner, 2026-11-27: the meta line is icons with their word on hover — the message gets the room. */}
              {pending && <IconFlag sm tone={m.status === 'failed' ? 'bad' : m.status === 'scheduled' ? 'info' : 'attn'}
                icon={<Icon n={m.status === 'scheduled' ? 'clock' : m.status === 'failed' ? 'alert' : 'eye'} />} label={STATUS_WORD[m.status ?? ""] ?? "Not sent"}
                detail={m.status === 'failed' ? m.detail : null} />}
              <span>{m.status === 'scheduled' ? fmt(m.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : clock(m.at)}</span>
              {m.by && (/automat/i.test(m.by) || m.by === 'Kaizen AI'
                ? <IconFlag sm icon={<Icon n={m.by === 'Kaizen AI' ? 'sparkles' : 'zap'} />} label={m.by === 'Kaizen AI' ? 'Kaizen AI' : 'Automatic'} detail="The guest sees the listing's host account." />
                : <span className="ix-by" title="Who sent it — the guest sees the listing's host account">{m.by.split('@')[0]}</span>)}
              {m.via && m.via !== 'channel' && <IconFlag sm icon={<Icon n={m.via === 'email' ? 'mail' : m.via === 'sms' ? 'phone' : 'message'} />} label={`Sent by ${m.via}`} />}
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

function Composer({ row, channel, via, list, portalLink, draft, canSend, onSent }: {
  row: InboxRow; channel: Channel; draft?: InboxThread['draft'];
  /** The tab it was written in: email or the booking channel's chat. Null = the way the thread already talks. */
  via: Via | null; list: InboxList; portalLink: string | null; canSend: boolean; onSent: () => void;
}) {
  const [text, setText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [when, setWhen] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [busy, setBusy] = useState<'' | 'send' | 'ai'>('');
  const [msg, setMsg] = useState('');
  const [ai, setAi] = useState<{ s: Suggestion; by: string; sops: string[]; auto?: boolean } | null>(null);
  // The draft written when the guest wrote: shown once per draft, the same card as Suggest. Its time is its identity.
  const draftAt = draft?.at ?? '';
  useEffect(() => {
    if (draft && 'reply' in draft && channel === 'hostaway') setAi({ s: draft, by: draft.by, sops: draft.sops, auto: true });
  }, [draftAt, channel]); // eslint-disable-line react-hooks/exhaustive-deps
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
          <span><Icon n="sparkles" /> {ai.auto ? 'Drafted when the guest wrote' : 'Suggested reply'}</span>
          <span className={`ix-conf c-${ai.s.confidence}`} title={`Model: ${ai.by}`}>{ai.s.handoff ? <><Icon n="hand" /> Needs a person</> : `${ai.s.confidence} confidence`}</span>
          <Hint label="Where this comes from">Written by {ai.by} from this listing's Repository record and Hostaway amenities, this booking, the company facts
            (Settings → Integrations → Guest messages & AI), the guest-side SOPs that match and the conversation.
            It is a draft: read it, change it, then send. {ai.s.sources.length ? <>Used: {ai.s.sources.join(' · ')}.</> : 'It named no source.'}
            {ai.sops.length > 0 && <> SOPs it was shown: {ai.sops.join(' · ')}.</>}</Hint>
        </div>
        <p>{ai.s.reply}</p>
        {ai.s.reason && <p className="ix-ai-why">{ai.s.reason}</p>}
        {ai.s.missing && <p className="ix-ai-why"><Icon n="alert" /> Missing: {ai.s.missing} — add it to the listing's record or the company facts.</p>}
        <div className="ix-ai-acts">
          <button type="button" className="ix-ghost" onClick={() => { const t = fill(ai.s.reply, varsFor(row, portalLink)).text; setText(t); setAiDraft(ai.s.reply); setTemplateId(''); setAi(null); }}>Use</button>
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
        {channel === 'hostaway' && list.aiMode === 'suggest' && <button type="button" className={`ix-ghost ix-icon-btn ${busy === 'ai' ? 'busy' : ''}`} disabled={busy !== ''} onClick={() => void suggest()}
          aria-label={busy === 'ai' ? 'Writing a suggestion…' : 'Suggest a reply with AI'} title={busy === 'ai' ? 'Writing a suggestion…' : 'Suggest a reply with AI'}>
          <Icon n="sparkles" /></button>}
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
  { key: 'upsell', label: 'Upsell', icon: 'card', hint: 'Charge the guest', placeholder: 'Details (optional)' },
];

type Group = 'work' | 'claim' | 'upsell';
const GROUP_OF: Record<NewKind, Group> = { task: 'work', repair: 'work', purchase: 'work', claim: 'claim', upsell: 'upsell' };
const closedCase = (status: string) => /^(resolved|paid|dismissed|closed)$/i.test(status);

/** A section of the stay's side that opens on a click (owner, 2026-11-17: "not all of them showing"); the count stays visible. */
/**
 * A section of the stay's side that opens on a click (owner, 2026-11-17: "not all of them showing"); the count stays visible.
 * `urgent` (Work, Claims): while anything is open its count is red with a "!" — so nothing is left undone behind a fold.
 */
/**
 * What this guest paid in the portal (owner, 2026-11-26: "see if they paid the deposit, and refund it right there") — the same
 * rows and buttons as Guest Services → Payments, for this reservation only.
 */
function StayPayments({ reservationId, canRefund, airbnbLink }: { reservationId: string; canRefund: boolean; airbnbLink?: string | null }) {
  const [list, setList] = useState<DeskPayment[] | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [err, setErr] = useState('');
  const [ask, setAsk] = useState<PayAsk | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    getStayPayments(reservationId).then(r => { if (r.ok) { setList(r.payments); setPending(r.pending ?? []); setErr(''); } else setErr(r.message ?? 'Could not read the payments.'); })
      .catch(e => setErr(String(e)));
  }, [reservationId, n]);
  const held = (list ?? []).filter(p => p.status === 'held');
  return (
    <Fold title="Payments" urgent count={held.length + pending.length}
      hint={<>What this guest paid in the guest portal by card: the waiver, the deposit (held on the card, not charged) and each extra.
        <b> Release</b> lets a held deposit go; <b>Keep…</b> charges part of it for damage and lets the rest go; <b>Refund…</b> gives money back
        on a paid line. A hold lasts about 7 days. <b>Pending</b> is what the guest still owes; <b>Remind…</b> sends them a message with their
        check-in link. All stays: Guest Services → Payments.</>}>
      {err && <p className="ix-state warn">{err}</p>}
      {pending.length > 0 && <PendingMini rows={pending} rcLink={airbnbLink} />}
      {list === null ? (!err && <p className="note loading-dot">Reading</p>) : !list.length ? (!pending.length && <p className="note">Nothing paid in the portal.</p>) : (
        <ul className="ix-pays">
          {list.map(p => <li key={p.id}>
            <div className="ix-pay">
              {/* Owner, 2026-11-27: status as icons (green paid, blue set-up done, ! pending), the dates on hover. */}
              <IconFlag sm tone={p.status === 'paid' ? 'ok' : p.status === 'held' ? 'info' : undefined}
                icon={<Icon n={p.status === 'held' ? 'clock' : p.status === 'paid' ? 'check' : 'undo'} />} label={PAY_STATE[p.status]}
                detail={`${p.paidOn}${p.holdEndsOn ? ` · hold ends ${p.holdEndsOn}` : ''}${p.refunded > 0 ? ` · ${money2(p.refunded)} refunded` : ''}${!p.livemode ? ' · test' : ''}`} />
              <span>{p.lines.map(l => `${l.label}${l.hold ? ' (hold)' : ''}`).join(' · ')} <b>{money2(p.amount)}</b>
                {p.refunded > 0 && <small> −{money2(p.refunded)}</small>}
                {p.followUps.map(t => <IconFlag key={t.id} sm tone={t.done ? 'info' : 'attn'} icon={<Icon n={t.done ? 'done' : 'alert'} />}
                  label={`Set-up #${t.id} ${t.done ? 'done' : 'pending'}`} />)}</span>
              {canRefund && <span>
                {p.status === 'held' && <><button type="button" className="ix-ghost" onClick={() => setAsk({ kind: 'release', p })}>Release</button>
                  <button type="button" className="ix-ghost" onClick={() => setAsk({ kind: 'keep', p })}>Keep…</button></>}
                {p.refundable > 0 && <button type="button" className="ix-ghost" onClick={() => setAsk({ kind: 'refund', p })}>Refund…</button>}
              </span>}
            </div>
          </li>)}
        </ul>
      )}
      {ask && <ActionDialog ask={ask} onClose={() => setAsk(null)} onDone={() => { setAsk(null); setN(x => x + 1); }} />}
    </Fold>
  );
}
/**
 * What the guest still owes, one short line each (owner, 2026-11-27: the table did not fit the panel) — the date behind a
 * calendar, what + amount + how; Remind / Check live in Guest Services → Payments, one tap away.
 */
function PendingMini({ rows, rcLink }: { rows: Pending[]; rcLink?: string | null }) {
  const toDesk = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault(); setParams({ tab: 'payments' }, { whole: true }); dispatchEvent(new PopStateEvent('popstate'));
  };
  return <>
    <ul className="ix-pays">{rows.map(p => <li key={p.key}><div className="ix-pay">
      <IconFlag sm tone="attn" icon={<Icon n="calendar" />} label={`Pending since ${md(p.since.slice(0, 10))}`}
        detail={p.lastReminder ? `Reminded ${md(p.lastReminder.at.slice(0, 10))} by ${p.lastReminder.by.split('@')[0]}` : 'Not reminded yet'} />
      <span><small>{p.what.replace(/^./, c => c.toUpperCase())}</small> <b>{p.amount != null ? money2(p.amount) : '—'}</b>
        {p.method === 'rc'
          ? <IconFlag sm icon={<Icon n="home" />} label="Airbnb Resolution Center">{rcLink && <><br /><a href={rcLink} target="_blank" rel="noreferrer">Open in Airbnb ↗</a></>}</IconFlag>
          : <IconFlag sm icon={<Icon n="card" />} label="Card, in the guest portal" />}
        {p.said && <IconFlag sm tone="bad" icon={<Icon n="alert" />} label="The guest says it is paid" detail="Check Airbnb, then confirm it in Payments." />}</span>
    </div></li>)}</ul>
    <a className="ix-pay-more" href="?tab=payments" onClick={toDesk}>Remind or check in Payments ↗</a>
  </>;
}
const PAY_STATE = { paid: 'Paid', held: 'Held on the card', refunded: 'Refunded', released: 'Released' } as const;

function Fold({ title, count, hint, onAdd, addLabel, urgent = false, children }: { title: string; count: number; hint: ReactNode; onAdd?: () => void; addLabel?: string; urgent?: boolean; children: ReactNode }) {
  const hot = urgent && count > 0;
  return (
    <details className={hot ? 'ix-card ix-fold hot' : 'ix-card ix-fold'}>
      <summary><h4>{title} {hot
        ? <span className="ix-count hot" title={`${count} open — still to do`}><Icon n="alert" />{count}</span>
        : <span className="ix-count">{count}</span>}<Hint>{hint}</Hint>
        {onAdd && <button type="button" className="ix-add" aria-label={addLabel ?? 'Add'} onClick={e => { e.preventDefault(); onAdd(); }}>+</button>}</h4></summary>
      {children}
    </details>
  );
}

function CaseList({ cases, onOpen }: { cases: StayCase[]; onOpen: (id: string) => void }) {
  return <ul className="ix-tasks">{cases.map(c => <li key={c.id}>
    <button type="button" className={closedCase(c.status) ? 'done' : ''} onClick={() => onOpen(c.id)} title="Open">
      <Icon n={closedCase(c.status) ? 'done' : isUpsell(c.category) ? 'card' : 'alert'} /><span>{c.category ?? 'Case'}{c.description ? ` — ${c.description}` : ''}</span>
      <time>{c.received > 0 ? `$${Math.round(c.received)}` : c.requested > 0 ? `$${Math.round(c.requested)} asked` : c.status}</time>
    </button>
  </li>)}</ul>;
}

function StayPanel({ row, stage, thread, canTodos, canClaims, canSend, canPayments, canRefund, today, onChanged }: {
  row: InboxRow; stage: ReturnType<typeof stageOf>; thread: InboxThread | null; canTodos: boolean; canClaims: boolean; canSend: boolean;
  canPayments: boolean; canRefund: boolean; today: DateStr;
  onChanged: () => void;
}) {
  // Owner, 2026-11-23: a to-do or a case opens as a pop-up over the conversation — never a trip to Operations → To-do.
  const [pop, setPop] = useState<{ todo?: string; claim?: string } | null>(null);
  const onTodo = (id: string) => setPop({ todo: id });
  const onClaim = (id: string) => setPop({ claim: id });
  const closePop = () => { setPop(null); onChanged(); };
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState(false);
  const [ciBusy, setCiBusy] = useState(false);
  const [ciMsg, setCiMsg] = useState('');
  const ci = thread?.checkin ?? null;
  const issue = thread?.issue ?? null;
  const [isWhy, setIsWhy] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [isMsg, setIsMsg] = useState('');
  const markIssue = async (on: boolean) => {
    setIsBusy(true); setIsMsg('');
    const r = await inboxAction({ action: 'issue', reservationId: row.reservationId, conversationId: row.conversationId, listingId: row.listingId, on, why: isWhy ?? '' })
      .catch(e => ({ ok: false as const, message: String(e) }));
    setIsBusy(false);
    if (!r.ok) { setIsMsg(r.message ?? 'Not saved.'); return; }
    setIsWhy(null);
    onChanged();
  };
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
  const [group, setGroup] = useState<Group>('work');
  // 2026-11-19 (owner): an upsell made here goes straight on to its charge (Stripe pay link + Hostaway hold, or Airbnb's doors).
  const [chargeFor, setChargeFor] = useState<string | null>(null);
  const [category, setCategory] = useState('');
  const isCase = kind === 'claim' || kind === 'upsell';
  const cats = kind === 'claim' ? CASE_CATEGORIES : UPSELL_CATEGORIES;
  // 2026-11-17 (owner): three sections, each with its own + — Work (task / repair / purchase), Claims, Upselling.
  const kinds = NEW_KINDS.filter(k => GROUP_OF[k.key] === group);
  const open = (g: Group) => { setGroup(g); setKind(NEW_KINDS.find(k => GROUP_OF[k.key] === g)!.key); setCategory(''); setMsg(''); setAdding(true); };
  const tasks = thread?.tasks ?? [];
  const claims = (thread?.cases ?? []).filter(c => !isUpsell(c.category));
  // Owner, 2026-11-27: a cancelled upsell (the guest switched how to pay, or changed the check-in) is not shown — it was never owed.
  const upsells = (thread?.cases ?? []).filter(c => isUpsell(c.category) && !/^dismissed$/i.test(c.status));
  // Owner, 2026-11-23: the hours on the card, marked while an early/late charge is not paid — Hostaway's hour moves only once it is.
  const unpaid = (cats: string[]) => upsells.find(c => !closedCase(c.status) && cats.includes(c.category ?? ''));
  const unpaidIn = unpaid(['Early check-in', 'Late check-in']), unpaidOut = unpaid(['Late checkout']);
  // Owner, 2026-11-27: the hour is changed right here — written on the Hostaway reservation (same path as the board),
  // so the reminders and the guest portal say the hour that was agreed. Shown as set until the next sync reads it back.
  const [setHour, setSetHour] = useState<{ checkin?: number; checkout?: number }>({});
  const [hourMsg, setHourMsg] = useState('');
  useEffect(() => { setSetHour({}); setHourMsg(''); }, [row.reservationId, row.checkInHour, row.checkOutHour]);
  const changeHour = async (k: 'checkin' | 'checkout', h: number) => {
    if (!row.reservationId) return;
    setSetHour(x => ({ ...x, [k]: h })); setHourMsg('Sending to Hostaway…');
    const r = await saveTurnover({ resId: row.reservationId, set: k === 'checkin' ? { checkinTime: timeOfHour(h) } : { checkoutTime: timeOfHour(h) } })
      .catch(e => ({ ok: false as const, message: String(e) }));
    if (!r.ok) { setSetHour(x => ({ ...x, [k]: undefined })); setHourMsg(('message' in r && r.message) || 'Not saved.'); return; }
    setHourMsg(r.time === 'queued' ? `${k === 'checkin' ? 'Check-in' : 'Check-out'} ${hourWord(h)} sent to Hostaway.` : 'Saved in Kaizen — Operations is not live, Hostaway not changed.');
    onChanged();
  };
  const hourOf = (k: 'checkin' | 'checkout', h0: number | null, open: StayCase | undefined) => {
    const h = setHour[k] ?? h0;
    return <small className={open ? 'ix-hour warn' : 'ix-hour'}
      title={open ? `${open.category} requested — not paid yet. Hostaway keeps this hour until it is paid.` : 'The hour Hostaway has for this stay — change it here'}>
      {open && <Icon n="alert" />}
      {row.reservationId
        ? <select className="ix-hour-pick" value={h ?? ''} aria-label={k === 'checkin' ? 'Check-in hour' : 'Check-out hour'}
            onChange={e => e.target.value !== '' && void changeHour(k, Number(e.target.value))}>
            {h == null && <option value="">—</option>}
            {HOURS.map(x => <option key={x} value={x}>{hourWord(x)}</option>)}
          </select>
        : h == null ? '—' : hourWord(h)}
      {open ? ' · not paid' : ''}</small>;
  };
  const links = bookingLinks(row);
  const [ext, setExt] = useState<ExtendFit | { message: string } | null>(null);
  const [extBusy, setExtBusy] = useState(false);
  const extend = async () => {
    setExtBusy(true);
    const r = await inboxExtend({ listingId: row.listingId, arrival: row.arrival, departure: row.departure }).catch(e => ({ ok: false as const, message: String(e) }));
    setExtBusy(false);
    setExt(r.ok ? r : { message: ('message' in r && r.message) || 'Could not read the calendar.' });
  };
  const stay = `${row.guest} · ${range(row.arrival, row.departure)}`;
  const add = async () => {
    setBusy(true); setMsg('');
    // 2026-11-17 (owner): one + for what a chat turns into — a to-do, a repair, a purchase, or an upsell (a case in
    // Claims & upselling, not a to-do: it carries money asked and received). A claim (damage, noise…) the same.
    const r = isCase
      ? await saveClaim({ unitId: row.listingId ?? null, category: category || cats[0], status: 'Open', source: 'Guest message',
          description: title.trim() || category || cats[0], reservationId: row.reservationId, reservationLabel: stay })
          .then(x => ({ ok: x.ok, message: x.error, id: x.id })).catch(e => ({ ok: false, message: String(e), id: undefined }))
      : await todoAction({ action: 'create', title, unitIds: row.listingId ? [row.listingId] : [], dueOn: due || null,
          kind: kind === 'repair' ? 'work_order' : 'task', asOrder: kind === 'purchase',
          reservationId: row.reservationId, reservationLabel: stay })
          .catch(e => ({ ok: false as const, message: String(e) }));
    setBusy(false);
    if (!r.ok) { setMsg(r.message ?? 'Not added.'); return; }
    setTitle(''); setDue('');
    if (kind === 'upsell' && 'id' in r && r.id != null) setChargeFor(String(r.id)); else setAdding(false);
    onChanged();
  };
  const fact = (icon: string, label: string, value: ReactNode) => <div className="ix-fact"><Icon n={icon} /><span>{label}</span><b>{value}</b></div>;
  return (
    <>
      {pop?.todo && <TodoList today={today} task={pop.todo} onClose={closePop} />}
      {pop?.claim && <ClaimPop id={pop.claim} today={today} onClose={closePop} />}
      <div className="ix-card ix-pass">
        <span className={`ix-stage s-${stage}`}>{STAGE_LABEL[stage]}</span>
        <h3>{row.listing}</h3>
        <div className="ix-dates">
          <div><span>Check-in</span><b>{row.arrival ? md(row.arrival) : '—'}</b>{hourOf('checkin', row.checkInHour ?? null, unpaidIn)}</div>
          <span className="ix-nights">{nights > 0 ? `${nights} night${nights === 1 ? '' : 's'}` : ''}</span>
          <div><span>Check-out</span><b>{row.departure ? md(row.departure) : '—'}</b>{hourOf('checkout', row.checkOutHour ?? null, unpaidOut)}</div>
        </div>
        {hourMsg && <p className="ix-hour-msg">{hourMsg}</p>}
        {fact('users', 'Guests', row.guests ?? '—')}
        {fact('globe', 'Channel', row.channel ? channelLabel(row.channel) : '—')}
        {fact('phone', thread?.phoneConfirmed ? 'Phone · confirmed by guest' : 'Phone', thread?.phone ?? '—')}
        {row.reservationId && fact('clipboard', 'Reservation', `#${row.reservationId}`)}
        {row.reservationId && (() => {
          const paid = /^paid$/i.test(row.payment ?? ''), signed = row.agreement === 'signed';
          // Owner, 2026-11-27: icons, the word on hover — green check when done, the thing's own icon while not.
          return <div className="ix-done-flags" aria-label="What the guest has done">
            <IconFlag tone={paid ? 'ok' : undefined} icon={<Icon n={paid ? 'check' : 'card'} />} label={paid ? 'Paid' : `Payment: ${row.payment || 'not recorded'}`} />
            <IconFlag tone={signed ? 'ok' : undefined} icon={<Icon n={signed ? 'check' : 'file'} />} label={signed ? 'Agreement signed' : 'Agreement not signed'} />
            <IconFlag tone={row.idVerified ? 'ok' : undefined} icon={<Icon n={row.idVerified ? 'check' : 'idcard'} />} label={row.idVerified ? 'ID verified' : 'ID not verified'} />
          </div>;
        })()}
      </div>

      {row.reservationId && <div className="ix-card ix-ci-row">
        <span className="ix-ci-label">Online check-in <Hint>Whether this guest finished the online check-in. The guest portal records it by itself once its real
          link is live; until then a person marks it here. Marking it done sends the automations that go <b>After online check-in</b> (the door code) and
          stops the reminders meant for guests who have not done it.</Hint></span>
        {ci
          ? <span className="ix-ci"><IconFlag tone="ok" icon={<Icon n="check" />} label="Done"
              detail={`${fmt(ci.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} — ${ci.source === 'team' ? `marked by ${(ci.by ?? 'the team').split('@')[0]}` : 'by the guest'}`}>
              {canSend && ci.source === 'team' && <><br /><button type="button" className="link tiny" disabled={ciBusy} onClick={() => void markCheckin(false)}>Undo</button></>}</IconFlag></span>
          : <span className="ix-ci"><IconFlag tone="attn" icon={<Icon n="clock" />} label="Not done yet" />
              {canSend && thread && <button type="button" className="ix-ghost" disabled={ciBusy} onClick={() => void markCheckin(true)}>{ciBusy ? 'Saving…' : 'Mark done'}</button>}</span>}
        {ciMsg && <p className="ix-state warn">{ciMsg}</p>}
      </div>}

      {row.reservationId && <div className="ix-card ix-ci-row">
        <span className="ix-ci-label">Bad experience <Hint>Kept on record when a guest reports a bad experience (dirty, broken, noise, a complaint) — the AI records it
          when it reads the message, or a person here. While it is on record, automations with the condition <b>No bad experience</b> (the review ask)
          are not sent to this stay. The guest is told nothing about it. Clear it if it was not one.</Hint>
          {/* Owner, 2026-11-27: the "!" sits beside the title, what happened on hover — the card stays one line. */}
          {issue && <IconFlag tone="bad" icon={<Icon n="alert" />} label={issue.why}
            detail={`${fmt(issue.at, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} — ${issue.source === 'team' ? `by ${(issue.by ?? 'the team').split('@')[0]}` : 'noticed by the AI'}`}>
            {canSend && <><br /><button type="button" className="link tiny" disabled={isBusy} onClick={() => void markIssue(false)}>Clear</button></>}</IconFlag>}</span>
        {issue
          ? null
          : isWhy === null
            ? <span className="ix-ci"><IconFlag tone="ok" icon={<Icon n="check" />} label="None on record" />
                {canSend && thread && <button type="button" className="ix-ghost" onClick={() => setIsWhy('')}>Record</button>}</span>
            : <span className="ix-ci">
                <input autoFocus value={isWhy} maxLength={300} placeholder="What happened, in one line" aria-label="What happened"
                  onChange={e => setIsWhy(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && isWhy.trim()) void markIssue(true); if (e.key === 'Escape') setIsWhy(null); }} />
                <button type="button" className="ix-ghost" disabled={isBusy || !isWhy.trim()} onClick={() => void markIssue(true)}>{isBusy ? 'Saving…' : 'Save'}</button>
                <button type="button" className="link tiny" onClick={() => setIsWhy(null)}>Cancel</button></span>}
        {isMsg && <p className="ix-state warn">{isMsg}</p>}
      </div>}

      {adding && chargeFor && <Modal title={`${category || cats[0]} — charge the guest`} onClose={() => { setAdding(false); setChargeFor(null); }}>
        <UpsellCharge claimId={chargeFor} hasStay onChanged={onChanged} />
        <p className="note">The case is in Upselling below and in Operations → To-do; the charge can be made there later too.</p>
        <button type="button" className="ix-send" onClick={() => { setAdding(false); setChargeFor(null); }}>Done</button>
      </Modal>}
      {adding && !chargeFor && <Modal title={group === 'work' ? 'New work for this stay' : group === 'claim' ? 'New claim' : 'New upsell'} onClose={() => setAdding(false)}>
        <div className="ix-form ix-new">
          {kinds.length > 1 && <div className="ix-kinds" role="radiogroup" aria-label="What is it">
            {kinds.map(k => <button key={k.key} type="button" role="radio" aria-checked={kind === k.key}
                                    className={kind === k.key ? 'ix-kind on' : 'ix-kind'} onClick={() => { setKind(k.key); setCategory(''); }}>
              <Icon n={k.icon} /><b>{k.label}</b><span>{k.hint}</span></button>)}
          </div>}
          {isCase && <select value={category || cats[0]} aria-label="Category" onChange={e => setCategory(e.target.value)}>
            {cats.map(c => <option key={c}>{c}</option>)}</select>}
          <input value={title} autoFocus placeholder={NEW_KINDS.find(k => k.key === kind)!.placeholder} aria-label="What" maxLength={300}
                 onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (title.trim() || kind === 'upsell')) void add(); }} />
          <div className="ix-form-row">
            {!isCase && <input type="date" value={due} aria-label="Due" title="Due" onChange={e => setDue(e.target.value)} />}
            <button type="button" className="ix-send" disabled={busy || !(title.trim() || kind === 'upsell')} onClick={() => void add()}>{busy ? 'Adding…' : kind === 'upsell' ? 'Next: charge' : 'Add'}</button>
            <button type="button" className="link tiny" onClick={() => setAdding(false)}>Cancel</button>
          </div>
          {msg && <p className="ix-state warn">{msg}</p>}
        </div>
      </Modal>}

      {row.reservationId && canPayments && <StayPayments key={row.reservationId} reservationId={row.reservationId} canRefund={canRefund}
        airbnbLink={links.channel?.url ?? null} />}

      {row.reservationId && canTodos && <Fold title="Work" urgent count={tasks.filter(t => !t.done).length} onAdd={() => open('work')} addLabel="Add a task, repair or purchase"
        hint={<>The team's work tied to this stay — the same as Operations → To-do. The + makes a <b>Task</b>, a <b>Repair</b> (work order) or a <b>Purchase</b>
          (purchase order) for this listing and this guest.</>}>
        <ul className="ix-tasks">
          {tasks.map(t => <li key={t.id}>
            <button type="button" className={t.done ? 'done' : ''} onClick={() => onTodo(t.id)} title="Open">
              <Icon n={t.done ? 'done' : t.order ? 'cart' : t.kind === 'work_order' ? 'wrench' : 'list'} /><span>{t.title}</span>
              {t.dueOn && !t.done && <time>{md(t.dueOn)}</time>}
            </button>
          </li>)}
        </ul>
        {thread && !tasks.length && <p className="note">None for this stay.</p>}
      </Fold>}

      {row.reservationId && canClaims && <Fold title="Claims" urgent count={claims.filter(c => !closedCase(c.status)).length} onAdd={() => open('claim')} addLabel="Start a claim"
        hint={<>Guest complaints and damage for this stay (damage, cleanliness, noise…) — the same cases as Claims &amp; upselling. The + starts one; its
          repairs and purchases are added from the case.</>}>
        <CaseList cases={claims} onOpen={onClaim} />
        {thread && !claims.length && <p className="note">None for this stay.</p>}
      </Fold>}

      {row.reservationId && (canClaims || canSend) && <Fold title="Upselling" urgent count={upsells.filter(c => !closedCase(c.status)).length} onAdd={canClaims ? () => open('upsell') : undefined} addLabel="Add an upsell"
        hint={<>What this guest pays on top (pet fee, early check-in, late checkout…) — cases in Claims &amp; upselling, counted in Revenue once the money is
          entered as received. The + goes on to <b>charge the guest</b>: a card pay link (the guest also sees it on their stay page), or on Airbnb the
          Resolution Center; Kaizen sets the nights or the hour up in Hostaway once it is paid. <b>Extend stay</b>
          reads the listing's live Hostaway calendar: the free nights before and after, with Hostaway's price when it has one — to sell them, + → Extra nights.</>}>
        <CaseList cases={upsells} onOpen={onClaim} />
        {thread && !upsells.length && <p className="note">None for this stay.</p>}
        {row.listingId && row.arrival && row.departure && <div className="ix-extend">
          {!ext ? <button type="button" className="ix-ghost" disabled={extBusy} onClick={() => void extend()}><Icon n="calendar" /> {extBusy ? 'Reading the calendar…' : 'Extend stay'}</button>
            : 'message' in ext ? <p className="ix-state warn">{ext.message}</p>
            : <>
              <p><Icon n="calendar" /> <b>{ext.freeBefore}</b> free night{ext.freeBefore === 1 ? '' : 's'} before · <b>{ext.freeAfter}</b> after
                {ext.freeAfter >= 7 || ext.freeBefore >= 7 ? <span className="note"> (looked 7 ahead)</span> : null}</p>
              {ext.nightPrices && (ext.freeBefore + ext.freeAfter) > 0 && <p className="note">Hostaway's price: {[...ext.nightPrices.before, ...ext.nightPrices.after].map(p => `$${Math.round(p)}`).join(' · ')}</p>}
              {(ext.freeBefore + ext.freeAfter) > 0 && <p className="ix-extend-go">Change the dates in {links.channel ? <><a href={links.channel.url} target="_blank" rel="noreferrer">{links.channel.label}</a> (an alteration the guest accepts)</> : links.hostaway ? <a href={links.hostaway} target="_blank" rel="noreferrer">Hostaway</a> : 'Hostaway'}.</p>}
            </>}
        </div>}
      </Fold>}

      {row.reservationId && <Fold title="Scheduled" count={waiting.length + pending.length}
        hint={<>Messages still to go for this stay: the ones a person scheduled, and the active automations (<Icon n="zap" />, top of the inbox) that apply to this
          listing, with the moment each one goes. <b>After check-in</b> = it waits for the guest's online check-in; <b>Not needed</b> = its condition does not hold.
          Each automatic message goes once per stay. <b>Cancel</b> stops one for this stay only (the automation stays on for everyone else); <b>Cancel all</b> stops
          everything still to go — for when something happened (a cancellation, a change of plan). A cancelled automation can be put back with <b>Undo</b>.</>}>
        {canSend && waiting.length + pending.length > 1 && <p className="ix-hold-all">{sure
          ? <><button type="button" className="ix-ghost danger" disabled={holdBusy} onClick={() => void hold(pending.map(p => p.templateId), waiting.map(m => m.id))}>{holdBusy ? 'Cancelling…' : `Cancel ${waiting.length + pending.length}`}</button>
              <button type="button" className="link tiny" onClick={() => setSure(false)}>Keep</button></>
          : <button type="button" className="ix-ghost" onClick={() => setSure(true)}>Cancel all</button>}</p>}
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
      </Fold>}

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
