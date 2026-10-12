/**
 * An inspection walked from a link, no account (§135) — the inspector's side
 * of the same field door the cleaners' helpers use (§134): /report#i=<token>,
 * answered by /api/report-link when the request carries `X-Inspect-Token`
 * (that path already sits behind the Access bypass, so no new door is opened).
 *
 * The link is for ONE inspection: its unit, day and checklist are fixed by
 * the link, never sent by the page. The inspector answers room by room (each
 * tap saved, through the same inspection-run lib the team uses), a problem
 * needs a photo, and at the end SENDS. Sending makes no work: the team
 * reviews and finishes in Kaizen, where findings become work orders, the
 * shopping list and clean tasks. Refused once the link expires (the day after
 * the inspection), the inspection is finished, or it was cancelled.
 *
 *   GET                                                   the inspection, its checklist, what is answered, the language
 *   POST { action: check, reporter, itemId, n, result?, outcome?, note? } | { …, checkId }
 *   POST { action: allOk, reporter, area, n }             the unanswered items of a room → OK
 *   POST { action: add, reporter, kind: repair|purchase|clean, label, area, n, note? }
 *   POST { action: remove, reporter, checkId }            an on-the-spot finding only
 *   POST { action: send, reporter }                       every item answered, every finding with a photo
 *   POST { action: reopen, reporter }                     sent → open again (until the team finishes)
 *   POST multipart: reporter, checkId, file…              photos onto one finding, to Drive
 */
import type { SqlFn } from './accounts.ts';
import { decrypt, encrypt } from './crypto.ts';
import { newToken, sha256 } from './crew.ts';
import { addFinding, addPhotos, allOk, loadRun, removeFinding, saveCheck } from './inspection-run.ts';
import { addDays, todayIn } from '../../src/lib/dates.ts';
import { progress, readyToFinish } from '../../src/lib/inspection.ts';

const TZ = 'America/New_York';

interface LinkRow { id: string; unit_name: string; date: string; expires: string; result: string | null; sent_at: string | null }

/** The team's side: the link for one scheduled inspection — the same one again while it lasts. */
export async function linkFor(sql: SqlFn, encryptionKey: string, inspectionId: string, origin: string) {
  const [ins] = await sql`SELECT id::text, unit_name, inspected_on::text AS date, result, link_token_enc, link_expires_on::text AS expires
                            FROM inspections WHERE account_id = 1 AND id = ${Number(inspectionId)}` as
    { id: string; unit_name: string; date: string; result: string | null; link_token_enc: string | null; expires: string | null }[];
  if (!ins) throw new Error('That inspection is gone.');
  if (ins.result) throw new Error('This inspection is finished — it is part of the record now.');
  const today = todayIn(TZ);
  // The day after the inspection; a late one (scheduled in the past, not done) gets until tomorrow.
  const expires = addDays(ins.date > today ? ins.date : today, 1);
  let token = ins.link_token_enc && ins.expires && ins.expires >= today
    ? await decrypt(ins.link_token_enc, encryptionKey).catch(() => null) : null;
  if (!token) {
    token = newToken();
    await sql`UPDATE inspections SET link_token_enc = ${await encrypt(token, encryptionKey)}, link_token_hash = ${await sha256(token)},
                     link_expires_on = ${expires}, updated_at = now()
               WHERE account_id = 1 AND id = ${Number(ins.id)}`;
  } else if (ins.expires !== expires) {
    // Moved to another day: the same link follows it.
    await sql`UPDATE inspections SET link_expires_on = ${expires} WHERE account_id = 1 AND id = ${Number(ins.id)}`;
  }
  return { link: `${origin}/report#i=${token}`, unit: ins.unit_name, date: ins.date, expires };
}

const gone = (ended = false) => Response.json({ ok: false, error: 'bad_link', message: ended
  ? 'This inspection is finished or closed, so this link no longer works. / Esta inspección terminó o se cerró, así que este enlace ya no sirve.'
  : 'This link is not valid — ask for it again. / Este enlace no es válido — pídelo de nuevo.' }, { status: 403 });
const bad = (message: string) => Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });

async function linkOf(sql: SqlFn, request: Request): Promise<LinkRow | Response> {
  const token = request.headers.get('X-Inspect-Token') ?? '';
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return gone();
  const [l] = await sql`SELECT id::text, unit_name, inspected_on::text AS date, link_expires_on::text AS expires, result, sent_at
                          FROM inspections WHERE account_id = 1 AND link_token_hash = ${await sha256(token)}` as LinkRow[];
  if (!l) return gone();
  if (l.result || !l.expires || l.expires < todayIn(TZ)) return gone(true);
  return l;
}

/** What the page shows: the run as the team's pop-up loads it, the language, and whether it was sent. */
async function page(sql: SqlFn, l: LinkRow) {
  const run = await loadRun(sql, l.id);
  if (!run) return null;
  const [s] = await sql`SELECT sent_at::text, sent_by FROM inspections WHERE account_id = 1 AND id = ${Number(l.id)}` as
    { sent_at: string | null; sent_by: string | null }[];
  // An inspector who is on the roster reads it in their language; anyone else in English (the page has a switch).
  const [c] = run.inspection.inspector
    ? await sql`SELECT lang FROM cleaners WHERE account_id = 1 AND name = ${run.inspection.inspector}` as { lang: string | null }[] : [];
  return {
    inspection: { unit: run.inspection.unit, date: run.inspection.date, inspector: run.inspection.inspector, until: l.expires },
    sections: run.sections, checks: run.checks.map(({ todoId: _t, cleanTaskId: _c, ...x }) => x),
    lang: c?.lang === 'es' ? 'es' : 'en',
    sent: s?.sent_at ? { at: s.sent_at, by: s.sent_by ?? '' } : null
  };
}

export async function inspectGet(sql: SqlFn, request: Request): Promise<Response> {
  const l = await linkOf(sql, request);
  if (l instanceof Response) return l;
  const p = await page(sql, l);
  if (!p) return gone(true);
  return Response.json({ ok: true, ...p }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function inspectPost(sql: SqlFn, encryptionKey: string, request: Request): Promise<Response> {
  const l = await linkOf(sql, request);
  if (l instanceof Response) return l;
  try {
    let b: Record<string, unknown> = {};
    const files: File[] = [];
    if ((request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
      const form = await request.formData();
      for (const [k, v] of form.entries()) { if (k === 'file') { if (typeof v !== 'string') files.push(v); } else b[k] = v; }
      b.action = 'photo';
    } else b = await request.json().catch(() => ({})) as Record<string, unknown>;
    const reporter = String(b.reporter ?? '').trim().slice(0, 60);
    if (!reporter) return bad('Your name, please. / Escribe tu nombre.');
    const who = `link: ${reporter}`;
    // The inspection is the link's, whatever the page sent.
    const body = { ...b, inspectionId: l.id };

    if (b.action === 'reopen') {
      await sql`UPDATE inspections SET sent_at = NULL, sent_by = NULL, updated_at = now() WHERE account_id = 1 AND id = ${Number(l.id)}`;
      return Response.json({ ok: true, ...(await page(sql, l)) });
    }
    // Sent is sent: the team may be reviewing it. Reopen first.
    if (l.sent_at) return bad('This inspection was sent — reopen it to change something. / Esta inspección ya se envió — reábrela para cambiar algo.');
    await sql`UPDATE inspections SET started_at = COALESCE(started_at, now()) WHERE account_id = 1 AND id = ${Number(l.id)}`;

    let extra: Record<string, unknown> = {};
    switch (b.action) {
      case 'check': extra = { checkId: await saveCheck(sql, who, body) }; break;
      case 'allOk': await allOk(sql, who, body); break;
      case 'add': extra = { checkId: await addFinding(sql, who, body) }; break;
      case 'remove': await removeFinding(sql, body); break;
      case 'photo': await addPhotos(sql, encryptionKey, who, l.id, String(b.checkId ?? ''), files); break;
      case 'send': {
        const run = await loadRun(sql, l.id);
        if (!run) return gone(true);
        const p = progress(run.sections, run.checks);
        if (p.done < p.total) throw new Error(`${p.total - p.done} item${p.total - p.done === 1 ? ' is' : 's are'} not answered yet.`);
        const ready = readyToFinish(run.checks);
        if (ready.missingPhoto.length) throw new Error(`${ready.missingPhoto.length} problem${ready.missingPhoto.length === 1 ? ' needs' : 's need'} a photo first.`);
        await sql`UPDATE inspections SET sent_at = now(), sent_by = ${reporter}, updated_at = now() WHERE account_id = 1 AND id = ${Number(l.id)}`;
        break;
      }
      default: return bad('Unknown action.');
    }
    return Response.json({ ok: true, ...extra, ...(await page(sql, l)) });
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  }
}
