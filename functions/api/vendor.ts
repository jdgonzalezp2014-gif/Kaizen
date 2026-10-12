/**
 * /api/vendor — a handyman signed in with the email in the vendor directory
 * (§137): their open work orders, and the same steps as their link.
 *
 *   GET                          their work orders not closed (and those closed in the last 7 days)
 *   POST { todoId, action, … }   a step (multipart for photos and receipts) — only on one of theirs
 *
 * The `vendor` permission opens only this route (roles.ts); who they are
 * comes from the sign-in (accessOf), never from the request.
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { workAct, workPage } from '../_lib/vendor-work.ts';

async function me(request: Request, env: Env, sql: SqlFn): Promise<string | Response> {
  const who = identify(request, env);
  if (!who) return unauthorised();
  // Local dev has no Access: ?as=<vendor> stands in for signing in as them.
  const as = new URL(request.url).searchParams.get('as');
  if (who.local && as) return as;
  const a = await accessOf(sql, who);
  return a.vendor ?? Response.json({ ok: false, error: 'not_a_vendor', message: 'This page is for handymen signing in with the email the team has for them.' }, { status: 403 });
}

const mine = async (sql: SqlFn, vendor: string) => (await sql`
  SELECT id::text FROM todos WHERE account_id = 1 AND deleted_at IS NULL AND kind = 'work_order' AND lower(vendor) = lower(${vendor})
     AND (status NOT IN ('completed', 'cancelled') OR done_at > now() - interval '7 days')
   ORDER BY scheduled_on NULLS LAST, id` as { id: string }[]).map(r => r.id);

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;
  const v = await me(request, env, sql);
  if (v instanceof Response) return v;
  const works = (await Promise.all((await mine(sql, v)).map(id => workPage(sql, id)))).filter(Boolean);
  return Response.json({ ok: true, vendor: v, works }, { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const sql = db(env) as unknown as SqlFn;
  const v = await me(request, env, sql);
  if (v instanceof Response) return v;
  let b: Record<string, unknown> = {};
  const files: File[] = [];
  if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
    const form = await request.formData();
    for (const [k, x] of form.entries()) { if (k === 'file') { if (typeof x !== 'string') files.push(x); } else b[k] = x; }
  } else b = await request.json().catch(() => ({})) as Record<string, unknown>;
  const id = String(b.todoId ?? '');
  if (!(await mine(sql, v)).includes(id)) return Response.json({ ok: false, error: 'bad_request', message: 'That work order is not yours.' }, { status: 400 });
  try { await workAct(sql, env.ENCRYPTION_KEY, id, { name: v, source: 'vendor' }, b, files, waitUntil); }
  catch (e) { return Response.json({ ok: false, error: 'bad_request', message: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
  return Response.json({ ok: true, page: await workPage(sql, id) });
};
