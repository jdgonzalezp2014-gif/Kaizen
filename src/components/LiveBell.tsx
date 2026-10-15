/**
 * Live work (§166): the bell in the header. New to-dos made by someone else — from Kaizen, Slack, Hostaway, a
 * cleaner's report, an inspection — arrive while the app is open: a short notice at the bottom, and a count on
 * the bell until it is opened. The list is this browser's own (it is a convenience, not a record: the work itself
 * is in Operations → To-do), and keeps the last 30.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LiveFresh } from '../api.ts';
import { useLive } from './useLive.ts';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';
import { Hint } from './Hint.tsx';

const KEY = 'kaizen.live.inbox';
type Inbox = { items: LiveFresh[]; unread: number };
const load = (): Inbox => {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (v && Array.isArray(v.items)) return v; } catch { /* private window */ }
  return { items: [], unread: 0 };
};
const save = (v: Inbox) => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private window */ } };

const what = (x: LiveFresh) => x.order ? 'Purchase order' : x.kind === 'work_order' ? 'Work order' : 'To-do';
const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const who = (x: LiveFresh) => x.createdBy ? x.createdBy.split('@')[0] : null;

export function LiveBell({ onOpen }: { onOpen: (todoId: string) => void }) {
  const [inbox, setInbox] = useState<Inbox>(load);
  const [toast, setToast] = useState<LiveFresh[] | null>(null);
  useEffect(() => save(inbox), [inbox]);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(t);
  }, [toast]);

  useLive(n => {
    if (!n.fresh.length) return;
    const seen = new Set(inbox.items.map(x => x.id));
    const add = n.fresh.filter(x => !seen.has(x.id));
    if (!add.length) return;
    setInbox(p => ({ items: [...add.reverse(), ...p.items].slice(0, 30), unread: p.unread + add.length }));
    setToast(add);
  });

  const open = (id: string) => { setToast(null); onOpen(id); };
  const urgent = (x: LiveFresh) => x.priority === 'urgent' || x.priority === 'high';
  return (
    <>
      <Popover align="right" className="live-bell" label={inbox.unread ? `${inbox.unread} new to-do${inbox.unread === 1 ? '' : 's'}` : 'New work'}
               button={<span onClick={() => setInbox(p => p.unread ? { ...p, unread: 0 } : p)}>
                 <Icon n="bell" />{inbox.unread > 0 && <b className="live-count">{inbox.unread > 9 ? '9+' : inbox.unread}</b>}</span>}>
        {close => (
          <div className="live-panel">
            <h3>New work <Hint>To-dos, work orders and purchase orders made by someone else — in Kaizen, Slack, Hostaway,
              a cleaner's report or an inspection — show up here while Kaizen is open, within about 10 seconds (Hostaway's own
              tasks when Kaizen next reads Hostaway). Lists on screen update by themselves too. This list lives in this
              browser only; the work itself is in Operations → To-do.</Hint></h3>
            {inbox.items.length === 0 ? <p className="note">Nothing new since you opened Kaizen here.</p> : (
              <ul>
                {inbox.items.map(x => (
                  <li key={x.id}>
                    <button type="button" className="live-item" onClick={() => { close(); open(x.id); }}>
                      <span className="live-what">{urgent(x) && <><Icon n="alert" /> <b>{x.priority === 'urgent' ? 'Urgent' : 'High'}</b> · </>}{what(x)}{x.units ? ` · ${x.units}` : ''}</span>
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
            ? <>New {what(toast[0]!).toLowerCase()}{toast[0]!.units ? ` · ${toast[0]!.units}` : ''}: <b>{toast[0]!.title}</b></>
            : <>{toast.length} new to-dos</>}</span>
          {toast.length === 1 && <button type="button" className="link" onClick={() => { setInbox(p => ({ ...p, unread: Math.max(0, p.unread - 1) })); open(toast[0]!.id); }}>Open</button>}
          <button type="button" className="link" aria-label="Dismiss" onClick={() => setToast(null)}>✕</button>
        </div>, document.body
      )}
    </>
  );
}
