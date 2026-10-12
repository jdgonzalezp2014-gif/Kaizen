/**
 * One clean as the people doing it report it (§134): photos before and
 * after, in the team's Drive — a folder per unit, and in it a folder per
 * clean — and "done" / "reopened". From the cleaner's page or from the link
 * they send to whoever helps them; several people can work the same clean,
 * and every photo and mark says who.
 */
import type { SqlFn } from './accounts.ts';
import { DriveError, createFolder, driveToken, findChildFolder, folderUrl, uploadFile } from './gdrive.ts';

export type Stage = 'before' | 'after';
export interface FieldWho { name: string; source: 'cleaner' | 'link' }
export interface CleanState {
  before: number; after: number; folderUrl: string | null;
  /** Done and not reopened since: by whom, when (New York). */
  done: { by: string; at: string } | null;
}
const TZ = 'America/New_York';
const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** The field record of a clean, made the first time anyone reports on it. */
export async function ensureRecord(sql: SqlFn, r: { key: string; cleaner: string; unitId: string | null; unitName: string; date: string }) {
  await sql`INSERT INTO clean_records (account_id, cleaning_key, cleaner, unit_id, unit_name, clean_date)
            VALUES (1, ${r.key}, ${r.cleaner}, ${r.unitId}, ${r.unitName}, ${r.date})
            ON CONFLICT (account_id, cleaning_key) DO UPDATE SET cleaner = EXCLUDED.cleaner`;
}

/** Where each clean stands, for the keys asked. */
export async function cleanStates(sql: SqlFn, keys: string[]): Promise<Record<string, CleanState>> {
  if (!keys.length) return {};
  const [recs, photos, marks] = await Promise.all([
    sql`SELECT cleaning_key AS key, drive_folder FROM clean_records WHERE account_id = 1 AND cleaning_key = ANY(${keys}::text[])`,
    sql`SELECT cleaning_key AS key, stage, count(*)::int AS n FROM clean_photos
         WHERE account_id = 1 AND cleaning_key = ANY(${keys}::text[]) GROUP BY 1, 2`,
    sql`SELECT DISTINCT ON (cleaning_key) cleaning_key AS key, kind, by_name,
               to_char(created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD HH24:MI') AS at
          FROM clean_marks WHERE account_id = 1 AND cleaning_key = ANY(${keys}::text[]) ORDER BY cleaning_key, id DESC`
  ]) as [{ key: string; drive_folder: string | null }[], { key: string; stage: Stage; n: number }[], { key: string; kind: string; by_name: string; at: string }[]];
  const out: Record<string, CleanState> = {};
  for (const r of recs) {
    const m = marks.find(x => x.key === r.key);
    out[r.key] = {
      before: photos.find(p => p.key === r.key && p.stage === 'before')?.n ?? 0,
      after: photos.find(p => p.key === r.key && p.stage === 'after')?.n ?? 0,
      folderUrl: r.drive_folder ? folderUrl(r.drive_folder) : null,
      done: m?.kind === 'done' ? { by: m.by_name, at: m.at } : null
    };
  }
  return out;
}

/** Photos to Drive: Kaizen — clean photos / <unit> / <date> <unit>. Checked before anything is uploaded. */
export async function addPhotos(sql: SqlFn, encryptionKey: string, key: string, stage: Stage, files: File[], who: FieldWho) {
  if (stage !== 'before' && stage !== 'after') throw new Error('Before or after?');
  if (!files.length) throw new Error('No photo.');
  if (files.length > 10) throw new Error('At most 10 photos at a time.');
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) throw new DriveError(`${f.name} is over 15 MB.`);
    if (!/^image\//.test(f.type || '')) throw new DriveError(`${f.name}: a photo, please.`);
  }
  const [rec] = await sql`SELECT unit_name, clean_date::text AS date, drive_folder FROM clean_records
                           WHERE account_id = 1 AND cleaning_key = ${key}` as { unit_name: string; date: string; drive_folder: string | null }[];
  if (!rec) throw new Error('Which clean?');
  const token = await driveToken(sql, encryptionKey);
  let folder = rec.drive_folder;
  if (!folder) {
    const [acc] = await sql`SELECT clean_photos_folder FROM accounts WHERE id = 1` as { clean_photos_folder: string | null }[];
    let root = acc?.clean_photos_folder ?? null;
    if (!root) {
      root = (await createFolder(token, null, 'Kaizen — clean photos')).id;
      await sql`UPDATE accounts SET clean_photos_folder = ${root} WHERE id = 1`;
    }
    const unit = await findChildFolder(token, root, rec.unit_name) ?? (await createFolder(token, root, rec.unit_name)).id;
    folder = (await createFolder(token, unit, `${rec.date} ${rec.unit_name}`)).id;
    await sql`UPDATE clean_records SET drive_folder = ${folder} WHERE account_id = 1 AND cleaning_key = ${key}`;
  }
  const [had] = await sql`SELECT count(*)::int AS n FROM clean_photos WHERE account_id = 1 AND cleaning_key = ${key} AND stage = ${stage}` as { n: number }[];
  let i = had?.n ?? 0;
  for (const f of files) {
    i++;
    const ext = (/\.[A-Za-z0-9]{2,5}$/.exec(f.name)?.[0] ?? '.jpg').toLowerCase();
    const name = `${stage === 'before' ? 'Before' : 'After'} ${String(i).padStart(2, '0')} — ${who.name}${ext}`.slice(0, 200);
    const up = await uploadFile(token, folder, name, f.type, await f.arrayBuffer());
    await sql`INSERT INTO clean_photos (account_id, cleaning_key, stage, name, url, drive_id, by_name, source)
              VALUES (1, ${key}, ${stage}, ${name}, ${up.webViewLink ?? `https://drive.google.com/file/d/${up.id}/view`}, ${up.id},
                      ${who.name}, ${who.source})`;
  }
  return files.length;
}

/**
 * Done, or reopened. Done needs at least one AFTER photo — the team's only
 * way to see the result, and the step most easily forgotten.
 */
export async function markClean(sql: SqlFn, key: string, kind: 'done' | 'reopened', who: FieldWho) {
  if (kind !== 'done' && kind !== 'reopened') throw new Error('Done or reopen?');
  const st = (await cleanStates(sql, [key]))[key];
  if (!st) throw new Error('Which clean?');
  if (kind === 'done' && !st.after) throw new Error('Add at least one AFTER photo first.');
  if (kind === 'done' && st.done) return;           // already done: a second tap changes nothing
  if (kind === 'reopened' && !st.done) return;
  await sql`INSERT INTO clean_marks (account_id, cleaning_key, kind, by_name, source) VALUES (1, ${key}, ${kind}, ${who.name}, ${who.source})`;
}
