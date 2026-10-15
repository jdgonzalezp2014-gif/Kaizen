/**
 * Live work (§166): the bell. Work made, done or cancelled by someone else — from Kaizen, Slack, Hostaway, a
 * cleaner's report, an inspection — arrives while the app is open: a short notice at the bottom, a chime, a desktop
 * notice when the tab is hidden (if allowed), and a count on the bell until it is opened. The list is this browser's
 * own (a convenience, not a record: the work itself is in Operations → To-do), and keeps the last 30.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LiveFresh } from '../api.ts';
import { useLive } from './useLive.ts';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';
import { Hint } from './Hint.tsx';
import { chime, loadSound, saveSound, testChime, type SoundPrefs } from './chime.ts';

const KEY = 'kaizen.live.inbox';
type Inbox = { items: LiveFresh[]; unread: number };
const load = (): Inbox => {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (v && Array.isArray(v.items)) return v; } catch { /* private window */ }
  return { items: [], unread: 0 };
};
const save = (v: Inbox) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private window */ } };

const keyOf = (x: LiveFresh) => `${x.id}:${x.event ?? 'new'}`;
const what = (x: LiveFresh) => x.order ? 'Purchase order' : x.kind === 'work_order' ? 'Work order' : 'To-do';
const verb = (x: LiveFresh) => x.event === 'completed' ? 'Done' : x.event === 'cancelled' ? 'Cancelled' : 'New';
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const who = (x: LiveFresh) => x.createdBy ? x.createdBy.split('@')[0] : null;

const hasDesktop = typeof Notification !== 'undefined';
const PERM: Record<NotificationPermission, string> = {
  granted: 'On — shown when Kaizen is in another tab or window.',
  denied: 'Blocked — allow notifications for this site in the browser (the lock icon by the address).',
  default: 'Off — not asked yet.'
};

export function LiveBell({ onOpen }: { onOpen: (todoId: string) => void }) {
  const [inbox, setInbox] = useState<Inbox>(load);
  const [toast, setToast] = useState<LiveFresh[] | null>(null);
  const [prefs, setPrefs] = useState<SoundPrefs>(loadSound);
  const [gear, setGear] = useState(false);
  const [perm, setPerm] = useState<NotificationPermission>(hasDesktop ? Notification.permission : 'denied');
  useEffect(() => save(inbox), [inbox]);
  useEffect(() => saveSound(prefs), [prefs]);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(t);
  }, [toast]);

  useLive(n => {
    const seen = new Set(inbox.items.map(keyOf));
    const add = n.fresh.filter(x => !seen.has(keyOf(x)) && prefs.events[x.event ?? 'new']);
    if (!add.length) return;
    setInbox(p => ({ items: [...add.reverse(), ...p.items].slice(0, 30), unread: p.unread + add.length }));
    setToast(add);
    if (prefs.on) chime(prefs.volume);
    if (hasDesktop && Notification.permission === 'granted' && document.hidden) {
      const first = add[0]!;
      const note = new Notification(add.length === 1 ? `${verb(first)} ${what(first).toLowerCase()}` : `${add.length} updates in Kaizen`,
        { body: add.length === 1 ? `${first.title}${first.units ? ` · ${first.units}` : ''}` : add.map(x => x.title).join(', '), tag: 'kaizen-live' });
      note.onclick = () => { window.focus(); if (add.length === 1) onOpen(first.id); note.close(); };
    }
  });

  const ask = async () => { if (hasDesktop) setPerm(await Notification.requestPermission()); };
  const ev = (k: keyof SoundPrefs['events'], label: string) => (
    <label><input type="checkbox" checked={prefs.events[k]} onChange={e => setPrefs(p => ({ ...p, events: { ...p.events, [k]: e.target.checked } }))} /> {label}</label>
  );
  const open = (id: string) => { setToast(null); onOpen(id); };
  const urgent = (x: LiveFresh) => x.priority === 'urgent' || x.priority === 'high';
  return (
    <>
      <Popover align="right" className="live-bell" label={inbox.unread ? `${inbox.unread} update${inbox.unread === 1 ? '' : 's'}` : 'Work updates'}
               button={<span onClick={() => setInbox(p => p.unread ? { ...p, unread: 0 } : p)}>
                 <Icon n="bell" />{inbox.unread > 0 && <b className="live-count">{inbox.unread > 9 ? '9+' : inbox.unread}</b>}</span>}>
        {close => (
          <div className="live-panel">
            <h3>Work updates <Hint>To-dos, work orders and purchase orders made, done or cancelled by someone else — in Kaizen,
              Slack, Hostaway, a cleaner's report or an inspection — show up here while Kaizen is open, within about 10 seconds
              (once a minute when Kaizen is in a hidden tab). The gear picks which ones, the sound and desktop notices, for
              this browser only. A browser plays sound only after you have clicked somewhere in Kaizen since opening it; desktop
              notices need your permission once and show only while Kaizen is open somewhere. The work itself is in
              Operations → To-do.</Hint>
              <button type="button" className="live-gear" aria-label="Notification settings" aria-expanded={gear} title="Notification settings"
                      onClick={() => setGear(v => !v)}><Icon n="gear" /></button></h3>
            {gear && (
              <div className="live-sound">
                <div className="live-row">{ev('new', 'New')}{ev('completed', 'Done')}{ev('cancelled', 'Cancelled')}</div>
                <div className="live-row">
                  <label><input type="checkbox" checked={prefs.on} onChange={e => setPrefs(p => ({ ...p, on: e.target.checked }))} /> Sound</label>
                  <input type="range" min={0} max={1} step={0.05} value={prefs.volume} disabled={!prefs.on} aria-label="Volume"
                         onChange={e => setPrefs(p => ({ ...p, volume: Number(e.target.value) }))} />
                  <span className="note live-pct">{Math.round(prefs.volume * 100)}%</span>
                  <button type="button" className="link tiny" disabled={!prefs.on} onClick={() => testChime(prefs.volume)}>Test</button>
                </div>
                <div className="live-row">
                  <span className={`note${perm === 'denied' ? ' live-warn' : ''}`}>
                    {perm === 'denied' && <Icon n="warning" />} <b>Desktop:</b> {hasDesktop ? PERM[perm] : 'This browser has no desktop notices.'}</span>
                  {perm === 'default' && <button type="button" className="link tiny" onClick={() => void ask()}>Turn on</button>}
                </div>
              </div>
            )}
            {inbox.items.length === 0 ? <p className="note">Nothing new since you opened Kaizen here.</p> : (
              <ul>
                {inbox.items.map(x => (
                  <li key={keyOf(x)}>
                    <button type="button" className="live-item" onClick={() => { close(); open(x.id); }}>
                      <span className="live-what">{urgent(x) && x.event === 'new' && <><Icon n="alert" /> <b>{x.priority === 'urgent' ? 'Urgent' : 'High'}</b> · </>}
                        {x.event && x.event !== 'new' && <><Icon n={x.event === 'completed' ? 'done' : 'ban'} /> <b>{verb(x)}</b> · </>}{what(x)}{x.units ? ` · ${x.units}` : ''}</span>
                      <span className="live-title">{x.title}</span>
                      <span className="note">{[who(x), ago(x.createdAt)].filter(Boolean).join(' · ')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {inbox.items.length > 0 && <button type="button" className="link tiny" onClick={() => setInbox({ items: [], unread: 0 })}>Clear</button>}
          </div>
        )}
      </Popover>
      {/* On the body: inside the side rail it would sit under an open panel (the rail's own stacking). */}
      {toast && createPortal(
        <div className="live-toast" role="status">
          <Icon n="bell" />
          <span>{toast.length === 1
            ? <>{verb(toast[0]!)} {what(toast[0]!).toLowerCase()}{toast[0]!.units ? ` · ${toast[0]!.units}` : ''}: <b>{toast[0]!.title}</b></>
            : <>{toast.length} updates</>}</span>
          {toast.length === 1 && <button type="button" className="link" onClick={() => { setInbox(p => ({ ...p, unread: Math.max(0, p.unread - 1) })); open(toast[0]!.id); }}>Open</button>}
          <button type="button" className="link" aria-label="Dismiss" onClick={() => setToast(null)}>✕</button>
        </div>, document.body
      )}
    </>
  );
}
