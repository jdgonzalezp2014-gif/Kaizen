/**
 * §175 (owner, 2026-11-15): a cleaner is told in their own channel when their schedule changes —
 * a clean given to them or taken off them, moved to another day, a new checkout time — without
 * having to open their page. Only among what they can see (`visibleAhead`), measured against what
 * they were last told (`crew_notified`), with the same comparison as the page's "Changes since".
 * The first check for a cleaner only records where things stand: nothing is said.
 */
import type { SqlFn } from './accounts.ts';
import { slackApi, type SlackSetup } from './slack.ts';
import { crewVisibility, scheduleState } from './crew.ts';
import { langOf } from './crew-slack.ts';
import { scheduleMovements, type ScheduleItem, type Visibility } from '../../src/lib/crew.ts';
import { crewChangesMessage } from '../../src/lib/crew-slack.ts';

export async function tellScheduleChanges(sql: SqlFn, s: SlackSetup, encryptionKey: string): Promise<string[]> {
  const chans = Object.entries(s.config.cleaners ?? {}).filter(([, c]) => c.channelId);
  if (!s.token || !chans.length) return [];
  const vis = await crewVisibility(sql);
  const visNow: Visibility = { published: vis.published, autoDays: vis.autoDays };
  const st = await scheduleState(sql, encryptionKey, vis.days);
  const today = st.s.today;
  const told = new Map((await sql`SELECT cleaner, day::text AS day, through::text AS through, vis, items FROM crew_notified WHERE account_id = 1` as
    { cleaner: string; day: string; through: string; vis: Visibility; items: ScheduleItem[] }[]).map(r => [r.cleaner, r]));
  const out: string[] = [];
  for (const [name, ch] of chans) {
    const mine = st.now.filter(i => i.cleaner === name);
    const b = told.get(name);
    // Their own "Can't do it" is not news to them.
    const moves = b ? scheduleMovements(name, { items: b.items, day: b.day, through: b.through, vis: b.vis }, st.now, today, visNow, st.fate(name))
      .filter(m => !(m.kind === 'removed' && m.why === 'declined')) : [];
    if (moves.length) {
      const m = crewChangesMessage(await langOf(sql, name), moves, s.config.appUrl);
      const r = await slackApi(s.token, 'chat.postMessage', { channel: ch.channelId, unfurl_links: false, ...m });
      // Not sent: what they were told stays as it was, so the next check says it again.
      if (!r.ok) { out.push(`changes ${name} failed`); continue; }
      out.push(`changes ${name}: ${moves.length}`);
    }
    // Rolled forward even when nothing moved: a clean that came into view since is part of what they know.
    const same = b && b.day === today && b.through === st.s.end && JSON.stringify(b.vis) === JSON.stringify(visNow)
      && JSON.stringify(b.items) === JSON.stringify(mine);
    if (same) continue;
    await sql`INSERT INTO crew_notified (account_id, cleaner, day, through, vis, items, told_at)
              VALUES (1, ${name}, ${today}::date, ${st.s.end}::date, ${JSON.stringify(visNow)}::jsonb, ${JSON.stringify(mine)}::jsonb, now())
              ON CONFLICT (account_id, cleaner) DO UPDATE SET day = EXCLUDED.day, through = EXCLUDED.through, vis = EXCLUDED.vis,
                items = EXCLUDED.items, told_at = now()`;
  }
  return out;
}
