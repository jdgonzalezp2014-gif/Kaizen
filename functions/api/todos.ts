/**
 * /api/todos — work (§76, §77): to-dos and work orders, `todos`.
 *
 *   GET                         open work, and what closed in the last 14 days
 *   GET ?claim=ID               every piece of work on one claim, however old
 *   GET ?updates=ID             one task's timeline
 *   POST { action: 'create', title, kind?, unitIds?, dueOn?, priority?, assignee?, claimId?,
 *          vendor?, scheduledOn?, costEstimate?, costActual? }
 *   POST { action: 'update', id, …any of the above, status? }     null clears a field
 *   POST { action: 'done', id, done }                             the checkbox
 *   POST { action: 'note', id, body }                             an update, in words
 *   POST { action: 'delete', id }                                 stamped, never erased (its sub-tasks too)
 *   POST { action: 'restore', id }                                undo a removal, with what it took (§82)
 *   POST { action: 'toClaim', id, category?, severity? }          register it as a claim (§78)
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
import { accessOf, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { can } from '../_lib/roles.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^\d{1,18}$/;
const KINDS = ['task', 'work_order'];
const STATUSES = ['open', 'in_progress', 'waiting', 'done', 'cancelled'];
const PRIORITIES = ['normal', 'high', 'urgent'];
const STATUS_WORD: Record<string, string> = {
  open: 'To do', in_progress: 'In progress', waiting: 'Waiting', done: 'Done', cancelled: 'Cancelled'
};

interface Row {
  id: string; title: string; unit_ids: string[]; due_on: string | null;
  created_at: string | Date; created_by: string | null; done_at: string | Date | null; done_by: string | null;
  kind: string; status: string; priority: string; assignee: string | null; claim_id: string | null;
  vendor: string | null; scheduled_on: string | null; cost_estimate: string | null; cost_actual: string | null;
  updates: number; description: string | null; parent_id: string | null;
  reservation_id: string | null; reservation_label: string | null;
}
const iso = (d: string | Date | null) => d == null ? null : new Date(d).toISOString();
const num = (v: string | null) => v == null ? null : Number(v);
const out = (r: Row) => ({
  id: String(r.id), title: r.title, unitIds: r.unit_ids ?? [], dueOn: r.due_on,
  createdAt: iso(r.created_at)!, createdBy: r.created_by, doneAt: iso(r.done_at), doneBy: r.done_by,
  kind: r.kind, status: r.status, priority: r.priority, assignee: r.assignee, claimId: r.claim_id,
  vendor: r.vendor, scheduledOn: r.scheduled_on, costEstimate: num(r.cost_estimate), costActual: num(r.cost_actual),
  updates: Number(r.updates ?? 0), description: r.description, parentId: r.parent_id,
  reservationId: r.reservation_id, reservationLabel: r.reservation_label
});

async function list(sql: SqlFn, claim?: string) {
  const rows = await sql`
    SELECT t.id, t.title, t.unit_ids, t.due_on::text AS due_on, t.created_at, t.created_by, t.done_at, t.done_by,
           t.kind, t.status, t.priority, t.assignee, t.claim_id, t.vendor, t.scheduled_on::text AS scheduled_on,
           t.cost_estimate, t.cost_actual, t.description, t.parent_id::text AS parent_id,
           t.reservation_id, t.reservation_label,
           (SELECT count(*)::int FROM work_updates w
             WHERE w.account_id = 1 AND w.subject = 'task' AND w.subject_id = t.id::text) AS updates
      FROM todos t
     WHERE t.account_id = 1 AND t.deleted_at IS NULL
       AND (${claim ?? null}::text IS NULL AND (t.done_at IS NULL OR t.done_at > now() - interval '14 days'
              -- A sub-task closed long ago still belongs under its open parent.
              OR t.parent_id IN (SELECT p.id FROM todos p WHERE p.account_id = 1 AND p.deleted_at IS NULL AND p.done_at IS NULL))
            OR t.claim_id = ${claim ?? null})
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
  const updates = url.searchParams.get('updates');
  if (updates) {
    if (!ID.test(updates)) return bad('Which task?');
    const rows = await sql`SELECT id, kind, body, created_by, created_at FROM work_updates
                            WHERE account_id = 1 AND subject = 'task' AND subject_id = ${updates}
                            ORDER BY created_at, id`;
    return Response.json({ ok: true, updates: rows.map((r: any) => ({ id: String(r.id), kind: r.kind, body: r.body,
      createdBy: r.created_by, createdAt: iso(r.created_at) })) }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const claim = url.searchParams.get('claim') ?? undefined;
  if (claim !== undefined && !ID.test(claim) && !/^[\w-]{1,64}$/.test(claim)) return bad('Which claim?');
  return Response.json({ ok: true, todos: await list(sql, claim) }, { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, any>;

  // Each field: undefined = not being changed; null = cleared.
  const text = (v: unknown, max: number) => v === null ? null : typeof v === 'string' ? (v.trim().replace(/\s+/g, ' ').slice(0, max) || null) : undefined;
  const date = (v: unknown) => v === null || v === '' ? null : typeof v === 'string' ? v : undefined;
  const money = (v: unknown) => v === null || v === '' ? null : v === undefined ? undefined : Number(v);
  const f = {
    title: text(b.title, 300), dueOn: date(b.dueOn), scheduledOn: date(b.scheduledOn),
    assignee: text(b.assignee, 120), vendor: text(b.vendor, 120),
    claimId: b.claimId === null || b.claimId === '' ? null : b.claimId === undefined ? undefined : String(b.claimId),
    costEstimate: money(b.costEstimate), costActual: money(b.costActual),
    kind: b.kind === undefined ? undefined : String(b.kind), priority: b.priority === undefined ? undefined : String(b.priority),
    status: b.status === undefined ? undefined : String(b.status),
    // The description keeps its line breaks; the title does not.
    description: b.description === null ? null : typeof b.description === 'string' ? (b.description.trim().slice(0, 4000) || null) : undefined,
    parentId: b.parentId === null || b.parentId === '' || b.parentId === undefined ? undefined : String(b.parentId),
    // The stay it is about (§84): an id from the stay picker, with its label.
    reservationId: b.reservationId === null || b.reservationId === '' ? null : b.reservationId === undefined ? undefined : String(b.reservationId),
    reservationLabel: typeof b.reservationLabel === 'string' ? b.reservationLabel.trim().slice(0, 160) || null : null
  };
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
  if (f.priority !== undefined && !PRIORITIES.includes(f.priority)) return bad('Priority is normal, high or urgent.');
  if (f.status !== undefined && !STATUSES.includes(f.status)) return bad('Unknown status.');
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
    const status = f.status && !['done', 'cancelled'].includes(f.status) ? f.status : 'open';
    const row = (await sql`
      INSERT INTO todos (account_id, title, unit_ids, due_on, created_by, kind, status, priority, assignee,
                         claim_id, vendor, scheduled_on, cost_estimate, cost_actual, description, parent_id,
                         reservation_id, reservation_label)
      VALUES (1, ${f.title}, ${unitIds ?? []}, ${f.dueOn ?? null}, ${who.email}, ${f.kind ?? 'task'}, ${status},
              ${f.priority ?? 'normal'}, ${f.assignee ?? null}, ${f.claimId ?? null}, ${f.vendor ?? null},
              ${f.scheduledOn ?? null}, ${f.costEstimate ?? null}, ${f.costActual ?? null},
              ${f.description ?? null}, ${f.parentId ?? null},
              ${f.reservationId ?? null}, ${f.reservationId ? f.reservationLabel : null})
      RETURNING id`)[0] as { id: string };
    const what = (f.kind ?? 'task') === 'work_order' ? 'Work order' : 'To-do';
    await note(sql, 'task', String(row.id), 'status',
      `${what} created${parentTitle ? ` under “${parentTitle}”` : ''}${claimLabel ? ` for the claim ${claimLabel}` : ''}.`, who.email);
    if (f.parentId) await note(sql, 'task', f.parentId, 'change', `Sub-task added: ${f.title}`, who.email);
    if (f.claimId) await note(sql, 'claim', f.claimId, 'change', `${what} added: ${f.title}`, who.email);
    return Response.json({ ok: true, id: String(row.id), todos: await list(sql, b.claimScope ? f.claimId ?? undefined : undefined) });
  }

  const id = String(b.id ?? '');
  if (!ID.test(id)) return bad('Which task?');
  // Undo of a removal (§82): the task, and the sub-tasks removed in the same instant.
  if (b.action === 'restore') {
    const gone = (await sql`SELECT title, deleted_at, claim_id FROM todos WHERE account_id = 1 AND id = ${id} AND deleted_at IS NOT NULL`)[0] as
      { title: string; deleted_at: string | Date; claim_id: string | null } | undefined;
    if (!gone) return bad('Nothing to restore — it is not removed.');
    const kids = await sql`UPDATE todos SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
                            WHERE account_id = 1 AND parent_id = ${id} AND deleted_at = ${gone.deleted_at} RETURNING id`;
    await sql`UPDATE todos SET deleted_at = NULL, deleted_by = NULL, updated_at = now() WHERE account_id = 1 AND id = ${id}`;
    await note(sql, 'task', id, 'change', `Restored${kids.length ? ` with its ${kids.length} sub-task${kids.length === 1 ? '' : 's'}` : ''}`, who.email);
    if (gone.claim_id) await note(sql, 'claim', gone.claim_id, 'change', `Restored: ${gone.title}`, who.email);
    return Response.json({ ok: true, todos: await list(sql, b.claimScope ? String(b.claimScope) : undefined) });
  }

  const before = (await sql`SELECT title, status, priority, assignee, due_on::text AS due_on, claim_id, vendor,
                                   scheduled_on::text AS scheduled_on, cost_estimate, cost_actual, kind, unit_ids, description,
                                   reservation_id, reservation_label
                              FROM todos WHERE account_id = 1 AND id = ${id} AND deleted_at IS NULL`)[0] as Record<string, any> | undefined;
  if (!before) return Response.json({ ok: false, message: 'That task is gone — someone removed it.' }, { status: 404 });
  const scope = b.claimScope ? String(b.claimScope) : undefined;

  if (b.action === 'note') {
    const body = typeof b.body === 'string' ? b.body.trim().slice(0, 4000) : '';
    if (!body) return bad('An update needs words.');
    await note(sql, 'task', id, 'note', body, who.email);
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
      INSERT INTO claims (account_id, unit_id, occurred_on, category, severity, status, description, refund, repair_cost, created_by,
                          reservation_id, reservation_label)
      VALUES (1, ${(before.unit_ids ?? [])[0] ?? null}, ${new Date().toISOString().slice(0, 10)}, ${category}, ${severity}, 'Open',
              ${[before.title, detail].filter(Boolean).join(' — ').slice(0, 2000)}, 0, 0, ${who.email},
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
    return Response.json({ ok: true, todos: await list(sql, scope) });
  }

  // update / done — work out the new status, then write what changed.
  let status = f.status;
  if (b.action === 'done') status = b.done === false ? 'open' : 'done';
  else if (b.action !== 'update') return bad('Unknown action.');
  if (b.action === 'update' && f.title === null) return bad('Work needs a name.');

  const closedNow = status !== undefined && ['done', 'cancelled'].includes(status);
  await sql`UPDATE todos SET
      title         = COALESCE(${f.title ?? null}, title),
      unit_ids      = COALESCE(${unitIds ?? null}::text[], unit_ids),
      due_on        = CASE WHEN ${f.dueOn !== undefined} THEN ${f.dueOn ?? null}::date ELSE due_on END,
      scheduled_on  = CASE WHEN ${f.scheduledOn !== undefined} THEN ${f.scheduledOn ?? null}::date ELSE scheduled_on END,
      assignee      = CASE WHEN ${f.assignee !== undefined} THEN ${f.assignee ?? null} ELSE assignee END,
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
    WHERE account_id = 1 AND id = ${id}`;

  // The timeline, in words.
  if (status !== undefined && status !== before.status) {
    await note(sql, 'task', id, 'status', `${STATUS_WORD[before.status]} → ${STATUS_WORD[status]}`, who.email);
    if (before.claim_id && ['done', 'cancelled'].includes(status)) {
      await note(sql, 'claim', before.claim_id, 'change', `${STATUS_WORD[status]}: ${before.title}`, who.email);
    }
  }
  const changed: string[] = [];
  const cmp = (label: string, was: unknown, now: unknown, show = (v: unknown) => v == null || v === '' ? '—' : String(v)) => {
    if (now === undefined || String(was ?? '') === String(now ?? '')) return;
    changed.push(`${label}: ${show(was)} → ${show(now)}`);
  };
  cmp('Title', before.title, f.title ?? undefined);
  cmp('Deadline', before.due_on, f.dueOn);
  cmp('Scheduled', before.scheduled_on, f.scheduledOn);
  cmp('Owner', before.assignee, f.assignee);
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
  if (changed.length) await note(sql, 'task', id, 'change', changed.join(' · '), who.email);

  return Response.json({ ok: true, todos: await list(sql, scope) });
};

function bad(message: string): Response {
  return Response.json({ ok: false, message }, { status: 400 });
}
