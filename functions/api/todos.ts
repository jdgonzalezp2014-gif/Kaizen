/**
 * /api/todos — the team's to-do list (§76), `todos`.
 *
 *   GET                                         open to-dos, and those done in the last 14 days
 *   POST { action: 'create', title, unitIds?, dueOn? }
 *   POST { action: 'update', id, title?, unitIds?, dueOn? }     dueOn: null clears it
 *   POST { action: 'done', id, done }                            tick, or untick
 *   POST { action: 'delete', id }                                stamped, never erased
 *
 * Every read is the table as it is now. Listings are Hostaway listing IDs
 * that Kaizen knows (units); none is fine — not every to-do is about a unit.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^\d{1,18}$/;

interface Row {
  id: string; title: string; unit_ids: string[]; due_on: string | null;
  created_at: string | Date; created_by: string | null; done_at: string | Date | null; done_by: string | null;
}
const iso = (d: string | Date | null) => d == null ? null : new Date(d).toISOString();
const out = (r: Row) => ({ id: String(r.id), title: r.title, unitIds: r.unit_ids ?? [], dueOn: r.due_on,
  createdAt: iso(r.created_at)!, createdBy: r.created_by, doneAt: iso(r.done_at), doneBy: r.done_by });

async function list(sql: SqlFn) {
  const rows = await sql`
    SELECT id, title, unit_ids, due_on::text AS due_on, created_at, created_by, done_at, done_by
      FROM todos WHERE account_id = 1 AND deleted_at IS NULL
       AND (done_at IS NULL OR done_at > now() - interval '14 days')
     ORDER BY created_at` as Row[];
  return rows.map(out);
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  return Response.json({ ok: true, todos: await list(sql) }, { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, any>;

  const title = typeof b.title === 'string' ? b.title.trim().replace(/\s+/g, ' ').slice(0, 300) : undefined;
  const dueOn = b.dueOn === null || b.dueOn === '' ? null : typeof b.dueOn === 'string' ? b.dueOn : undefined;
  if (dueOn && !DAY.test(dueOn)) return bad('A deadline is a date.');
  let unitIds: string[] | undefined;
  if (Array.isArray(b.unitIds)) {
    unitIds = [...new Set((b.unitIds as unknown[]).map(String))];
    if (unitIds.length) {
      const known = new Set((await sql`SELECT id FROM units WHERE id = ANY(${unitIds})`).map((r: any) => String(r.id)));
      if (unitIds.some(u => !known.has(u))) return bad('One of those listings is not known to Kaizen — sync units in Settings.');
    }
  }

  if (b.action === 'create') {
    if (!title) return bad('A to-do needs words.');
    await sql`INSERT INTO todos (account_id, title, unit_ids, due_on, created_by)
              VALUES (1, ${title}, ${unitIds ?? []}, ${dueOn ?? null}, ${who.email})`;
    return Response.json({ ok: true, todos: await list(sql) });
  }

  const id = String(b.id ?? '');
  if (!ID.test(id)) return bad('Which to-do?');
  const exists = await sql`SELECT 1 FROM todos WHERE account_id = 1 AND id = ${id} AND deleted_at IS NULL`;
  if (!exists.length) return Response.json({ ok: false, message: 'That to-do is gone — someone removed it.' }, { status: 404 });

  if (b.action === 'update') {
    if (title === '') return bad('A to-do needs words.');
    await sql`UPDATE todos SET
                title = COALESCE(${title ?? null}, title),
                unit_ids = COALESCE(${unitIds ?? null}::text[], unit_ids),
                due_on = CASE WHEN ${dueOn !== undefined} THEN ${dueOn ?? null}::date ELSE due_on END,
                updated_at = now()
              WHERE account_id = 1 AND id = ${id}`;
  } else if (b.action === 'done') {
    const done = b.done !== false;
    await sql`UPDATE todos SET done_at = ${done ? new Date().toISOString() : null},
                               done_by = ${done ? who.email : null}, updated_at = now()
              WHERE account_id = 1 AND id = ${id}`;
  } else if (b.action === 'delete') {
    await sql`UPDATE todos SET deleted_at = now(), deleted_by = ${who.email} WHERE account_id = 1 AND id = ${id}`;
  } else return bad('Unknown action.');
  return Response.json({ ok: true, todos: await list(sql) });
};

function bad(message: string): Response {
  return Response.json({ ok: false, message }, { status: 400 });
}
