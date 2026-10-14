/**
 * POST /api/turnover — a person's decision about one stay.
 *
 *   { resId, set: { assignment, cleaner, deep, checkoutTime, checkinTime } }
 *   { resId, note: { kind: 'checkin' | 'checkout', text }, unit, guest, checkIn }
 *   { resId, resendTime: 'checkin' | 'checkout' }
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
 *
 * A changed check-in / check-out time is written on the Hostaway
 * reservation the same way, after the response (early check-in / late
 * check-out is what the guest sees); cleared → the listing's standard
 * hour. Whole hours only: Hostaway keeps no minutes.
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { loadOps, opsConfig, pushHostNotes, recordCleanings } from '../_lib/ops.ts';
import { pushStayTimes, type TimeCheck } from '../_lib/stay-times.ts';
import type { StayEnd } from '../../src/lib/stay-time.ts';

// Whole hours: the time goes to the Hostaway reservation, which keeps no minutes.
const TIME = /^(1[0-2]|0?[1-9]):00\s?(AM|PM)$/i;
const ASSIGNMENTS = new Set(['assigned', 'tbd', 'not_needed']);

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const body = await request.json().catch(() => ({})) as Record<string, any>;
  const resId = String(body.resId ?? '').trim();
  if (!/^\d{1,20}$/.test(resId)) return bad('Which reservation?');

  const cfg = await opsConfig(sql);
  const times: Partial<Record<StayEnd, string | null>> = {};

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
      if (v !== null && !TIME.test(v)) return bad('Whole hours only, like 10:00 AM — Hostaway keeps the hour, not minutes.');
      // Always sent: Kaizen's copy is cleared once Hostaway has it, so "unchanged here" says nothing about Hostaway.
      times[col === 'checkout_time' ? 'checkout' : 'checkin'] = v;
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

  // ⚠ on the board → "Send again": the time Kaizen holds now, unchanged.
  if (body.resendTime === 'checkin' || body.resendTime === 'checkout') {
    const k = body.resendTime as StayEnd;
    const row = (await sql`SELECT checkout_time, checkin_time FROM turnover_overrides
                            WHERE account_id = 1 AND reservation_id = ${resId}`)[0];
    times[k] = (k === 'checkout' ? row?.checkout_time : row?.checkin_time) ?? null;
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

  // §156: the board's pop-up — who the change was checked with, the cleaner to remind, the night to close.
  const tc = body.timeCheck && typeof body.timeCheck === 'object' ? body.timeCheck as Record<string, unknown> : null;
  const check: TimeCheck | null = tc && Object.keys(times).length ? {
    checkedWith: String(tc.checkedWith ?? '').slice(0, 80).trim() || who.email,
    cleaner: cfg.roster.some(c => c.name === tc.cleaner) ? String(tc.cleaner) : null,
    blockNight: /^\d{4}-\d{2}-\d{2}$/.test(String(tc.blockNight)) ? String(tc.blockNight) : null
  } : null;

  let push: 'queued' | 'shadow' | 'archived' = 'shadow';
  const timeQueued = cfg.mode === 'live' && Object.keys(times).length > 0;
  if (cfg.mode === 'live') {
    push = 'queued';
    waitUntil((async () => {
      try {
        const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
        // First, and on its own: the guest's time does not wait on the board rebuild.
        if (timeQueued) await pushStayTimes(sql, creds, env.ENCRYPTION_KEY, resId, times, who.email, check).catch(() => {});
        const s = await loadOps(sql, creds);
        // The record follows the edit at once — not whenever someone next
        // opens the board — so a cleaner changed at 9am is who gets paid.
        await recordCleanings(sql, s);
        await pushHostNotes(sql, creds, s, [resId]);
      } catch { /* the scheduled pass retries whatever did not land */ }
    })());
  }

  return Response.json({ ok: true, push, time: timeQueued ? 'queued' : null });
};

function bad(message: string): Response {
  return Response.json({ ok: false, error: 'bad_request', message }, { status: 400 });
}
