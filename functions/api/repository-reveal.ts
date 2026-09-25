/**
 * POST /api/repository-reveal  { table, id, column }
 *
 * The plain value of one secret — a password in the repository's Logins
 * table, say. Its own route rather than an `op` on /api/repository so the
 * role check stays a plain path rule: ops may read the repository, and
 * this path is simply not on their list (roles.ts).
 *
 * Written down BEFORE it is fetched. The repository logs its own reveals,
 * but its API runs as its owner, so from there every reveal made through
 * Kaizen looks like the same person. The person is known only here. A
 * reveal that fails after the row is written still leaves a row — an
 * attempt to read a password is itself worth knowing about.
 */
import { db, type Env } from '../_lib/db.ts';
import { getRepoCredentials, roleOf, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { repoCall, RepoError } from '../_lib/repository.ts';

const KEY = /^[a-z0-9_]{1,64}$/;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;
  // The middleware already refuses ops here. Checked again because this
  // is the one route in the integration that hands out a secret, and a
  // route must stay safe if the middleware is ever moved (§29).
  if (await roleOf(sql, who) !== 'admin') {
    return Response.json({ ok: false, error: 'forbidden', message: 'Only admins can reveal a secret.' },
                         { status: 403 });
  }

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const table = String(body.table ?? '');
  const id = String(body.id ?? '').trim();
  const column = String(body.column ?? '');
  if (!KEY.test(table) || !id || id.length > 64 || !KEY.test(column)) {
    return Response.json({ ok: false, error: 'bad_request', message: 'Which secret?' }, { status: 400 });
  }

  const creds = await getRepoCredentials(sql, env.ENCRYPTION_KEY);
  if (!creds) {
    return Response.json({ ok: false, error: 'not_configured',
      message: 'The Data Repository is not connected.' }, { status: 409 });
  }

  await sql`INSERT INTO repo_reveals (account_id, actor, table_key, row_id, column_key)
            VALUES (1, ${who.email}, ${table}, ${id}, ${column})`;

  try {
    const r = await repoCall<{ value: string }>(creds, 'reveal', { table, id, column });
    return Response.json({ ok: true, value: r.value },
                         { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof RepoError ? 'repository' : 'internal',
      message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
};
