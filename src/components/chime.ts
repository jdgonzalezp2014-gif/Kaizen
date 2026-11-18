/**
 * The bell's sounds (§166, tones 2026-11-17): short notes made by the browser (Web Audio) — no file to load. A browser
 * lets a page play sound only after a click or a key on it, so the context is opened on the first one; until then it
 * stays quiet. Each tone is a few [frequency, start, length] notes.
 */
import type { Tone } from '../lib/notify.ts';

type Note = [freq: number, at: number, len: number];
const NOTES: Record<Exclude<Tone, 'none'>, { type: OscillatorType; notes: Note[]; peak: number }> = {
  chime: { type: 'sine', peak: 0.35, notes: [[880, 0, 0.5], [1318.5, 0.14, 0.5]] },
  ding: { type: 'triangle', peak: 0.4, notes: [[1567.98, 0, 0.7]] },
  soft: { type: 'sine', peak: 0.25, notes: [[523.25, 0, 0.6], [659.25, 0.18, 0.7]] },
  pulse: { type: 'square', peak: 0.08, notes: [[987.77, 0, 0.09], [987.77, 0.15, 0.09], [987.77, 0.3, 0.09]] }
};

let ctx: AudioContext | null = null;
const unlock = (): Promise<void> => { try { ctx ??= new AudioContext(); return ctx.resume(); } catch { return Promise.resolve(); /* no Web Audio */ } };
if (typeof window !== 'undefined') {
  addEventListener('pointerdown', () => void unlock(), { once: true });
  addEventListener('keydown', () => void unlock(), { once: true });
}
/** Whether a sound can play now (false until the first click or key since Kaizen opened). */
export const soundReady = () => ctx?.state === 'running';

export function chime(volume: number, tone: Tone = 'chime') {
  if (!ctx || ctx.state !== 'running' || volume <= 0 || tone === 'none') return;
  const s = NOTES[tone], t = ctx.currentTime;
  for (const [freq, start, len] of s.notes) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = s.type; osc.frequency.value = freq;
    const at = t + start;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(s.peak * volume, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at); osc.stop(at + len + 0.05);
  }
}

/** For a "Play" button: it is a click, so the context can open right there. */
// The context opens asynchronously: the note waits for it, or the first click would stay silent.
export function testChime(volume: number, tone: Tone = 'chime') { void unlock().then(() => chime(volume, tone)); }
