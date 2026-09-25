/**
 * POST /api/turnover — a person's decision about one stay.
 *
 *   { resId, set: { assignment, cleaner, deep, checkoutTime, checkinTime } }
 *   { resId, note: { kind: 'checkin' | 'checkout', text }, unit, guest, checkIn }
 *
 * `set` fields that are present are applied; `null` hands that field
 * back to the rule. When nothing is left overriding the rule, the row is
 * removed rather than kept as a row of nulls.
 *
 * Notes are APPENDED, never edited: the current note is the latest row,
 * and the history is the point (the Notes Log was append-only for the
 * same reason).
 *
 * In live mode the reservation's Host Note is pushed after the response
 * is sent — the person editing does not wait on Hostaway, and the push
 * still leaves its row in host_note_pushes either way.
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { loadOps, opsConfig, pushHostNotes, recordCleanings } from '../_lib/ops.ts';

const TIME = /^(1[0-2]|0?[1-9]):[0-5]\d\s?(AM|PM)$/i;
const ASSIGNMENTS = new Set(['assigned', 'tbd', 'not_needed']);

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => ({})) as Record<string, any>;
  const resId = String(body.resId ?? '').trim();
  if (!/^\d{1,20}$/.test(resId)) return bad('Which reservation?');

  const cfg = await opsConfig(sql);

  if (body.set && typeof body.set === 'object') {
    const set = body.set as Record<string, unknown>;
    const cur = (await sql`SELECT assignment, cleaner, deep, checkout_time, checkin_time
                             FROM turnover_overrides WHERE account_id = 1 AND reservation_id = ${resId}`)[0] ??
      { assignment: null, cleaner: null, deep: null, checkout_time: null, checkin_time: null };
    const next = { ...cur } as Record<string, unknown>;

    if ('assignment' in set) {
      const a = set.assignment;
      if (a !== null && !ASSIGNMENTS.has(String(a))) return bad('Unknown assignment.');
      if (a === 'assigned') {
        const name = String(set.cleaner ?? '');
        // Only someone on the roster, and active. A name typed freely is
        // how a clean ends up assigned to a person who no longer works here.
        if (!cfg.roster.some(c => c.active && c.name === name)) return bad(`"${name}" is not on the active roster.`);
        next.assignment = 'assigned'; next.cleaner = name;
      } else {
        next.assignment = a; next.cleaner = null;
      }
    }
    if ('deep' in set) {
      if (set.deep !== null && typeof set.deep !== 'boolean') return bad('Deep is yes, no, or back to the rule.');
      next.deep = set.deep;
    }
    for (const [field, col] of [['checkoutTime', 'checkout_time'], ['checkinTime', 'checkin_time']] as const) {
      if (!(field in set)) continue;
      const v = set[field] === null || set[field] === '' ? null : String(set[field]).trim().toUpperCase();
      if (v !== null && !TIME.test(v)) return bad('Times look like 10:00 AM.');
      next[col] = v;
    }

    const empty = ['assignment', 'deep', 'checkout_time', 'checkin_time'].every(k => next[k] === null);
    if (empty) {
      await sql`DELETE FROM turnover_overrides WHERE account_id = 1 AND reservation_id = ${resId}`;
    } else {
      await sql`
        INSERT INTO turnover_overrides (account_id, reservation_id, assignment, cleaner, deep,
                                        checkout_time, checkin_time, updated_by)
        VALUES (1, ${resId}, ${next.assignment as string | null}, ${next.cleaner as string | null},
                ${next.deep as boolean | null}, ${next.checkout_time as string | null},
                ${next.checkin_time as string | null}, ${who.email})
        ON CONFLICT (account_id, reservation_id) DO UPDATE SET
          assignment = EXCLUDED.assignment, cleaner = EXCLUDED.cleaner, deep = EXCLUDED.deep,
          checkout_time = EXCLUDED.checkout_time, checkin_time = EXCLUDED.checkin_time,
          updated_by = EXCLUDED.updated_by, updated_at = now()`;
    }
  }

  if (body.note && typeof body.note === 'object') {
    const kind = body.note.kind === 'checkin' ? 'checkin' : body.note.kind === 'checkout' ? 'checkout' : null;
    if (!kind) return bad('A note is about the check-in or the check-out.');
    const text = String(body.note.text ?? '').slice(0, 2000).trim();
    const latest = (await sql`SELECT notes FROM stay_notes WHERE account_id = 1
                                AND reservation_id = ${resId} AND kind = ${kind}
                              ORDER BY id DESC LIMIT 1`)[0] as { notes: string } | undefined;
    // Only a CHANGE is a row. Saving the same words twice is not history.
    if ((latest?.notes ?? '') !== text) {
      await sql`INSERT INTO stay_notes (account_id, reservation_id, kind, unit_id, unit_name, guest,
                                        check_in, notes, created_by)
                VALUES (1, ${resId}, ${kind}, ${body.unitId ?? null}, ${body.unit ?? null},
                        ${body.guest ?? null}, ${/^\d{4}-\d{2}-\d{2}$/.test(String(body.checkIn)) ? body.checkIn : null},
                        ${text}, ${who.email})`;
    }
  }

  let push: 'queued' | 'shadow' | 'archived' = 'shadow';
  if (cfg.mode === 'live') {
    push = 'queued';
    waitUntil((async () => {
      try {
        const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
        const s = await loadOps(sql, creds);
        // The record follows the edit at once — not whenever someone next
        // opens the board — so a cleaner changed at 9am is who gets paid.
        await recordCleanings(sql, s);
        await pushHostNotes(sql, creds, s, [resId]);
      } catch { /* the scheduled pass retries whatever did not land */ }
    })());
  }

  return Response.json({ ok: true, push });
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
