/**
 * The bell's preferences (owner 2026-11-17: guest messages and task alerts in one bell, with one settings menu).
 * Per browser, like the theme — a convenience, not a record. Pure: what to do with one notice, given the
 * preferences and the clock, so the rules (quiet hours across midnight, "urgent only", pause) are tested here.
 */
export type Kind = 'messages' | 'tasks';
export type Tone = 'chime' | 'ding' | 'soft' | 'pulse' | 'none';
export const TONES: { id: Tone; label: string }[] = [
  { id: 'chime', label: 'Chime' }, { id: 'ding', label: 'Ding' }, { id: 'soft', label: 'Soft' }, { id: 'pulse', label: 'Pulse' }, { id: 'none', label: 'Silent' }
];

export interface Channel { on: boolean; urgentOnly: boolean; tone: Tone; toast: boolean; desktop: boolean }
export interface NotifyPrefs {
  messages: Channel;
  tasks: Channel & { events: { new: boolean; completed: boolean; cancelled: boolean } };
  volume: number;
  /** "HH:MM" in this browser's clock; `to` earlier than `from` means the window runs past midnight. */
  quiet: { on: boolean; from: string; to: string; urgentRings: boolean };
  /** Epoch ms: everything is silent (the list still fills) until then. 0 = not paused. */
  pausedUntil: number;
}

export const DEFAULT_PREFS: NotifyPrefs = {
  messages: { on: true, urgentOnly: false, tone: 'ding', toast: true, desktop: true },
  tasks: { on: true, urgentOnly: false, tone: 'chime', toast: true, desktop: true, events: { new: true, completed: true, cancelled: true } },
  volume: 0.6,
  quiet: { on: false, from: '22:00', to: '07:00', urgentRings: true },
  pausedUntil: 0
};

const isTone = (t: unknown): t is Tone => TONES.some(x => x.id === t);
const hhmm = (s: unknown, d: string) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : d;
const bool = (v: unknown, d: boolean) => typeof v === 'boolean' ? v : d;
function channel<T extends Channel>(raw: unknown, d: T): T {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { ...d, on: bool(r.on, d.on), urgentOnly: bool(r.urgentOnly, d.urgentOnly), tone: isTone(r.tone) ? r.tone : d.tone,
           toast: bool(r.toast, d.toast), desktop: bool(r.desktop, d.desktop) };
}

/** Whatever was stored (or nothing, or the bell's first settings `{on, volume, events}` of §166) → full preferences. */
export function normalizePrefs(raw: unknown, legacy?: unknown): NotifyPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const l = (legacy && typeof legacy === 'object' ? legacy : null) as Record<string, any> | null;
  const D = DEFAULT_PREFS;
  const tasks = channel(r.tasks, D.tasks);
  const ev = r.tasks?.events ?? l?.events ?? {};
  tasks.events = { new: bool(ev.new, true), completed: bool(ev.completed, true), cancelled: bool(ev.cancelled, true) };
  if (!r.tasks && l && l.on === false) tasks.tone = 'none';
  const vol = typeof r.volume === 'number' ? r.volume : typeof l?.volume === 'number' ? l.volume : D.volume;
  const q = r.quiet ?? {};
  return {
    messages: channel(r.messages, D.messages), tasks,
    volume: Math.min(1, Math.max(0, vol)),
    quiet: { on: bool(q.on, D.quiet.on), from: hhmm(q.from, D.quiet.from), to: hhmm(q.to, D.quiet.to), urgentRings: bool(q.urgentRings, D.quiet.urgentRings) },
    pausedUntil: typeof r.pausedUntil === 'number' && r.pausedUntil > 0 ? r.pausedUntil : 0
  };
}

const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
export function inQuiet(q: NotifyPrefs['quiet'], now: Date): boolean {
  if (!q.on) return false;
  const m = now.getHours() * 60 + now.getMinutes(), a = mins(q.from), b = mins(q.to);
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

export interface Notice { kind: Kind; urgent: boolean; event?: 'new' | 'completed' | 'cancelled' | null; test?: boolean }
export interface Decision { list: boolean; sound: boolean; toast: boolean; desktop: boolean; tone: Tone; why?: string }

/** What one notice does. `list` = it goes in the bell; the rest are the interruptions, which pause and quiet hours mute. */
export function decide(p: NotifyPrefs, n: Notice, now: Date): Decision {
  const c = p[n.kind];
  const none = (why: string, list: boolean): Decision => ({ list, sound: false, toast: false, desktop: false, tone: c.tone, why });
  if (!n.test) {
    if (!c.on) return none('off', false);
    if (n.kind === 'tasks' && !p.tasks.events[n.event ?? 'new']) return none('event', false);
    if (c.urgentOnly && !n.urgent) return none('urgent only', false);
  }
  if (p.pausedUntil > now.getTime()) return none('paused', true);
  if (inQuiet(p.quiet, now) && !(n.urgent && p.quiet.urgentRings)) return none('quiet hours', true);
  return { list: true, sound: c.tone !== 'none' && p.volume > 0, toast: c.toast, desktop: c.desktop, tone: c.tone };
}
