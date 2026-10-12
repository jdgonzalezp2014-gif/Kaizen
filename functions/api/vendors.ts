/**
 * /api/vendors — handymen and suppliers (§133). A directory for now: who does
 * what, and how to reach them. A repair's vendor is picked from it (the field
 * stays free text, for someone not in the list yet).
 *
 *   GET                                                       active vendors, then the rest
 *   POST { action: 'save', id?, name, trade?, phone?, email?, notes?, active? }
 *   POST { action: 'delete', id }                             switched off, never erased: old repairs name them
 *
 * GET with `operations` or `todos`; POST with `operations.setup` (roles.ts).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';

async function list(sql: SqlFn) {
  return (await sql`SELECT id::text, name, trade, phone, email, notes, active FROM vendors WHERE account_id = 1
                     ORDER BY active DESC, lower(name)`) as { id: string; name: string; trade: string | null; phone: string | null;
                                                            email: string | null; notes: string | null; active: boolean }[];
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  return Response.json({ ok: true, vendors: await list(db(env) as unknown as SqlFn) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, unknown>;
  const s = (k: string, max = 200) => String(b[k] ?? '').trim().slice(0, max) || null;
  if (b.action === 'save') {
    const name = s('name', 120);
    if (!name) return bad('A vendor needs a name.');
    const email = s('email', 160)?.toLowerCase() ?? null;
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(`"${email}" is not an email address.`);
    try {
      if (b.id) {
        await sql`UPDATE vendors SET name = ${name}, trade = ${s('trade', 80)}, phone = ${s('phone', 40)}, email = ${email},
                         notes = ${s('notes', 1000)}, active = ${b.active !== false}, updated_at = now()
                   WHERE account_id = 1 AND id = ${Number(b.id)}`;
      } else {
        await sql`INSERT INTO vendors (account_id, name, trade, phone, email, notes)
                  VALUES (1, ${name}, ${s('trade', 80)}, ${s('phone', 40)}, ${email}, ${s('notes', 1000)})`;
      }
    } catch {
      return bad(`There is already a vendor called "${name}".`);
    }
  } else if (b.action === 'delete') {
    await sql`UPDATE vendors SET active = false, updated_at = now() WHERE account_id = 1 AND id = ${Number(b.id)}`;
  } else {
    return bad('Unknown action.');
  }
  return Response.json({ ok: true, vendors: await list(sql) });
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
