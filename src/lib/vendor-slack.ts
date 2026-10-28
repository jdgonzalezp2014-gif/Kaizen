/**
 * What the bot tells a handyman in their Slack channel (owner, 2026-10-27: "simpler — a summary each day of how many
 * they have, and one when a new one arrives, nothing more"). English; the handyman @-mentioned, since a channel may
 * hold the whole team. Pure: functions/_lib/vendor-slack.ts sends them.
 */
import { dayLabel } from './crew-i18n.ts';

export interface HandymanJob { title: string; unit: string | null; day: string | null }
export interface SlackText { text: string; blocks: { type: 'section'; text: { type: 'mrkdwn'; text: string } }[] }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const jobs = (n: number) => `${n} job${n === 1 ? '' : 's'}`;
const msg = (line: string, plain: string): SlackText => ({ text: plain, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: line } }] });
const who = (userId: string | null | undefined) => userId ? `<@${userId}> ` : '';

/** Jobs per house, most first. */
function perHouse(js: HandymanJob[]): [string, number][] {
  const m = new Map<string, number>();
  for (const j of js) m.set(j.unit ?? 'No listing', (m.get(j.unit ?? 'No listing') ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** One line when work arrives: the job (or how many, and where), and the page. */
export function newWorkMessage(js: HandymanJob[], link: string, userId?: string | null): SlackText | null {
  if (!js.length) return null;
  const houses = perHouse(js);
  const what = js.length === 1
    ? `New job at *${esc(js[0]!.unit ?? 'No listing')}*: ${esc(js[0]!.title)}`
    : houses.length === 1 ? `${jobs(js.length)} new at *${esc(houses[0]![0])}*`
    : `${jobs(js.length)} new — ${houses.map(([h, n]) => `${esc(h)} ${n}`).join(' · ')}`;
  return msg(`🔧 ${who(userId)}${what} · <${link}|Open ›>`, js.length === 1 ? `New job at ${js[0]!.unit ?? 'No listing'}` : `${jobs(js.length)} new`);
}

/** The morning summary: how many open, where, how many today. Nothing when there is nothing. */
export function daySummary(js: HandymanJob[], link: string, today: string, userId?: string | null): SlackText | null {
  if (!js.length) return null;
  const houses = perHouse(js);
  const now = js.filter(j => j.day === today).length;
  const line = `☀️ ${who(userId)}${jobs(js.length)} open in ${houses.length} house${houses.length === 1 ? '' : 's'} — ` +
    `${houses.map(([h, n]) => `${esc(h)} ${n}`).join(' · ')}${now ? ` · *${now} today* (${dayLabel('en', today)})` : ''} · <${link}|Open ›>`;
  return msg(line, `${jobs(js.length)} open${now ? `, ${now} today` : ''}`);
}
