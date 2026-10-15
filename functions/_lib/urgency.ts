/**
 * A field report's urgency, set by the team (§162, owner 2026-10-15) — from Slack's buttons on its message or by
 * setting the priority in Kaizen. Urgent → due today; high → due the checkout of the stay in the unit now or next,
 * read from Hostaway and attached to the to-do; medium/low → no date. Its "Validate the urgency" sub-task closes.
 */
import { getCredentials, type SqlFn } from './accounts.ts';
import { fetchReservationsTouching } from './hostaway.ts';
import { reservationCounts } from '../../src/lib/finance.ts';
import { URGENCY_CHECK, PRIORITY_LABEL, stayLabel, urgencyDue, type StayWindow } from '../../src/lib/todos.ts';
import { addDays, todayIn } from '../../src/lib/dates.ts';

const TZ = 'America/New_York';

export async function applyUrgency(sql: SqlFn, key: string, id: string, priority: string, by: string, keepDue = false) {
  const [t] = await sql`SELECT id::text, unit_ids, due_on::text AS due_on FROM todos WHERE account_id = 1 AND id = ${Number(id)} AND deleted_at IS NULL` as
    { id: string; unit_ids: string[] | null; due_on: string | null }[];
  if (!t) throw new Error('That to-do is gone.');
  const today = todayIn(TZ);
  const unit = t.unit_ids?.[0] ?? null;
  let stays: StayWindow[] = [];
  let why = '';
  if (unit && (priority === 'urgent' || priority === 'high')) {
    try {
      stays = (await fetchReservationsTouching(await getCredentials(sql, key), today, addDays(today, 120)))
        .filter(r => r.listingId === unit && reservationCounts(r.status))
        .map(r => ({ id: r.reservationId, guest: r.guestName ?? '', arrival: r.arrival, departure: r.departure }));
    } catch (e) { why = ` (Hostaway did not answer: ${e instanceof Error ? e.message : String(e)})`; }
  }
  const { dueOn, stay } = urgencyDue(priority, today, stays);
  const label = stay ? stayLabel(stay.guest, stay.arrival, stay.departure) : null;
  await sql`UPDATE todos SET priority = ${priority},
              due_on = CASE WHEN ${keepDue} THEN due_on ELSE ${dueOn}::date END,
              reservation_id = COALESCE(${stay?.id ?? null}, reservation_id), reservation_label = COALESCE(${label}, reservation_label),
              updated_at = now()
            WHERE account_id = 1 AND id = ${Number(id)}`;
  const word = PRIORITY_LABEL[priority as keyof typeof PRIORITY_LABEL] ?? priority;
  const said = `Urgency: ${word}${!keepDue && dueOn ? ` — due ${dueOn}${priority === 'high' && label ? `, the checkout of ${label}` : ''}` : ''}` +
    `${priority === 'high' && !stay ? ` — no stay ahead in Hostaway, so no date${why}` : ''}`;
  const closed = await sql`UPDATE todos SET status = 'completed', done_at = now(), done_by = ${by}, resolution_note = ${said}, updated_at = now()
                            WHERE account_id = 1 AND parent_id = ${Number(id)} AND title = ${URGENCY_CHECK}
                              AND status NOT IN ('completed', 'cancelled') AND deleted_at IS NULL RETURNING id`;
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'task', ${String(id)}, 'change', ${`${said}${closed.length ? ' (urgency validated)' : ''}`}, ${by})`;
  return { dueOn, stay: stay ? { ...stay, label } : null, said };
}
