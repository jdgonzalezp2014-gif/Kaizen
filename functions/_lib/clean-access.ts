/**
 * Who sees the clean photos in Drive (owner, 2026-10-14): not anyone with the link — Kaizen's members on the
 * root folder (admins as writers, the rest as readers), and each cleaner on their own cleans' folders only
 * (what their helpers sent for that clean included). Shared quietly: no email from Google. Kaizen's own
 * pages read photos through the app and need none of this.
 */
import type { SqlFn } from './accounts.ts';
import { driveToken } from './gdrive.ts';

const API = 'https://www.googleapis.com/drive/v3/files';
type Perm = { id: string; type: string; role: string; emailAddress?: string };

async function perms(token: string, file: string): Promise<Perm[]> {
  const r = await fetch(`${API}/${file}/permissions?fields=permissions(id,type,role,emailAddress)&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive permissions: ${r.status}`);
  return ((await r.json()) as { permissions?: Perm[] }).permissions ?? [];
}
const RANK: Record<string, number> = { reader: 1, commenter: 2, writer: 3, fileOrganizer: 4, organizer: 5, owner: 6 };

/** The people given (at least) a role, the "anyone with the link" taken off. Returns what changed. */
export async function ensureAccess(token: string, file: string, emails: string[], role: 'reader' | 'writer'): Promise<string[]> {
  const now = await perms(token, file);
  const changed: string[] = [];
  for (const p of now.filter(p => p.type === 'anyone')) {
    await fetch(`${API}/${file}/permissions/${p.id}?supportsAllDrives=true`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    changed.push('link access off');
  }
  for (const email of [...new Set(emails.map(e => e.trim().toLowerCase()).filter(Boolean))]) {
    const has = now.find(p => p.type === 'user' && p.emailAddress?.toLowerCase() === email);
    if (has && (RANK[has.role] ?? 0) >= RANK[role]!) continue;
    const r = await fetch(`${API}/${file}/permissions?sendNotificationEmail=false&supportsAllDrives=true`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role, emailAddress: email })
    });
    changed.push(r.ok ? `${email} ${role}` : `${email} failed (${r.status})`);
  }
  return changed;
}

/** A root folder of Kaizen's: every team member sees it all — admins organize (writer), the rest read
 *  (owner, 2026-10-14: Derek, Amanda, Laura, Juan, Shannon); nobody else, not by link. Cleaners and the
 *  handyman are not members: they see only what is theirs. */
export async function shareRoot(sql: SqlFn, token: string, root: string) {
  const m = await sql`SELECT email, role FROM members WHERE account_id = 1 AND role NOT IN ('cleaner', 'vendor', 'handyman')` as { email: string; role: string }[];
  return [...await ensureAccess(token, root, m.filter(x => x.role === 'admin').map(x => x.email), 'writer'),
          ...await ensureAccess(token, root, m.filter(x => x.role !== 'admin').map(x => x.email), 'reader')];
}

/** One clean's folder: its cleaner can see it (a cleaner with no email: nothing to share). */
export async function shareCleanFolder(sql: SqlFn, token: string, key: string): Promise<string[]> {
  const [r] = await sql`SELECT r.drive_folder, c.email FROM clean_records r LEFT JOIN cleaners c ON c.account_id = r.account_id AND c.name = r.cleaner
                         WHERE r.account_id = 1 AND r.cleaning_key = ${key}` as { drive_folder: string | null; email: string | null }[];
  if (!r?.drive_folder || !r.email) return [];
  return ensureAccess(token, r.drive_folder, [r.email], 'reader');
}

/**
 * Every Kaizen root folder to the team (owner, 2026-10-14: "a task's file would not open") — clean photos,
 * field reports (to-do files, orders, reports), inspections, crew extras — and each clean's folder to its
 * cleaner. The first time, once a day from the clock (new members), and when a root is made.
 */
export async function syncTeamDriveAccess(sql: SqlFn, encryptionKey: string): Promise<string[]> {
  const token = await driveToken(sql, encryptionKey);
  const [a] = await sql`SELECT clean_photos_folder, field_reports_folder, inspection_photos_folder, crew_extras_folder FROM accounts WHERE id = 1` as
    Record<string, string | null>[];
  const out: string[] = [];
  for (const [col, id] of Object.entries(a ?? {})) if (id) out.push(...(await shareRoot(sql, token, id)).map(x => `${col}: ${x}`));
  const keys = await sql`SELECT cleaning_key FROM clean_records WHERE account_id = 1 AND drive_folder IS NOT NULL` as { cleaning_key: string }[];
  for (const k of keys) out.push(...(await shareCleanFolder(sql, token, k.cleaning_key)).map(x => `${k.cleaning_key}: ${x}`));
  return out;
}
