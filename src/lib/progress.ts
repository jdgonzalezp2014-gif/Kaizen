/**
 * How far along a wait is, honestly.
 *
 * A percentage nobody can justify is a lie with a progress bar around it,
 * and people learn to distrust it within a week. This one is an estimate
 * against a MEASURED baseline — how long this exact call took last time,
 * which the API already reports as `tookMs` — and it is labelled as an
 * estimate.
 *
 * Two rules keep it honest:
 *
 *   · it never reaches 100% on its own. Completion is the response
 *     landing, not a timer expiring.
 *   · it never stalls at a wall. A bar frozen at 95% for eight seconds
 *     is worse than no bar: it says "something is broken" when nothing
 *     is. This curve keeps moving, just slower, for as long as the wait
 *     lasts.
 */

/**
 * Asymptotic: reaches ~80% at the expected duration and keeps creeping
 * afterwards without ever arriving. An overrun looks like a slow finish,
 * which is what it is, rather than like a hang.
 */
export function progressAt(elapsedMs: number, estimateMs: number): number {
  const est = Math.max(400, estimateMs);
  const p = 1 - Math.exp(-1.6 * (elapsedMs / est));
  return Math.max(0, Math.min(0.99, p));
}

const KEY = 'kaizen-timing';

/**
 * Remembered per browser, because it is a per-viewer convenience and the
 * right estimate depends on their connection as much as on the server.
 * Wrapped: a blocked store costs the estimate, never the page.
 */
export function rememberTiming(name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
    const prev = all[name];
    // Averaged with the previous reading rather than replaced, so one
    // unusually slow call does not make every later bar crawl.
    all[name] = prev ? Math.round(prev * 0.6 + ms * 0.4) : Math.round(ms);
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* an estimate is not worth an exception */ }
}

export function recallTiming(name: string, fallbackMs: number): number {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
    const v = all[name];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallbackMs;
  } catch {
    return fallbackMs;
  }
}
