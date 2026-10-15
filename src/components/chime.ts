/**
 * The bell's sound (§166): two short notes made by the browser (Web Audio) — no file to load. A browser lets a page
 * play sound only after a click or a key on it, so the context is opened on the first one; until then it stays quiet.
 */
const KEY = 'kaizen.live.sound';
export interface SoundPrefs { on: boolean; volume: number; events: { new: boolean; completed: boolean; cancelled: boolean } }
const DEFAULT: SoundPrefs = { on: true, volume: 0.6, events: { new: true, completed: true, cancelled: true } };

export const loadSound = (): SoundPrefs => {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (v && typeof v.volume === 'number') return { ...DEFAULT, ...v, events: { ...DEFAULT.events, ...v.events } }; } catch { /* private window */ }
  return DEFAULT;
};
export const saveSound = (p: SoundPrefs) => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private window */ } };

let ctx: AudioContext | null = null;
const unlock = () => { ctx ??= new AudioContext(); void ctx.resume(); };
if (typeof window !== 'undefined') {
  addEventListener('pointerdown', unlock, { once: true });
  addEventListener('keydown', unlock, { once: true });
}

export function chime(volume: number) {
  if (!ctx || ctx.state !== 'running' || volume <= 0) return;
  const t = ctx.currentTime;
  for (const [i, freq] of [880, 1318.5].entries()) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = freq;
    const at = t + i * 0.14;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.35 * volume, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at); osc.stop(at + 0.55);
  }
}

/** For the "Test" button: it is a click, so the context can open right there. */
export function testChime(volume: number) { unlock(); chime(volume); }
