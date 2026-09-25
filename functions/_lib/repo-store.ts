/**
 * The Data Repository's store (§71): structure and records in Postgres.
 *
 * It used to be read through the old Apps Script project — 11 s for the
 * structure alone, a table a minute under load. The idea is what stayed:
 * structure is data (sections → tables → typed columns), a record's
 * values are one object keyed by column, secrets live apart and
 * encrypted, documents are Drive links. Every screen reads from here.
 *
 * The API routes answer in the shapes the old API had, so the screen did
 * not have to learn a second repository.
 */
import type { SqlFn } from './accounts.ts';
import { SECRET_MASK, type ColumnType, type RepoCol } from '../../src/lib/repo.ts';
import { DriveError, createFolder, folderIdFromUrl, folderUrl, parentOf } from './gdrive.ts';

export const KEY = /^[a-z0-9_]{1,64}$/;
/** Keys the store fills itself. A person's column can never take one. */
export const SYSTEM_KEYS = new Set(['id', 'folder', 'created_at', 'created_by', 'updated_at', 'updated_by']);

export interface ColumnOut {
  key: string; title: string; type: string; group: string;
  required: boolean; unique: boolean; options: string[] | null;
  reference: { table: string; column: string } | null;
  editable: boolean; system: boolean;
}
export interface TableOut {
  key: string; title: string; section: string; idPrefix: string;
  nameFields: string[]; columns: ColumnOut[];
}
export interface SectionOut { key: string; title: string; tables: TableOut[] }
export type RowOut = Record<string, string | number | boolean>;

export interface TableRow { key: string; section_key: string; title: string; id_prefix: string; name_fields: string[] }
interface ColRow {
  table_key: string; key: string; title: string; type: ColumnType; grp: string;
  required: boolean; uniq: boolean; options: string[] | null; ref_table: string | null; ref_column: string | null;
}

const sys = (key: string, title: string, type: string): ColumnOut => ({
  key, title, type, group: 'System', required: false, unique: false, options: null,
  reference: null, editable: false, system: true
});
const BEFORE = [sys('id', 'ID', 'id')];
const AFTER = [sys('folder', 'Folder', 'folder'), sys('created_at', 'Created At', 'auto'), sys('created_by', 'Created By', 'auto'),
               sys('updated_at', 'Updated At', 'auto'), sys('updated_by', 'Updated By', 'auto')];

export const colOf = (c: ColRow): RepoCol => ({
  key: c.key, title: c.title, type: c.type, required: c.required, uniq: c.uniq,
  options: c.options, refTable: c.ref_table, refColumn: c.ref_column
});

const colOut = (c: ColRow): ColumnOut => ({
  key: c.key, title: c.title, type: c.type, group: c.grp, required: c.required, unique: c.uniq,
  options: c.options, reference: c.ref_table && c.ref_column ? { table: c.ref_table, column: c.ref_column } : null,
  // Documents are added through their own box, never typed into a cell.
  editable: c.type !== 'doc', system: false
});

/** The whole structure: three queries, one round trip each, in parallel. */
export async function loadMeta(sql: SqlFn): Promise<{ sections: SectionOut[] }> {
  const [sections, tables, cols] = await Promise.all([
    sql`SELECT key, title FROM repo_sections WHERE account_id = 1 AND archived_at IS NULL ORDER BY position, title`,
    sql`SELECT key, section_key, title, id_prefix, name_fields FROM repo_tables
         WHERE account_id = 1 AND archived_at IS NULL ORDER BY position, title`,
    sql`SELECT table_key, key, title, type, grp, required, uniq, options, ref_table, ref_column
          FROM repo_columns WHERE account_id = 1 ORDER BY table_key, position`
  ]) as [{ key: string; title: string }[], TableRow[], ColRow[]];
  return {
    sections: sections.map(s => ({
      key: s.key, title: s.title,
      tables: tables.filter(t => t.section_key === s.key).map(t => ({
        key: t.key, title: t.title, section: s.key, idPrefix: t.id_prefix, nameFields: t.name_fields,
        columns: [...BEFORE, ...cols.filter(c => c.table_key === t.key).map(colOut), ...AFTER]
      }))
    }))
  };
}

/** One live table and its columns, or null. */
export async function tableCols(sql: SqlFn, table: string): Promise<{ table: TableRow; cols: RepoCol[] } | null> {
  const [t, cols] = await Promise.all([
    sql`SELECT key, section_key, title, id_prefix, name_fields FROM repo_tables
         WHERE account_id = 1 AND key = ${table} AND archived_at IS NULL`,
    sql`SELECT table_key, key, title, type, grp, required, uniq, options, ref_table, ref_column
          FROM repo_columns WHERE account_id = 1 AND table_key = ${table} ORDER BY position`
  ]) as [TableRow[], ColRow[]];
  return t[0] ? { table: t[0], cols: cols.map(colOf) } : null;
}

export interface RecordRow {
  table_key: string; id: string; vals: Record<string, unknown>; folder_url: string | null;
  created_at: string | Date; created_by: string | null; updated_at: string | Date; updated_by: string | null;
}

const iso = (d: string | Date) => new Date(d).toISOString();

/**
 * A record as the screen reads it. A secret is the mask when one is set
 * and empty when not — the value itself never leaves except by a reveal.
 */
export function rowOut(r: RecordRow, secretCols: string[], setSecrets: Set<string>): RowOut {
  const out: RowOut = { id: r.id };
  for (const [k, v] of Object.entries(r.vals ?? {})) {
    if (!SYSTEM_KEYS.has(k)) out[k] = v === null || v === undefined ? '' : v as string | number | boolean;
  }
  for (const c of secretCols) out[c] = setSecrets.has(`${r.id}|${c}`) ? SECRET_MASK : '';
  out.folder = r.folder_url ?? '';
  out.created_at = iso(r.created_at); out.created_by = r.created_by ?? '';
  out.updated_at = iso(r.updated_at); out.updated_by = r.updated_by ?? '';
  return out;
}

/** Which secrets are set in a table, as `id|column`. */
export async function secretsSet(sql: SqlFn, table: string, ids?: string[]): Promise<Set<string>> {
  const rows = (ids
    ? await sql`SELECT record_id, column_key FROM repo_secrets WHERE account_id = 1 AND table_key = ${table}
                  AND record_id = ANY(${ids})`
    : await sql`SELECT record_id, column_key FROM repo_secrets WHERE account_id = 1 AND table_key = ${table}`
  ) as { record_id: string; column_key: string }[];
  return new Set(rows.map(r => `${r.record_id}|${r.column_key}`));
}

export async function listRows(sql: SqlFn, table: string, cols: RepoCol[]): Promise<RowOut[]> {
  const [recs, secrets] = await Promise.all([
    sql`SELECT table_key, id, vals, folder_url, created_at, created_by, updated_at, updated_by
          FROM repo_records WHERE account_id = 1 AND table_key = ${table} AND archived_at IS NULL
         ORDER BY position, seq` as Promise<RecordRow[]>,
    secretsSet(sql, table)
  ]);
  const secretCols = cols.filter(c => c.type === 'secret').map(c => c.key);
  return recs.map(r => rowOut(r, secretCols, secrets));
}

export async function getRow(sql: SqlFn, table: string, id: string, cols: RepoCol[]): Promise<RowOut | null> {
  const [recs, secrets] = await Promise.all([
    sql`SELECT table_key, id, vals, folder_url, created_at, created_by, updated_at, updated_by
          FROM repo_records WHERE account_id = 1 AND table_key = ${table} AND id = ${id} AND archived_at IS NULL` as Promise<RecordRow[]>,
    secretsSet(sql, table, [id])
  ]);
  return recs[0] ? rowOut(recs[0], cols.filter(c => c.type === 'secret').map(c => c.key), secrets) : null;
}

export interface FileOut { fileId: string; name: string; mimeType: string; size: number; url: string; updatedAt: string; driveFileId: string | null }

/** The links in one document column, for a set of records. */
export async function docsFor(
  sql: SqlFn, table: string, column: string, ids: string[]
): Promise<Record<string, { folderUrl: string; files: FileOut[]; truncated: boolean }>> {
  const [recs, files] = await Promise.all([
    sql`SELECT id, doc_folders ->> ${column} AS folder FROM repo_records
         WHERE account_id = 1 AND table_key = ${table} AND id = ANY(${ids})`,
    sql`SELECT id, record_id, name, url, mime_type, size_bytes, added_at, drive_file_id FROM repo_files
         WHERE account_id = 1 AND table_key = ${table} AND column_key = ${column}
           AND record_id = ANY(${ids}) AND removed_at IS NULL ORDER BY added_at`
  ]) as [{ id: string; folder: string | null }[], { id: string; record_id: string; name: string; url: string;
          mime_type: string | null; size_bytes: string | number | null; added_at: string | Date; drive_file_id: string | null }[]];
  const out: Record<string, { folderUrl: string; files: FileOut[]; truncated: boolean }> = {};
  for (const r of recs) out[r.id] = { folderUrl: r.folder ?? '', files: [], truncated: false };
  for (const f of files) {
    out[f.record_id]?.files.push({ fileId: String(f.id), name: f.name, mimeType: f.mime_type ?? '',
      size: Number(f.size_bytes ?? 0), url: f.url, updatedAt: iso(f.added_at), driveFileId: f.drive_file_id });
  }
  return out;
}

export async function audit(sql: SqlFn, actor: string, action: string, table: string | null,
                            rowId: string | null, detail: string | null): Promise<void> {
  await sql`INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
            VALUES (1, ${actor}, ${action}, ${table}, ${rowId}, ${detail})`;
}

/* ── Drive folders (§72) ──────────────────────────────────────────── */

/**
 * The Drive folder a document column's files go in, for one record —
 * made on first use, in the shape the old repository built:
 * section → table → record → one subfolder per document column.
 * Imported records already have theirs; a new record gets its folder the
 * first time a file is added to it.
 */
export async function docFolder(sql: SqlFn, token: string, table: string, id: string, column: string): Promise<string> {
  const rec = (await sql`
    SELECT r.folder_url, r.doc_folders ->> ${column} AS doc, r.vals, t.name_fields, c.title AS col_title
      FROM repo_records r
      JOIN repo_tables t ON t.account_id = r.account_id AND t.key = r.table_key
      JOIN repo_columns c ON c.account_id = r.account_id AND c.table_key = r.table_key AND c.key = ${column}
     WHERE r.account_id = 1 AND r.table_key = ${table} AND r.id = ${id} AND r.archived_at IS NULL`)[0] as
    { folder_url: string | null; doc: string | null; vals: Record<string, unknown>; name_fields: string[]; col_title: string } | undefined;
  if (!rec) throw new DriveError('No such record, or no such document column.');
  const existing = folderIdFromUrl(rec.doc);
  if (existing) return existing;

  let recordFolder = folderIdFromUrl(rec.folder_url);
  if (!recordFolder) {
    const name = [id, ...rec.name_fields.map(k => rec.vals?.[k]).filter(v => v !== undefined && v !== '')].join(' — ');
    recordFolder = (await createFolder(token, await tableFolder(sql, token, table), name)).id;
    await sql`UPDATE repo_records SET folder_url = ${folderUrl(recordFolder)}
               WHERE account_id = 1 AND table_key = ${table} AND id = ${id}`;
  }
  const sub = (await createFolder(token, recordFolder, rec.col_title)).id;
  await sql`UPDATE repo_records SET doc_folders = doc_folders || jsonb_build_object(${column}::text, ${folderUrl(sub)}::text)
             WHERE account_id = 1 AND table_key = ${table} AND id = ${id}`;
  return sub;
}

async function tableFolder(sql: SqlFn, token: string, table: string): Promise<string> {
  const t = (await sql`SELECT drive_folder_id, title, section_key FROM repo_tables WHERE account_id = 1 AND key = ${table}`)[0] as
    { drive_folder_id: string | null; title: string; section_key: string };
  if (t.drive_folder_id) return t.drive_folder_id;
  // An imported table's folder is the parent of any of its records' folders.
  const any = (await sql`SELECT folder_url FROM repo_records WHERE account_id = 1 AND table_key = ${table}
                           AND folder_url IS NOT NULL LIMIT 1`)[0] as { folder_url: string } | undefined;
  const child = folderIdFromUrl(any?.folder_url);
  const id = (child && await parentOf(token, child))
    || (await createFolder(token, await sectionFolder(sql, token, t.section_key), t.title)).id;
  await sql`UPDATE repo_tables SET drive_folder_id = ${id} WHERE account_id = 1 AND key = ${table}`;
  return id;
}

async function sectionFolder(sql: SqlFn, token: string, section: string): Promise<string> {
  const s = (await sql`SELECT drive_folder_id, title FROM repo_sections WHERE account_id = 1 AND key = ${section}`)[0] as
    { drive_folder_id: string | null; title: string };
  if (s.drive_folder_id) return s.drive_folder_id;
  let root = (await sql`SELECT repo_drive_root_id FROM accounts WHERE id = 1`)[0]?.repo_drive_root_id as string | null;
  if (!root) {
    // The old repository's root: the parent of any section's folder.
    const other = (await sql`SELECT drive_folder_id FROM repo_sections WHERE account_id = 1
                               AND drive_folder_id IS NOT NULL LIMIT 1`)[0] as { drive_folder_id: string } | undefined;
    root = (other && await parentOf(token, other.drive_folder_id)) || (await createFolder(token, null, 'Kaizen Repository')).id;
    await sql`UPDATE accounts SET repo_drive_root_id = ${root} WHERE id = 1`;
  }
  const id = (await createFolder(token, root, s.title)).id;
  await sql`UPDATE repo_sections SET drive_folder_id = ${id} WHERE account_id = 1 AND key = ${section}`;
  return id;
}
