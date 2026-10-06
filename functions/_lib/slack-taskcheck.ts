/**
 * The tasks' check-in and check-out (§107): what is open, and what the day
 * closed and opened — top-level work, the day being the team's local day
 * (Central by default). Composed by src/lib/slack.ts taskCheckMessage.
 */
import type { SqlFn } from './accounts.ts';
import { dayRange, type TaskCheckInput } from '../../src/lib/slack.ts';

const who = (e: string | null) => e ? (e.includes('@') ? e.split('@')[0]! : e) : null;

export async function taskCheckFacts(sql: SqlFn, day: string, tz: string): Promise<TaskCheckInput> {
  const [from, to] = dayRange(day, tz);
  const [open, closed, opened] = await Promise.all([
    sql`SELECT t.title, t.assignee, t.kind, t.status, t.due_on::text AS due_on, u.name AS unit
          FROM todos t LEFT JOIN units u ON u.account_id = t.account_id AND u.id = t.unit_ids[1]
         WHERE t.account_id = 1 AND t.deleted_at IS NULL AND t.parent_id IS NULL AND t.status NOT IN ('completed', 'cancelled')
         ORDER BY t.due_on NULLS LAST, t.created_at` as Promise<{ title: string; assignee: string | null; kind: string; status: string; due_on: string | null; unit: string | null }[]>,
    sql`SELECT title, done_by, status FROM todos
         WHERE account_id = 1 AND deleted_at IS NULL AND parent_id IS NULL AND status IN ('completed', 'cancelled')
           AND done_at >= ${from}::timestamptz AND done_at < ${to}::timestamptz ORDER BY done_at` as Promise<{ title: string; done_by: string | null; status: string }[]>,
    sql`SELECT title, created_by FROM todos
         WHERE account_id = 1 AND deleted_at IS NULL AND parent_id IS NULL
           AND created_at >= ${from}::timestamptz AND created_at < ${to}::timestamptz ORDER BY created_at` as Promise<{ title: string; created_by: string | null }[]>
  ]);
  return {
    day,
    open: open.map(t => ({ title: t.title, owner: t.assignee, unit: t.unit, kind: t.kind, inProgress: t.status === 'in_progress',
                           overdue: !!t.due_on && t.due_on < day, dueToday: t.due_on === day })),
    closed: closed.map(c => ({ title: c.title, by: who(c.done_by), cancelled: c.status === 'cancelled' })),
    opened: opened.map(o => ({ title: o.title, by: who(o.created_by) }))
  };
}
