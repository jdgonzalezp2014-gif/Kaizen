/**
 * The cleaners' own Slack channels (§134) — pure: when the reminders are
 * due, and what the messages say, in the cleaner's language.
 *
 *  - 9 AM: today's cleans; 6 PM: tomorrow's (team time, Central by default) —
 *    only when there is something, with the four steps of a clean recalled;
 *  - as it happens: what their helpers report through a clean's link (photos,
 *    what they took from the storage, done, a problem or a need).
 * Off until switched on in Settings → Slack → Cleaners' channels.
 */
import { esc } from './slack.ts';
import { bedsWord, dayLabel, type Lang } from './crew-i18n.ts';

export interface CrewChannels { reminders?: boolean; morning?: string; evening?: string; helperNotices?: boolean }
export const DEFAULT_CREW_CHANNELS: Required<CrewChannels> = { reminders: false, morning: '09:00', evening: '18:00', helperNotices: false };
export const crewChannelsOf = (c?: CrewChannels | null): Required<CrewChannels> => ({ ...DEFAULT_CREW_CHANNELS, ...(c ?? {}) });

const nextDay = (d: string) => new Date(Date.parse(`${d}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);

/**
 * Which reminders are due now: today's from `morning` until 1 PM, tomorrow's
 * from `evening` until 11:30 PM — a clock that ran late still sends, one
 * that comes back at midnight does not wake anyone.
 */
export function dueCrewReminders(now: { day: string; hm: string }, cfg?: CrewChannels | null): { kind: 'today' | 'tomorrow'; day: string }[] {
  const c = crewChannelsOf(cfg);
  if (!c.reminders) return [];
  const out: { kind: 'today' | 'tomorrow'; day: string }[] = [];
  // An empty time is that reminder off (owner, Oct 2026: only tomorrow's, at 6 PM).
  if (c.morning && now.hm >= c.morning && now.hm < '13:00') out.push({ kind: 'today', day: now.day });
  if (c.evening && now.hm >= c.evening && now.hm < '23:30') out.push({ kind: 'tomorrow', day: nextDay(now.day) });
  return out;
}

type Block = Record<string, unknown>;
const section = (text: string): Block => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text: string): Block => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

// midStay: a manual clean while the guest stays (§79) — no checkout to name.
// checkin: the next guest's check-in time when they arrive that same day (it may be early).
export interface CrewClean { unit: string; time: string; beds?: number | null; deep?: boolean; sameDay?: boolean; midStay?: boolean; checkin?: string | null }

/** "10:00 AM" → minutes since midnight; null when it does not read as a time. */
const minutesOf = (t: string): number | null => {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M\.?$/i.exec(t.trim());
  if (!m) return null;
  return (Number(m[1]) % 12 + ((m[3] ?? '').toUpperCase() === 'P' ? 12 : 0)) * 60 + Number(m[2] ?? 0);
};

/**
 * By when a clean must be done (owner, 2026-10-14): never "no check-in" — that made cleaners go late.
 * The next guest's check-in that day, if any (it may be an early one); else 4 PM, unless the checkout
 * is a late one (1 PM or later), where 4 PM is not the rule — nothing is said. A mid-stay has none.
 */
export function readyBy(c: CrewClean): { time: string; checkin: boolean } | null {
  if (c.midStay) return null;
  if (c.checkin) return { time: c.checkin, checkin: true };
  const out = minutesOf(c.time);
  if (out !== null && out >= 13 * 60) return null;
  return { time: '4:00 PM', checkin: false };
}

const W = {
  en: {
    head: (k: 'today' | 'tomorrow', d: string, n: number) => `${k === 'today' ? '☀️ Today' : '🌙 Tomorrow'}, ${d} — ${n} clean${n === 1 ? '' : 's'}`,
    checkout: 'checkout', midStay: '🧹 mid-stay clean',
    ready: (t: string, ci: boolean) => `⏰ ready by ${t}${ci ? ' (next guest checks in)' : ''}`, deep: '🧽 deep',
    steps: 'At each clean: 1 📷 photos BEFORE · 2 🧴 what you took from storage · 3 📷 photos AFTER · 4 ✅ mark it done — in Options… on your page. If something changes, your page has the latest.',
    open: 'Open my page',
    stage: { before: 'BEFORE', after: 'AFTER' }, photos: (n: number) => `${n} photo${n === 1 ? '' : 's'}`,
    extra: 'added an extra:', declined: "can't do it", reply: '💬 The team answers in this thread.',
    took: 'took from storage:', nothing: 'took nothing from storage', done: 'marked it ✅ done', reopened: 'reopened it ↩️',
    what: { problem: '⚠️ Something is wrong', request: '🧴 Requests supplies', missing: '❓ Something is missing', purchase: '🛒 Bought' } as Record<string, string>,
    urg: { urgent: '🔴 urgent', high: '🟠 soon', low: '⚪ when possible' } as Record<string, string>
  },
  es: {
    head: (k: 'today' | 'tomorrow', d: string, n: number) => `${k === 'today' ? '☀️ Hoy' : '🌙 Mañana'}, ${d} — ${n} ${n === 1 ? 'limpieza' : 'limpiezas'}`,
    checkout: 'salida', midStay: '🧹 limpieza durante la estadía',
    ready: (t: string, ci: boolean) => `⏰ lista a las ${t}${ci ? ' (entra el siguiente huésped)' : ''}`, deep: '🧽 profunda',
    steps: 'En cada limpieza: 1 📷 fotos ANTES · 2 🧴 lo que tomaste del storage · 3 📷 fotos DESPUÉS · 4 ✅ marcar completada — en Opciones… de tu página. Si algo cambia, tu página tiene lo último.',
    open: 'Abrir mi página',
    stage: { before: 'ANTES', after: 'DESPUÉS' }, photos: (n: number) => `${n} ${n === 1 ? 'foto' : 'fotos'}`,
    extra: 'agregó un extra:', declined: 'no puede hacerla', reply: '💬 El equipo responde en este hilo.',
    took: 'tomó del storage:', nothing: 'no tomó nada del storage', done: 'la marcó ✅ completada', reopened: 'la reabrió ↩️',
    what: { problem: '⚠️ Algo está mal', request: '🧴 Pide insumos', missing: '❓ Falta algo', purchase: '🛒 Compró' } as Record<string, string>,
    urg: { urgent: '🔴 urgente', high: '🟠 pronto', low: '⚪ cuando se pueda' } as Record<string, string>
  }
};

/** Today's or tomorrow's cleans for one cleaner, in their language. */
export function crewDayMessage(lang: Lang, kind: 'today' | 'tomorrow', day: string, cleans: CrewClean[], appUrl?: string) {
  const w = W[lang];
  const head = w.head(kind, dayLabel(lang, day), cleans.length);
  const lines = cleans.map(c => ({ c, by: readyBy(c) })).map(({ c, by }) => [`• *${esc(c.unit)}*`, c.beds ? bedsWord(lang, c.beds) : '', c.midStay ? w.midStay + (c.time ? ` ${esc(c.time)}` : '') : `${w.checkout} ${esc(c.time)}`,
    by ? w.ready(by.time, by.checkin) : '', c.deep ? w.deep : ''].filter(Boolean).join(' · '));
  return { text: head, blocks: [
    section(`*${head}*\n${lines.join('\n')}`),
    context(w.steps + (appUrl ? ` <${appUrl}/|${w.open}>` : ''))
  ] };
}

/**
 * Something done on a clean or from the field — by the cleaner or one of their helpers — said in the
 * cleaner's channel (owner, 2026-10-14: their own too, to follow up and answer there). No unit: a report
 * not tied to a clean.
 */
export type HelperEvent = { by: string; unit?: string | null } & (
  | { kind: 'photos'; stage: 'before' | 'after'; n: number }
  | { kind: 'taken'; lines: { name: string; qty: number }[] }
  | { kind: 'nothing' } | { kind: 'done' } | { kind: 'reopened' }
  | { kind: 'extra'; amount: number; description: string } | { kind: 'declined'; reason: string }
  | { kind: 'report'; what: string; text: string; priority?: string | null });

export function crewHelperMessage(lang: Lang, e: HelperEvent, todo?: boolean) {
  const w = W[lang];
  const who = `*${esc(e.by)}*${e.unit ? ` · ${esc(e.unit)}` : ''}`;
  const line = e.kind === 'photos' ? `📷 ${who}: ${w.photos(e.n)} ${w.stage[e.stage]}`
    : e.kind === 'taken' ? `🧴 ${who} ${w.took} ${e.lines.map(l => `${esc(l.name)} × ${l.qty}`).join(', ')}`
    : e.kind === 'nothing' ? `🧴 ${who} ${w.nothing}`
    : e.kind === 'done' ? `✅ ${who} ${w.done}`
    : e.kind === 'reopened' ? `↩️ ${who} ${w.reopened}`
    : e.kind === 'extra' ? `💵 ${who} ${w.extra} $${e.amount} — ${esc(e.description)}`
    : e.kind === 'declined' ? `✕ ${who} ${w.declined}${e.reason ? `: ${esc(e.reason)}` : ''}`
    : `${w.what[e.what] ?? e.what}${e.priority && w.urg[e.priority] ? ` (${w.urg[e.priority]})` : ''} — ${who}: ${esc(e.text)}`;
  // A to-do behind it: a reply in the thread is a comment on it (§153), so it can be followed up there.
  return { text: line.replace(/\*/g, ''), blocks: [section(line), ...(todo ? [context(w.reply)] : [])] };
}
