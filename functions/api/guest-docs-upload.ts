/**
 * POST /api/guest-docs-upload — one file into a reservation's ID or
 * Rental Agreement folder (§73). multipart/form-data: resId, kind, file.
 *
 * The folder is found — or made — from Hostaway's own record of the stay
 * (its arrival and the guest's name), not from what the browser says, so
 * a file can only land in the folder the daily file would have used.
 * The file keeps its name, as it did there. `guests.documents`; audited.
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { DriveError, driveToken, uploadFile } from '../_lib/gdrive.ts';
import { docFolderFor, docNameOf, docsStatus, type DocKind } from '../_lib/guest-docs.ts';
import { fetchReservationDetail } from '../_lib/hostaway.ts';
import { audit } from '../_lib/repo-store.ts';

const MAX_BYTES = 50 * 1024 * 1024;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;

  const form = await request.formData().catch(() => null);
  const resId = String(form?.get('resId') ?? '');
  const kind = String(form?.get('kind') ?? '') as DocKind;
  const file = form?.get('file');
  if (!/^\d{1,20}$/.test(resId) || !['id', 'agreement'].includes(kind)) return fail(400, 'Which reservation, and ID or agreement?');
  if (!file || typeof file === 'string') return fail(400, 'No file.');
  if (file.size > MAX_BYTES) return fail(413, `${file.name} is over 50 MB.`);

  try {
    const d = await fetchReservationDetail(await getCredentials(sql, env.ENCRYPTION_KEY), resId);
    const arrival = String(d?.arrivalDate ?? '');
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(arrival)) return fail(502, 'Hostaway did not return that reservation.');
    const name = docNameOf(d);
    const token = await driveToken(sql, env.ENCRYPTION_KEY);
    const folder = await docFolderFor(sql, token, arrival, name, kind);
    const f = await uploadFile(token, folder, file.name.slice(0, 200) || `${kind}-upload`, file.type || 'application/octet-stream',
                               await file.arrayBuffer());
    await audit(sql, who.email, `guest.${kind}.upload`, 'guest_docs', resId, `${name} · ${arrival} · ${f.name}`);
    const docs = (await docsStatus(sql, token, [{ resId, arrival, name }]))[resId];
    return Response.json({ ok: true, docs });
  } catch (e) {
    return fail(e instanceof DriveError ? 502 : 500, e instanceof Error ? e.message : String(e));
  }
};

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, message }, { status });
}
