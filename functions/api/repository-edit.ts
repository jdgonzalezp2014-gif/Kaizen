/**
 * POST /api/repository-edit — records and their documents.
 *
 *   { op: 'create', table, values }
 *   { op: 'update', table, id, values }        only the fields that changed
 *   { op: 'delete', table, id }                row out, its folder ARCHIVED
 *   { op: 'docs.upload', table, id, column, name, mimeType, data }   base64
 *   { op: 'docs.create', table, id, column, name, kind: 'doc'|'sheet' }
 *   { op: 'docs.rename', fileId, name }
 *   { op: 'docs.delete', fileId }              to Drive's trash, 30 days
 *
 * `repository.edit` (roles.ts). The repository's engine validates every
 * write; this route adds the two things only Kaizen knows: who the person
 * is (repo_audit), and that a masked secret must never be written back.
 */
import { db, type Env } from '../_lib/db.ts';
import { getRepoCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { EDIT, RepoError, SECRET_MASK, repoCall, type RepoMeta } from '../_lib/repository.ts';

const KEY = /^[a-z0-9_]{1,64}$/;
/** Apps Script decodes the upload in memory; past this it fails slowly and unhelpfully. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const creds = await getRepoCredentials(sql, env.ENCRYPTION_KEY);
  if (!creds) return fail(409, 'The Data Repository is not connected.');

  const b = await request.json().catch(() => ({})) as Record<string, any>;
  const op = String(b.op ?? '');
  if (!EDIT.has(op)) return fail(400, `"${op}" is not an edit.`);

  const table = String(b.table ?? '');
  const id = String(b.id ?? '').trim();
  if (op.startsWith('docs.rename') || op === 'docs.delete') {
    if (!/^[\w-]{10,100}$/.test(String(b.fileId ?? ''))) return fail(400, 'Which file?');
  } else {
    if (!KEY.test(table)) return fail(400, 'Which table?');
    if (op !== 'create' && (!id || id.length > 64)) return fail(400, 'Which record?');
  }

  let detail: string | null = null;
  const params: Record<string, unknown> = { table, actor: who.email };

  if (op === 'create' || op === 'update') {
    const values = (b.values && typeof b.values === 'object') ? b.values as Record<string, unknown> : null;
    if (!values || !Object.keys(values).length) return fail(400, 'Nothing to save.');
    // The API hands secrets back as a mask. A form that echoed a field it
    // never changed would encrypt the mask and destroy the real password,
    // silently and permanently. Refused whatever the column says.
    for (const [k, v] of Object.entries(values)) {
      if (!KEY.test(k)) return fail(400, `Unknown field "${k}".`);
      if (typeof v === 'string' && /^•+$/.test(v)) return fail(400, `"${k}" is masked — leave it out unless it is being changed.`);
    }
    const secrets = await secretColumns(creds, table);
    detail = Object.keys(values).map(k => secrets.has(k) ? `${k} (secret changed)` : k).join(', ');
    Object.assign(params, op === 'create' ? { values } : { id, values });
  } else if (op === 'delete') {
    // Never `hard`: the row's folder goes to the table's _Archive, not the bin.
    Object.assign(params, { id });
    detail = 'row removed, folder archived';
  } else if (op === 'docs.upload') {
    const column = String(b.column ?? '');
    const data = String(b.data ?? '');
    const name = String(b.name ?? '').trim().slice(0, 200);
    if (!KEY.test(column) || !name || !data) return fail(400, 'A document column, a file name and the file.');
    if (data.length * 0.75 > MAX_UPLOAD_BYTES) return fail(413, 'Files are limited to 10 MB.');
    Object.assign(params, { id, column, name, mimeType: String(b.mimeType || 'application/octet-stream'), data });
    detail = `${column}: ${name}`;
  } else if (op === 'docs.create') {
    const column = String(b.column ?? '');
    if (!KEY.test(column)) return fail(400, 'Which document column?');
    Object.assign(params, { id, column, name: String(b.name ?? '').trim().slice(0, 200) || undefined,
                            kind: b.kind === 'sheet' ? 'sheet' : 'doc' });
    detail = `${column}: new Google ${b.kind === 'sheet' ? 'Sheet' : 'Doc'}`;
  } else if (op === 'docs.rename') {
    Object.assign(params, { fileId: b.fileId, name: String(b.name ?? '').trim().slice(0, 200) });
    detail = `file ${b.fileId} → ${params.name}`;
  } else if (op === 'docs.delete') {
    Object.assign(params, { fileId: b.fileId });
    detail = `file ${b.fileId} to Drive's trash`;
  }

  try {
    const data = await repoCall<unknown>(creds, op, params);
    await sql`INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
              VALUES (1, ${who.email}, ${op}, ${table || null},
                      ${op === 'create' ? String((data as Record<string, unknown>)?.id ?? '') : id || null}, ${detail})`;
    return Response.json({ ok: true, data });
  } catch (e) {
    return fail(e instanceof RepoError ? 502 : 500, e instanceof Error ? e.message : String(e));
  }
};

async function secretColumns(creds: { url: string; key: string }, table: string): Promise<Set<string>> {
  try {
    const meta = await repoCall<RepoMeta>(creds, 'meta');
    const t = meta.sections.flatMap(s => s.tables).find(x => x.key === table);
    return new Set((t?.columns ?? []).filter(c => c.type === 'secret').map(c => c.key));
  } catch { return new Set(); }
}

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, error: 'repository', message }, { status });
}
