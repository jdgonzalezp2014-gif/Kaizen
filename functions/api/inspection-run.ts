/**
 * /api/inspection-run — an inspection, walked on a phone (§133).
 *
 *   GET  ?id=<inspection>                     the unit's checklist, what is answered, its next clean
 *   POST { action: 'start', inspectionId? | unitId, date?, inspector? }
 *   POST { action: 'check', inspectionId, itemId, n, result?, note?, outcome? } | { …, checkId }
 *   POST { action: 'allOk', inspectionId, area, n }        the unanswered items of a room → OK
 *   POST { action: 'add', inspectionId, kind: clean|repair|purchase, label, note?, area?, n? }
 *   POST { action: 'remove', inspectionId, checkId }       an on-the-spot finding only
 *   POST { action: 'finish', inspectionId, result?, notes?, cleanDate? }
 *   POST { action: 'link', inspectionId }                  the inspector's link, no account (§135)
 *   POST multipart: inspectionId, checkId, file…           photos, to Drive
 *
 * GET with `operations`; POST with `operations.edit` (roles.ts). Every answer
 * is saved as it is given; finishing turns findings into work (inspection-run lib).
 */
import { db, type Env } from '../_lib/db.ts';
import type { SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { linkFor } from '../_lib/inspect-link.ts';
import { addFinding, addPhotos, allOk, checkSupply, finishRun, loadRun, pushMade, removeFinding, saveCheck, startRun } from '../_lib/inspection-run.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^\d+$/.test(id)) return bad('Which inspection?');
  const run = await loadRun(sql, id);
  if (!run) return Response.json({ ok: false, error: 'not_found', message: 'That inspection is gone.' }, { status: 404 });
  return Response.json({ ok: true, ...run }, { headers: { 'Cache-Control': 'no-store' } });
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  try {
    if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
      const form = await request.formData();
      const files = form.getAll('file').filter((f): f is File => typeof f !== 'string');
      const photos = await addPhotos(sql, env.ENCRYPTION_KEY, who.email, String(form.get('inspectionId') ?? ''), String(form.get('checkId') ?? ''), files);
      return Response.json({ ok: true, photos });
    }
    const b = await request.json().catch(() => ({})) as Record<string, unknown>;
    switch (b.action) {
      case 'start': return Response.json({ ok: true, id: await startRun(sql, who.email, b) });
      case 'check': return Response.json({ ok: true, checkId: await saveCheck(sql, who.email, b) });
      case 'allOk': return Response.json({ ok: true, added: await allOk(sql, who.email, b) });
      case 'add': return Response.json({ ok: true, checkId: await addFinding(sql, who.email, b) });
      case 'supply': await checkSupply(sql, who.email, b); return Response.json({ ok: true });
      case 'remove': await removeFinding(sql, b); return Response.json({ ok: true });
      case 'link': return Response.json({ ok: true, ...(await linkFor(sql, env.ENCRYPTION_KEY, String(b.inspectionId ?? ''), new URL(request.url).origin)) });
      case 'finish': {
        const r = await finishRun(sql, who.email, b);
        waitUntil(pushMade(sql, env.ENCRYPTION_KEY, r.toPush));
        return Response.json({ ok: true, result: r.result, made: r.made });
      }
      default: return bad('Unknown action.');
    }
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
