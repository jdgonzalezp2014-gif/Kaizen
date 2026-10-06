/**
 * The reservations reminder's facts (§99): today's and tomorrow's
 * check-ins and cleans from the board (the same decisions it shows), the
 * ID copies Drive is missing for the units that keep one, overdue and
 * due-today work, and open claims. Composed into a message by
 * src/lib/slack.ts digestMessage.
 */
import type { SqlFn } from './accounts.ts';
import { getAccount } from './accounts.ts';
import type { HostawayCredentials } from './hostaway.ts';
import { loadOps } from './ops.ts';
import { driveToken } from './gdrive.ts';
import { docsStatus } from './guest-docs.ts';
import type { CleanRow, DigestInput } from '../../src/lib/slack.ts';
import { addDays, todayIn } from '../../src/lib/dates.ts';

const TZ = 'America/New_York';

export async function digestFacts(sql: SqlFn, creds: HostawayCredentials, key: string): Promise<DigestInput> {
  const today = todayIn(TZ);
  const tomorrow = addDays(today, 1);
  const account = await getAccount(sql);
  const s = await loadOps(sql, creds, { days: 2, cleaningsCsvUrl: account?.cleaningsCsvUrl ?? null, refreshSheet: false });
  const rows = s.rows.filter(r => r.date === today || r.date === tomorrow);
  const needs = new Set(s.guestDocUnits ?? []);

  // The building's copy of the ID (§73): read from Drive for the arrivals that need one; unknown if Drive cannot be read.
  let docs: Record<string, { id: unknown[] }> = {};
  const want = rows.filter(r => r.kind === 'in' && needs.has(r.unitId)).map(r => ({ resId: r.resId, arrival: r.date, name: r.docName }));
  if (want.length) {
    try { docs = await docsStatus(sql, await driveToken(sql, key), want); } catch { docs = {}; }
  }

  const [tasks, claims] = await Promise.all([
    sql`SELECT t.id::text, t.title, u.name AS unit, t.assignee, t.due_on::text AS due_on
          FROM todos t LEFT JOIN units u ON u.account_id = t.account_id AND u.id = t.unit_ids[1]
         WHERE t.account_id = 1 AND t.deleted_at IS NULL AND t.parent_id IS NULL
           AND t.status NOT IN ('completed', 'cancelled')
         ORDER BY t.due_on NULLS LAST, t.title` as Promise<{ id: string; title: string; unit: string | null; assignee: string | null; due_on: string | null }[]>,
    sql`SELECT COALESCE(u.name, 'Portfolio') || ' · ' || COALESCE(NULLIF(c.description, ''), c.category, 'Claim') AS label,
               c.severity, (CURRENT_DATE - c.occurred_on)::int AS days
          FROM claims c LEFT JOIN units u ON u.account_id = c.account_id AND u.id = c.unit_id
         WHERE c.account_id = 1 AND c.deleted_at IS NULL AND c.status IN ('Open', 'In progress')
         ORDER BY (c.severity IN ('Critical', 'High')) DESC, c.occurred_on` as Promise<{ label: string; severity: string; days: number }[]>
  ]);

  return {
    today, tomorrow,
    arrivals: rows.filter(r => r.kind === 'in').map(r => ({
      resId: r.resId, date: r.date, time: r.time, unit: r.unit, guest: r.guest || 'guest', agreement: r.agreement,
      needsId: needs.has(r.unitId), idInDrive: needs.has(r.unitId) && docs[r.resId] ? docs[r.resId]!.id.length > 0 : null
    })),
    departures: rows.filter(r => r.kind === 'out').map(r => ({
      resId: r.resId, date: r.date, time: r.time, unit: r.unit, cleaner: r.cleaner, assigned: r.assignment === 'assigned',
      notNeeded: r.assignment === 'not_needed', sameDay: r.urgency === 'turnover'
    })),
    tasks: tasks.map(t => ({ id: t.id, title: t.title, unit: t.unit, owner: t.assignee, overdue: !!t.due_on && t.due_on < today, dueToday: t.due_on === today })),
    claims: claims.map(c => ({ label: c.label.slice(0, 90), severity: c.severity, days: c.days }))
  };
}

/** A cleaner's next cleans, from the board (prepared, §99 — sent only by hand). */
export async function cleanerSchedule(sql: SqlFn, creds: HostawayCredentials, name: string, days = 7) {
  const account = await getAccount(sql);
  const s = await loadOps(sql, creds, { days, cleaningsCsvUrl: account?.cleaningsCsvUrl ?? null, refreshSheet: false });
  return s.rows.filter(r => r.kind === 'out' && r.assignment === 'assigned' && (r.cleaner ?? '').toLowerCase() === name.toLowerCase())
    .map(r => ({ date: r.date, time: r.time, unit: r.unit, beds: r.beds, deep: r.deep, sameDay: r.urgency === 'turnover', note: r.note || null }));
}

/** A day's cleans from the board (§101): who, when, what kind — for the Cleans pop-up. */
export async function cleansFor(sql: SqlFn, creds: HostawayCredentials, date: string): Promise<CleanRow[]> {
  const account = await getAccount(sql);
  const today = todayIn(TZ);
  const days = Math.max(1, Math.round((Date.parse(date) - Date.parse(today)) / 864e5) + 1);
  const s = await loadOps(sql, creds, { days: Math.min(days, 14), cleaningsCsvUrl: account?.cleaningsCsvUrl ?? null, refreshSheet: false });
  return s.rows.filter(r => r.kind === 'out' && r.date === date).map(r => ({
    resId: r.resId, time: r.time, unit: r.unit, beds: r.beds, cleaner: r.cleaner,
    state: r.assignment === 'assigned' ? 'assigned' as const : r.assignment === 'not_needed' ? 'not_needed' as const : 'open' as const,
    sameDay: r.urgency === 'turnover', deep: r.deep, byHand: !!r.manual?.cleaner
  }));
}
