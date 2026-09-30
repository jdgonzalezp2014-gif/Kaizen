/**
 * Work ↔ Hostaway tasks (§93): the calls and the two directions.
 *
 *   push  — a Kaizen to-do or repair (top level; sub-tasks stay in Kaizen)
 *           is created or updated as a Hostaway task after every change;
 *           removed in Kaizen = cancelled in Hostaway, never deleted there.
 *   pull  — what the team changed in Hostaway comes back (status, owner,
 *           deadline, cost, title, description), each change a line on the
 *           to-do's timeline; tasks written by hand in Hostaway come in as
 *           Kaizen work. Hostaway's automatic tasks never do.
 *
 * A failed push keeps its error on the row and is retried on the next pull,
 * so an edit made while Hostaway was down still arrives.
 */
import { getAccessToken, fetchReservationDetail, type HostawayCredentials } from './hostaway.ts';
import type { SqlFn } from './accounts.ts';
import {
  changesFrom, coreOf, FOOTER_MARK, importable, sameState, stateOf, toHostawayBody, userName, fromHostawayStatus, utcToNyDay,
  type HostawayTask, type HostawayUser, type SyncState, type WorkForSync
} from '../../src/lib/hostaway-tasks.ts';
import { stayLabel } from '../../src/lib/todos.ts';

const BASE = 'https://api.hostaway.com/v1';
/** How often a page load may ask Hostaway for changes. */
const PULL_EVERY_MS = 2 * 60 * 1000;

async function call<T>(creds: HostawayCredentials, method: string, path: string, body?: unknown): Promise<{ status: number; result: T | null; message: string }> {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { Authorization: `Bearer ${await getAccessToken(creds)}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const j = await res.json().catch(() => null) as { result?: T; message?: string } | null;
  return { status: res.status, result: j?.result ?? null, message: j?.message ?? `HTTP ${res.status}` };
}

export const listTasks = async (creds: HostawayCredentials) => (await call<HostawayTask[]>(creds, 'GET', '/tasks')).result ?? [];
export const listUsers = async (creds: HostawayCredentials) =>
  ((await call<HostawayUser[]>(creds, 'GET', '/users')).result ?? []).map(u => ({ id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName }));

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
  priority: WorkForSync['priority']; unit_ids: string[]; reservation_id: string | null; due_on: string | null;
  scheduled_on: string | null; assignee: string | null; vendor: string | null; cost_estimate: string | null;
  cost_actual: string | null; created_at: string | Date; parent_id: string | null; deleted_at: string | Date | null;
  hostaway_task_id: string | null; hostaway_state: SyncState | null; hostaway_error: string | null;
}
const workOf = (r: Row): WorkForSync => ({
  id: String(r.id), title: r.title, description: r.description, kind: r.kind, status: r.deleted_at ? 'cancelled' : r.status,
  priority: r.priority, unitIds: r.unit_ids ?? [], reservationId: r.reservation_id, dueOn: r.due_on, scheduledOn: r.scheduled_on,
  assignee: r.assignee, vendor: r.vendor, costEstimate: r.cost_estimate == null ? null : Number(r.cost_estimate),
  costActual: r.cost_actual == null ? null : Number(r.cost_actual), createdAt: new Date(r.created_at).toISOString()
});
const SELECT_ROW = (sql: SqlFn, id: string) => sql`
  SELECT id::text, title, description, kind, status, priority, unit_ids, reservation_id, due_on::text AS due_on,
         scheduled_on::text AS scheduled_on, assignee, vendor, cost_estimate, cost_actual, created_at, parent_id::text AS parent_id,
         deleted_at, hostaway_task_id, hostaway_state, hostaway_error
    FROM todos WHERE account_id = 1 AND id = ${id}`;

/**
 * Kaizen → Hostaway for one piece of work. Creates the task the first
 * time; never creates one for work already closed or removed.
 */
export async function pushWork(sql: SqlFn, creds: HostawayCredentials, id: string, users?: HostawayUser[]): Promise<'created' | 'updated' | 'skipped' | 'failed'> {
  const r = (await SELECT_ROW(sql, id) as Row[])[0];
  if (!r || r.parent_id) return 'skipped';
  const w = workOf(r);
  if (!r.hostaway_task_id && (r.deleted_at || w.status === 'done' || w.status === 'cancelled')) return 'skipped';
  try {
    const people = users ?? await listUsers(creds);
    const names = w.unitIds.length > 1
      ? (await sql`SELECT name FROM units WHERE id = ANY(${w.unitIds})` as { name: string }[]).map(u => u.name) : [];
    const body = toHostawayBody(w, people, names);
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

export interface PullResult { skipped?: string; changed: number; imported: number; unlinked: number; retried: number; people: string[] }

/** Hostaway → Kaizen: changes to linked tasks, and hand-made tasks to import. */
export async function pullAll(sql: SqlFn, creds: HostawayCredentials, force = false,
                              /** Scripts only: run with the switch off, touching only these to-dos. */
                              test?: { only: string[] }): Promise<PullResult> {
  const none: PullResult = { changed: 0, imported: 0, unlinked: 0, retried: 0, people: [] };
  const [acc] = await sql`SELECT hostaway_tasks, hostaway_tasks_pulled_at FROM accounts WHERE id = 1` as
    { hostaway_tasks: string; hostaway_tasks_pulled_at: string | Date | null }[];
  if (acc?.hostaway_tasks !== 'mirror' && !test) return { ...none, skipped: 'off' };
  if (!force && acc?.hostaway_tasks_pulled_at && Date.now() - new Date(acc.hostaway_tasks_pulled_at).getTime() < PULL_EVERY_MS) {
    return { ...none, skipped: 'recent' };
  }
  // Claimed before the work, so two page loads at once do not both pull.
  await sql`UPDATE accounts SET hostaway_tasks_pulled_at = now() WHERE id = 1`;

  const [tasks, users] = await Promise.all([listTasks(creds), listUsers(creds)]);
  const byId = new Map(tasks.map(t => [String(t.id), t]));
  const out: PullResult = { ...none, people: users.map(userName) };

  const linked = await sql`
    SELECT id::text, title, description, kind, status, priority, unit_ids, reservation_id, due_on::text AS due_on,
           scheduled_on::text AS scheduled_on, assignee, vendor, cost_estimate, cost_actual, created_at, parent_id::text AS parent_id,
           deleted_at, hostaway_task_id, hostaway_state, hostaway_error
      FROM todos WHERE account_id = 1 AND hostaway_task_id IS NOT NULL
       AND (${test ? test.only : null}::text[] IS NULL OR id::text = ANY(${test ? test.only : null}::text[]))` as Row[];
  for (const r of linked) {
    // An edit that could not be sent is sent first: Kaizen's change was made first.
    if (r.hostaway_error) { await pushWork(sql, creds, r.id, users); out.retried++; continue; }
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
    // Removed in Kaizen: the record stays as it was; only the snapshot moves.
    if (!r.deleted_at && said.length) {
      await applyPatch(sql, r.id, patch);
      const who = users.find(u => u.id === t.assigneeUserId);
      const resolution = patch.status === 'done' && t.resolutionNote ? ` — “${t.resolutionNote}”` : '';
      await note(sql, r.id, patch.status ? 'status' : 'change', `In Hostaway: ${said.join(' · ')}${resolution}`, who && patch.status ? `Hostaway · ${userName(who)}` : 'Hostaway');
      out.changed++;
    }
    await saveState(sql, r.id, now);
  }

  // Hand-made in Hostaway, open, and not already Kaizen's (Kaizen's tasks carry its footer).
  const known = new Set(linked.map(r => r.hostaway_task_id));
  const units = new Set((await sql`SELECT id FROM units WHERE account_id = 1` as { id: string }[]).map(u => String(u.id)));
  for (const t of test ? [] : tasks) {
    if (!importable(t) || known.has(String(t.id)) || (t.description ?? '').includes(FOOTER_MARK)) continue;
    const s = stateOf(t);
    const assignee = users.find(u => u.id === t.assigneeUserId);
    const creator = users.find(u => u.id === t.createdByUserId);
    let label: string | null = null;
    if (t.reservationId) {
      const d = await fetchReservationDetail(creds, String(t.reservationId)).catch(() => null);
      if (d) label = stayLabel(String(d.guestName ?? ''), String(d.arrivalDate ?? ''), String(d.departureDate ?? ''));
    }
    const unit = t.listingMapId != null && units.has(String(t.listingMapId)) ? [String(t.listingMapId)] : [];
    const status = fromHostawayStatus(t.status);
    const [row] = await sql`
      INSERT INTO todos (account_id, title, description, unit_ids, due_on, created_by, kind, status, assignee,
                         reservation_id, reservation_label, source, hostaway_task_id, hostaway_state, hostaway_synced_at)
      VALUES (1, ${s.title.slice(0, 300) || 'Hostaway task'}, ${coreOf(t.description) || null}, ${unit}, ${utcToNyDay(t.shouldEndBy)},
              ${creator ? `Hostaway · ${userName(creator)}` : 'Hostaway'}, 'task', ${status}, ${assignee ? userName(assignee) : null},
              ${t.reservationId ? String(t.reservationId) : null}, ${label}, 'hostaway', ${String(t.id)}, ${JSON.stringify(s)}::jsonb, now())
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

async function applyPatch(sql: SqlFn, id: string, p: ReturnType<typeof changesFrom>['patch']) {
  const closing = p.status === 'done' || p.status === 'cancelled';
  const reopening = p.status !== undefined && !closing;
  await sql`UPDATE todos SET
      title       = COALESCE(${p.title ?? null}, title),
      description = CASE WHEN ${p.description !== undefined} THEN ${p.description ?? null} ELSE description END,
      assignee    = CASE WHEN ${p.assignee !== undefined} THEN ${p.assignee ?? null} ELSE assignee END,
      due_on      = CASE WHEN ${p.dueOn !== undefined} THEN ${p.dueOn ?? null}::date ELSE due_on END,
      cost_actual = CASE WHEN ${p.costActual !== undefined} THEN ${p.costActual ?? null}::numeric ELSE cost_actual END,
      status      = COALESCE(${p.status ?? null}, status),
      done_at     = CASE WHEN ${closing} THEN COALESCE(done_at, now()) WHEN ${reopening} THEN NULL ELSE done_at END,
      done_by     = CASE WHEN ${closing} THEN COALESCE(done_by, 'Hostaway') WHEN ${reopening} THEN NULL ELSE done_by END,
      updated_at  = now()
    WHERE account_id = 1 AND id = ${id}`;
}
