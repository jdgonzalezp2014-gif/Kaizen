/**
 * /api/checkin-photo (Check-in builder, 2026-11-09) — the photos of a unit's arrival steps.
 *   GET ?id=<Drive file id>  → the image, read with Kaizen's Drive token (Drive would ask each viewer to sign in).
 *                              Only an id some checkin_guides step names — never any Drive id someone types.
 *   POST multipart { unit, file } → into the record's "Check-in photos" folder in Drive; answers { ok, id }.
 *                              The step keeps the id when the builder saves.
 * GET = permission `repository` (the staff demo today; the guest's signed link will serve the same way), POST = `repository.edit`.
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { driveToken, uploadFile } from '../_lib/gdrive.ts';
import { audit, checkinPhotoFolder } from '../_lib/repo-store.ts';
import { repoMatch, type RepoRow } from '../../src/lib/unit-access.ts';
import { UNIT_TABLES } from '../../src/lib/repo-checks.ts';
import { isPhotoId } from '../../src/lib/checkin.ts';

const MAX_BYTES = 8 * 1024 * 1024;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!identify(request, env)) return unauthorised();
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!isPhotoId(id)) return new Response('Which photo?', { status: 400 });
  const sql = db(env) as unknown as SqlFn;
  const [named] = await sql`SELECT 1 AS ok FROM checkin_guides g, jsonb_array_elements(g.steps) s
                             WHERE g.account_id = 1 AND s->'photos' ? ${id} LIMIT 1` as { ok: number }[];
  if (!named) return new Response('No such photo.', { status: 404 });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${await driveToken(sql, env.ENCRYPTION_KEY)}` } });
  if (!res.ok) return new Response(`Drive said ${res.status}.`, { status: 502 });
  const type = res.headers.get('Content-Type') ?? '';
  if (!type.startsWith('image/')) return new Response('Not a photo.', { status: 415 });
  return new Response(res.body, { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const form = await request.formData().catch(() => null);
  const unit = String(form?.get('unit') ?? '');
  const file = form?.get('file');
  if (!(file instanceof File) || !file.type.startsWith('image/')) return Response.json({ ok: false, message: 'Pick a photo.' }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ ok: false, message: 'Photo over 8 MB.' }, { status: 400 });
  const [u] = await sql`SELECT name FROM units WHERE account_id = 1 AND id::text = ${unit}` as { name: string }[];
  if (!u) return Response.json({ ok: false, message: 'Pick a unit.' }, { status: 400 });
  const recs = await sql`SELECT table_key AS "table", id, vals FROM repo_records
                          WHERE account_id = 1 AND table_key = ANY(${UNIT_TABLES}) AND archived_at IS NULL` as RepoRow[];
  const rec = repoMatch(u.name, recs);
  if (!rec) return Response.json({ ok: false, message: `${u.name} has no Repository record to keep its photos.` }, { status: 400 });
  try {
    const token = await driveToken(sql, env.ENCRYPTION_KEY);
    const folder = await checkinPhotoFolder(sql, token, rec.table, String(rec.id));
    const f = await uploadFile(token, folder, file.name || 'photo.jpg', file.type, await file.arrayBuffer());
    await audit(sql, who.email, 'checkin.photo', rec.table, String(rec.id), `${u.name}: ${f.name}`);
    return Response.json({ ok: true, id: f.id });
  } catch (e) {
    return Response.json({ ok: false, message: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
};
