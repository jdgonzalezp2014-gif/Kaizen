/**
 * The hourly look at every unit's calendar (§169). Run by /api/slack-cron?job=calendar, a call of its
 * own: 27 calendar reads would not fit beside the clock's other work under the 50-subrequest cap.
 * So every query here is one statement for all listings — a query per unit would blow that cap too.
 */
import { fetchCalendars, type HostawayCredentials } from './hostaway.ts';
import type { SqlFn } from './accounts.ts';
import { addDays, todayIn } from '../../src/lib/dates.ts';
import { codeOf, diffLooks, type Look } from '../../src/lib/calendar-watch.ts';

/** A year ahead: blocks are put on far out (owner stays, renovations), and the call costs the same. */
const AHEAD = 365;

export async function watchCalendars(sql: SqlFn, creds: HostawayCredentials) {
  const from = todayIn('America/New_York');
  const ids = ((await sql`SELECT id FROM units WHERE account_id = 1 ORDER BY id`) as { id: string }[]).map(r => r.id);
  const prevRows = (await sql`
    SELECT listing_id, from_day::text AS from_day, codes, notes, checked_at FROM calendar_watch WHERE account_id = 1
  `) as { listing_id: string; from_day: string; codes: string; notes: Record<string, string>; checked_at: string }[];
  const prev = new Map(prevRows.map(r => [r.listing_id, r]));
  const cals = await fetchCalendars(creds, ids, from, addDays(from, AHEAD - 1));

  const looks: { id: string; look: Look }[] = [];
  const ch = { id: [] as string[], day: [] as string[], was: [] as string[], became: [] as string[], note: [] as (string | null)[], since: [] as string[] };
  for (const id of ids) {
    const days = cals[id] ?? [];
    // A calendar that failed to read, or came back with holes, is not a look: comparing it would invent
    // changes. The last good look stays until the next one that is whole.
    if (!days.length || days[0]!.date !== from || days.some((d, i) => d.date !== addDays(from, i))) continue;
    const look: Look = {
      from,
      codes: days.map(d => codeOf(d.status)).join(''),
      notes: Object.fromEntries(days.filter(d => d.note).map(d => [d.date, d.note!]))
    };
    looks.push({ id, look });
    const p = prev.get(id);
    if (!p) continue; // the first look only sets the baseline
    for (const c of diffLooks({ from: p.from_day, codes: p.codes, notes: p.notes ?? {} }, look)) {
      ch.id.push(id); ch.day.push(c.day); ch.was.push(c.was); ch.became.push(c.now); ch.note.push(c.note);
      ch.since.push(new Date(p.checked_at).toISOString());
    }
  }

  if (ch.id.length) {
    await sql`
      INSERT INTO calendar_changes (account_id, listing_id, day, was, became, note, since)
      SELECT 1, * FROM unnest(${ch.id}::text[], ${ch.day}::date[], ${ch.was}::text[], ${ch.became}::text[],
                              ${ch.note}::text[], ${ch.since}::timestamptz[])
    `;
  }
  if (looks.length) {
    await sql`
      INSERT INTO calendar_watch (account_id, listing_id, from_day, codes, notes, checked_at)
      SELECT 1, l, ${from}::date, c, n::jsonb, now()
        FROM unnest(${looks.map(l => l.id)}::text[], ${looks.map(l => l.look.codes)}::text[],
                    ${looks.map(l => JSON.stringify(l.look.notes))}::text[]) AS t(l, c, n)
      ON CONFLICT (account_id, listing_id) DO UPDATE SET
        from_day = EXCLUDED.from_day, codes = EXCLUDED.codes, notes = EXCLUDED.notes, checked_at = now()
    `;
  }
  return { units: ids.length, looked: looks.length, changes: ch.id.length };
}
