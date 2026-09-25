/**
 * POST /api/repository-import — a Monday board into a new Repository table (§74).
 *
 *   multipart: file                         an .xlsx export or a .csv → { name, rows }
 *   { op: 'read', link }                    an .xlsx or Google Sheet already in Drive → { name, rows }
 *   { op: 'commit', section, title, idPrefix, columns, items }
 *       columns: [{ index, title, type, options }]  index into each item's cells; -1 = its group
 *       items:   [{ group, cells }]
 *
 * Reading returns the rows as text; the preview (header, groups, types)
 * is src/lib/repo-import.ts in the browser, where a person corrects it.
 * Committing makes the table in one go: values converted by the same rules
 * as a type change (coerce), secrets encrypted apart, IDs numbered from 1.
 * `repository.structure` (roles.ts).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { encrypt } from '../_lib/crypto.ts';
import { DriveError, driveToken, fileIdFromUrl, spreadsheetCsv } from '../_lib/gdrive.ts';
import { KEY, SYSTEM_KEYS, audit } from '../_lib/repo-store.ts';
import { CONVERTIBLE, coerce, formatId, slug, type ColumnType } from '../../src/lib/repo.ts';
import { parseCsv } from '../../src/lib/repo-import.ts';

const TYPES = new Set<string>([...CONVERTIBLE, 'secret']);
const MAX_ITEMS = 5000;
const MAX_BYTES = 20 * 1024 * 1024;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;

  try {
    if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
      const file = (await request.formData()).get('file');
      if (!file || typeof file === 'string') return fail(400, 'No file.');
      if (file.size > MAX_BYTES) return fail(413, 'That file is over 20 MB.');
      if (/\.csv$/i.test(file.name) || file.type === 'text/csv') {
        return Response.json({ ok: true, name: file.name, rows: parseCsv(await file.text()) });
      }
      const token = await driveToken(sql, env.ENCRYPTION_KEY);
      const r = await spreadsheetCsv(token, { bytes: await file.arrayBuffer(), name: file.name,
        mimeType: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      return Response.json({ ok: true, name: r.name, rows: parseCsv(r.csv) });
    }

    const b = await request.json().catch(() => ({})) as Record<string, any>;
    if (b.op === 'read') {
      const id = fileIdFromUrl(String(b.link ?? ''));
      if (!id) return fail(400, 'Paste the file’s Drive link.');
      const r = await spreadsheetCsv(await driveToken(sql, env.ENCRYPTION_KEY), { fileId: id });
      return Response.json({ ok: true, name: r.name, rows: parseCsv(r.csv) });
    }
    if (b.op !== 'commit') return fail(400, 'Unknown import step.');

    const section = String(b.section ?? '');
    const title = String(b.title ?? '').trim().slice(0, 80);
    const idPrefix = String(b.idPrefix ?? '').trim().toUpperCase().slice(0, 6);
    if (!KEY.test(section) || !title) return fail(400, 'A section and a table name.');
    if (idPrefix && !/^[A-Z0-9]+$/.test(idPrefix)) return fail(400, 'The ID prefix is letters and digits, like UNI.');
    const sec = await sql`SELECT 1 FROM repo_sections WHERE account_id = 1 AND key = ${section} AND archived_at IS NULL`;
    if (!sec.length) return fail(404, 'No such section.');

    const items = (Array.isArray(b.items) ? b.items : []) as { group?: string; cells?: string[] }[];
    if (!items.length) return fail(400, 'No records to import.');
    if (items.length > MAX_ITEMS) return fail(413, `At most ${MAX_ITEMS} records at a time.`);
    const raw = (Array.isArray(b.columns) ? b.columns : []) as { index?: number; title?: string; type?: string; options?: string[] }[];
    if (!raw.length) return fail(400, 'Pick at least one column.');

    // Keys from titles, unique within the table and never a system key.
    const taken: string[] = [...SYSTEM_KEYS];
    const valueAt = (it: { group?: string; cells?: string[] }, index: number) =>
      index === -1 ? String(it.group ?? '') : String(it.cells?.[index] ?? '');
    const cols = raw.map(c => {
      const type = (TYPES.has(String(c.type)) ? c.type : 'text') as ColumnType;
      const colTitle = String(c.title ?? '').trim().slice(0, 80) || 'Column';
      const key = slug(colTitle, taken); taken.push(key);
      const index = Number(c.index);
      // A dropdown keeps every value the board had: an option list that
      // missed one would clear it on the way in.
      const options = type === 'select'
        ? [...new Set([...(c.options ?? []).map(String), ...items.map(it => valueAt(it, index).trim()).filter(Boolean)])].slice(0, 200)
        : null;
      return { key, title: colTitle, type, index, options };
    });
    if (cols.some(c => !Number.isInteger(c.index) || c.index < -1)) return fail(400, 'A column points nowhere.');

    const tables = (await sql`SELECT key FROM repo_tables WHERE account_id = 1`).map((r: any) => r.key as string);
    const key = slug(title, tables);
    const plain = cols.filter(c => c.type !== 'secret');
    const secretCols = cols.filter(c => c.type === 'secret');
    const kept = items.filter(it => cols.some(c => valueAt(it, c.index).trim() !== ''));

    await sql`INSERT INTO repo_tables (account_id, key, section_key, title, id_prefix, name_fields, position)
              SELECT 1, ${key}, ${section}, ${title}, ${idPrefix}, ${[cols[0]!.key]}, COALESCE(MAX(position), 0) + 1
                FROM repo_tables WHERE account_id = 1`;
    await sql`INSERT INTO repo_columns (account_id, table_key, key, title, type, options, position)
              SELECT 1, ${key}, k, t, ty, CASE WHEN o = '' THEN NULL ELSE string_to_array(o, E'\\x1f') END, n
                FROM unnest(${cols.map(c => c.key)}::text[], ${cols.map(c => c.title)}::text[], ${cols.map(c => c.type)}::text[],
                            ${cols.map(c => (c.options ?? []).join('\x1f'))}::text[]) WITH ORDINALITY AS t(k, t, ty, o, n)`;

    const ids = kept.map((_, i) => formatId(idPrefix, i + 1));
    const vals = kept.map(it => JSON.stringify(Object.fromEntries(plain.map(c => [c.key, coerce(c, valueAt(it, c.index))]))));
    await sql`INSERT INTO repo_records (account_id, table_key, id, seq, vals, position, created_by, updated_by)
              SELECT 1, ${key}, i, n, v::jsonb, n, ${who.email}, ${who.email}
                FROM unnest(${ids}::text[], ${vals}::text[]) WITH ORDINALITY AS t(i, v, n)`;

    const sIds: string[] = [], sCols: string[] = [], sEnc: string[] = [];
    for (const [i, it] of kept.entries()) {
      for (const c of secretCols) {
        const v = valueAt(it, c.index).trim();
        if (v) { sIds.push(ids[i]!); sCols.push(c.key); sEnc.push(await encrypt(v, env.ENCRYPTION_KEY)); }
      }
    }
    if (sIds.length) {
      await sql`INSERT INTO repo_secrets (account_id, table_key, record_id, column_key, value_enc)
                SELECT 1, ${key}, r, c, e FROM unnest(${sIds}::text[], ${sCols}::text[], ${sEnc}::text[]) AS t(r, c, e)`;
    }
    await audit(sql, who.email, 'import.monday', key, null,
      `${title}: ${kept.length} records, ${cols.length} columns, ${sIds.length} secrets encrypted`);
    return Response.json({ ok: true, key, records: kept.length, secrets: sIds.length });
  } catch (e) {
    return fail(e instanceof DriveError ? 502 : 500, e instanceof Error ? e.message : String(e));
  }
};

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, message }, { status });
}
