/**
 * POST /api/repository-reveal  { table, id, column }
 *
 * The plain value of one secret — a password in the Tools table, say. Its
 * own route rather than an `op` on /api/repository so the role check stays
 * a plain path rule: a role may read the repository, and this path is
 * simply not on its list (roles.ts).
 *
 * Written down BEFORE it is decrypted. A reveal that fails after the row
 * is written still leaves a row — an attempt to read a password is itself
 * worth knowing about.
 */
import { db, type Env } from '../_lib/db.ts';
import { accessOf, type SqlFn } from '../_lib/accounts.ts';
import { can } from '../_lib/roles.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { decrypt } from '../_lib/crypto.ts';
import { KEY } from '../_lib/repo-store.ts';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;
  // The middleware already refuses a role without it. Checked again because this
  // is the one route in the repository that hands out a secret, and a
  // route must stay safe if the middleware is ever moved (§29).
  if (!can((await accessOf(sql, who)).permissions, 'repository.reveal')) {
    return Response.json({ ok: false, error: 'forbidden',
      message: 'Your role does not include revealing passwords.' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const table = String(body.table ?? '');
  const id = String(body.id ?? '').trim();
  const column = String(body.column ?? '');
  if (!KEY.test(table) || !id || id.length > 64 || !KEY.test(column)) {
    return Response.json({ ok: false, error: 'bad_request', message: 'Which secret?' }, { status: 400 });
  }

  await sql`INSERT INTO repo_reveals (account_id, actor, table_key, row_id, column_key)
            VALUES (1, ${who.email}, ${table}, ${id}, ${column})`;

  const row = (await sql`
    SELECT s.value_enc FROM repo_secrets s
      JOIN repo_records r ON r.account_id = s.account_id AND r.table_key = s.table_key AND r.id = s.record_id
      JOIN repo_tables t ON t.account_id = r.account_id AND t.key = r.table_key
     WHERE s.account_id = 1 AND s.table_key = ${table} AND s.record_id = ${id} AND s.column_key = ${column}
       AND r.archived_at IS NULL AND t.archived_at IS NULL`)[0] as { value_enc: string } | undefined;
  if (!row) return Response.json({ ok: false, error: 'not_found', message: 'No value is set.' }, { status: 404 });

  try {
    return Response.json({ ok: true, value: await decrypt(row.value_enc, env.ENCRYPTION_KEY) },
                         { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, error: 'internal',
      message: 'The stored value could not be decrypted with this key.' }, { status: 500 });
  }
};
