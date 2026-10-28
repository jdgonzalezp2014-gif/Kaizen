/**
 * /api/todo-files — a to-do's files (owner, Oct 2026).
 *   GET  ?todoId=N                                   its files
 *   POST multipart { todoId, file… }                 add several (Drive)
 *   POST { action: 'remove', id }                    off the to-do (the Drive copy stays)
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { workProof } from '../_lib/pay-check.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { attachTodoFiles, listTodoFiles } from '../_lib/todo-files.ts';

const bad = (message: string, status = 400) => Response.json({ ok: false, message }, { status });

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const id = new URL(request.url).searchParams.get('todoId') ?? '';
  if (!/^\d+$/.test(id)) return bad('Which to-do?');
  const sql = db(env) as unknown as SqlFn;
  // Owner, 2026-10-28: with the files, the handyman's photos and charges of the work it holds — audited from the task.
  const [files, work] = await Promise.all([listTodoFiles(sql, id), workProof(sql, id)]);
  return Response.json({ ok: true, files, work }, { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  try {
    if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
      const form = await request.formData();
      const id = String(form.get('todoId') ?? '');
      if (!/^\d+$/.test(id)) return bad('Which to-do?');
      const files = await Promise.all(form.getAll('file').filter((v): v is File => typeof v !== 'string')
        .map(async f => ({ name: f.name, type: f.type, data: await f.arrayBuffer() })));
      if (!files.length) return bad('Pick a file.');
      await attachTodoFiles(sql, env.ENCRYPTION_KEY, id, files, who.email, 'app');
      return Response.json({ ok: true, files: await listTodoFiles(sql, id) });
    }
    const b = await request.json().catch(() => ({})) as Record<string, unknown>;
    if (b.action === 'remove') {
      const [r] = await sql`DELETE FROM todo_files WHERE account_id = 1 AND id = ${Number(b.id) || 0} RETURNING todo_id::text, name` as { todo_id: string; name: string }[];
      if (!r) return bad('Already removed.');
      await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by) VALUES (1, 'task', ${r.todo_id}, 'change', ${`📎 File removed: ${r.name}`}, ${who.email})`;
      return Response.json({ ok: true, files: await listTodoFiles(sql, r.todo_id) });
    }
    return bad('Unknown action.');
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e), 500);
  }
};
