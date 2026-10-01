/**
 * Work ↔ Hostaway tasks (§93, §94): the calls and the two directions.
 *
 *   push  — a Kaizen task (top level; sub-tasks stay in Kaizen) is created
 *           or updated as a Hostaway task after every change; removed in
 *           Kaizen = cancelled in Hostaway, never deleted there.
 *   pull  — what the team changed in Hostaway comes back, field by field,
 *           each change a line on the task's timeline; tasks written by
 *           hand in Hostaway come in as Kaizen tasks. Hostaway's automatic
 *           tasks (the per-reservation cleans) never do.
 *
 * Since §94 the two hold the same fields, so both directions copy.
 * A failed push keeps its error on the row and is retried on the next
 * pull, so an edit made while Hostaway was down still arrives.
 */
import { getAccessToken, fetchReservationDetail, type HostawayCredentials } from './hostaway.ts';
import type { SqlFn } from './accounts.ts';
import {
  changesFrom, FOOTER_MARK, importable, sameState, stateOf, toHostawayBody, userName, workFromState,
  type HostawayTask, type HostawayUser, type SyncState, type WorkForSync, type WorkPatch
} from '../../src/lib/hostaway-tasks.ts';
import { stayLabel } from '../../src/lib/todos.ts';
import { settleRepair } from './repair-costs.ts';
import { notifyTask } from './slack.ts';

const BASE = 'https://api.hostaway.com/v1';
/** How often a page load may ask Hostaway for changes. */
const PULL_EVERY_MS = 2 * 60 * 1000;
/** How often the owner/supervisor pickers re-read Hostaway's users. */
const USERS_EVERY_MS = 12 * 3600 * 1000;

async function call<T>(creds: HostawayCredentials, method: string, path: string, body?: unknown): Promise<{ status: number; result: T | null; message: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { Authorization: `Bearer ${await getAccessToken(creds)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const j = await res.json().catch(() => null) as { result?: T; message?: string } | null;
  return { status: res.status, result: j?.result ?? null, message: j?.message ?? `HTTP ${res.status}` };
}

export const listTasks = async (creds: HostawayCredentials) => (await call<HostawayTask[]>(creds, 'GET', '/tasks')).result ?? [];

/* ── Hostaway's users ────────────────────────────────────────────────── */

export interface Person { id: number; name: string; email: string | null }

/** Re-read from Hostaway and kept, so a form never waits on Hostaway. */
export async function refreshUsers(sql: SqlFn, creds: HostawayCredentials): Promise<HostawayUser[]> {
  const users = ((await call<HostawayUser[]>(creds, 'GET', '/users')).result ?? [])
    .map(u => ({ id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName }));
  if (!users.length) return users;
  for (const u of users) {
    await sql`INSERT INTO hostaway_users (account_id, id, name, email, synced_at) VALUES (1, ${u.id}, ${userName(u)}, ${u.email}, now())
              ON CONFLICT (account_id, id) DO UPDATE SET name = EXCLUDED.name, email = EXCLUDED.email, synced_at = now()`;
  }
  await sql`DELETE FROM hostaway_users WHERE account_id = 1 AND NOT (id = ANY(${users.map(u => u.id)}::int[]))`;
  return users;
}

/** The kept users — refreshed first when older than half a day, or when there are none. */
export async function people(sql: SqlFn, creds: () => Promise<HostawayCredentials>): Promise<Person[]> {
  const rows = await sql`SELECT id, name, email, synced_at FROM hostaway_users WHERE account_id = 1 ORDER BY name` as
    (Person & { synced_at: string | Date })[];
  const stale = !rows.length || Date.now() - new Date(rows[0]!.synced_at).getTime() > USERS_EVERY_MS;
  if (stale) {
    try { await refreshUsers(sql, await creds()); } catch { return rows.map(({ id, name, email }) => ({ id, name, email })); }
    return (await sql`SELECT id, name, email FROM hostaway_users WHERE account_id = 1 ORDER BY name`) as Person[];
  }
  return rows.map(({ id, name, email }) => ({ id, name, email }));
}

/* ── the mirror ──────────────────────────────────────────────────────── */

export async function mirrorOn(sql: SqlFn): Promise<boolean> {
  const [a] = await sql`SELECT hostaway_tasks FROM accounts WHERE id = 1` as { hostaway_tasks: string }[];
  return a?.hostaway_tasks === 'mirror';
}

async function note(sql: SqlFn, id: string, kind: 'status' | 'change', body: string, by: string) {
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'task', ${id}, ${kind}, ${body.slice(0, 4000)}, ${by})`;
}

interface Row {
  id: string; title: string; description: string | null; kind: WorkForSync['kind']; status: WorkForSync['status'];
  priority: WorkForSync['priority']; unit_ids: string[]; reservation_id: string | null;
  scheduled_on: string | null; start_time: string | null; due_on: string | null; due_time: string | null;
  assignee_user_id: number | null; supervisor_user_id: number | null; vendor: string | null;
  cost_estimate: string | null; cost_actual: string | null; resolution_note: string | null;
  parent_id: string | null; deleted_at: string | Date | null;
  hostaway_task_id: string | null; hostaway_state: SyncState | null; hostaway_error: string | null;
}
const workOf = (r: Row): WorkForSync => ({
  id: String(r.id), title: r.title, description: r.description, kind: r.kind, status: r.deleted_at ? 'cancelled' : r.status,
  priority: r.priority, unitIds: r.unit_ids ?? [], reservationId: r.reservation_id,
  scheduledOn: r.scheduled_on, startTime: r.start_time, dueOn: r.due_on, dueTime: r.due_time,
  assigneeUserId: r.assignee_user_id, supervisorUserId: r.supervisor_user_id, vendor: r.vendor,
  costEstimate: r.cost_estimate == null ? null : Number(r.cost_estimate),
  costActual: r.cost_actual == null ? null : Number(r.cost_actual), resolutionNote: r.resolution_note
});
const ROWS = (sql: SqlFn, where: { id?: string; linked?: boolean; only?: string[] | null }) => sql`
  SELECT id::text, title, description, kind, status, priority, unit_ids, reservation_id,
         scheduled_on::text AS scheduled_on, to_char(start_time, 'HH24:MI') AS start_time,
         due_on::text AS due_on, to_char(due_time, 'HH24:MI') AS due_time,
         assignee_user_id, supervisor_user_id, vendor, cost_estimate, cost_actual, resolution_note,
         parent_id::text AS parent_id, deleted_at, hostaway_task_id, hostaway_state, hostaway_error
    FROM todos
   WHERE account_id = 1
     AND (${where.id ?? null}::text IS NULL OR id::text = ${where.id ?? null})
     AND (NOT ${!!where.linked} OR hostaway_task_id IS NOT NULL)
     AND (${where.only ?? null}::text[] IS NULL OR id::text = ANY(${where.only ?? null}::text[]))` as Promise<Row[]>;

/**
 * Kaizen → Hostaway for one task. Creates the Hostaway task the first
 * time; never creates one for work already closed or removed.
 */
export async function pushWork(sql: SqlFn, creds: HostawayCredentials, id: string): Promise<'created' | 'updated' | 'skipped' | 'failed'> {
  const r = (await ROWS(sql, { id }))[0];
  if (!r || r.parent_id) return 'skipped';
  const w = workOf(r);
  if (!r.hostaway_task_id && (r.deleted_at || w.status === 'completed' || w.status === 'cancelled')) return 'skipped';
  try {
    const body = toHostawayBody(w);
    const res = r.hostaway_task_id
      ? await call<HostawayTask>(creds, 'PUT', `/tasks/${r.hostaway_task_id}`, body)
      : await call<HostawayTask>(creds, 'POST', '/tasks', body);
    if (res.status === 404 && r.hostaway_task_id) {
      await sql`UPDATE todos SET hostaway_task_id = NULL, hostaway_state = NULL, hostaway_error = NULL WHERE account_id = 1 AND id = ${id}`;
      await note(sql, id, 'change', 'Its Hostaway task was deleted there — no longer linked.', 'Hostaway');
      return 'failed';
    }
    if (!res.result) throw new Error(res.message);
    await sql`UPDATE todos SET hostaway_task_id = ${String(res.result.id)}, hostaway_state = ${JSON.stringify(stateOf(res.result))}::jsonb,
                               hostaway_synced_at = now(), hostaway_error = NULL
               WHERE account_id = 1 AND id = ${id}`;
    if (!r.hostaway_task_id) await note(sql, id, 'change', `Sent to Hostaway as task #${res.result.id}.`, 'Hostaway');
    return r.hostaway_task_id ? 'updated' : 'created';
  } catch (e) {
    await sql`UPDATE todos SET hostaway_error = ${(e instanceof Error ? e.message : String(e)).slice(0, 300)} WHERE account_id = 1 AND id = ${id}`;
    return 'failed';
  }
}

export interface PullResult { skipped?: string; changed: number; imported: number; unlinked: number; retried: number }

/** Hostaway → Kaizen: changes to linked tasks, and hand-made tasks to bring in. */
export async function pullAll(sql: SqlFn, creds: HostawayCredentials, force = false,
                              /** Scripts only: run with the switch off, touching only these tasks. */
                              test?: { only: string[] }, slackKey?: string): Promise<PullResult> {
  const none: PullResult = { changed: 0, imported: 0, unlinked: 0, retried: 0 };
  const [acc] = await sql`SELECT hostaway_tasks, hostaway_tasks_pulled_at FROM accounts WHERE id = 1` as
    { hostaway_tasks: string; hostaway_tasks_pulled_at: string | Date | null }[];
  if (acc?.hostaway_tasks !== 'mirror' && !test) return { ...none, skipped: 'off' };
  if (!force && acc?.hostaway_tasks_pulled_at && Date.now() - new Date(acc.hostaway_tasks_pulled_at).getTime() < PULL_EVERY_MS) {
    return { ...none, skipped: 'recent' };
  }
  // Claimed before the work, so two page loads at once do not both pull.
  await sql`UPDATE accounts SET hostaway_tasks_pulled_at = now() WHERE id = 1`;

  const [tasks, users] = await Promise.all([listTasks(creds), refreshUsers(sql, creds)]);
  const byId = new Map(tasks.map(t => [String(t.id), t]));
  const out: PullResult = { ...none };
  const units = new Set((await sql`SELECT id FROM units WHERE account_id = 1` as { id: string }[]).map(u => String(u.id)));
  const labelFor = async (reservationId: string | null | undefined) => {
    if (!reservationId) return null;
    const d = await fetchReservationDetail(creds, reservationId).catch(() => null);
    return d ? stayLabel(String(d.guestName ?? ''), String(d.arrivalDate ?? ''), String(d.departureDate ?? '')) : null;
  };

  const linked = await ROWS(sql, { linked: true, only: test?.only ?? null });
  for (const r of linked) {
    // An edit that could not be sent is sent first: Kaizen's change was made first.
    if (r.hostaway_error) { await pushWork(sql, creds, r.id); out.retried++; continue; }
    const t = byId.get(r.hostaway_task_id!);
    if (!t) {
      await sql`UPDATE todos SET hostaway_task_id = NULL, hostaway_state = NULL WHERE account_id = 1 AND id = ${r.id}`;
      await note(sql, r.id, 'change', 'Its Hostaway task was deleted there — no longer linked.', 'Hostaway');
      out.unlinked++; continue;
    }
    const now = stateOf(t);
    if (!r.hostaway_state) { await saveState(sql, r.id, now); continue; }
    if (sameState(r.hostaway_state, now)) continue;
    const { patch, said } = changesFrom(r.hostaway_state, now, users);
    // A listing Kaizen does not know is left as it was.
    if (patch.unitIds && patch.unitIds.some(u => !units.has(u))) delete patch.unitIds;
    // Removed in Kaizen: the record stays as it was; only the snapshot moves.
    if (!r.deleted_at && said.length) {
      await applyPatch(sql, r.id, patch, patch.reservationId !== undefined ? await labelFor(patch.reservationId) : null);
      await note(sql, r.id, patch.status ? 'status' : 'change', `In Hostaway: ${said.join(' · ')}`, 'Hostaway');
      // §95: completed with a cost there = the repair's expense here.
      await settleRepair(sql, r.id, 'Hostaway', async () => creds);
      // §99: what the team did in Hostaway, said in Slack (needs the key, so only where the caller gave one).
      if (slackKey) await notifyTask(sql, slackKey, r.id, 'hostaway', 'Hostaway', said.join(' · ')).catch(() => {});
      out.changed++;
    }
    await saveState(sql, r.id, now);
  }

  // Hand-made in Hostaway, open, and not already Kaizen's (Kaizen's tasks carry its footer).
  const known = new Set(linked.map(r => r.hostaway_task_id));
  for (const t of test ? [] : tasks) {
    if (!importable(t) || known.has(String(t.id)) || (t.description ?? '').includes(FOOTER_MARK)) continue;
    const s = stateOf(t);
    const k = workFromState(s, users);
    const creator = users.find(u => u.id === t.createdByUserId);
    const unit = k.unitIds.filter(u => units.has(u));
    const [row] = await sql`
      INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority,
                         assignee_user_id, assignee, supervisor_user_id, supervisor, scheduled_on, start_time, due_on, due_time,
                         cost_actual, resolution_note, reservation_id, reservation_label,
                         source, hostaway_task_id, hostaway_state, hostaway_synced_at)
      VALUES (1, ${k.title.slice(0, 300) || 'Hostaway task'}, ${k.description}, ${unit},
              ${creator ? `Hostaway · ${userName(creator)}` : 'Hostaway'}, 'task', ${k.status}, ${k.priority},
              ${k.assigneeUserId}, ${k.assignee}, ${k.supervisorUserId}, ${k.supervisor},
              ${k.scheduledOn}, ${k.startTime}::time, ${k.dueOn}, ${k.dueTime}::time, ${k.costActual}, ${k.resolutionNote},
              ${k.reservationId}, ${await labelFor(k.reservationId)},
              'hostaway', ${String(t.id)}, ${JSON.stringify(s)}::jsonb, now())
      ON CONFLICT DO NOTHING
      RETURNING id::text` as { id: string }[];
    if (row) {
      await note(sql, row.id, 'status', `Created in Hostaway${creator ? ` by ${userName(creator)}` : ''} (task #${t.id}).`, 'Hostaway');
      out.imported++;
    }
  }
  return out;
}

async function saveState(sql: SqlFn, id: string, s: SyncState) {
  await sql`UPDATE todos SET hostaway_state = ${JSON.stringify(s)}::jsonb, hostaway_synced_at = now() WHERE account_id = 1 AND id = ${id}`;
}

async function applyPatch(sql: SqlFn, id: string, p: WorkPatch, reservationLabel: string | null) {
  const closing = p.status === 'completed' || p.status === 'cancelled';
  const reopening = p.status !== undefined && !closing;
  const has = (k: keyof WorkPatch) => p[k] !== undefined;
  await sql`UPDATE todos SET
      title              = COALESCE(${p.title ?? null}, title),
      description        = CASE WHEN ${has('description')} THEN ${p.description ?? null} ELSE description END,
      priority           = COALESCE(${p.priority ?? null}, priority),
      assignee_user_id   = CASE WHEN ${has('assigneeUserId')} THEN ${p.assigneeUserId ?? null}::int ELSE assignee_user_id END,
      assignee           = CASE WHEN ${has('assigneeUserId')} THEN ${p.assignee ?? null} ELSE assignee END,
      supervisor_user_id = CASE WHEN ${has('supervisorUserId')} THEN ${p.supervisorUserId ?? null}::int ELSE supervisor_user_id END,
      supervisor         = CASE WHEN ${has('supervisorUserId')} THEN ${p.supervisor ?? null} ELSE supervisor END,
      unit_ids           = COALESCE(${p.unitIds ?? null}::text[], unit_ids),
      reservation_id     = CASE WHEN ${has('reservationId')} THEN ${p.reservationId ?? null} ELSE reservation_id END,
      reservation_label  = CASE WHEN ${has('reservationId')} THEN ${reservationLabel} ELSE reservation_label END,
      scheduled_on       = CASE WHEN ${has('scheduledOn')} THEN ${p.scheduledOn ?? null}::date ELSE scheduled_on END,
      start_time         = CASE WHEN ${has('scheduledOn')} THEN ${p.startTime ?? null}::time ELSE start_time END,
      due_on             = CASE WHEN ${has('dueOn')} THEN ${p.dueOn ?? null}::date ELSE due_on END,
      due_time           = CASE WHEN ${has('dueOn')} THEN ${p.dueTime ?? null}::time ELSE due_time END,
      cost_actual        = CASE WHEN ${has('costActual')} THEN ${p.costActual ?? null}::numeric ELSE cost_actual END,
      resolution_note    = CASE WHEN ${has('resolutionNote')} THEN ${p.resolutionNote ?? null} ELSE resolution_note END,
      status             = COALESCE(${p.status ?? null}, status),
      done_at            = CASE WHEN ${closing} THEN COALESCE(done_at, now()) WHEN ${reopening} THEN NULL ELSE done_at END,
      done_by            = CASE WHEN ${closing} THEN COALESCE(done_by, 'Hostaway') WHEN ${reopening} THEN NULL ELSE done_by END,
      updated_at         = now()
    WHERE account_id = 1 AND id = ${id}`;
}
