/**
 * Guest documents — an ID and a rental agreement per reservation (§73).
 *
 * Kept where the daily file kept them, found by the same names:
 *   root / 2026 / 2026-09 / 2026-09-24 / "Sep 24 & Guest" / ID
 *                                                         / Rental Agreement
 * so a file dropped in from either side is seen by both, and nothing had
 * to be moved. Hostaway never exposes the ID image; the SIGNED agreement
 * it does (`rentalAgreementFileUrl`), and Kaizen files it like the daily
 * file did.
 *
 * Folder IDs are remembered in `drive_folders` (they do not change); the
 * files inside are listed from Drive every time they are shown.
 */
import type { SqlFn } from './accounts.ts';
import { DriveError, createFolder, filesIn, folderUrl, type DriveFile } from './gdrive.ts';

export const SUBFOLDER = { id: 'ID', agreement: 'Rental Agreement' } as const;
export type DocKind = keyof typeof SUBFOLDER;

const FOLDER = 'application/vnd.google-apps.folder';

/** "Sep 24 & Guest" — the daily file's manualDocFolderName_, exactly. */
export function reservationFolderName(arrival: string, name: string): string {
  const d = new Date(`${arrival}T12:00:00Z`);
  const mmm = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${mmm} ${d.getUTCDate()} & ${name}`.replace(/[/\\]/g, '-');
}

/** The folders from the root down to a reservation's folder. */
export function reservationPath(arrival: string, name: string): string[] {
  const [y, m] = arrival.split('-');
  return [y!, `${y}-${m}`, arrival, reservationFolderName(arrival, name)];
}

/** "CL Sunset #102" → "cl-sunset-102", as the daily file names a pulled agreement. */
export function slug(s: string): string {
  return String(s || 'unknown').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'unknown';
}

/** The daily file's name for a guest, from a Hostaway reservation (same rule as hostaway.ts docName). */
export const docNameOf = (r: Record<string, unknown>) =>
  `${r.guestFirstName ?? ''} ${r.guestLastName ?? ''}`.trim() || String(r.guestName ?? '').trim() || 'Guest';

export async function guestRoot(sql: SqlFn): Promise<string> {
  const id = (await sql`SELECT guest_docs_root_id FROM accounts WHERE id = 1`)[0]?.guest_docs_root_id as string | null;
  if (!id) throw new DriveError('No guest documents folder is set — Settings → Google Drive.');
  return id;
}

async function childFolders(token: string, parents: string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>(parents.map(p => [p, new Map()]));
  const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  for (let i = 0; i < parents.length; i += 30) {
    const q = `(${parents.slice(i, i + 30).map(p => `${quote(p)} in parents`).join(' or ')}) and mimeType = '${FOLDER}' and trashed = false`;
    let pageToken = '';
    do {
      const res = await fetch(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({
        q, fields: 'nextPageToken,files(id,name,parents)', pageSize: '1000', orderBy: 'createdTime',
        supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}) })}`,
        { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new DriveError(`Drive could not list folders (HTTP ${res.status}).`);
      const r = await res.json() as { files: { id: string; name: string; parents?: string[] }[]; nextPageToken?: string };
      // The oldest folder of a name wins — the one the daily file made first.
      for (const f of r.files) for (const p of f.parents ?? []) { const m = out.get(p); if (m && !m.has(f.name)) m.set(f.name, f.id); }
      pageToken = r.nextPageToken ?? '';
    } while (pageToken);
  }
  return out;
}

/**
 * Folder IDs for many paths at once, level by level: one Drive query per
 * level for everything not yet known, not one per folder. With `create`,
 * a missing folder is made (an upload); without, it stays missing (a
 * status read never creates anything).
 */
export async function resolvePaths(sql: SqlFn, token: string, root: string, paths: string[][],
                                   create: boolean): Promise<Map<string, string>> {
  const key = (parts: string[]) => `${root}/${parts.join('/')}`;
  const allKeys = [...new Set(paths.flatMap(p => p.map((_, i) => key(p.slice(0, i + 1)))))];
  const known = new Map<string, string>(
    (await sql`SELECT path, folder_id FROM drive_folders WHERE account_id = 1 AND path = ANY(${allKeys})`)
      .map((r: any) => [r.path as string, r.folder_id as string]));
  const saved: [string, string][] = [];
  const depth = Math.max(0, ...paths.map(p => p.length));

  for (let level = 0; level < depth; level++) {
    const needs = paths.filter(p => p.length > level && !known.has(key(p.slice(0, level + 1)))
      && (level === 0 || known.has(key(p.slice(0, level)))));
    if (!needs.length) continue;
    const parentOf = (p: string[]) => level === 0 ? root : known.get(key(p.slice(0, level)))!;
    const listed = await childFolders(token, [...new Set(needs.map(parentOf))]);
    for (const p of needs) {
      const k = key(p.slice(0, level + 1));
      if (known.has(k)) continue;   // two paths sharing this level
      let id = listed.get(parentOf(p))?.get(p[level]!) ?? null;
      if (!id && create) id = (await createFolder(token, parentOf(p), p[level]!)).id;
      if (id) { known.set(k, id); saved.push([k, id]); }
    }
  }
  if (saved.length) {
    await sql`INSERT INTO drive_folders (account_id, path, folder_id)
              SELECT 1, p, f FROM unnest(${saved.map(s => s[0])}::text[], ${saved.map(s => s[1])}::text[]) AS t(p, f)
              ON CONFLICT (account_id, path) DO UPDATE SET folder_id = EXCLUDED.folder_id, found_at = now()`;
  }
  return known;
}

export interface GuestFile { fileId: string; name: string; mimeType: string; url: string; updatedAt: string }
export interface StayDocs { folderUrl: string | null; id: GuestFile[]; agreement: GuestFile[] }

const fileOut = (f: DriveFile): GuestFile =>
  ({ fileId: f.id, name: f.name, mimeType: f.mimeType, url: f.webViewLink, updatedAt: f.modifiedTime });

/** What each stay has filed, read from Drive now. */
export async function docsStatus(sql: SqlFn, token: string,
                                 stays: { resId: string; arrival: string; name: string }[]): Promise<Record<string, StayDocs>> {
  const root = await guestRoot(sql);
  const key = (parts: string[]) => `${root}/${parts.join('/')}`;
  const paths = stays.flatMap(s => {
    const base = reservationPath(s.arrival, s.name);
    return [[...base, SUBFOLDER.id], [...base, SUBFOLDER.agreement]];
  });
  const known = await resolvePaths(sql, token, root, paths, false);
  const sub = (s: { arrival: string; name: string }, kind: DocKind) =>
    known.get(key([...reservationPath(s.arrival, s.name), SUBFOLDER[kind]])) ?? null;
  const folders = stays.flatMap(s => [sub(s, 'id'), sub(s, 'agreement')]).filter((x): x is string => !!x);
  const files = folders.length ? await filesIn(token, folders) : new Map<string, DriveFile[]>();
  const out: Record<string, StayDocs> = {};
  for (const s of stays) {
    const parent = known.get(key(reservationPath(s.arrival, s.name)));
    const idF = sub(s, 'id'), agF = sub(s, 'agreement');
    out[s.resId] = {
      folderUrl: parent ? folderUrl(parent) : null,
      id: (idF ? files.get(idF) ?? [] : []).map(fileOut),
      agreement: (agF ? files.get(agF) ?? [] : []).map(fileOut)
    };
  }
  return out;
}

/** The folder a document goes in, made if it is not there yet. */
export async function docFolderFor(sql: SqlFn, token: string, arrival: string, name: string, kind: DocKind): Promise<string> {
  const root = await guestRoot(sql);
  const path = [...reservationPath(arrival, name), SUBFOLDER[kind]];
  const id = (await resolvePaths(sql, token, root, [path], true)).get(`${root}/${path.join('/')}`);
  if (!id) throw new DriveError('Could not make the reservation’s folder in Drive.');
  return id;
}
