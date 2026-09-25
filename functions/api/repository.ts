/**
 * GET /api/repository?op=meta
 * GET /api/repository?op=list&table=units
 * GET /api/repository?op=get&table=units&id=UNI-0001
 * GET /api/repository?op=docs&table=units&id=UNI-0001&column=documents
 * GET /api/repository?op=search&q=2450
 *
 * The Data Repository, read from inside Kaizen OS. Secrets arrive masked
 * — the repository masks them itself — and are only ever read through
 * /api/repository-reveal, which is admin-only and logged.
 */
import { db, type Env } from '../_lib/db.ts';
import { getAccount, getRepoCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import {
  repoCall, RepoError, searchRows, trimMeta,
  type RepoFile, type RepoMeta, type RepoRow
} from '../_lib/repository.ts';

/** Keys the repository uses for its tables and columns: lowercase words. */
const KEY = /^[a-z0-9_]{1,64}$/;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const sql = db(env) as unknown as SqlFn;
  const creds = await getRepoCredentials(sql, env.ENCRYPTION_KEY);
  if (!creds) {
    return Response.json({ ok: false, error: 'not_configured',
      message: 'The Data Repository is not connected yet — an admin adds its API link and key in Settings.'
    }, { status: 409 });
  }

  const url = new URL(request.url);
  const op = url.searchParams.get('op') ?? 'meta';
  const table = url.searchParams.get('table') ?? '';
  const id = url.searchParams.get('id') ?? '';
  const column = url.searchParams.get('column') ?? '';
  const started = Date.now();

  try {
    if (op === 'meta') {
      const [meta, account] = await Promise.all([repoCall<RepoMeta>(creds, 'meta'), getAccount(sql)]);
      return Response.json({ ok: true, meta: trimMeta(meta), appUrl: account?.repoAppUrl ?? null,
                             tookMs: Date.now() - started });
    }
    if (op === 'list') {
      if (!KEY.test(table)) return bad('Which table?');
      const r = await repoCall<{ total: number; rows: RepoRow[] }>(creds, 'list', { table });
      return Response.json({ ok: true, table, total: r.total, rows: r.rows, tookMs: Date.now() - started });
    }
    if (op === 'get') {
      if (!KEY.test(table) || !id) return bad('Which record?');
      const row = await repoCall<RepoRow>(creds, 'get', { table, id });
      return Response.json({ ok: true, table, row });
    }
    if (op === 'docs') {
      if (!KEY.test(table) || !id || !KEY.test(column)) return bad('Which documents?');
      const r = await repoCall<{ folderUrl: string; files: RepoFile[] }>(creds, 'docs.list', { table, id, column });
      return Response.json({ ok: true, folderUrl: r.folderUrl, files: r.files });
    }
    if (op === 'search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q.length < 2) return bad('Type at least two characters.');
      // Every table at once. The repository has its own cross-table
      // search, but it is a UI function behind a Google sign-in, not an
      // API action — so the fan-out happens here, in parallel.
      const meta = await repoCall<RepoMeta>(creds, 'meta');
      const tables = meta.sections.flatMap(s => s.tables.map(t => ({ section: s.title, table: t })));
      const results = await Promise.all(tables.map(async ({ section, table: t }) => {
        try {
          const r = await repoCall<{ rows: RepoRow[] }>(creds, 'list', { table: t.key });
          const hits = searchRows(r.rows, q);
          return { section, table: t.key, title: t.title, total: hits.length, rows: hits.slice(0, 25) };
        } catch (e) {
          // One unreadable table must not blank the search — but it must
          // say it was not searched, or "no results" is a lie.
          return { section, table: t.key, title: t.title, total: 0, rows: [],
                   problem: e instanceof Error ? e.message : String(e) };
        }
      }));
      return Response.json({ ok: true, q, results: results.filter(r => r.total > 0 || 'problem' in r),
                             searched: tables.length, tookMs: Date.now() - started });
    }
    return bad(`Unknown op "${op}".`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: e instanceof RepoError ? 'repository' : 'internal', message },
                         { status: 502 });
  }
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
