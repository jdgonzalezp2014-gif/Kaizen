/**
 * POST /api/repository-edit — records and their documents.
 *
 *   { op: 'create', table, values }
 *   { op: 'update', table, id, values }        only the fields that changed
 *   { op: 'delete', table, id }                archived: out of every view, never erased
 *   { op: 'docs.link', table, id, column, name, url }   a Drive file or any https link
 *   { op: 'docs.create', table, id, column, name?, kind: 'doc' | 'sheet' }   a new Google file, in place
 *   { op: 'docs.rename', fileId, name }        renamed in Drive too, when it is a Drive file
 *   { op: 'docs.delete', fileId }              a Drive file goes to Drive's trash (30 days);
 *                                              a pasted link is only removed
 *
 * Uploads have their own route (/api/repository-upload): they are
 * multipart, not JSON.
 *
 * `repository.edit` (roles.ts). The rules are the repository's own
 * (src/lib/repo.ts) and every write leaves a repo_audit row naming the
 * person. A masked secret is refused whatever the column says: a form
 * that echoed a field it never changed would encrypt the mask and destroy
 * the real password, silently and permanently.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { encrypt } from '../_lib/crypto.ts';
import { KEY, audit, docFolder, getRow, tableCols } from '../_lib/repo-store.ts';
import { DriveError, createGoogleFile, driveToken, renameFile, trashFile } from '../_lib/gdrive.ts';
import { coerce, formatId, validate, type RepoCol } from '../../src/lib/repo.ts';

const OPS = new Set(['create', 'update', 'delete', 'docs.link', 'docs.create', 'docs.rename', 'docs.delete']);

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;

  const b = await request.json().catch(() => ({})) as Record<string, any>;
  const op = String(b.op ?? '');
  if (!OPS.has(op)) return fail(400, `"${op}" is not an edit.`);

  try {
    if (op === 'docs.rename' || op === 'docs.delete') {
      const fileId = String(b.fileId ?? '');
      if (!/^\d{1,18}$/.test(fileId)) return fail(400, 'Which file?');
      const f = (await sql`SELECT table_key, record_id, column_key, name, drive_file_id FROM repo_files
                            WHERE account_id = 1 AND id = ${fileId} AND removed_at IS NULL`)[0] as
        { table_key: string; record_id: string; column_key: string; name: string; drive_file_id: string | null } | undefined;
      if (!f) return fail(404, 'That file is no longer listed.');
      // Drive first: if Drive refuses, Kaizen's list must not claim otherwise.
      if (op === 'docs.rename') {
        const name = String(b.name ?? '').trim().slice(0, 200);
        if (!name) return fail(400, 'A file needs a name.');
        if (f.drive_file_id) await renameFile(await driveToken(sql, env.ENCRYPTION_KEY), f.drive_file_id, name);
        await sql`UPDATE repo_files SET name = ${name} WHERE account_id = 1 AND id = ${fileId}`;
        await audit(sql, who.email, op, f.table_key, f.record_id, `${f.column_key}: ${f.name} → ${name}`);
      } else {
        if (f.drive_file_id) await trashFile(await driveToken(sql, env.ENCRYPTION_KEY), f.drive_file_id);
        await sql`UPDATE repo_files SET removed_at = now(), removed_by = ${who.email} WHERE account_id = 1 AND id = ${fileId}`;
        await audit(sql, who.email, op, f.table_key, f.record_id,
                    `${f.column_key}: ${f.drive_file_id ? 'to Drive’s trash' : 'removed link'} ${f.name}`);
      }
      return Response.json({ ok: true, data: { fileId } });
    }

    const table = String(b.table ?? '');
    const id = String(b.id ?? '').trim();
    if (!KEY.test(table)) return fail(400, 'Which table?');
    if (op !== 'create' && (!id || id.length > 64)) return fail(400, 'Which record?');
    const t = await tableCols(sql, table);
    if (!t) return fail(404, 'That table does not exist, or was archived.');

    if (op === 'delete') {
      const r = await sql`UPDATE repo_records SET archived_at = now(), archived_by = ${who.email}
                           WHERE account_id = 1 AND table_key = ${table} AND id = ${id} AND archived_at IS NULL
                           RETURNING id`;
      if (!r.length) return fail(404, 'No such record.');
      await audit(sql, who.email, op, table, id, 'archived');
      return Response.json({ ok: true, data: { id } });
    }

    if (op === 'docs.create') {
      const column = String(b.column ?? '');
      if (!t.cols.some(c => c.key === column && c.type === 'doc')) return fail(400, 'Which document column?');
      const kind = b.kind === 'sheet' ? 'sheet' : 'doc';
      const name = String(b.name ?? '').trim().slice(0, 200) || `${id} — ${kind === 'sheet' ? 'Sheet' : 'Doc'}`;
      const token = await driveToken(sql, env.ENCRYPTION_KEY);
      const g = await createGoogleFile(token, await docFolder(sql, token, table, id, column), name, kind);
      const f = (await sql`INSERT INTO repo_files (account_id, table_key, record_id, column_key, name, url, mime_type, drive_file_id, added_by)
                           VALUES (1, ${table}, ${id}, ${column}, ${g.name}, ${g.webViewLink}, ${g.mimeType}, ${g.id}, ${who.email})
                           RETURNING id`)[0] as { id: string };
      await audit(sql, who.email, op, table, id, `${column}: new Google ${kind === 'sheet' ? 'Sheet' : 'Doc'} ${g.name}`);
      return Response.json({ ok: true, data: { fileId: String(f.id), url: g.webViewLink } });
    }

    if (op === 'docs.link') {
      const column = String(b.column ?? '');
      const col = t.cols.find(c => c.key === column && c.type === 'doc');
      if (!col) return fail(400, 'Which document column?');
      let link: URL;
      try { link = new URL(String(b.url ?? '').trim()); } catch { return fail(400, 'Paste the file’s link (https://…).'); }
      if (link.protocol !== 'https:') return fail(400, 'Only https links.');
      const name = String(b.name ?? '').trim().slice(0, 200) || nameFromUrl(link);
      const rec = await sql`SELECT 1 FROM repo_records WHERE account_id = 1 AND table_key = ${table} AND id = ${id} AND archived_at IS NULL`;
      if (!rec.length) return fail(404, 'No such record.');
      const f = (await sql`INSERT INTO repo_files (account_id, table_key, record_id, column_key, name, url, mime_type, added_by)
                           VALUES (1, ${table}, ${id}, ${column}, ${name}, ${link.href}, ${mimeFromUrl(link)}, ${who.email})
                           RETURNING id`)[0] as { id: string };
      await audit(sql, who.email, op, table, id, `${column}: ${name}`);
      return Response.json({ ok: true, data: { fileId: String(f.id) } });
    }

    // create / update
    const values = (b.values && typeof b.values === 'object') ? b.values as Record<string, unknown> : null;
    if (!values || !Object.keys(values).length) return fail(400, 'Nothing to save.');
    const byKey = new Map(t.cols.map(c => [c.key, c]));
    const plain: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      const col = byKey.get(k);
      if (!col || col.type === 'doc') return fail(400, `Unknown field "${k}".`);
      if (typeof v === 'string' && /^•+$/.test(v)) return fail(400, `"${col.title}" is masked — leave it out unless it is being changed.`);
      if (col.type === 'secret') secrets[k] = String(v ?? '');
      else plain[k] = normalize(col, v);
    }

    let existing: Record<string, unknown> = {};
    if (op === 'update') {
      const rec = (await sql`SELECT vals FROM repo_records WHERE account_id = 1 AND table_key = ${table}
                              AND id = ${id} AND archived_at IS NULL`)[0] as { vals: Record<string, unknown> } | undefined;
      if (!rec) return fail(404, 'No such record.');
      existing = rec.vals ?? {};
    }

    const written = new Set(Object.keys(values));
    const checked = op === 'create' ? t.cols : t.cols.filter(c => written.has(c.key));
    const others = checked.some(c => c.uniq)
      ? (await sql`SELECT vals FROM repo_records WHERE account_id = 1 AND table_key = ${table}
                    AND archived_at IS NULL AND id <> ${id}`).map((r: any) => r.vals as Record<string, unknown>)
      : [];
    const refs = await refValues(sql, checked);
    const errors = validate(t.cols, { ...existing, ...plain, ...secrets }, others,
                            (rt, rc) => refs.get(`${rt}|${rc}`) ?? new Set(),
                            op === 'create' ? undefined : written);
    if (errors.length) return fail(400, errors.join(' '));

    let recordId = id;
    if (op === 'create') {
      recordId = await insertRecord(sql, table, t.table.id_prefix, plain, who.email);
    } else {
      await sql`UPDATE repo_records SET vals = vals || ${JSON.stringify(plain)}::jsonb,
                       updated_at = now(), updated_by = ${who.email}
                 WHERE account_id = 1 AND table_key = ${table} AND id = ${id}`;
    }
    for (const [k, v] of Object.entries(secrets)) {
      if (v === '') {
        await sql`DELETE FROM repo_secrets WHERE account_id = 1 AND table_key = ${table} AND record_id = ${recordId} AND column_key = ${k}`;
      } else {
        const enc = await encrypt(v, env.ENCRYPTION_KEY);
        await sql`INSERT INTO repo_secrets (account_id, table_key, record_id, column_key, value_enc)
                  VALUES (1, ${table}, ${recordId}, ${k}, ${enc})
                  ON CONFLICT (account_id, table_key, record_id, column_key)
                  DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = now()`;
      }
    }
    await audit(sql, who.email, op, table, recordId,
      Object.keys(values).map(k => k in secrets ? `${k} (secret ${secrets[k] ? 'changed' : 'cleared'})` : k).join(', '));
    return Response.json({ ok: true, data: await getRow(sql, table, recordId, t.cols) });
  } catch (e) {
    return fail(e instanceof DriveError ? 502 : 500, e instanceof Error ? e.message : String(e));
  }
};

/**
 * What the grid sends, as the column stores it: a checkbox is true/false,
 * a number is a number. Anything that does not read as its type is kept
 * as typed so validation can say what is wrong with it.
 */
function normalize(col: RepoCol, v: unknown): unknown {
  if (v === null || v === undefined) return '';
  if (col.type === 'checkbox') return coerce(col, v);
  const s = String(v).trim();
  if (col.type === 'number' && s !== '' && !Number.isNaN(Number(s))) return Number(s);
  return s;
}

/** The values each referenced column holds, for the ref columns being written. */
async function refValues(sql: SqlFn, cols: RepoCol[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  for (const c of cols) {
    if (c.type !== 'ref' || !c.refTable || !c.refColumn) continue;
    const k = `${c.refTable}|${c.refColumn}`;
    if (out.has(k)) continue;
    const rows = await sql`SELECT CASE WHEN ${c.refColumn} = 'id' THEN id ELSE vals ->> ${c.refColumn} END AS v
                             FROM repo_records WHERE account_id = 1 AND table_key = ${c.refTable} AND archived_at IS NULL`;
    out.set(k, new Set(rows.map((r: any) => String(r.v ?? ''))));
  }
  return out;
}

/**
 * The next ID continues the series, archived records included — an ID
 * once used is never handed out again. Two people creating at the same
 * instant collide on the key; the loser simply takes the next number.
 */
async function insertRecord(sql: SqlFn, table: string, prefix: string,
                            vals: Record<string, unknown>, actor: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const seq = Number((await sql`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM repo_records
                                   WHERE account_id = 1 AND table_key = ${table}`)[0].n);
    const id = formatId(prefix, seq);
    try {
      await sql`INSERT INTO repo_records (account_id, table_key, id, seq, vals, position, created_by, updated_by)
                VALUES (1, ${table}, ${id}, ${seq}, ${JSON.stringify(vals)}::jsonb, ${seq}, ${actor}, ${actor})`;
      return id;
    } catch (e) {
      if (!/duplicate key/i.test(String(e))) throw e;
    }
  }
  throw new Error('Could not number the new record — try again.');
}

function nameFromUrl(u: URL): string {
  const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
  if (/docs\.google\.com|drive\.google\.com/.test(u.hostname)) return 'Drive file';
  return last || u.hostname;
}
function mimeFromUrl(u: URL): string | null {
  if (/docs\.google\.com\/document/.test(u.href)) return 'application/vnd.google-apps.document';
  if (/docs\.google\.com\/spreadsheets/.test(u.href)) return 'application/vnd.google-apps.spreadsheet';
  if (/\/folders\//.test(u.pathname)) return 'application/vnd.google-apps.folder';
  if (/\.pdf$/i.test(u.pathname)) return 'application/pdf';
  if (/\.(png|jpe?g|webp|heic)$/i.test(u.pathname)) return 'image/*';
  return null;
}

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, error: 'repository', message }, { status });
}
