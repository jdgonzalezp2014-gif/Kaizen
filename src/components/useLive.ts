/**
 * Live work (§166): one quiet question every few seconds — "has any work moved?" — shared by every screen that
 * shows work, so two lists on screen still ask once. Only while the page is visible (a hidden tab costs nothing,
 * and asks again the moment it is back). The answer is two signatures; a screen reloads its list only when one
 * differs from the last answer, whoever moved it: the app, Slack, Hostaway's pull, a cleaner's or a vendor's link.
 */
import { useEffect, useRef } from 'react';
import { getLive, type LiveFresh } from '../api.ts';

export interface LiveNews { todos: boolean; claims: boolean; fresh: LiveFresh[] }
type Listener = (n: LiveNews) => void;

const EVERY_MS = 10_000;
const listeners = new Set<Listener>();
let last: { todos: string; claims: string; top: string } | null = null;
let timer: number | undefined;
let asking = false;

async function ask() {
  if (asking || document.hidden) return;
  asking = true;
  try {
    const r = await getLive(last?.top);
    if (!r.ok) return;
    // The first answer is where this page starts: nothing has "moved" yet.
    const news: LiveNews | null = last && {
      todos: r.todos !== last.todos, claims: r.claims !== last.claims, fresh: r.fresh
    };
    last = { todos: r.todos, claims: r.claims, top: r.top };
    if (news && (news.todos || news.claims || news.fresh.length)) for (const f of listeners) f(news);
  } catch { /* offline for a moment: the next tick asks again */ }
  finally { asking = false; }
}

const onVisible = () => { if (!document.hidden) void ask(); };

function start() {
  if (timer !== undefined) return;
  void ask();
  timer = window.setInterval(() => void ask(), EVERY_MS);
  document.addEventListener('visibilitychange', onVisible);
}

function stop() {
  window.clearInterval(timer); timer = undefined;
  document.removeEventListener('visibilitychange', onVisible);
}

/** Calls `on` whenever work moved since the last answer. Mount it where a list or the bell lives. */
export function useLive(on: Listener, enabled = true) {
  const ref = useRef(on);
  ref.current = on;
  useEffect(() => {
    if (!enabled) return;
    const f: Listener = n => ref.current(n);
    listeners.add(f); start();
    return () => { listeners.delete(f); if (!listeners.size) stop(); };
  }, [enabled]);
}
