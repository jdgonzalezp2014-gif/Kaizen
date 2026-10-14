/**
 * Files on a to-do (owner, Oct 2026) — any kind, several at a time, kept in Drive
 * (the field reports folder) and listed on the to-do. They come from Kaizen (📎 on
 * an open to-do) or from Slack: the message @Kaizen made the to-do from, and files
 * posted later in its thread.
 */
import type { SqlFn } from './accounts.ts';
import { DriveError, createFolder, driveToken, uploadFile } from './gdrive.ts';
import { todayIn } from '../../src/lib/dates.ts';

const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_FILES = 10;
export interface InFile { name: string; type: string; data: ArrayBuffer }
export interface TodoFile { id: string; name: string; url: string; mime: string | null; source: 'app' | 'slack'; by: string; at: string }

export async function listTodoFiles(sql: SqlFn, todoId: string): Promise<TodoFile[]> {
  const rows = await sql`SELECT id::text, name, url, mime, source, by_name, created_at FROM todo_files
                          WHERE account_id = 1 AND todo_id = ${Number(todoId) || 0} ORDER BY id` as
    { id: string; name: string; url: string; mime: string | null; source: 'app' | 'slack'; by_name: string; created_at: string }[];
  return rows.map(r => ({ id: r.id, name: r.name, url: r.url, mime: r.mime, source: r.source, by: r.by_name, at: new Date(r.created_at).toISOString() }));
}

/** Files into the field-reports folder in Drive (made the first time); their names and links. */
export async function toDrive(sql: SqlFn, key: string, label: string, files: InFile[]): Promise<{ name: string; url: string; type: string }[]> {
  const token = await driveToken(sql, key);
  const [acc] = await sql`SELECT field_reports_folder FROM accounts WHERE id = 1` as { field_reports_folder: string | null }[];
  let folder = acc?.field_reports_folder ?? null;
  if (!folder) {
    folder = (await createFolder(token, null, 'Kaizen — field reports')).id;
    await sql`UPDATE accounts SET field_reports_folder = ${folder} WHERE id = 1`;
  }
  const out: { name: string; url: string; type: string }[] = [];
  for (const f of files) {
    const name = (f.name || 'file').slice(0, 120);
    const up = await uploadFile(token, folder, `${todayIn('America/New_York')} ${label} — ${name}`.slice(0, 200), f.type || 'application/octet-stream', f.data);
    out.push({ name, url: up.webViewLink ?? `https://drive.google.com/file/d/${up.id}/view`, type: f.type });
  }
  return out;
}

/** Uploads them to Drive and lists them on the to-do; one activity line names them. Returns the names saved. */
export async function attachTodoFiles(sql: SqlFn, key: string, todoId: string, files: InFile[], by: string, source: 'app' | 'slack'): Promise<string[]> {
  if (!files.length) return [];
  if (files.length > MAX_FILES) throw new DriveError(`At most ${MAX_FILES} files at a time.`);
  for (const f of files) if (f.data.byteLength > MAX_FILE_BYTES) throw new DriveError(`${f.name} is over 15 MB.`);
  const [t] = await sql`SELECT id::text FROM todos WHERE account_id = 1 AND id = ${Number(todoId) || 0} AND deleted_at IS NULL` as { id: string }[];
  if (!t) throw new Error('That to-do is gone.');
  const names: string[] = [];
  for (const u of await toDrive(sql, key, `to-do #${t.id}`, files)) {
    await sql`INSERT INTO todo_files (account_id, todo_id, name, url, mime, source, by_name)
              VALUES (1, ${Number(t.id)}, ${u.name}, ${u.url}, ${u.type || null}, ${source}, ${by})`;
    names.push(u.name);
  }
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'task', ${t.id}, 'change', ${`📎 ${names.length === 1 ? 'File' : `${names.length} files`} added${source === 'slack' ? ' from Slack' : ''}: ${names.join(', ')}`}, ${by})`;
  return names;
}

/** Slack's files on a message, downloaded with the bot's token (files:read). Over the limits: left out. */
export async function slackFiles(token: string, files: unknown): Promise<InFile[]> {
  const list = (Array.isArray(files) ? files : []) as { name?: string; title?: string; mimetype?: string; size?: number; url_private_download?: string; url_private?: string; mode?: string }[];
  const out: InFile[] = [];
  for (const f of list.slice(0, MAX_FILES)) {
    const url = f.url_private_download ?? f.url_private;
    if (!url || f.mode === 'tombstone' || (f.size ?? 0) > MAX_FILE_BYTES) continue;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    // Without files:read Slack answers with its sign-in page, not the file.
    if (!r.ok || (r.headers.get('Content-Type') ?? '').startsWith('text/html')) continue;
    out.push({ name: f.name ?? f.title ?? 'file', type: f.mimetype ?? r.headers.get('Content-Type') ?? 'application/octet-stream', data: await r.arrayBuffer() });
  }
  return out;
}

/** The files of one Slack message (a thread's first message or a reply), read back when only its ts is known. */
export async function slackMessageFiles(token: string, channel: string, ts: string): Promise<unknown[]> {
  const q = new URLSearchParams({ channel, ts, limit: '1', inclusive: 'true' });
  const r = await fetch(`https://slack.com/api/conversations.replies?${q}`, { headers: { Authorization: `Bearer ${token}` } })
    .then(x => x.json() as Promise<{ ok: boolean; messages?: { ts: string; files?: unknown[] }[] }>).catch(() => ({ ok: false } as { ok: boolean; messages?: { ts: string; files?: unknown[] }[] }));
  return (r.messages ?? []).find(m => m.ts === ts)?.files ?? [];
}
