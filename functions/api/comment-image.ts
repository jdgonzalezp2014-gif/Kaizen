/**
 * /api/comment-image?id=<Drive file id> — a photo posted with a comment (§162), read from the team's Drive
 * with Kaizen's token so it shows inside the comment whoever looks (Drive itself would ask each viewer to
 * sign in). Only a file a comment, a handyman's job photo or a receipt names — never any Drive id someone types.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { driveToken } from '../_lib/gdrive.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^[\w-]{10,200}$/.test(id)) return new Response('Which photo?', { status: 400 });
  const sql = db(env) as unknown as SqlFn;
  // Owner, 2026-10-28: also a handyman's photo before/after, or the receipt of a field charge or a purchase — audited from
  // the task, Handymen and Costs.
  const [named] = await sql`SELECT 1 AS ok FROM work_updates WHERE account_id = 1 AND kind = 'note'
                              AND body LIKE ${`%📷 %/file/d/${id}/%`}
                            UNION ALL SELECT 1 FROM work_photos WHERE account_id = 1 AND url LIKE ${`%/d/${id}/%`}
                            UNION ALL SELECT 1 FROM field_expenses WHERE account_id = 1 AND photos::text LIKE ${`%/d/${id}/%`}
                            UNION ALL SELECT 1 FROM inventory_purchases WHERE account_id = 1 AND photos::text LIKE ${`%/d/${id}/%`}
                            LIMIT 1` as { ok: number }[];
  if (!named) return new Response('No such photo.', { status: 404 });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${await driveToken(sql, env.ENCRYPTION_KEY)}` } });
  if (!res.ok) return new Response(`Drive said ${res.status}.`, { status: 502 });
  const type = res.headers.get('Content-Type') ?? '';
  if (!type.startsWith('image/')) return new Response('Not a photo.', { status: 415 });
  return new Response(res.body, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' } });
};
