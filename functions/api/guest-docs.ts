/**
 * POST /api/guest-docs — guest documents (§73), `guests.documents`.
 *
 *   { action: 'status', stays: [{ resId, arrival, name }] }
 *       what each stay has filed, read from Drive now — the board's column
 *   { action: 'agreement', resId }
 *       asks Hostaway about the signed agreement, and files the PDF into
 *       the reservation's folder when Hostaway has it and the folder is
 *       empty — what the daily file did on every refresh
 *
 * Uploads are multipart: /api/guest-docs-upload.
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { DriveError, driveToken, uploadFile } from '../_lib/gdrive.ts';
import { docFolderFor, docNameOf, docsStatus, slug } from '../_lib/guest-docs.ts';
import { downloadAgreement, fetchReservationDetail } from '../_lib/hostaway.ts';
import { audit } from '../_lib/repo-store.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RES = /^\d{1,20}$/;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, any>;

  try {
    if (b.action === 'status') {
      const stays = (Array.isArray(b.stays) ? b.stays : []).slice(0, 300)
        .map((s: any) => ({ resId: String(s?.resId ?? ''), arrival: String(s?.arrival ?? ''), name: String(s?.name ?? '').slice(0, 200) }))
        .filter((s: { resId: string; arrival: string; name: string }) => RES.test(s.resId) && DAY.test(s.arrival) && s.name);
      if (!stays.length) return Response.json({ ok: true, docs: {} });
      const token = await driveToken(sql, env.ENCRYPTION_KEY);
      return Response.json({ ok: true, docs: await docsStatus(sql, token, stays) }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (b.action === 'agreement') {
      const resId = String(b.resId ?? '');
      if (!RES.test(resId)) return fail(400, 'Which reservation?');
      const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
      const d = await fetchReservationDetail(creds, resId);
      if (!d) return fail(502, 'Hostaway did not return that reservation.');
      const arrival = String(d.arrivalDate ?? '');
      if (!DAY.test(arrival)) return fail(502, 'Hostaway gave no arrival date for it.');
      const name = docNameOf(d);
      const signed = String(d.reservationAgreement ?? '').trim().toLowerCase() === 'signed';
      const pdf = String(d.rentalAgreementFileUrl ?? '').trim();
      const available = /^https?:\/\//i.test(pdf);

      const token = await driveToken(sql, env.ENCRYPTION_KEY);
      let docs = (await docsStatus(sql, token, [{ resId, arrival, name }]))[resId]!;
      let pulled = false;
      // Once filed, never downloaded again — a refresh must not stack copies.
      if (available && !docs.agreement.length) {
        const file = await downloadAgreement(creds, pdf);
        const ext = file.mimeType === 'application/pdf' ? 'pdf' : (file.mimeType.split('/')[1] ?? 'bin');
        const folder = await docFolderFor(sql, token, arrival, name, 'agreement');
        await uploadFile(token, folder, `${slug(String(d.listingName ?? 'unit'))}-agreement-1.${ext}`, file.mimeType, file.bytes);
        await audit(sql, who.email, 'guest.agreement.pulled', 'guest_docs', resId, `${name} · ${arrival}`);
        docs = (await docsStatus(sql, token, [{ resId, arrival, name }]))[resId]!;
        pulled = true;
      }
      return Response.json({ ok: true, signed, available, pulled, docs }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return fail(400, 'Unknown action.');
  } catch (e) {
    return fail(e instanceof DriveError ? 502 : 500, e instanceof Error ? e.message : String(e));
  }
};

function fail(status: number, message: string): Response {
  return Response.json({ ok: false, message }, { status });
}
