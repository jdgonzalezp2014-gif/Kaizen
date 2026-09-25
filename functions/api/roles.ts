/**
 * /api/roles — what each role may do.
 *
 *   GET                                      the roles and the permission catalog
 *   POST { key, name, permissions }          create or change a role
 *   DELETE ?key=…                            remove a role nobody holds
 *
 * Settings permission only (roles.ts). `admin` is fixed — it holds
 * everything, and a role that could be edited down to nothing is how an
 * account ends up with no one able to administer it.
 *
 * Every change is written to member_audit beside the grants and removals
 * of people, because changing what a role permits changes what everyone
 * holding it can see — it is a grant, just a wholesale one.
 */
import { db, type Env } from '../_lib/db.ts';
import { type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { PERMISSIONS, PERMISSION_KEYS } from '../_lib/roles.ts';

const KEY = /^[a-z0-9_-]{1,32}$/;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const roles = await sql`
    SELECT r.key, r.name, r.permissions, r.builtin,
           (SELECT COUNT(*)::int FROM members m WHERE m.account_id = r.account_id AND m.role = r.key) AS members
      FROM roles r WHERE r.account_id = 1 ORDER BY r.builtin DESC, r.name`;
  return Response.json({ ok: true, roles, catalog: PERMISSIONS.map(p => ({ key: p.key, label: p.label })) });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;

  const name = String(body.name ?? '').trim().slice(0, 60);
  const key = String(body.key ?? '').trim().toLowerCase() ||
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  if (!name || !KEY.test(key)) return bad('A role needs a name.');
  if (key === 'admin') return bad('Admin is fixed: it holds every permission.');

  const asked = Array.isArray(body.permissions) ? (body.permissions as unknown[]).map(String) : [];
  // Only known permissions, and never '*': "everything" belongs to admin
  // alone, and an unknown key would sit in the row meaning nothing.
  const unknown = asked.filter(p => !PERMISSION_KEYS.has(p));
  if (unknown.length) return bad(`Unknown permission: ${unknown.join(', ')}.`);
  const permissions = [...new Set(asked)];

  const before = (await sql`SELECT permissions, builtin FROM roles WHERE account_id = 1 AND key = ${key}`)[0] as
    { permissions: string[]; builtin: boolean } | undefined;
  if (before?.builtin) return bad('That role is fixed.');

  await sql`
    INSERT INTO roles (account_id, key, name, permissions) VALUES (1, ${key}, ${name}, ${permissions})
    ON CONFLICT (account_id, key) DO UPDATE SET name = EXCLUDED.name,
      permissions = EXCLUDED.permissions, updated_at = now()`;

  const added = permissions.filter(p => !before?.permissions.includes(p));
  const removed = (before?.permissions ?? []).filter(p => !permissions.includes(p));
  if (!before || added.length || removed.length) {
    await sql`INSERT INTO member_audit (account_id, actor, action, email, detail)
              VALUES (1, ${who.email.toLowerCase()}, ${before ? 'role_edited' : 'role_created'}, ${`role:${key}`},
                      ${[added.length ? `+ ${added.join(', ')}` : '', removed.length ? `− ${removed.join(', ')}` : '']
                          .filter(Boolean).join(' · ') || null})`;
  }
  return Response.json({ ok: true, key });
};

export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const key = new URL(request.url).searchParams.get('key') ?? '';
  const row = (await sql`
    SELECT r.builtin, (SELECT COUNT(*)::int FROM members m WHERE m.account_id = 1 AND m.role = r.key) AS n
      FROM roles r WHERE r.account_id = 1 AND r.key = ${key}`)[0] as { builtin: boolean; n: number } | undefined;
  if (!row) return bad('No such role.');
  if (row.builtin) return bad('That role is fixed.');
  // Refused rather than leaving people with a role that no longer exists.
  if (row.n > 0) return bad(`${row.n} member(s) still have this role — give them another one first.`);
  await sql`DELETE FROM roles WHERE account_id = 1 AND key = ${key}`;
  await sql`INSERT INTO member_audit (account_id, actor, action, email) VALUES (1, ${who.email.toLowerCase()}, 'role_deleted', ${`role:${key}`})`;
  return Response.json({ ok: true });
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
