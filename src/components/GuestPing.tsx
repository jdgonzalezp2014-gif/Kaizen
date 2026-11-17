/**
 * Guests waiting for an answer, live (Guest Services → Inbox, owner 2026-11-16): a count on the menu's Guest Services
 * and a desktop notice when a guest writes — while Kaizen is open in a tab, even a hidden one. It reads Kaizen's own
 * `guest_events` (what Hostaway's webhook reported, sorted by a light model so "thanks!" does not count), never
 * Hostaway itself, so asking every half minute costs one small query. No webhook connected = it stays at zero.
 *
 * One poll for the whole app, however many places draw the count.
 */
import { useEffect, useState } from 'react';
import { getInboxEvents } from '../api.ts';

/** Fired on `window` when a guest wrote: the Inbox reloads its list at once instead of at its next quiet reload. */
export const GUEST_EVENT = 'kaizen-guest-event';

let waiting = 0, last = -1, timer: number | undefined, users = 0;
const subs = new Set<(n: number) => void>();
let open: (conversationId: string) => void = () => {};

async function tick() {
  const r = await getInboxEvents(Math.max(0, last)).catch(() => null);
  if (!r?.ok) return;
  // The first answer only sets the mark: what was already waiting when Kaizen opened is a count, not a burst of notices.
  const fresh = last < 0 ? [] : r.fresh;
  last = r.last;
  if (r.waiting !== waiting) { waiting = r.waiting; subs.forEach(f => f(waiting)); }
  if (!fresh.length) return;
  window.dispatchEvent(new CustomEvent(GUEST_EVENT));
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  const first = fresh[0]!;
  const note = new Notification(fresh.length === 1 ? `${first.urgent ? 'Urgent — ' : ''}${first.guest} wrote` : `${fresh.length} guests wrote`,
    { body: fresh.length === 1 ? first.preview : fresh.map(f => f.guest).join(', '), tag: 'kaizen-guests' });
  note.onclick = () => { window.focus(); open(first.conversationId); note.close(); };
}
const loop = () => { void tick(); timer = window.setTimeout(loop, document.hidden ? 60_000 : 30_000); };

/** The count beside "Guest Services". `onOpen` is where a notice's click lands: that guest's conversation. */
export function GuestPing({ onOpen }: { onOpen: (conversationId: string) => void }) {
  const [n, setN] = useState(waiting);
  open = onOpen;
  useEffect(() => {
    subs.add(setN);
    if (users++ === 0) loop();
    return () => { subs.delete(setN); if (--users === 0) window.clearTimeout(timer); };
  }, []);
  return n > 0 ? <b className="live-count guest-ping" title={`${n} guest${n === 1 ? '' : 's'} waiting for an answer`}>{n > 9 ? '9+' : n}</b> : null;
}
