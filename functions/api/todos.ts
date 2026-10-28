/**
 * /api/todos — work (§76, §77): to-dos and work orders, `todos`.
 *
 *   GET                         open work, and what closed in the last 14 days
 *   GET ?claim=ID               every piece of work on one claim, however old
 *   GET ?updates=ID             one task's timeline
 *   GET ?history=1&from&to[&removed=1]   the done log (§87): closed — and, if asked, removed — in a range
 *   GET ?people=1               Hostaway's users, for the owner and supervisor pickers (§94)
 *   POST { action: 'create', title, kind?, unitIds?, dueOn?, dueTime?, scheduledOn?, startTime?, priority?,
 *          assigneeUserId?, supervisorUserId?, claimId?, vendor?, costEstimate?, costActual?, resolutionNote? }
 *        — several unitIds = one task per listing (§94)
 *   POST { action: 'update', id, …any of the above, status? }     null clears a field
 *   POST { action: 'done', id, done }                             the checkbox: completed / pending
 *   POST { action: 'note', id, body }                             an update, in words
 *   POST { action: 'delete', id }                                 stamped, never erased (its sub-tasks too)
 *   POST { action: 'restore', id }                                undo a removal, with what it took (§82)
 *   POST { action: 'toClaim', id, category?, severity? }          register it as a claim (§78)
 *   POST { action: 'hostawaySync', force? }                       pull changes from Hostaway tasks (§93)
 *
 * §93: with the Hostaway mirror on, every change here is pushed to the
 * work's Hostaway task after the response (waitUntil), and a page load
 * asks for Hostaway's changes at most every two minutes.
 *
 * §78: a task has a title and a `description`; `parentId` makes it a
 * sub-task (one level deep). A to-do can hold any number of sub-tasks of
 * any kind, or none.
 *
 * Every change of status or of a field writes its own line in the task's
 * timeline (work_updates), so "what happened to this" has an answer even
 * when nobody typed one. Work added to a claim is also said on the claim's
 * timeline — the claim is the case, and its history should read whole.
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { can } from '../_lib/roles.ts';
import { mirrorOn, people, pullAll, pushWork } from '../_lib/hostaway-tasks.ts';
import { settleRepair } from '../_lib/repair-costs.ts';
import { workLinkFor } from '../_lib/vendor-work.ts';
import { commentToThread, notifyTask, tellOwner, type TaskEvent } from '../_lib/slack.ts';
import { applyUrgency } from '../_lib/urgency.ts';
import { todayIn } from '../../src/lib/dates.ts';
import { tellHandyman } from '../_lib/vendor-slack.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^\d{1,18}$/;
const KINDS = ['task', 'work_order'];
// Hostaway's task model, word for word (§94).
const STATUSES = ['pending', 'confirmed', 'in_progress', 'completed', 'cancelled'];
const CLOSED = ['completed', 'cancelled'];
// Nobody has touched the work yet, so the first comment on it means it began (§143).
const UNSTARTED = ['pending', 'confirmed'];
const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'];
const STATUS_WORD: Record<string, string> = {
  // §159: the timeline speaks the app's words (Hostaway's values stay what is stored).
  pending: 'New', confirmed: 'New · confirmed', in_progress: 'In progress', completed: 'Done', cancelled: 'Cancelled'
};
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

interface Row {
  id: string; title: string; unit_ids: string[]; due_on: string | null;
  created_at: string | Date; created_by: string | null; done_at: string | Date | null; done_by: string | null;
  kind: string; status: string; priority: string; assignee: string | null; claim_id: string | null;
  vendor: string | null; scheduled_on: string | null; cost_estimate: string | null; cost_actual: string | null;
  updates: number; description: string | null; parent_id: string | null;
  reservation_id: string | null; reservation_label: string | null;
  hostaway_task_id?: string | null; hostaway_error?: string | null; source?: string;
  assignee_user_id?: number | null; supervisor_user_id?: number | null; supervisor?: string | null;
  start_time?: string | null; due_time?: string | null; resolution_note?: string | null;
  charge_owner?: boolean; hostaway_expense_id?: string | null;
  rev?: string | number;
  clean_group?: string | null; purchases?: number; files?: number; purchase_total?: string | null; is_order?: boolean; urgency_pending?: boolean;
}
const iso = (d: string | Date | null) => d == null ? null : new Date(d).toISOString();
const num = (v: string | null) => v == null ? null : Number(v);
const out = (r: Row) => ({
  id: String(r.id), title: r.title, unitIds: r.unit_ids ?? [], dueOn: r.due_on,
  createdAt: iso(r.created_at)!, createdBy: r.created_by, doneAt: iso(r.done_at), doneBy: r.done_by,
  kind: r.kind, status: r.status, priority: r.priority, assignee: r.assignee, claimId: r.claim_id,
  vendor: r.vendor, scheduledOn: r.scheduled_on, costEstimate: num(r.cost_estimate), costActual: num(r.cost_actual),
  updates: Number(r.updates ?? 0), description: r.description, parentId: r.parent_id,
  reservationId: r.reservation_id, reservationLabel: r.reservation_label,
  hostawayTaskId: r.hostaway_task_id ?? null, hostawayError: r.hostaway_error ?? null, source: r.source ?? 'kaizen',
  assigneeUserId: r.assignee_user_id ?? null, supervisorUserId: r.supervisor_user_id ?? null, supervisor: r.supervisor ?? null,
  startTime: r.start_time ?? null, dueTime: r.due_time ?? null, resolutionNote: r.resolution_note ?? null,
  chargeOwner: !!r.charge_owner, hostawayExpenseId: r.hostaway_expense_id ?? null,
  // §150: a cleaner's supplies request, and whether anything was bought for it — closing it unbought is asked.
  cleanGroup: r.clean_group ?? null, purchases: Number(r.purchases ?? 0), files: Number(r.files ?? 0),
  purchaseTotal: Number(r.purchase_total ?? 0), order: !!r.is_order, urgencyPending: !!r.urgency_pending,
  // Live work (§166): the row's version — a save says which one it edited.
  rev: String(r.rev ?? '')
});

async function list(sql: SqlFn, claim?: string, only?: string) {
  const rows = await sql`
    SELECT t.id, t.title, t.unit_ids, t.due_on::text AS due_on, t.created_at, t.created_by, t.done_at, t.done_by,
           t.kind, t.status, t.priority, t.assignee, t.claim_id, t.vendor, t.scheduled_on::text AS scheduled_on,
           t.cost_estimate, t.cost_actual, t.description, t.parent_id::text AS parent_id,
           t.reservation_id, t.reservation_label, t.hostaway_task_id, t.hostaway_error, t.source,
           t.assignee_user_id, t.supervisor_user_id, t.supervisor, to_char(t.start_time, 'HH24:MI') AS start_time,
           to_char(t.due_time, 'HH24:MI') AS due_time, t.resolution_note, t.charge_owner, t.hostaway_expense_id, t.clean_group, t.urgency_pending, t.rev,
           (SELECT count(*)::int FROM inventory_purchases p WHERE p.account_id = 1 AND p.todo_id = t.id) AS purchases,
           (SELECT sum(p.total) FROM inventory_purchases p WHERE p.account_id = 1 AND p.todo_id = t.id) AS purchase_total,
           -- §162: a purchase order wherever it is listed (a claim's work too) — the same rule as openOrders.
           (EXISTS (SELECT 1 FROM inventory_orders o WHERE o.account_id = 1 AND o.todo_id = t.id)
             OR (t.parent_id IS NULL AND t.clean_group IN ('request', 'inspection'))) AS is_order,
           (SELECT count(*)::int FROM todo_files f WHERE f.account_id = 1 AND f.todo_id = t.id) AS files,
           (SELECT count(*)::int FROM work_updates w
             WHERE w.account_id = 1 AND w.subject = 'task' AND w.subject_id = t.id::text) AS updates
      FROM todos t
     WHERE t.account_id = 1 AND t.deleted_at IS NULL
       AND (${only ?? null}::text IS NOT NULL AND t.id::text = ${only ?? null} OR ${only ?? null}::text IS NULL AND (${claim ?? null}::text IS NULL AND (t.done_at IS NULL OR t.done_at > now() - interval '14 days'
              -- A sub-task closed long ago still belongs under its open parent.
              OR t.parent_id IN (SELECT p.id FROM todos p WHERE p.account_id = 1 AND p.deleted_at IS NULL AND p.done_at IS NULL))
            OR t.claim_id = ${claim ?? null}))
     ORDER BY t.created_at` as Row[];
  return rows.map(out);
}

async function note(sql: SqlFn, subject: 'task' | 'claim', id: string, kind: 'note' | 'status' | 'change',
                    body: string, who: string) {
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, ${subject}, ${id}, ${kind}, ${body.slice(0, 4000)}, ${who})`;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const url = new URL(request.url);
  // Live work (§166): what every open screen asks every few seconds — has anything moved? One cheap line, no rows:
  // the sums move on any insert or update (the database bumps rev, migration 091), the counts on a new comment.
  // The screen reloads its list only when the answer differs from the last one it got.
  if (url.searchParams.get('live')) {
    const [r] = await sql`SELECT
        (SELECT concat(count(*), '.', COALESCE(sum(rev), 0)) FROM todos WHERE account_id = 1) AS todos,
        (SELECT concat(count(*), '.', COALESCE(sum(rev), 0)) FROM claims WHERE account_id = 1) AS claims,
        (SELECT concat(count(*), '.', COALESCE(max(id), 0)) FROM work_updates WHERE account_id = 1 AND subject = 'task') AS task_notes,
        (SELECT concat(count(*), '.', COALESCE(max(id), 0)) FROM work_updates WHERE account_id = 1 AND subject = 'claim') AS claim_notes,
        now() AS at` as
      { todos: string; claims: string; task_notes: string; claim_notes: string; at: string | Date }[];
    // New work for the bell: top-level to-dos after the last one this screen saw, made by someone else (from any door).
    const after = url.searchParams.get('after') ?? '';
    const [top] = await sql`SELECT COALESCE(max(id), 0)::text AS id FROM todos WHERE account_id = 1` as { id: string }[];
    const fresh = ID.test(after) ? await sql`
      SELECT t.id::text AS id, t.title, t.kind, t.priority, t.created_by, t.created_at, t.clean_group,
             (SELECT string_agg(u.name, ', ') FROM units u WHERE u.id = ANY(t.unit_ids)) AS units
        FROM todos t
       WHERE t.account_id = 1 AND t.id > ${after}::bigint AND t.parent_id IS NULL AND t.deleted_at IS NULL
         AND t.created_by IS DISTINCT FROM ${who.email}
       ORDER BY t.id LIMIT 20` as { id: string; title: string; kind: string; priority: string; created_by: string | null;
                                    created_at: string | Date; clean_group: string | null; units: string | null }[] : [];
    // Closed by someone else since the last answer (the database's clock both ways, so no skew).
    const since = url.searchParams.get('since') ?? '';
    const closed = since && !Number.isNaN(Date.parse(since)) ? await sql`
      SELECT t.id::text AS id, t.title, t.kind, t.priority, t.status, t.done_by, t.done_at, t.clean_group,
             (SELECT string_agg(u.name, ', ') FROM units u WHERE u.id = ANY(t.unit_ids)) AS units
        FROM todos t
       WHERE t.account_id = 1 AND t.status IN ('completed', 'cancelled') AND t.done_at > ${since}::timestamptz
         AND t.parent_id IS NULL AND t.deleted_at IS NULL AND t.done_by IS DISTINCT FROM ${who.email}
       ORDER BY t.done_at LIMIT 20` as { id: string; title: string; kind: string; priority: string; status: string; done_by: string | null;
                                         done_at: string | Date; clean_group: string | null; units: string | null }[] : [];
    const order = (g: string | null) => g === 'request' || g === 'inspection';
    return Response.json({ ok: true, todos: `${r!.todos}|${r!.task_notes}`, claims: `${r!.claims}|${r!.claim_notes}`, top: top!.id, at: iso(r!.at),
                           fresh: [...fresh.map(x => ({ id: x.id, event: 'new', title: x.title, kind: x.kind, priority: x.priority, createdBy: x.created_by,
                                                        createdAt: iso(x.created_at), order: order(x.clean_group), units: x.units })),
                                   ...closed.map(x => ({ id: x.id, event: x.status, title: x.title, kind: x.kind, priority: x.priority, createdBy: x.done_by,
                                                         createdAt: iso(x.done_at), order: order(x.clean_group), units: x.units }))] },
                         { headers: { 'Cache-Control': 'no-store' } });
  }
  const updates = url.searchParams.get('updates');
  if (updates) {
    if (!ID.test(updates)) return bad('Which task?');
    const rows = await sql`SELECT id, kind, body, created_by, created_at FROM work_updates
                            WHERE account_id = 1 AND subject = 'task' AND subject_id = ${updates}
                            ORDER BY created_at, id`;
    return Response.json({ ok: true, updates: rows.map((r: any) => ({ id: String(r.id), kind: r.kind, body: r.body,
      createdBy: r.created_by, createdAt: iso(r.created_at) })) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  // The done log (§87): everything closed in the range, by when it was
  // closed; removed ones too when asked — who removed what is audit too.
  if (url.searchParams.get('history')) {
    const DAYRX = /^\d{4}-\d{2}-\d{2}$/;
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (!DAYRX.test(from) || !DAYRX.test(to)) return bad('A date range, please.');
    const removed = url.searchParams.get('removed') === '1';
    const rows = await sql`
      SELECT t.id, t.title, t.unit_ids, t.due_on::text AS due_on, t.created_at, t.created_by, t.done_at, t.done_by,
             t.kind, t.status, t.priority, t.assignee, t.claim_id, t.vendor, t.scheduled_on::text AS scheduled_on,
             t.cost_estimate, t.cost_actual, t.description, t.parent_id::text AS parent_id,
             t.reservation_id, t.reservation_label, t.deleted_at, t.deleted_by,
             t.assignee_user_id, t.supervisor_user_id, t.supervisor, t.resolution_note,
             (SELECT count(*)::int FROM work_updates w
               WHERE w.account_id = 1 AND w.subject = 'task' AND w.subject_id = t.id::text) AS updates
        FROM todos t
       WHERE t.account_id = 1
         -- Days are New York days: an evening close belongs to that day, not UTC's next one.
         AND ((t.deleted_at IS NULL AND t.done_at IS NOT NULL
               AND (t.done_at AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date)
           OR (${removed} AND t.deleted_at IS NOT NULL
               AND (t.deleted_at AT TIME ZONE 'America/New_York')::date BETWEEN ${from}::date AND ${to}::date))
       ORDER BY COALESCE(t.deleted_at, t.done_at) DESC
       LIMIT 3000` as (Row & { deleted_at: string | Date | null; deleted_by: string | null })[];
    return Response.json({ ok: true, rows: rows.map(r => ({ ...out(r), deletedAt: iso(r.deleted_at), deletedBy: r.deleted_by })) },
                         { headers: { 'Cache-Control': 'no-store' } });
  }
  // §94: Hostaway's users, for the owner and supervisor pickers.
  if (url.searchParams.get('people')) {
    const list = await people(sql, () => getCredentials(sql, env.ENCRYPTION_KEY)).catch(() => []);
    return Response.json({ ok: true, people: list }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const claim = url.searchParams.get('claim') ?? undefined;
  if (claim !== undefined && !ID.test(claim) && !/^[\w-]{1,64}$/.test(claim)) return bad('Which claim?');
  return Response.json({ ok: true, todos: await list(sql, claim) }, { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, any>;

  // §93: Hostaway's side of the work — changes there, and tasks written there.
  if (b.action === 'hostawaySync') {
    try {
      const sync = await pullAll(sql, await getCredentials(sql, env.ENCRYPTION_KEY), b.force === true, undefined, env.ENCRYPTION_KEY);
      return Response.json({ ok: true, sync, todos: await list(sql) });
    } catch (e) {
      return Response.json({ ok: false, message: `Hostaway tasks: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
    }
  }
  // After the response: this work's Hostaway task follows what just changed.
  const mirror = (id: string) => waitUntil((async () => {
    if (!(await mirrorOn(sql))) return;
    await pushWork(sql, await getCredentials(sql, env.ENCRYPTION_KEY), id);
  })().catch(() => { /* kept on the row as hostaway_error by pushWork, or retried on the next pull */ }));
  // §95: the repair's expense in Costs (and the owner's charge in Hostaway) follows what just changed.
  const settle = (id: string) => settleRepair(sql, id, who.email, () => getCredentials(sql, env.ENCRYPTION_KEY));
  // §99: the news, in Slack's tasks channel — after the response, never failing the action.
  const tell = (id: string, ev: TaskEvent) => waitUntil(notifyTask(sql, env.ENCRYPTION_KEY, id, ev, who.email).catch(() => {}));
  // §100: and its owner hears it directly.
  const dm = (id: string) => waitUntil(tellOwner(sql, env.ENCRYPTION_KEY, id, who.email).catch(() => {}));

  // Each field: undefined = not being changed; null = cleared.
  const text = (v: unknown, max: number) => v === null ? null : typeof v === 'string' ? (v.trim().replace(/\s+/g, ' ').slice(0, max) || null) : undefined;
  const date = (v: unknown) => v === null || v === '' ? null : typeof v === 'string' ? v : undefined;
  const money = (v: unknown) => v === null || v === '' ? null : v === undefined ? undefined : Number(v);
  const f = {
    title: text(b.title, 300), dueOn: date(b.dueOn), scheduledOn: date(b.scheduledOn),
    vendor: text(b.vendor, 120),
    claimId: b.claimId === null || b.claimId === '' ? null : b.claimId === undefined ? undefined : String(b.claimId),
    costEstimate: money(b.costEstimate), costActual: money(b.costActual),
    kind: b.kind === undefined ? undefined : String(b.kind), priority: b.priority === undefined ? undefined : String(b.priority),
    status: b.status === undefined ? undefined : String(b.status),
    // The description keeps its line breaks; the title does not.
    description: b.description === null ? null : typeof b.description === 'string' ? (b.description.trim().slice(0, 4000) || null) : undefined,
    parentId: b.parentId === null || b.parentId === '' || b.parentId === undefined ? undefined : String(b.parentId),
    // The stay it is about (§84): an id from the stay picker, with its label.
    reservationId: b.reservationId === null || b.reservationId === '' ? null : b.reservationId === undefined ? undefined : String(b.reservationId),
    reservationLabel: typeof b.reservationLabel === 'string' ? b.reservationLabel.trim().slice(0, 160) || null : null,
    // §94: owner and supervisor are Hostaway users; times go with Start from / Finish by.
    assigneeUserId: b.assigneeUserId === null || b.assigneeUserId === '' ? null : b.assigneeUserId === undefined ? undefined : Number(b.assigneeUserId),
    supervisorUserId: b.supervisorUserId === null || b.supervisorUserId === '' ? null : b.supervisorUserId === undefined ? undefined : Number(b.supervisorUserId),
    startTime: b.startTime === null || b.startTime === '' ? null : typeof b.startTime === 'string' ? b.startTime.slice(0, 5) : undefined,
    dueTime: b.dueTime === null || b.dueTime === '' ? null : typeof b.dueTime === 'string' ? b.dueTime.slice(0, 5) : undefined,
    resolutionNote: b.resolutionNote === null ? null : typeof b.resolutionNote === 'string' ? (b.resolutionNote.trim().slice(0, 2000) || null) : undefined,
    // §95: a repair's cost also charged to the owner, as an expense in Hostaway.
    chargeOwner: typeof b.chargeOwner === 'boolean' ? b.chargeOwner : undefined
  };
  for (const tm of [f.startTime, f.dueTime]) if (tm && !TIME.test(tm)) return bad('Times are HH:MM.');
  // The people are Hostaway's: an id they do not have is refused, and the name is theirs.
  const personName = async (id: number | null | undefined) => {
    if (id == null) return id;
    const [u] = await sql`SELECT name FROM hostaway_users WHERE account_id = 1 AND id = ${id}` as { name: string }[];
    return u ? u.name : false;
  };
  const assigneeName = await personName(f.assigneeUserId);
  const supervisorName = await personName(f.supervisorUserId);
  if (assigneeName === false || supervisorName === false) return bad('That person is not a Hostaway user.');
  if (f.reservationId && !/^\d{1,20}$/.test(f.reservationId)) return bad('Which stay?');
  let parentTitle = '';
  if (f.parentId) {
    if (!ID.test(f.parentId)) return bad('Which parent task?');
    const p = (await sql`SELECT title, parent_id FROM todos WHERE account_id = 1 AND id = ${f.parentId} AND deleted_at IS NULL`)[0] as
      { title: string; parent_id: string | null } | undefined;
    if (!p) return bad('That parent task is gone.');
    // One level: a sub-task holds no sub-tasks, so a list never becomes a maze.
    if (p.parent_id) return bad('A sub-task cannot have sub-tasks of its own.');
    parentTitle = p.title;
  }
  for (const d of [f.dueOn, f.scheduledOn]) if (d && !DAY.test(d)) return bad('Dates are dates.');
  for (const m of [f.costEstimate, f.costActual]) if (m != null && (!Number.isFinite(m) || m < 0)) return bad('Costs are amounts, not below zero.');
  if (f.kind !== undefined && !KINDS.includes(f.kind)) return bad('A to-do or a work order.');
  if (f.status !== undefined && !STATUSES.includes(f.status)) return bad('Unknown status.');
  if (f.priority !== undefined && !PRIORITIES.includes(f.priority)) return bad('Priority is none, low, medium, high or urgent.');
  let unitIds: string[] | undefined;
  if (Array.isArray(b.unitIds)) {
    unitIds = [...new Set((b.unitIds as unknown[]).map(String))];
    if (unitIds.length) {
      const known = new Set((await sql`SELECT id FROM units WHERE id = ANY(${unitIds})`).map((r: any) => String(r.id)));
      if (unitIds.some(u => !known.has(u))) return bad('One of those listings is not known to Kaizen — sync units in Settings.');
    }
  }
  let claimLabel = '';
  if (f.claimId) {
    const c = (await sql`SELECT c.id, c.category, u.name AS unit FROM claims c LEFT JOIN units u ON u.id = c.unit_id
                          WHERE c.account_id = 1 AND c.id::text = ${f.claimId} AND c.deleted_at IS NULL`)[0] as { category: string | null; unit: string | null } | undefined;
    if (!c) return bad('That claim does not exist.');
    claimLabel = [c.unit, c.category].filter(Boolean).join(' · ');
  }

  if (b.action === 'create') {
    if (!f.title) return bad('Work needs a name.');
    const status = f.status && !CLOSED.includes(f.status) ? f.status : 'pending';
    // One listing per task, as in Hostaway (§94): several listings chosen = one task each.
    const targets: string[][] = unitIds && unitIds.length > 1 ? unitIds.map(u => [u]) : [unitIds ?? []];
    const ids: string[] = [];
    for (const units of targets) {
      // A stay belongs to one listing: it rides along only when there is one.
      const stay = targets.length === 1 ? f.reservationId ?? null : null;
      const row = (await sql`
        INSERT INTO todos (account_id, title, unit_ids, due_on, due_time, created_by, kind, status, priority,
                           assignee_user_id, assignee, supervisor_user_id, supervisor,
                           claim_id, vendor, scheduled_on, start_time, cost_estimate, cost_actual, description, parent_id,
                           reservation_id, reservation_label, charge_owner)
        VALUES (1, ${f.title}, ${units}, ${f.dueOn ?? null}, ${f.dueTime ?? null}::time, ${who.email}, ${f.kind ?? 'task'}, ${status},
                ${f.priority ?? 'none'}, ${f.assigneeUserId ?? null}, ${assigneeName ?? null},
                ${f.supervisorUserId ?? null}, ${supervisorName ?? null}, ${f.claimId ?? null}, ${f.vendor ?? null},
                ${f.scheduledOn ?? null}, ${f.startTime ?? null}::time, ${f.costEstimate ?? null}, ${f.costActual ?? null},
                ${f.description ?? null}, ${f.parentId ?? null}, ${stay}, ${stay ? f.reservationLabel : null}, ${f.chargeOwner ?? false})
        RETURNING id`)[0] as { id: string };
      ids.push(String(row.id));
      // §159: "+ Purchase order" (Home, To-do) — an order from its first moment, like a cleaner's request: listed
      // with the orders, built from what was written (✨), closed unbought only with a reason.
      if (b.asOrder === true && !f.parentId) await sql`UPDATE todos SET clean_group = 'request' WHERE account_id = 1 AND id = ${row.id}`;
      const what = b.asOrder === true ? 'Purchase order' : (f.kind ?? 'task') === 'work_order' ? 'Work order' : 'To-do';
      await note(sql, 'task', String(row.id), 'status',
        `${what} created${parentTitle ? ` under “${parentTitle}”` : ''}${claimLabel ? ` for the claim ${claimLabel}` : ''}` +
        `${targets.length > 1 ? ` (one of ${targets.length}, one per listing)` : ''}.`, who.email);
      if (f.parentId) await note(sql, 'task', f.parentId, 'change', `Sub-task added: ${f.title}`, who.email);
      if (f.claimId) await note(sql, 'claim', f.claimId, 'change', `${what} added: ${f.title}`, who.email);
      // Made in Slack: no channel notice — only work arriving from elsewhere (the app, Hostaway) is announced (§119).
      // A claim's work is told in the claim's thread, from Slack too. 'slack-thread': made by "@Kaizen new" inside a thread, which already says so there.
      if (!f.parentId) { mirror(String(row.id)); if ((b.via !== 'slack' || f.claimId) && b.via !== 'slack-thread') tell(String(row.id), 'created'); if (f.assigneeUserId) dm(String(row.id)); }
      // Owner, Oct 2026: a sub-task is told in its parent's thread — not a thread of its own.
      else if (b.via !== 'slack-thread') tell(String(row.id), 'created');
      await settle(String(row.id));
    }
    if (f.vendor && (f.kind ?? 'task') === 'work_order') waitUntil(tellHandyman(sql, env.ENCRYPTION_KEY, ids, new URL(request.url).origin));
    return Response.json({ ok: true, id: ids[0], ids, todos: await list(sql, b.claimScope ? f.claimId ?? undefined : undefined) });
  }

  const id = String(b.id ?? '');
  if (!ID.test(id)) return bad('Which task?');
  // Undo of a removal (§82): the task, and the sub-tasks removed in the same instant.
  // §137: the link for the vendor of a work order — a day and a vendor first.
  if (b.action === 'vendorLink') {
    try { return Response.json({ ok: true, ...(await workLinkFor(sql, env.ENCRYPTION_KEY, String(b.id ?? ''), new URL(request.url).origin)) }); }
    catch (e) { return bad(e instanceof Error ? e.message : String(e)); }
  }

  if (b.action === 'restore') {
    const gone = (await sql`SELECT title, deleted_at, claim_id FROM todos WHERE account_id = 1 AND id = ${id} AND deleted_at IS NOT NULL`)[0] as
      { title: string; deleted_at: string | Date; claim_id: string | null } | undefined;
    if (!gone) return bad('Nothing to restore — it is not removed.');
    const kids = await sql`UPDATE todos SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
                            WHERE account_id = 1 AND parent_id = ${id} AND deleted_at = ${gone.deleted_at} RETURNING id`;
    await sql`UPDATE todos SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE account_id = 1 AND id = ${id}`;
    await note(sql, 'task', id, 'change', `Restored${kids.length ? ` with its ${kids.length} sub-task${kids.length === 1 ? '' : 's'}` : ''}`, who.email);
    if (gone.claim_id) await note(sql, 'claim', gone.claim_id, 'change', `Restored: ${gone.title}`, who.email);
    for (const x of [id, ...kids.map((k: any) => String(k.id))]) await settle(x);
    mirror(id);
    return Response.json({ ok: true, todos: await list(sql, b.claimScope ? String(b.claimScope) : undefined) });
  }

  const before = (await sql`SELECT title, status, priority, assignee, supervisor, due_on::text AS due_on, claim_id, vendor,
                                   to_char(start_time, 'HH24:MI') AS start_time, to_char(due_time, 'HH24:MI') AS due_time, resolution_note, charge_owner,
                                   scheduled_on::text AS scheduled_on, cost_estimate, cost_actual, kind, unit_ids, description,
                                   reservation_id, reservation_label, parent_id, clean_group, urgency_pending, rev::text AS rev, done_by
                              FROM todos WHERE account_id = 1 AND id = ${id} AND deleted_at IS NULL`)[0] as Record<string, any> | undefined;
  if (!before) return Response.json({ ok: false, message: 'That task is gone — someone removed it.' }, { status: 404 });
  const scope = b.claimScope ? String(b.claimScope) : undefined;
  // Live work (§166): a save from an open screen says which version it edited. Moved since → refused with the row as it
  // is now, and who touched it last; the screen keeps what does not collide and asks about what does. Doors without a
  // version (Slack, the field links, Hostaway's pull) write as before.
  const baseRev = b.baseRev == null || b.baseRev === '' ? null : String(b.baseRev);
  if (baseRev !== null && !/^\d{1,19}$/.test(baseRev)) return bad('Which version?');
  const conflict = async (error: 'conflict' | 'already', message: string) => {
    const [last] = await sql`SELECT created_by, created_at FROM work_updates WHERE account_id = 1 AND subject = 'task' AND subject_id = ${id}
                             ORDER BY id DESC LIMIT 1` as { created_by: string | null; created_at: string | Date }[];
    const [current] = await list(sql, undefined, id);
    return Response.json({ ok: false, error, message, current: current ?? null,
                           by: last?.created_by ?? null, at: last ? iso(last.created_at) : null, todos: await list(sql, scope) }, { status: 409 });
  };
  if (baseRev !== null && before.rev !== baseRev) {
    // ✓ Done / ↺ Reopen on something already there: say so instead of doing it twice.
    if (b.action === 'done') {
      const want = b.done === false ? 'open' : 'closed';
      if ((want === 'closed') === CLOSED.includes(before.status))
        return conflict('already', want === 'closed' ? `Already ${STATUS_WORD[before.status]!.toLowerCase()}${before.done_by ? ` by ${before.done_by}` : ''}.` : 'Already reopened.');
    } else if (b.action === 'update') return conflict('conflict', 'Someone changed this while you were editing.');
  }

  // §162 (owner, 2026-10-15): the team answers a field report's urgency — Slack's buttons on its message, or Kaizen.
  // Priority, deadline (urgent today; high the checkout of the stay ahead, attached) and its check sub-task closed.
  if (b.action === 'urgency') {
    const p = String(b.priority ?? '');
    if (!['urgent', 'high', 'medium', 'low'].includes(p)) return bad('Urgent, high, medium or low?');
    const r = await applyUrgency(sql, env.ENCRYPTION_KEY, id, p, who.email);
    mirror(id); tell(id, 'urgency');
    return Response.json({ ok: true, said: r.said, dueOn: r.dueOn, todos: await list(sql, scope) });
  }

  // Owner, 2026-10-27: a repair's vendor takes its items like a cleaner takes cleans — all of them, or all but some.
  // Written on each item (never inherited), so "all but this one" stays true when the repair's vendor changes again.
  if (b.action === 'giveItems') {
    if (before.kind !== 'work_order' || !before.vendor) return bad('Set and save the repair’s vendor first.');
    const want = (Array.isArray(b.items) ? b.items : []).map(String).filter(x => ID.test(x));
    const given = await sql`UPDATE todos SET vendor = ${before.vendor}, updated_at = now()
                             WHERE account_id = 1 AND parent_id = ${id} AND id = ANY(${want.map(Number)}::bigint[]) AND kind = 'work_order'
                               AND deleted_at IS NULL AND status NOT IN ('completed', 'cancelled') AND vendor IS DISTINCT FROM ${before.vendor}
                             RETURNING id::text, title` as { id: string; title: string }[];
    for (const g of given) { await note(sql, 'task', g.id, 'change', `Vendor: ${before.vendor} — given with the repair`, who.email); mirror(g.id); await settle(g.id); }
    if (given.length) await note(sql, 'task', id, 'change', `${before.vendor} has ${given.length} item${given.length === 1 ? '' : 's'}: ${given.map(g => g.title).join('; ')}`.slice(0, 4000), who.email);
    if (given.length) waitUntil(tellHandyman(sql, env.ENCRYPTION_KEY, given.map(g => g.id), new URL(request.url).origin));
    return Response.json({ ok: true, given: given.length, todos: await list(sql, scope) });
  }

  // §159 (owner, 2026-10-14): two to-dos that are the same job become one. Everything that was said and attached
  // moves to the one that stays; the other closes as cancelled, saying where it went (and Hostaway closes it too).
  if (b.action === 'merge') {
    const into = String(b.into ?? '');
    if (!ID.test(into) || into === id) return bad('Merge into which to-do?');
    const tgt = (await sql`SELECT id::text, title, parent_id::text AS parent_id, claim_id, status FROM todos
                           WHERE account_id = 1 AND id = ${into} AND deleted_at IS NULL`)[0] as
      { id: string; title: string; parent_id: string | null; claim_id: string | null; status: string } | undefined;
    if (!tgt) return bad('That to-do is gone.');
    if (CLOSED.includes(tgt.status)) return bad('Reopen it first — work is not merged into a closed to-do.');
    if (tgt.parent_id === id) return bad('That is inside this one — merge the other way round.');
    const [kc] = await sql`SELECT count(*)::int AS n FROM todos WHERE account_id = 1 AND parent_id = ${id} AND deleted_at IS NULL` as { n: number }[];
    const kidsN = kc?.n ?? 0;
    if (kidsN && tgt.parent_id) return bad('This one has items inside, and the other is itself inside a to-do — merge into its parent instead.');
    await sql`UPDATE todos SET parent_id = ${into} WHERE account_id = 1 AND parent_id = ${id} AND deleted_at IS NULL`;
    await sql`UPDATE work_updates SET subject_id = ${into} WHERE account_id = 1 AND subject = 'task' AND subject_id = ${id} AND kind = 'note'`;
    await sql`UPDATE todo_files SET todo_id = ${Number(into)} WHERE account_id = 1 AND todo_id = ${Number(id)}`;
    await sql`UPDATE work_photos SET todo_id = ${Number(into)} WHERE account_id = 1 AND todo_id = ${Number(id)}`;
    await sql`UPDATE inventory_moves SET todo_id = ${Number(into)} WHERE account_id = 1 AND todo_id = ${Number(id)}`;
    await sql`UPDATE inventory_purchases SET todo_id = ${Number(into)} WHERE account_id = 1 AND todo_id = ${Number(id)}`;
    await sql`UPDATE inspection_checks SET todo_id = ${Number(into)} WHERE account_id = 1 AND todo_id = ${Number(id)}`;
    await sql`UPDATE field_expenses SET todo_id = ${Number(into)} WHERE account_id = 1 AND todo_id = ${Number(id)}`;
    // An order on both: one order with both lists of lines.
    await sql`INSERT INTO inventory_orders (account_id, todo_id, lines, created_by)
              SELECT account_id, ${Number(into)}, lines, created_by FROM inventory_orders WHERE account_id = 1 AND todo_id = ${Number(id)}
              ON CONFLICT (account_id, todo_id) DO UPDATE SET lines = inventory_orders.lines || EXCLUDED.lines`;
    await sql`DELETE FROM inventory_orders WHERE account_id = 1 AND todo_id = ${Number(id)}`;
    if (!tgt.claim_id && before.claim_id) await sql`UPDATE todos SET claim_id = ${before.claim_id} WHERE account_id = 1 AND id = ${into}`;
    if ((before.description ?? '').trim())
      await sql`UPDATE todos SET description = concat_ws(E'\n\n', NULLIF(description, ''), ${`From “${before.title}”: ${before.description}`}), updated_at = now()
                WHERE account_id = 1 AND id = ${into}`;
    await sql`UPDATE todos SET status = 'cancelled', done_at = now(), done_by = ${who.email},
                               resolution_note = ${`Merged into #${into} — ${tgt.title}`.slice(0, 2000)}, updated_at = now()
              WHERE account_id = 1 AND id = ${id}`;
    await note(sql, 'task', into, 'change', `Merged in: “${before.title}” (#${id}) — its comments, files and items are here now`, who.email);
    await note(sql, 'task', id, 'status', `Merged into #${into} — “${tgt.title}”`, who.email);
    mirror(id); mirror(into);
    return Response.json({ ok: true, todos: await list(sql, scope) });
  }

  if (b.action === 'note') {
    const body = typeof b.body === 'string' ? b.body.trim().slice(0, 4000) : '';
    if (!body) return bad('An update needs words.');
    await note(sql, 'task', id, 'note', body, who.email);
    // §143: the first comment is what "started" means — somebody is on it, in
    // words. Saying so by hand as well was a button that told nobody anything
    // (the field already does this when a vendor's "before" photos land).
    if (UNSTARTED.includes(before.status)) {
      await sql`UPDATE todos SET status = 'in_progress', updated_at = now() WHERE account_id = 1 AND id = ${id}`;
      await note(sql, 'task', id, 'status', `${STATUS_WORD[before.status]} → ${STATUS_WORD.in_progress}`, who.email);
      mirror(id);
    }
    if (b.via !== 'slack-thread') waitUntil(commentToThread(sql, env.ENCRYPTION_KEY, 'task', id, body, who.email).catch(() => {}));
    return Response.json({ ok: true, todos: await list(sql, scope) });
  }

  // Register a to-do as a claim (§78): everything can start as a to-do, and
  // become a case when it turns out to be one. The claim is created on the
  // Claims side and this task is linked to it — both timelines say so.
  if (b.action === 'toClaim') {
    if (!can((await accessOf(sql, who)).permissions, 'claims')) {
      return Response.json({ ok: false, message: 'Your role does not include claims.' }, { status: 403 });
    }
    if (before.claim_id) return bad('It already belongs to a claim.');
    const severity = ['Low', 'Medium', 'High', 'Critical'].includes(String(b.severity)) ? String(b.severity) : 'Medium';
    const category = typeof b.category === 'string' && b.category.trim() ? b.category.trim().slice(0, 60) : null;
    const detail = (await sql`SELECT description FROM todos WHERE id = ${id}`)[0]?.description as string | null;
    const c = (await sql`
      INSERT INTO claims (account_id, unit_id, occurred_on, category, severity, status, description, refund, created_by,
                          reservation_id, reservation_label)
      VALUES (1, ${(before.unit_ids ?? [])[0] ?? null}, ${todayIn('America/New_York')}, ${category}, ${severity}, 'Open',
              ${[before.title, detail].filter(Boolean).join(' — ').slice(0, 2000)}, 0, ${who.email},
              ${before.reservation_id ?? null}, ${before.reservation_label ?? null})
      RETURNING id`)[0] as { id: string | number };
    const claimId = String(c.id);
    await sql`UPDATE todos SET claim_id = ${claimId}, updated_at = now() WHERE account_id = 1 AND id = ${id}`;
    await note(sql, 'claim', claimId, 'status', `Claim opened from the to-do “${before.title}”`, who.email);
    await note(sql, 'task', id, 'change', 'Registered as a claim', who.email);
    return Response.json({ ok: true, claimId, todos: await list(sql, scope) });
  }

  if (b.action === 'delete') {
    // One instant for the task and the sub-tasks that go with it, so an
    // undo brings back exactly what this removal took — no more, no less.
    const at = new Date().toISOString();
    await sql`UPDATE todos SET deleted_at = ${at}, deleted_by = ${who.email} WHERE account_id = 1 AND id = ${id}`;
    const kids = await sql`UPDATE todos SET deleted_at = ${at}, deleted_by = ${who.email}
                            WHERE account_id = 1 AND parent_id = ${id} AND deleted_at IS NULL RETURNING id`;
    await note(sql, 'task', id, 'change', `Removed${kids.length ? ` with its ${kids.length} sub-task${kids.length === 1 ? '' : 's'}` : ''}`, who.email);
    if (before.claim_id) await note(sql, 'claim', before.claim_id, 'change', `Removed: ${before.title}`, who.email);
    for (const x of [id, ...kids.map((k: any) => String(k.id))]) await settle(x);
    mirror(id);
    return Response.json({ ok: true, todos: await list(sql, scope) });
  }

  // update / done — work out the new status, then write what changed.
  let status = f.status;
  if (b.action === 'done') status = b.done === false ? 'pending' : 'completed';
  else if (b.action !== 'update') return bad('Unknown action.');
  if (b.action === 'update' && f.title === null) return bad('Work needs a name.');
  // One listing per task (§94); a new one is written as its own task.
  if (unitIds && unitIds.length > 1) return bad('A task is on one listing — add another task for the next one.');

  const closedNow = status !== undefined && CLOSED.includes(status);
  // §150, owner: a cleaner's or an inspection's request is an ORDER; closing it with nothing bought reads as dismissing
  // it — refused without a reason, from any door (Kaizen, Slack), and the reason is kept on the to-do.
  // Owner, 2026-10-15: the same for any to-do that carries an order with lines ("Buy supplies…", one for later) — an
  // order always ends bought, kept, moved to a new order, or closed with a reason; never lost without a word.
  const [ordered] = closedNow && !CLOSED.includes(before.status) && !before.parent_id && before.clean_group !== 'request' && before.clean_group !== 'inspection'
    ? await sql`SELECT 1 FROM inventory_orders WHERE account_id = 1 AND todo_id = ${id} AND jsonb_array_length(lines) > 0` : [];
  if (closedNow && !CLOSED.includes(before.status) && !before.parent_id && (before.clean_group === 'request' || before.clean_group === 'inspection' || ordered)) {
    const [pu] = await sql`SELECT count(*)::int AS n FROM inventory_purchases WHERE account_id = 1 AND todo_id = ${id}` as { n: number }[];
    const reason = String(b.closeReason ?? '').trim().slice(0, 300);
    if (!pu!.n && !reason) return Response.json({ ok: false, error: 'unbought',
      message: `Nothing was bought for this ${ordered ? 'order' : 'request'} — record the purchase, or say why it is closed.` }, { status: 409 });
    if (!pu!.n) await note(sql, 'task', id, 'note', `Closed without buying: ${reason}`, who.email);
  }
  const wrote = await sql`UPDATE todos SET
      title         = COALESCE(${f.title ?? null}, title),
      unit_ids      = COALESCE(${unitIds ?? null}::text[], unit_ids),
      due_on        = CASE WHEN ${f.dueOn !== undefined} THEN ${f.dueOn ?? null}::date ELSE due_on END,
      scheduled_on  = CASE WHEN ${f.scheduledOn !== undefined} THEN ${f.scheduledOn ?? null}::date ELSE scheduled_on END,
      assignee_user_id   = CASE WHEN ${f.assigneeUserId !== undefined} THEN ${f.assigneeUserId ?? null}::int ELSE assignee_user_id END,
      assignee           = CASE WHEN ${f.assigneeUserId !== undefined} THEN ${assigneeName ?? null} ELSE assignee END,
      supervisor_user_id = CASE WHEN ${f.supervisorUserId !== undefined} THEN ${f.supervisorUserId ?? null}::int ELSE supervisor_user_id END,
      supervisor         = CASE WHEN ${f.supervisorUserId !== undefined} THEN ${supervisorName ?? null} ELSE supervisor END,
      start_time    = CASE WHEN ${f.startTime !== undefined} THEN ${f.startTime ?? null}::time ELSE start_time END,
      due_time      = CASE WHEN ${f.dueTime !== undefined} THEN ${f.dueTime ?? null}::time ELSE due_time END,
      resolution_note = CASE WHEN ${f.resolutionNote !== undefined} THEN ${f.resolutionNote ?? null} ELSE resolution_note END,
      charge_owner  = COALESCE(${f.chargeOwner ?? null}::boolean, charge_owner),
      vendor        = CASE WHEN ${f.vendor !== undefined} THEN ${f.vendor ?? null} ELSE vendor END,
      claim_id      = CASE WHEN ${f.claimId !== undefined} THEN ${f.claimId ?? null} ELSE claim_id END,
      cost_estimate = CASE WHEN ${f.costEstimate !== undefined} THEN ${f.costEstimate ?? null}::numeric ELSE cost_estimate END,
      cost_actual   = CASE WHEN ${f.costActual !== undefined} THEN ${f.costActual ?? null}::numeric ELSE cost_actual END,
      kind          = COALESCE(${f.kind ?? null}, kind),
      priority      = COALESCE(${f.priority ?? null}, priority),
      description   = CASE WHEN ${f.description !== undefined} THEN ${f.description ?? null} ELSE description END,
      reservation_id    = CASE WHEN ${f.reservationId !== undefined} THEN ${f.reservationId ?? null} ELSE reservation_id END,
      reservation_label = CASE WHEN ${f.reservationId !== undefined} THEN ${f.reservationId ? f.reservationLabel : null} ELSE reservation_label END,
      status        = COALESCE(${status ?? null}, status),
      done_at       = CASE WHEN ${status === undefined} THEN done_at WHEN ${closedNow} THEN COALESCE(done_at, now()) ELSE NULL END,
      done_by       = CASE WHEN ${status === undefined} THEN done_by WHEN ${closedNow} THEN COALESCE(done_by, ${who.email}) ELSE NULL END,
      updated_at    = now()
    WHERE account_id = 1 AND id = ${id} AND (${b.action === 'update' ? baseRev : null}::bigint IS NULL OR rev = ${baseRev}::bigint)
    RETURNING id` as unknown[];
  // Moved between the check above and this write: the same answer, never a silent overwrite.
  if (!wrote.length) return conflict('conflict', 'Someone changed this while you were editing.');

  // The timeline, in words.
  if (status !== undefined && status !== before.status) {
    await note(sql, 'task', id, 'status', `${STATUS_WORD[before.status]} → ${STATUS_WORD[status]}`, who.email);
    if (before.claim_id && CLOSED.includes(status)) {
      await note(sql, 'claim', before.claim_id, 'change', `${STATUS_WORD[status]}: ${before.title}`, who.email);
    }
  }
  const changed: string[] = [];
  const cmp = (label: string, was: unknown, now: unknown, show = (v: unknown) => v == null || v === '' ? '—' : String(v)) => {
    if (now === undefined || String(was ?? '') === String(now ?? '')) return;
    changed.push(`${label}: ${show(was)} → ${show(now)}`);
  };
  cmp('Title', before.title, f.title ?? undefined);
  cmp('Finish by', before.due_on, f.dueOn);
  cmp('Start from', before.scheduled_on, f.scheduledOn);
  cmp('Owner', before.assignee, f.assigneeUserId !== undefined ? assigneeName ?? null : undefined);
  cmp('Supervisor', before.supervisor, f.supervisorUserId !== undefined ? supervisorName ?? null : undefined);
  cmp('Start time', before.start_time, f.startTime);
  cmp('Finish-by time', before.due_time, f.dueTime);
  if (f.resolutionNote !== undefined && (before.resolution_note ?? '') !== (f.resolutionNote ?? '')) {
    changed.push(f.resolutionNote ? `Resolution: ${f.resolutionNote}` : 'Resolution cleared');
  }
  cmp('Vendor', before.vendor, f.vendor);
  cmp('Priority', before.priority, f.priority);
  cmp('Kind', before.kind, f.kind);
  if (f.reservationId !== undefined && (before.reservation_id ?? '') !== (f.reservationId ?? '')) {
    changed.push(f.reservationId ? `Stay: ${f.reservationLabel ?? f.reservationId}` : 'No longer tied to a stay');
  }
  if (f.description !== undefined && (before.description ?? '') !== (f.description ?? '')) {
    changed.push(f.description ? 'Description updated' : 'Description cleared');
  }
  cmp('Estimate', before.cost_estimate == null ? null : Number(before.cost_estimate), f.costEstimate, v => v == null ? '—' : `$${Number(v).toFixed(2)}`);
  cmp('Actual cost', before.cost_actual == null ? null : Number(before.cost_actual), f.costActual, v => v == null ? '—' : `$${Number(v).toFixed(2)}`);
  if (f.claimId !== undefined && String(before.claim_id ?? '') !== String(f.claimId ?? '')) {
    changed.push(f.claimId ? `Linked to the claim ${claimLabel}` : 'Unlinked from its claim');
    if (f.claimId) await note(sql, 'claim', f.claimId, 'change', `Linked: ${f.title ?? before.title}`, who.email);
  }
  const same = (a: string[], c: string[]) => [...a].sort((x, y) => x.localeCompare(y)).join() === [...c].sort((x, y) => x.localeCompare(y)).join();
  if (unitIds && !same(unitIds, before.unit_ids ?? [])) {
    const names = unitIds.length ? (await sql`SELECT name FROM units WHERE id = ANY(${unitIds}) ORDER BY name`).map((r: any) => r.name).join(', ') : 'none';
    changed.push(`Listings: ${names}`);
  }
  if (f.chargeOwner !== undefined && f.chargeOwner !== before.charge_owner) changed.push(f.chargeOwner ? 'Charged to the owner' : 'No longer charged to the owner');
  if (changed.length) await note(sql, 'task', id, 'change', changed.join(' · '), who.email);
  await settle(id);
  mirror(id);
  // §159 (owner, 2026-10-14): something done inside a to-do is work on it — an Open parent moves to In progress,
  // as the first comment already does (§143). Only on completing, only an unstarted parent, said on its timeline.
  if (status === 'completed' && before.status !== 'completed' && before.parent_id) {
    const [par] = await sql`UPDATE todos SET status = 'in_progress', updated_at = now()
                            WHERE account_id = 1 AND id = ${before.parent_id} AND status = ANY(${UNSTARTED}) AND deleted_at IS NULL
                            RETURNING id::text, status` as { id: string }[];
    if (par) {
      await note(sql, 'task', par.id, 'status', `${STATUS_WORD.pending} → ${STATUS_WORD.in_progress} — “${before.title}” was done`, who.email);
      mirror(par.id);
    }
  }
  // §162: every status change is a line in the item's thread, saying who — from a Slack button too (it is a reply now,
  // not a second message in the channel, which is what 'slack-message' used to avoid).
  if (status !== undefined && status !== before.status) {
    if (CLOSED.includes(status)) tell(id, status === 'completed' ? 'completed' : 'cancelled');
    else if (CLOSED.includes(before.status)) tell(id, 'reopened');
    else tell(id, 'status');
  }
  if (f.assigneeUserId !== undefined && (assigneeName ?? null) !== (before.assignee ?? null) && assigneeName) { tell(id, 'assigned'); dm(id); }
  // Owner, 2026-10-27: a work order given to a handyman (a new vendor) is told in their channel, with their page's link.
  if (f.vendor && (f.kind ?? before.kind) === 'work_order' && f.vendor.trim().toLowerCase() !== (before.vendor ?? '').trim().toLowerCase())
    waitUntil(tellHandyman(sql, env.ENCRYPTION_KEY, [id], new URL(request.url).origin));
  // §164: a priority set in Kaizen on a report still waiting for its urgency answers it — the same deadline rule as
  // Slack's buttons, unless a date was set by hand in the same save.
  if (f.priority !== undefined && f.priority !== before.priority && f.priority !== 'none' && before.urgency_pending) {
    await applyUrgency(sql, env.ENCRYPTION_KEY, id, f.priority, who.email, f.dueOn !== undefined && f.dueOn !== before.due_on); tell(id, 'urgency');
  }

  return Response.json({ ok: true, todos: await list(sql, scope) });
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
