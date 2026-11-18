/**
 * Guests waiting for an answer, live (Guest Services → Inbox, owner 2026-11-16): a count on the menu's Guest Services
 * and a notice in the bell when a guest writes — while Kaizen is open in a tab, even a hidden one. It reads Kaizen's own
 * `guest_events` (what Hostaway's webhook reported, sorted by a light model so "thanks!" does not count), never
 * Hostaway itself, so asking every half minute costs one small query. No webhook connected = it stays at zero.
 *
 * One poll for the whole app, however many places draw the count. What a guest wrote goes to the bell
 * (`onGuestFresh`), which decides the sound, the notice on screen and the desktop notice by its settings.
 */
import { useEffect, useRef, useState } from 'react';
import { getInboxEvents, type InboxEvents } from '../api.ts';

/** Fired on `window` when a guest wrote: the Inbox reloads its list at once instead of at its next quiet reload. */
export const GUEST_EVENT = 'kaizen-guest-event';

let waiting = 0, last = -1, timer: number | undefined, users = 0;
const subs = new Set<(n: number) => void>();
export type GuestFresh = InboxEvents['fresh'][number];
const feeds = new Set<(f: GuestFresh[]) => void>();

async function tick() {
  const r = await getInboxEvents(Math.max(0, last)).catch(() => null);
  if (!r?.ok) return;
  // The first answer only sets the mark: what was already waiting when Kaizen opened is a count, not a burst of notices.
  const fresh = last < 0 ? [] : r.fresh;
  last = r.last;
  if (r.waiting !== waiting) { waiting = r.waiting; subs.forEach(f => f(waiting)); }
  if (!fresh.length) return;
  window.dispatchEvent(new CustomEvent(GUEST_EVENT));
  feeds.forEach(f => f(fresh));
}
const loop = () => { void tick(); timer = window.setTimeout(loop, document.hidden ? 60_000 : 30_000); };
const start = () => { if (users++ === 0) loop(); };
const stop = () => { if (--users === 0) window.clearTimeout(timer); };

/** The bell's side: called with each batch of guests who just wrote. Keeps the poll running while mounted. */
export function useGuestFeed(on: boolean, cb: (f: GuestFresh[]) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    if (!on) return;
    const f = (x: GuestFresh[]) => ref.current(x);
    feeds.add(f); start();
    return () => { feeds.delete(f); stop(); };
  }, [on]);
}

/** The count beside the CRM; `dot`: only a red dot, on Guest Services' icon (owner, 2026-11-17). */
export function GuestPing({ dot = false }: { dot?: boolean }) {
  const [n, setN] = useState(waiting);
  useEffect(() => {
    subs.add(setN); start();
    return () => { subs.delete(setN); stop(); };
  }, []);
  if (dot) return n > 0 ? <span className="guest-dot" role="img" aria-label={`${n} guest${n === 1 ? '' : 's'} waiting`} /> : null;
  return n > 0 ? <b className="live-count guest-ping" title={`${n} guest${n === 1 ? '' : 's'} waiting for an answer`}>{n > 9 ? '9+' : n}</b> : null;
}
