import { useEffect, useRef } from 'react';

/**
 * Links that follow the screen (owner, 2026-10-26): the address says which tab and which section is open,
 * so the browser's back / forward step through Kaizen, a reload stays put, and an address can be shared.
 *
 * A section is a step in history (push); an open record only rewrites the address (replace), so back
 * leaves the section instead of closing rows one by one. Path and hash are never touched — /crew,
 * /report, #crew/<name> and #as-cleaner/<name> keep meaning what they meant.
 */
export const param = (key: string) => new URLSearchParams(location.search).get(key);

// One click can change two sections in one render (Setup's gear: the view and its section) — one step, not two.
let burst = false;

/** Merge into the query (null / '' removes); `whole` drops every other key first — a tab change. */
export function setParams(changes: Record<string, string | null | undefined>, { replace = false, whole = false } = {}) {
  const q = new URLSearchParams(whole ? '' : location.search);
  for (const [k, v] of Object.entries(changes)) {
    if (v == null || v === '') q.delete(k); else q.set(k, v);
  }
  const s = q.toString();
  const url = location.pathname + (s ? `?${s}` : '') + location.hash;
  if (url === location.pathname + location.search + location.hash) return;
  if (replace || burst) { history.replaceState(history.state, '', url); return; }
  history.pushState(null, '', url);
  burst = true;
  queueMicrotask(() => { burst = false; });
}

/**
 * One piece of a screen's state, mirrored in the query as `key`. The address wins on mount and on
 * back / forward; afterwards every change is written. `def` is left out of the address (and is what a
 * missing key means); with no `def`, a missing key changes nothing and the first value only settles in.
 */
export function useUrlState<T extends string>(key: string, value: T | null, set: (v: T) => void, opts: {
  def?: T; valid?: (v: string) => boolean; replace?: boolean; on?: boolean;
} = {}) {
  const { def, valid = () => true, replace = false, on = true } = opts;
  const mounted = useRef(false);
  const read = () => {
    const v = param(key);
    if (v !== null && valid(v)) set(v as T);
    else if (v === null && def !== undefined) set(def);
  };
  useEffect(() => {
    if (!on) return;
    read();
    addEventListener('popstate', read);
    return () => removeEventListener('popstate', read);
  }, [on]);
  const prev = useRef<T | null>(null);
  useEffect(() => {
    if (!on) return;
    // The first render shows the screen's default; the address was just read and wins.
    if (!mounted.current) { mounted.current = true; prev.current = value; return; }
    const want = value == null || value === def ? null : value;
    if (want !== param(key)) setParams({ [key]: want }, { replace: replace || prev.current == null });
    prev.current = value;
  }, [value, on]);
}
