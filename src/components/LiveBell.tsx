/**
 * The bell (§166; guest messages joined it 2026-11-17): one place for what happened while Kaizen is open — guests who
 * wrote (the Inbox's live events) and work made, done or cancelled by someone else (Kaizen, Slack, Hostaway, a
 * cleaner's report, an inspection). Each kind rings, shows a short notice at the bottom and a desktop notice when the
 * tab is hidden, by the settings behind the gear (`NotifySettings`, per browser). The list is this browser's own (a
 * convenience, not a record: the work is in Operations → To-do, the guests in the Inbox) and keeps the last 40.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LiveFresh } from '../api.ts';
import { useLive } from './useLive.ts';
import { useGuestFeed, type GuestFresh } from './GuestPing.tsx';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';
import { Hint } from './Hint.tsx';
import { chime, soundReady, testChime } from './chime.ts';
import { NotifySettings, loadPrefs, savePrefs, BELL_TEST } from './NotifySettings.tsx';
import { decide, type Kind, type NotifyPrefs } from '../lib/notify.ts';

export interface BellItem {
  key: string; kind: Kind; at: string; urgent: boolean; test?: boolean;
  /** "New to-do · Preston", "Guest message" … */
  what: string; title: string; by?: string | null;
  event?: LiveFresh['event']; todo?: string; conversation?: string;
}

const KEY = 'kaizen.notify.feed';
type Feed = { items: BellItem[]; unread: number };
const load = (): Feed => {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (v && Array.isArray(v.items)) return v; } catch { /* private window */ }
  return { items: [], unread: 0 };
};
const save = (v: Feed) => { try { localStorage.setItem(KEY, JSON.stringify(v)); localStorage.removeItem('kaizen.live.inbox'); } catch { /* private window */ } };

const workWhat = (x: LiveFresh) => x.order ? 'Purchase order' : x.kind === 'work_order' ? 'Work order' : 'To-do';
const verb = (e?: LiveFresh['event']) => e === 'completed' ? 'Done' : e === 'cancelled' ? 'Cancelled' : 'New';
const fromWork = (x: LiveFresh): BellItem => ({
  key: `t:${x.id}:${x.event ?? 'new'}`, kind: 'tasks', at: x.createdAt, event: x.event, todo: x.id,
  urgent: x.priority === 'urgent' || x.priority === 'high',
  what: `${workWhat(x)}${x.units ? ` · ${x.units}` : ''}`, title: x.title, by: x.createdBy?.split('@')[0] ?? null
});
const fromGuest = (g: GuestFresh): BellItem => ({
  key: `m:${g.id}`, kind: 'messages', at: new Date().toISOString(), urgent: g.urgent, conversation: g.conversationId,
  what: g.guest, title: g.preview
});
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const headline = (x: BellItem) => x.kind === 'messages' ? `${x.urgent ? 'Urgent — ' : ''}${x.what} wrote` : `${verb(x.event)} ${x.what.toLowerCase()}`;

export function LiveBell({ tasks, messages, onTodo, onConversation }: {
  tasks: boolean; messages: boolean; onTodo: (id: string) => void; onConversation: (id: string) => void;
}) {
  const [feed, setFeed] = useState<Feed>(load);
  const [toast, setToast] = useState<BellItem[] | null>(null);
  const [prefs, setPrefs] = useState<NotifyPrefs>(loadPrefs);
  const [settings, setSettings] = useState(false);
  const [show, setShow] = useState<'all' | Kind>('all');
  useEffect(() => save(feed), [feed]);
  useEffect(() => savePrefs(prefs), [prefs]);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const openItem = (x: BellItem) => {
    setToast(null);
    if (x.test) return;
    if (x.todo) onTodo(x.todo); else if (x.conversation) onConversation(x.conversation);
  };

  /** One batch of notices of one kind: into the list, then the interruptions the settings allow. */
  const arrive = (batch: BellItem[]) => {
    const seen = new Set(feed.items.map(i => i.key)), now = new Date();
    const add = batch.filter(x => !seen.has(x.key)).map(x => ({ x, d: decide(prefs, { kind: x.kind, urgent: x.urgent, event: x.event, test: x.test }, now) }))
      .filter(a => a.d.list);
    if (!add.length) return;
    setFeed(p => ({ items: [...add.map(a => a.x).reverse(), ...p.items].slice(0, 40), unread: p.unread + add.length }));
    const loud = add.filter(a => a.d.toast || a.d.sound || a.d.desktop);
    if (!loud.length) return;
    const ring = loud.find(a => a.d.sound);
    if (ring) chime(prefs.volume, ring.d.tone);
    const shown = loud.filter(a => a.d.toast).map(a => a.x);
    if (shown.length) setToast(shown);
    const desk = loud.filter(a => a.d.desktop).map(a => a.x);
    if (desk.length && typeof Notification !== 'undefined' && Notification.permission === 'granted' && (document.hidden || desk[0]!.test)) {
      const first = desk[0]!;
      const note = new Notification(desk.length === 1 ? headline(first) : `${desk.length} updates in Kaizen`,
        { body: desk.length === 1 ? first.title : desk.map(x => x.title).join(', '), tag: `kaizen-${first.kind}` });
      note.onclick = () => { window.focus(); if (desk.length === 1) openItem(first); note.close(); };
    }
  };

  useLive(n => arrive(n.fresh.map(fromWork)), tasks);
  useGuestFeed(messages, f => arrive(f.map(fromGuest)));
  useEffect(() => {
    const t = (e: Event) => arrive([(e as CustomEvent<BellItem>).detail]);
    addEventListener(BELL_TEST, t);
    return () => removeEventListener(BELL_TEST, t);
  });

  const [ready, setReady] = useState(soundReady());
  useEffect(() => {
    if (ready) return;
    const t = window.setInterval(() => { if (soundReady()) setReady(true); }, 1000);
    return () => window.clearInterval(t);
  }, [ready]);
  const both = tasks && messages;
  const list = feed.items.filter(x => (show === 'all' || x.kind === show) && (x.kind === 'tasks' ? tasks : messages));
  const paused = prefs.pausedUntil > Date.now();
  const title = both ? 'Notifications' : messages ? 'Guest messages' : 'Work updates';
  // 2026-11-17 (owner: "I don't hear them"): a browser keeps a page silent until it is clicked once. Until then a small
  // "Sound off" sits by the bell; its click turns sound on (and plays the tone, so it is heard working).
  const silent = !ready && !paused && ((messages && prefs.messages.on && prefs.messages.tone !== 'none') || (tasks && prefs.tasks.on && prefs.tasks.tone !== 'none'));
  return (
    <>
      {silent && <button type="button" className="sound-off" title="The browser keeps Kaizen silent until you click it once. Click to turn the sound on."
                         onClick={() => { testChime(prefs.volume, messages ? prefs.messages.tone : prefs.tasks.tone); }}>
        <Icon n="mute" /><span>Sound off</span></button>}
      <Popover align="right" className="live-bell" label={feed.unread ? `${feed.unread} notification${feed.unread === 1 ? '' : 's'}` : title}
               button={<span onClick={() => setFeed(p => p.unread ? { ...p, unread: 0 } : p)}>
                 <Icon n="bell" />{feed.unread > 0 && <span className="live-dot" aria-hidden="true" />}
                 {paused && <span className="live-paused" aria-label="Paused" />}</span>}>
        {close => (
          <div className="live-panel">
            <h3>{title} <Hint>{messages && <>Guests who write (and need an answer) show up here within about half a minute. </>}
              {tasks && <>To-dos, work orders and purchase orders made, done or cancelled by someone else — in Kaizen, Slack,
              Hostaway, a cleaner's report or an inspection — within about 10 seconds. </>}
              A hidden tab asks once a minute. The gear sets what rings, the tones, quiet hours and desktop notices, and has
              test buttons — for this browser only. The list here is this browser's too; the work itself is in Operations →
              To-do and the guests in the Inbox.</Hint>
              <button type="button" className="live-gear" aria-label="Notification settings" title="Notification settings"
                      onClick={() => { close(); setSettings(true); }}><Icon n="gear" /></button></h3>
            {paused && <p className="live-state"><Icon n="moon" /> Paused until {new Date(prefs.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              <button type="button" className="link tiny" onClick={() => setPrefs(p => ({ ...p, pausedUntil: 0 }))}>Resume</button></p>}
            {both && (
              <div className="live-tabs" role="tablist">
                {(['all', 'messages', 'tasks'] as const).map(k => (
                  <button key={k} type="button" role="tab" aria-selected={show === k} className={`chip${show === k ? ' active' : ''}`} onClick={() => setShow(k)}>
                    {k === 'all' ? 'All' : k === 'messages' ? <><Icon n="message" /> Messages</> : <><Icon n="clipboard" /> Tasks</>}</button>
                ))}
              </div>
            )}
            {list.length === 0 ? <p className="note live-empty">Nothing new since you opened Kaizen here.</p> : (
              <ul>
                {list.map(x => (
                  <li key={x.key}>
                    <button type="button" className="live-item" onClick={() => { close(); openItem(x); }}>
                      <span className="live-what">
                        <Icon n={x.kind === 'messages' ? 'message' : x.event === 'completed' ? 'done' : x.event === 'cancelled' ? 'ban' : 'clipboard'} />
                        {x.urgent && (x.kind === 'messages' || x.event === 'new') && <b className="live-urgent"><Icon n="alert" /> Urgent</b>}
                        {x.kind === 'tasks' && x.event && x.event !== 'new' && <b>{verb(x.event)}</b>}
                        <span>{x.kind === 'messages' ? `${x.what} wrote` : x.what}</span>
                        {x.test && <span className="live-test">Test</span>}
                      </span>
                      <span className="live-title">{x.title}</span>
                      <span className="note">{[x.by, ago(x.at)].filter(Boolean).join(' · ')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {feed.items.length > 0 && <button type="button" className="link tiny" onClick={() => setFeed({ items: [], unread: 0 })}>Clear all</button>}
          </div>
        )}
      </Popover>
      {settings && createPortal(<NotifySettings prefs={prefs} onChange={setPrefs} tasks={tasks} messages={messages} onClose={() => setSettings(false)} />, document.body)}
      {/* On the body: inside the side rail it would sit under an open panel (the rail's own stacking). */}
      {toast && createPortal(
        <div className="live-toast" role="status">
          <Icon n={toast[0]!.kind === 'messages' ? 'message' : 'bell'} />
          <span>{toast.length === 1 ? <>{headline(toast[0]!)}: <b>{toast[0]!.title}</b></> : <>{toast.length} new notifications</>}</span>
          {toast.length === 1 && !toast[0]!.test && <button type="button" className="link" onClick={() => { setFeed(p => ({ ...p, unread: Math.max(0, p.unread - 1) })); openItem(toast[0]!); }}>Open</button>}
          <button type="button" className="link" aria-label="Dismiss" onClick={() => setToast(null)}>✕</button>
        </div>, document.body
      )}
    </>
  );
}
