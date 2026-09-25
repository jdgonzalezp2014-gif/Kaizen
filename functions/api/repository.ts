/**
 * GET /api/repository?op=meta
 * GET /api/repository?op=list&table=units
 * GET /api/repository?op=get&table=units&id=UNI-0001
 * GET /api/repository?op=docs&table=units&id=UNI-0001&column=lease
 * GET /api/repository?op=docsbatch&table=units&column=lease&ids=UNI-0001,UNI-0002
 * GET /api/repository?op=search&q=2450
 *
 * The Data Repository, native (§71): every answer is read from Postgres
 * as it is at that moment — nothing cached, nothing from the old Apps
 * Script project. Secrets arrive masked and are only ever read through
 * /api/repository-reveal, which is permission-checked and logged.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { KEY, docsFor, getRow, listRows, loadMeta, rowOut, secretsSet, tableCols, type RecordRow } from '../_lib/repo-store.ts';
import { matches } from '../../src/lib/repo.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;

  const url = new URL(request.url);
  const op = url.searchParams.get('op') ?? 'meta';
  const table = url.searchParams.get('table') ?? '';
  const id = url.searchParams.get('id') ?? '';
  const column = url.searchParams.get('column') ?? '';
  const started = Date.now();

  try {
    if (op === 'meta') {
      return Response.json({ ok: true, meta: await loadMeta(sql), appUrl: null, tookMs: Date.now() - started });
    }
    if (op === 'list' || op === 'get') {
      if (!KEY.test(table)) return bad('Which table?');
      const t = await tableCols(sql, table);
      if (!t) return notFound('That table does not exist, or was archived.');
      if (op === 'get') {
        const row = id ? await getRow(sql, table, id, t.cols) : null;
        return row ? Response.json({ ok: true, table, row }) : notFound('No such record.');
      }
      const rows = await listRows(sql, table, t.cols);
      return Response.json({ ok: true, table, total: rows.length, rows, tookMs: Date.now() - started });
    }
    if (op === 'docs' || op === 'docsbatch') {
      const ids = op === 'docs' ? [id]
        : (url.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 500);
      if (!KEY.test(table) || !KEY.test(column) || !ids.length || ids.some(i => !i || i.length > 64)) return bad('Which documents?');
      const docs = await docsFor(sql, table, column, ids);
      if (op === 'docsbatch') return Response.json({ ok: true, docs });
      const one = docs[id];
      return one ? Response.json({ ok: true, folderUrl: one.folderUrl, files: one.files }) : notFound('No such record.');
    }
    if (op === 'search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      if (q.length < 2) return bad('Type at least two characters.');
      // The database narrows (a value somewhere contains the text); the
      // rule decides (values only — a column's key is not a match, and a
      // secret is not in `vals` at all).
      const like = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`;
      const [meta, recs] = await Promise.all([
        loadMeta(sql),
        sql`SELECT r.table_key, r.id, r.vals, r.folder_url, r.created_at, r.created_by, r.updated_at, r.updated_by
              FROM repo_records r
             WHERE r.account_id = 1 AND r.archived_at IS NULL AND (r.vals::text ILIKE ${like} OR r.id ILIKE ${like})
             ORDER BY r.table_key, r.position, r.seq` as Promise<RecordRow[]>
      ]);
      const tables = meta.sections.flatMap(s => s.tables.map(t => ({ section: s.title, t })));
      const results = await Promise.all(tables.map(async ({ section, t }) => {
        const hits = recs.filter(r => r.table_key === t.key &&
          (r.id.toLowerCase().includes(q.toLowerCase()) || matches(r.vals, q, new Set())));
        if (!hits.length) return null;
        const secretCols = t.columns.filter(c => c.type === 'secret').map(c => c.key);
        const shown = hits.slice(0, 25);
        const set = secretCols.length ? await secretsSet(sql, t.key, shown.map(h => h.id)) : new Set<string>();
        return { section, table: t.key, title: t.title, total: hits.length, rows: shown.map(h => rowOut(h, secretCols, set)) };
      }));
      return Response.json({ ok: true, q, results: results.filter(Boolean), searched: tables.length,
                             tookMs: Date.now() - started });
    }
    return bad(`Unknown op "${op}".`);
  } catch (e) {
    return Response.json({ ok: false, error: 'internal', message: e instanceof Error ? e.message : String(e) },
                         { status: 500 });
  }
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
function notFound(message: string): Response {
  return Response.json({ ok: false, error: 'not_found', message }, { status: 404 });
}
