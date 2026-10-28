/**
 * A handyman's own page, behind either door: signed in (/api/vendor) or by
 * their secret link (/api/crew-link with X-Vendor-Token, owner 2026-10-25).
 * The caller's name comes from the door, never from the request body.
 */
import type { Env } from './db.ts';
import type { SqlFn } from './accounts.ts';
import { myRequests, requestedBy, settleWork, workAct, workPage, workPages, workPhoto, workRequest } from './vendor-work.ts';
import { loadVendorPage, periodPaid, vendorPast } from './vendor-pay.ts';
import { sha256 } from './crew.ts';

export async function vendorByToken(sql: SqlFn, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return null;
  const [v] = await sql`SELECT name FROM vendors WHERE account_id = 1 AND active AND link_token_hash = ${await sha256(token)}` as { name: string }[];
  return v?.name ?? null;
}

// Their work orders. A repair whose items are work orders is only the folder (owner, 2026-10-27): its items are the
// jobs, each given to its vendor, so it is not one more card — its text lists other vendors' items too.
// `open` = the jobs page; otherwise also those finished in the last 90 days (their Past tab: extras, notes).
const mine = async (sql: SqlFn, vendor: string, open = false) => (await sql`
  SELECT t.id::text FROM todos t
    LEFT JOIN todos p ON p.account_id = t.account_id AND p.id = t.parent_id AND p.kind = 'work_order' AND p.deleted_at IS NULL
   WHERE t.account_id = 1 AND t.deleted_at IS NULL AND t.kind = 'work_order'
     AND lower(btrim(t.vendor)) = lower(btrim(${vendor}))
     AND (t.status NOT IN ('completed', 'cancelled') OR (${!open} AND t.status = 'completed' AND t.done_at > now() - interval '90 days'))
     AND NOT EXISTS (SELECT 1 FROM todos c WHERE c.account_id = t.account_id AND c.parent_id = t.id AND c.kind = 'work_order' AND c.deleted_at IS NULL)
   ORDER BY coalesce(t.scheduled_on, p.scheduled_on) NULLS LAST, t.id` as { id: string }[]).map(r => r.id);

/**
 * An extra on a job whose invoice is already paid would raise a paid invoice and never be paid (payouts are one per
 * invoice). It goes on a job of its own instead — "Extra — <job>", done today, so it lands in the open invoice; the
 * team approves its charge as any, and that sets its pay and its cost (settleRepair). Charge-to-owner follows the job.
 */
async function extraJob(sql: SqlFn, env: Env, vendor: string, id: string, waitUntil: (p: Promise<unknown>) => void): Promise<string> {
  const [j] = await sql`SELECT t.title, t.unit_ids, t.charge_owner, t.status, (t.done_at AT TIME ZONE 'America/New_York')::date::text AS done
                          FROM todos t WHERE t.account_id = 1 AND t.id = ${Number(id)}` as { title: string; unit_ids: string[]; charge_owner: boolean; status: string; done: string | null }[];
  if (!j || j.status !== 'completed' || !j.done || !(await periodPaid(sql, vendor, j.done))) return id;
  const [t] = await sql`INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority, vendor, charge_owner, done_at, done_by)
                        VALUES (1, ${`Extra — ${j.title}`.slice(0, 300)}, ${`An extra after work order #${id} was paid — it is paid with the next invoice.`},
                                ${j.unit_ids}, ${requestedBy(vendor)}, 'work_order', 'completed', 'none', ${vendor}, ${j.charge_owner}, now(), ${vendor})
                        RETURNING id::text` as { id: string }[];
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'task', ${id}, 'change', ${`${vendor} added an extra after this was paid — on work order #${t!.id}.`}, ${requestedBy(vendor)})`;
  waitUntil(settleWork(sql, env.ENCRYPTION_KEY, t!.id, requestedBy(vendor)));
  return t!.id;
}

export async function vendorGet(request: Request, env: Env, sql: SqlFn, v: string): Promise<Response> {
  // A photo of a finding in one of THEIR work orders (?work=<id>&photo=<Drive id>), never another's.
  const q = new URL(request.url).searchParams;
  if (q.has('photo')) {
    const id = q.get('work') ?? '';
    if (!(await mine(sql, v)).includes(id)) return Response.json({ ok: false, error: 'not_found', message: 'No such photo.' }, { status: 404 });
    return workPhoto(sql, env.ENCRYPTION_KEY, id, q.get('photo') ?? '');
  }
  const [works, past, requests, houses] = await Promise.all([workPages(sql, await mine(sql, v, true)), vendorPast(sql, v), myRequests(sql, v),
    sql`SELECT id, name FROM units WHERE account_id = 1 AND active ORDER BY name` as Promise<{ id: string; name: string }[]>]);
  // Owner, 2026-10-25: their pay, as a cleaner sees theirs — the invoice periods only, never the team's own dates.
  const pay = await loadVendorPage(sql, v, new URL(request.url).searchParams.get('period'));
  return Response.json({ ok: true, vendor: v, works, past, requests, houses, pay: pay && { ...pay, openJobs: [] } }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function vendorPost(request: Request, env: Env, sql: SqlFn, v: string, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  let b: Record<string, unknown> = {};
  const files: File[] = [];
  if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
    const form = await request.formData();
    for (const [k, x] of form.entries()) { if (k === 'file') { if (typeof x !== 'string') files.push(x); } else b[k] = x; }
  } else b = await request.json().catch(() => ({})) as Record<string, unknown>;
  // Owner, 2026-10-27: other work they ask the team to approve — not one of theirs yet.
  if (b.action === 'request') {
    try { await workRequest(sql, env.ENCRYPTION_KEY, v, b, files, waitUntil); }
    catch (e) { return Response.json({ ok: false, error: 'bad_request', message: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
    return Response.json({ ok: true, requests: await myRequests(sql, v) });
  }
  const id = String(b.todoId ?? '');
  if (!(await mine(sql, v)).includes(id)) return Response.json({ ok: false, error: 'bad_request', message: 'That work order is not yours.' }, { status: 400 });
  try {
    const on = b.action === 'charge' ? await extraJob(sql, env, v, id, waitUntil) : id;
    await workAct(sql, env.ENCRYPTION_KEY, on, { name: v, source: 'vendor' }, b, files, waitUntil);
  } catch (e) { return Response.json({ ok: false, error: 'bad_request', message: e instanceof Error ? e.message : String(e) }, { status: 400 }); }
  return Response.json({ ok: true, page: await workPage(sql, id) });
}
