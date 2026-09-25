/**
 * POST /api/repository-upload — one file into a record's document column.
 *
 *   multipart/form-data: table, id, column, file
 *
 * The file goes to Google Drive, into the record's folder for that column
 * (made on first use, §72), and the record keeps its link. `repository.edit`
 * (roles.ts); the upload is audited under the person's name, though Drive
 * shows the connected account as its owner.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { DriveError, driveToken, uploadFile } from '../_lib/gdrive.ts';
import { KEY, audit, docFolder } from '../_lib/repo-store.ts';

/** The file passes through the Worker's memory on its way to Drive. */
const MAX_BYTES = 50 * 1024 * 1024;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;

  const form = await request.formData().catch(() => null);
  const table = String(form?.get('table') ?? '');
  const id = String(form?.get('id') ?? '').trim();
  const column = String(form?.get('column') ?? '');
  const file = form?.get('file');
  if (!KEY.test(table) || !id || id.length > 64 || !KEY.test(column)) return fail(400, 'Which record and document column?');
  if (!file || typeof file === 'string') return fail(400, 'No file.');
  if (file.size > MAX_BYTES) return fail(413, `${file.name} is over 50 MB — put it in the record's Drive folder and add its link.`);

  try {
    const col = await sql`SELECT 1 FROM repo_columns WHERE account_id = 1 AND table_key = ${table} AND key = ${column} AND type = 'doc'`;
    if (!col.length) return fail(400, 'That is not a document column.');
    const token = await driveToken(sql, env.ENCRYPTION_KEY);
    const folder = await docFolder(sql, token, table, id, column);
    const name = file.name.slice(0, 200) || 'file';
    const f = await uploadFile(token, folder, name, file.type || 'application/octet-stream', await file.arrayBuffer());
    const row = (await sql`INSERT INTO repo_files (account_id, table_key, record_id, column_key, name, url, mime_type,
                                                   size_bytes, drive_file_id, added_by)
                           VALUES (1, ${table}, ${id}, ${column}, ${f.name}, ${f.webViewLink}, ${f.mimeType},
                                   ${Number(f.size ?? file.size)}, ${f.id}, ${who.email})
                           RETURNING id`)[0] as { id: string };
    await audit(sql, who.email, 'docs.upload', table, id, `${column}: ${f.name} (${Math.round(file.size / 1024)} KB)`);
    return Response.json({ ok: true, data: { fileId: String(row.id), url: f.webViewLink } });
  } catch (e) {
    return fail(e instanceof DriveError ? 502 : 500, e instanceof Error ? e.message : String(e));
  }
};

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, error: 'repository', message }, { status });
}
