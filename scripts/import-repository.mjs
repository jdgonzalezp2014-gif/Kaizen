/**
 * One-time move of the Data Repository into Kaizen OS (§71).
 *
 *   npm run import:repository -- --dry       read everything, write nothing
 *   npm run import:repository                import into empty repo_* tables
 *   npm run import:repository -- --replace   wipe repo_* and import again
 *
 * Reads the old Apps Script API — slowly, with retries, in small batches,
 * because it fails under load — and writes structure, records, document
 * links (with their Drive file IDs and each section's Drive folder) and
 * secrets. Secrets are revealed one by one and re-encrypted with
 * Kaizen's key; each reveal is also written to repo_reveals as the import.
 *
 * Values are copied as they are. The old data predates the rules (a date
 * column with dropdown options, a password kept as a select); the only
 * change is a date column's timestamp reduced to its day.
 */
import { neon } from '@neondatabase/serverless';
import { getRepoCredentials } from '../functions/_lib/accounts.ts';
import { repoCall, SECRET_MASK } from '../functions/_lib/repository.ts';
import { encrypt } from '../functions/_lib/crypto.ts';

const DRY = process.argv.includes('--dry');
const REPLACE = process.argv.includes('--replace');
const ACTOR = 'import@data-repository';
const SYSTEM = new Set(['id', 'folder', 'created_at', 'created_by', 'updated_at', 'updated_by']);
const unq = v => String(v ?? '').replace(/^"|"$/g, '');

const sql = neon(unq(process.env.DATABASE_URL));
const KEY = unq(process.env.ENCRYPTION_KEY);
if (!KEY) throw new Error('ENCRYPTION_KEY is not set.');
const creds = await getRepoCredentials(sql, KEY);
if (!creds) throw new Error('The old repository API is not configured in accounts.');

async function call(action, params = {}, tries = 6) {
  for (let i = 1; ; i++) {
    try { return await repoCall(creds, action, params); }
    catch (e) {
      if (i >= tries) throw e;
      const wait = 2000 * i;
      console.log(`  … ${action} failed (${e.message.slice(0, 80)}), retry ${i} in ${wait / 1000}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}
const stamp = v => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };
const idNumber = id => { const m = /(\d+)\s*$/.exec(String(id)); return m ? parseInt(m[1], 10) : 0; };

const existing = Number((await sql`SELECT count(*) AS n FROM repo_records WHERE account_id = 1`)[0].n);
if (existing && !REPLACE && !DRY) throw new Error(`repo_records already holds ${existing} records. Use --replace to import again.`);

const t0 = Date.now();
console.log('Reading the structure…');
const meta = await call('meta');

const plan = [];
for (const s of meta.sections) {
  for (const t of s.tables) {
    const cols = t.columns.filter(c => !c.system && !SYSTEM.has(c.key));
    console.log(`Reading ${s.title} / ${t.title}…`);
    const { rows } = await call('list', { table: t.key });
    const docCols = cols.filter(c => c.type === 'doc');
    const docs = {};
    for (const c of docCols) {
      docs[c.key] = {};
      const ids = rows.map(r => String(r.id));
      for (let i = 0; i < ids.length; i += 5) {
        Object.assign(docs[c.key], await call('docs.batch', { table: t.key, column: c.key, ids: ids.slice(i, i + 5), perRow: 50 }));
      }
    }
    plan.push({ section: s, table: t, cols, rows, docs });
  }
}

const summary = plan.map(p => ({
  table: p.table.key, records: p.rows.length, columns: p.cols.length,
  secrets: p.rows.reduce((n, r) => n + p.cols.filter(c => c.type === 'secret' && r[c.key] === SECRET_MASK).length, 0),
  files: Object.values(p.docs).reduce((n, byId) => n + Object.values(byId).reduce((m, e) => m + (e?.files?.length ?? 0), 0), 0)
}));
console.table(summary);
if (DRY) {
  for (const p of plan) console.log(p.table.key, JSON.stringify(p.rows[0]).slice(0, 600));
  console.log(`Dry run — nothing written (${Math.round((Date.now() - t0) / 1000)} s).`);
  process.exit(0);
}

if (REPLACE) {
  console.log('Clearing repo_* …');
  await sql`DELETE FROM repo_files WHERE account_id = 1`;
  await sql`DELETE FROM repo_secrets WHERE account_id = 1`;
  await sql`DELETE FROM repo_records WHERE account_id = 1`;
  await sql`DELETE FROM repo_columns WHERE account_id = 1`;
  await sql`DELETE FROM repo_tables WHERE account_id = 1`;
  await sql`DELETE FROM repo_sections WHERE account_id = 1`;
}

let secretsDone = 0;
for (const [si, s] of meta.sections.entries()) {
  await sql`INSERT INTO repo_sections (account_id, key, title, position, drive_folder_id)
            VALUES (1, ${s.key}, ${s.title}, ${si + 1}, ${s.folderId || null})
            ON CONFLICT (account_id, key) DO NOTHING`;
}
for (const [ti, p] of plan.entries()) {
  const t = p.table;
  await sql`INSERT INTO repo_tables (account_id, key, section_key, title, id_prefix, name_fields, position)
            VALUES (1, ${t.key}, ${p.section.key}, ${t.title}, ${t.idPrefix ?? ''}, ${t.nameFields ?? []}, ${ti + 1})`;
  for (const [ci, c] of p.cols.entries()) {
    await sql`INSERT INTO repo_columns (account_id, table_key, key, title, type, grp, required, uniq, options,
                                        ref_table, ref_column, position)
              VALUES (1, ${t.key}, ${c.key}, ${c.title}, ${c.type}, ${c.group || 'Details'}, ${!!c.required}, ${!!c.unique},
                      ${c.options?.length ? c.options.map(String) : null}, ${c.reference?.table ?? null},
                      ${c.reference?.column ?? null}, ${ci + 1})`;
  }
  const secretCols = p.cols.filter(c => c.type === 'secret');
  const docCols = p.cols.filter(c => c.type === 'doc');
  const dateCols = new Set(p.cols.filter(c => c.type === 'date').map(c => c.key));
  const keep = new Set(p.cols.filter(c => c.type !== 'secret' && c.type !== 'doc').map(c => c.key));
  for (const [ri, r] of p.rows.entries()) {
    const id = String(r.id);
    const vals = {};
    for (const [k, v] of Object.entries(r)) {
      if (!keep.has(k)) continue;
      vals[k] = dateCols.has(k) && /^\d{4}-\d{2}-\d{2}T/.test(String(v)) ? String(v).slice(0, 10) : v;
    }
    const docFolders = Object.fromEntries(docCols.map(c => [c.key, p.docs[c.key]?.[id]?.folderUrl]).filter(([, u]) => u));
    await sql`INSERT INTO repo_records (account_id, table_key, id, seq, vals, folder_url, doc_folders, position,
                                        created_at, created_by, updated_at, updated_by)
              VALUES (1, ${t.key}, ${id}, ${idNumber(id)}, ${JSON.stringify(vals)}::jsonb, ${String(r.folder || '') || null},
                      ${JSON.stringify(docFolders)}::jsonb, ${ri + 1},
                      ${stamp(r.created_at) ?? new Date().toISOString()}, ${String(r.created_by || '') || null},
                      ${stamp(r.updated_at) ?? stamp(r.created_at) ?? new Date().toISOString()}, ${String(r.updated_by || '') || null})`;
    for (const c of docCols) {
      for (const f of p.docs[c.key]?.[id]?.files ?? []) {
        await sql`INSERT INTO repo_files (account_id, table_key, record_id, column_key, name, url, mime_type, size_bytes,
                                          drive_file_id, added_at, added_by)
                  VALUES (1, ${t.key}, ${id}, ${c.key}, ${f.name}, ${f.url}, ${f.mimeType || null}, ${f.size || null},
                          ${f.fileId || null},
                          ${stamp(f.updatedAt) ?? new Date().toISOString()}, ${ACTOR})`;
      }
    }
    for (const c of secretCols) {
      if (r[c.key] !== SECRET_MASK) continue;
      const { value } = await call('reveal', { table: t.key, id, column: c.key });
      if (value === '' || value == null) continue;
      await sql`INSERT INTO repo_reveals (account_id, actor, table_key, row_id, column_key)
                VALUES (1, ${ACTOR}, ${t.key}, ${id}, ${c.key})`;
      await sql`INSERT INTO repo_secrets (account_id, table_key, record_id, column_key, value_enc)
                VALUES (1, ${t.key}, ${id}, ${c.key}, ${await encrypt(String(value), KEY)})`;
      secretsDone++;
    }
  }
  console.log(`  ${t.title}: ${p.rows.length} records`);
}

await sql`INSERT INTO repo_audit (account_id, actor, action, table_key, row_id, detail)
          VALUES (1, ${ACTOR}, 'import', NULL, NULL, ${JSON.stringify(summary)})`;

const [c] = await sql`SELECT (SELECT count(*) FROM repo_records WHERE account_id = 1) AS records,
                             (SELECT count(*) FROM repo_secrets WHERE account_id = 1) AS secrets,
                             (SELECT count(*) FROM repo_files WHERE account_id = 1) AS files,
                             (SELECT count(*) FROM repo_columns WHERE account_id = 1) AS columns`;
const want = summary.reduce((a, s) => ({ records: a.records + s.records, secrets: a.secrets + s.secrets, files: a.files + s.files }),
                            { records: 0, secrets: 0, files: 0 });
console.log('In Kaizen:', c, 'expected:', want, `secrets imported this run: ${secretsDone}`);
if (Number(c.records) !== want.records || Number(c.secrets) !== want.secrets || Number(c.files) !== want.files) {
  console.error('✖ Counts differ — do not switch over until they match.');
  process.exit(1);
}
console.log(`✔ Imported in ${Math.round((Date.now() - t0) / 1000)} s.`);
