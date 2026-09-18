/**
 * POST /api/feed — pull the Apps Script sheet now.
 *
 * Also used by /api/forward on a staleness check, so in normal use
 * nobody presses anything. This route exists for the first setup and
 * for "it should have updated by now".
 */
import { importFeed } from '../_lib/feed.ts';
import { db, type Env } from '../_lib/db.ts';
import { getAccount, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => ({})) as { url?: string; save?: boolean };
  const account = await getAccount(sql);
  const url = (body.url ?? account?.feedCsvUrl ?? '').trim();

  if (!url) {
    return Response.json({ ok: false, error: 'no_url',
      message: 'No feed configured. In the sheet: File → Share → Publish to web → the ' +
               'Kaizen Feed tab, CSV — then paste the URL here.' }, { status: 400 });
  }

  const result = await importFeed(sql as never, url);
  if (result.ok && body.save !== false && url !== account?.feedCsvUrl) {
    await sql`UPDATE accounts SET feed_csv_url = ${url} WHERE id = 1`;
  }
  return Response.json(result, { status: result.ok ? 200 : 400 });
};
