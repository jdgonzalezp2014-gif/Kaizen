/**
 * The wait, with a number on it.
 *
 * People are impatient and a bare "Loading…" gives them nothing to
 * judge: at three seconds and at thirty it says exactly the same thing.
 * This shows how far along the wait is against how long it took last
 * time, and names the step it is on.
 *
 * It is an estimate and says so. What it never does is claim to be
 * finished — see progressAt.
 */
import { useEffect, useState } from 'react';
import { progressAt } from '../lib/progress.ts';

export function Loading({ estimateMs, stages, note }: {
  estimateMs: number;
  /** Shown in order, each for its share of the estimate. */
  stages: string[];
  note?: string;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    // 100ms: fast enough to read as motion, slow enough that a long wait
    // is not a hundred renders a second on someone's laptop fan.
    const id = window.setInterval(() => setElapsed(Date.now() - started), 100);
    return () => window.clearInterval(id);
  }, []);

  const p = progressAt(elapsed, estimateMs);
  // Stages advance with the bar rather than on their own timer, so the
  // label can never describe a step the bar has already passed.
  const stage = stages[Math.min(stages.length - 1, Math.floor(p * stages.length))];
  const overrun = elapsed > estimateMs * 1.6;

  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="loading-head">
        <span className="loading-stage">{stage}</span>
        <span className="loading-pct">{Math.round(p * 100)}%</span>
      </div>
      <div className="loading-track">
        <div className="loading-fill" style={{ width: `${p * 100}%` }} />
      </div>
      <p className="note">
        {overrun
          // Said plainly rather than left to a frozen bar. Slower than
          // usual is information; a stuck bar is just alarming.
          ? `Taking longer than usual — ${Math.round(elapsed / 1000)}s so far.`
          : (note ?? 'Estimated from how long this took last time.')}
      </p>
    </div>
  );
}
