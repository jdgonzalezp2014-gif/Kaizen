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
  if (now.hm >= c.morning && now.hm < '13:00') out.push({ kind: 'today', day: now.day });
  if (now.hm >= c.evening && now.hm < '23:30') out.push({ kind: 'tomorrow', day: nextDay(now.day) });
  return out;
}

type Block = Record<string, unknown>;
const section = (text: string): Block => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text: string): Block => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

export interface CrewClean { unit: string; time: string; beds?: number | null; deep?: boolean; sameDay?: boolean }

const W = {
  en: {
    head: (k: 'today' | 'tomorrow', d: string, n: number) => `${k === 'today' ? '☀️ Today' : '🌙 Tomorrow'}, ${d} — ${n} clean${n === 1 ? '' : 's'}`,
    checkout: 'checkout', sameDay: '⚡ next guest the same day', deep: '🧽 deep',
    steps: 'At each clean: 1 📷 photos BEFORE · 2 🧴 what you took from storage · 3 📷 photos AFTER · 4 ✅ mark it done — in Options… on your page. If something changes, your page has the latest.',
    open: 'Open my page',
    stage: { before: 'BEFORE', after: 'AFTER' }, photos: (n: number) => `${n} photo${n === 1 ? '' : 's'}`,
    took: 'took from storage:', nothing: 'took nothing from storage', done: 'marked it ✅ done', reopened: 'reopened it ↩️',
    what: { problem: '⚠️ Something is wrong', request: '🙋 Needs something', missing: '❓ Something is missing', purchase: '🛒 Bought' } as Record<string, string>,
    urg: { urgent: '🔴 urgent', high: '🟠 soon', low: '⚪ when possible' } as Record<string, string>
  },
  es: {
    head: (k: 'today' | 'tomorrow', d: string, n: number) => `${k === 'today' ? '☀️ Hoy' : '🌙 Mañana'}, ${d} — ${n} ${n === 1 ? 'limpieza' : 'limpiezas'}`,
    checkout: 'salida', sameDay: '⚡ entra huésped el mismo día', deep: '🧽 profunda',
    steps: 'En cada limpieza: 1 📷 fotos ANTES · 2 🧴 lo que tomaste del storage · 3 📷 fotos DESPUÉS · 4 ✅ marcar completada — en Opciones… de tu página. Si algo cambia, tu página tiene lo último.',
    open: 'Abrir mi página',
    stage: { before: 'ANTES', after: 'DESPUÉS' }, photos: (n: number) => `${n} ${n === 1 ? 'foto' : 'fotos'}`,
    took: 'tomó del storage:', nothing: 'no tomó nada del storage', done: 'la marcó ✅ completada', reopened: 'la reabrió ↩️',
    what: { problem: '⚠️ Algo está mal', request: '🙋 Necesita algo', missing: '❓ Falta algo', purchase: '🛒 Compró' } as Record<string, string>,
    urg: { urgent: '🔴 urgente', high: '🟠 pronto', low: '⚪ cuando se pueda' } as Record<string, string>
  }
};

/** Today's or tomorrow's cleans for one cleaner, in their language. */
export function crewDayMessage(lang: Lang, kind: 'today' | 'tomorrow', day: string, cleans: CrewClean[], appUrl?: string) {
  const w = W[lang];
  const head = w.head(kind, dayLabel(lang, day), cleans.length);
  const lines = cleans.map(c => [`• *${esc(c.unit)}*`, c.beds ? bedsWord(lang, c.beds) : '', `${w.checkout} ${esc(c.time)}`,
    c.sameDay ? w.sameDay : '', c.deep ? w.deep : ''].filter(Boolean).join(' · '));
  return { text: head, blocks: [
    section(`*${head}*\n${lines.join('\n')}`),
    context(w.steps + (appUrl ? ` <${appUrl}/|${w.open}>` : ''))
  ] };
}

/** Something one of their helpers did on a clean, said to the cleaner. */
export type HelperEvent = { by: string; unit: string } & (
  | { kind: 'photos'; stage: 'before' | 'after'; n: number }
  | { kind: 'taken'; lines: { name: string; qty: number }[] }
  | { kind: 'nothing' } | { kind: 'done' } | { kind: 'reopened' }
  | { kind: 'report'; what: string; text: string; priority?: string | null });

export function crewHelperMessage(lang: Lang, e: HelperEvent) {
  const w = W[lang];
  const who = `*${esc(e.by)}* · ${esc(e.unit)}`;
  const line = e.kind === 'photos' ? `📷 ${who}: ${w.photos(e.n)} ${w.stage[e.stage]}`
    : e.kind === 'taken' ? `🧴 ${who} ${w.took} ${e.lines.map(l => `${esc(l.name)} × ${l.qty}`).join(', ')}`
    : e.kind === 'nothing' ? `🧴 ${who} ${w.nothing}`
    : e.kind === 'done' ? `✅ ${who} ${w.done}`
    : e.kind === 'reopened' ? `↩️ ${who} ${w.reopened}`
    : `${w.what[e.what] ?? e.what}${e.priority && w.urg[e.priority] ? ` (${w.urg[e.priority]})` : ''} — ${who}: ${esc(e.text)}`;
  return { text: line.replace(/\*/g, ''), blocks: [section(line)] };
}
