/**
 * A handyman's own page, behind either door: signed in (/api/vendor) or by
 * their secret link (/api/crew-link with X-Vendor-Token, owner 2026-10-25).
 * The caller's name comes from the door, never from the request body.
 */
import type { Env } from './db.ts';
import type { SqlFn } from './accounts.ts';
import { workAct, workPage } from './vendor-work.ts';
import { loadVendorPage } from './vendor-pay.ts';
import { sha256 } from './crew.ts';

export async function vendorByToken(sql: SqlFn, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const [v] = await sql`SELECT name FROM vendors WHERE account_id = 1 AND active AND link_token_hash = ${await sha256(token)}` as { name: string }[];
  return v?.name ?? null;
}

const mine = async (sql: SqlFn, vendor: string) => (await sql`
  SELECT id::text FROM todos WHERE account_id = 1 AND deleted_at IS NULL AND kind = 'work_order' AND lower(vendor) = lower(${vendor})
     AND (status NOT IN ('completed', 'cancelled') OR done_at > now() - interval '7 days')
   ORDER BY scheduled_on NULLS LAST, id` as { id: string }[]).map(r => r.id);

export async function vendorGet(request: Request, sql: SqlFn, v: string): Promise<Response> {
  const works = (await Promise.all((await mine(sql, v)).map(id => workPage(sql, id)))).filter(Boolean);
  // Owner, 2026-10-25: their pay, as a cleaner sees theirs — the invoice periods only, never the team's own dates.
  const pay = await loadVendorPage(sql, v, new URL(request.url).searchParams.get('period'));
  return Response.json({ ok: true, vendor: v, works, pay: pay && { ...pay, openJobs: [] } }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function vendorPost(request: Request, env: Env, sql: SqlFn, v: string, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
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
}
