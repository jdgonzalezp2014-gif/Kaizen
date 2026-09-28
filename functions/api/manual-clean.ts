/**
 * /api/manual-clean — the cleans no checkout schedules (§79), `operations.edit`.
 *
 *   GET  ?unitId=…&date=YYYY-MM-DD      the stays in that unit on that day (Hostaway, now)
 *   POST { action: 'create', unitId, date, kind, reservationId?, cleaner?, deep?, note? }
 *        kind: 'early_departure' | 'mid_stay' | 'extra'
 *   POST { action: 'cancel', key }
 *
 * A manual clean is a row in the cleanings record (key MAN-<n>), paid like
 * any other at the cleaner's rate for the unit's size.
 *
 * EARLY DEPARTURE: the guest left before their checkout, the unit is
 * cleaned now — so the clean their checkout would schedule later must not
 * happen. That stay's checkout is set to "no clean needed" as a person's
 * decision (turnover_overrides, like any change on the board), and the
 * record says why. Cancelling the manual clean hands that checkout back to
 * the rule.
 */
import { db, type Env } from '../_lib/db.ts';
import { getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { fetchReservationsTouching, fetchReservationDetail } from '../_lib/hostaway.ts';
import { loadOps, opsConfig, pushHostNotes, recordCleanings } from '../_lib/ops.ts';
import { rateFor } from '../../src/lib/operations.ts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set(['early_departure', 'mid_stay', 'extra']);
const KIND_WORD: Record<string, string> = { early_departure: 'guest left early', mid_stay: 'mid-stay clean', extra: 'extra clean' };

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const url = new URL(request.url);
  const unitId = url.searchParams.get('unitId') ?? '';
  const date = url.searchParams.get('date') ?? '';
  if (!/^\d{1,20}$/.test(unitId) || !DAY.test(date)) return bad('Which unit and day?');
  try {
    const stays = (await fetchReservationsTouching(await getCredentials(sql, env.ENCRYPTION_KEY), date, date))
      .filter(r => r.listingId === unitId && r.arrival <= date && r.departure >= date)
      .map(r => ({ resId: r.reservationId, guest: r.guestName ?? '', arrival: r.arrival, departure: r.departure, channel: r.channel }));
    return Response.json({ ok: true, stays }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ ok: false, message: `Hostaway: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env) as unknown as SqlFn;
  const b = await request.json().catch(() => ({})) as Record<string, any>;
  const cfg = await opsConfig(sql);

  if (b.action === 'cancel') {
    const key = String(b.key ?? '');
    if (!/^MAN-\d+$/.test(key)) return bad('Which manual clean?');
    const row = (await sql`SELECT kind, for_reservation, checkout_on::text AS day, unit_id, unit_name, guest FROM cleanings
                            WHERE account_id = 1 AND key = ${key} AND void_reason IS NULL`)[0] as
      { kind: string; for_reservation: string | null; day: string; unit_id: string | null; unit_name: string; guest: string | null } | undefined;
    if (!row) return bad('That clean is already cancelled, or gone.');
    await sql`UPDATE cleanings SET void_reason = ${`cancelled by ${who.email}`}, imported_at = now()
               WHERE account_id = 1 AND key = ${key}`;
    let restored = false;
    if (row.kind === 'early_departure' && row.for_reservation) {
      // The checkout clean comes back to the rule — unless someone set it otherwise since.
      const o = await sql`UPDATE turnover_overrides SET assignment = NULL, cleaner = NULL, updated_by = ${who.email}, updated_at = now()
                           WHERE account_id = 1 AND reservation_id = ${row.for_reservation} AND assignment = 'not_needed'
                           RETURNING deep, checkout_time, checkin_time`;
      // A checkout already in the record (and so frozen) goes back to
      // "unassigned" — someone says who cleaned it; the rule cannot, after the fact.
      await sql`UPDATE cleanings SET assignment = 'tbd', decided_by = ${`manual clean ${key} cancelled by ${who.email} — reassign`},
                       imported_at = now()
                 WHERE account_id = 1 AND key = ${row.for_reservation} AND assignment = 'not_needed'
                   AND checkout_on < CURRENT_DATE AND void_reason IS NULL`;
      // The line this clean added to the checkout note comes out again —
      // in live mode that note is the Host Note, and it would be wrong.
      const latest = (await sql`SELECT notes FROM stay_notes WHERE account_id = 1 AND reservation_id = ${row.for_reservation}
                                  AND kind = 'checkout' ORDER BY id DESC LIMIT 1`)[0]?.notes as string | undefined;
      const mark = `Guest left early — cleaned ${row.day}`;
      if (latest?.includes(mark)) {
        const kept = latest.split('\n').filter(l => !l.startsWith(mark)).join('\n');
        await sql`INSERT INTO stay_notes (account_id, reservation_id, kind, unit_id, unit_name, guest, notes, created_by)
                  VALUES (1, ${row.for_reservation}, 'checkout', ${row.unit_id}, ${row.unit_name}, ${row.guest}, ${kept}, ${who.email})`;
      }
      if (o.length) {
        restored = true;
        const x = o[0] as { deep: boolean | null; checkout_time: string | null; checkin_time: string | null };
        if (x.deep === null && !x.checkout_time && !x.checkin_time) {
          await sql`DELETE FROM turnover_overrides WHERE account_id = 1 AND reservation_id = ${row.for_reservation}`;
        }
      }
    }
    if (cfg.mode === 'live' && restored) syncInBackground(sql, env, waitUntil, row.for_reservation!);
    return Response.json({ ok: true, restored });
  }

  if (b.action !== 'create') return bad('Unknown action.');
  const unitId = String(b.unitId ?? '');
  const date = String(b.date ?? '');
  const kind = String(b.kind ?? '');
  const resId = b.reservationId ? String(b.reservationId) : null;
  const cleaner = b.cleaner ? String(b.cleaner) : null;
  const deep = b.deep === true;
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 500) || null : null;
  if (!DAY.test(date)) return bad('Which day?');
  if (!KINDS.has(kind)) return bad('Guest left early, mid-stay clean, or an extra clean.');
  if (resId && !/^\d{1,20}$/.test(resId)) return bad('Which stay?');
  if (kind === 'early_departure' && !resId) return bad('Which stay did the guest leave early from?');
  // Only someone on the roster, and active — the same rule as the board.
  if (cleaner && !cfg.roster.some(c => c.active && c.name === cleaner)) return bad(`"${cleaner}" is not on the active roster.`);

  const unit = (await sql`SELECT id, name, bedrooms FROM units WHERE id = ${unitId}`)[0] as
    { id: string; name: string; bedrooms: number | null } | undefined;
  if (!unit) return bad('That unit is not known to Kaizen.');

  // The stay, from Hostaway itself: it must be in this unit, and an early
  // departure must be before the checkout it replaces.
  let guest: string | null = null;
  if (resId) {
    const d = await fetchReservationDetail(await getCredentials(sql, env.ENCRYPTION_KEY), resId);
    if (!d) return bad('Hostaway did not return that stay.');
    const listing = String(d.listingMapId ?? d.listingId ?? '');
    if (listing && listing !== unitId) return bad('That stay is in another unit.');
    const departure = String(d.departureDate ?? '');
    if (kind === 'early_departure' && departure && date >= departure) {
      return bad(`The checkout is ${departure} — a clean on or after it is the normal checkout clean, not an early one.`);
    }
    guest = String(d.guestName ?? '').trim() || null;
  }

  const price = rateFor(cfg.roster, cleaner, unit.bedrooms, deep);
  const key = `MAN-${(await sql`SELECT nextval('manual_clean_seq') AS n`)[0].n}`;
  await sql`
    INSERT INTO cleanings (account_id, key, unit_id, unit_name, checkout_on, cleaner, assignment, guest, price, deep,
                           reservation_note, beds, source, decided_by, kind, for_reservation, created_by)
    VALUES (1, ${key}, ${unit.id}, ${unit.name}, ${date}, ${cleaner}, ${cleaner ? 'assigned' : 'tbd'}, ${guest}, ${price}, ${deep},
            ${note}, ${unit.bedrooms}, 'manual', ${`manual:${who.email} (${KIND_WORD[kind]})`}, ${kind}, ${resId}, ${who.email})`;

  if (kind === 'early_departure' && resId) {
    // The checkout's own clean is no longer needed — a person's decision, recorded as one.
    await sql`
      INSERT INTO turnover_overrides (account_id, reservation_id, assignment, cleaner, updated_by)
      VALUES (1, ${resId}, 'not_needed', NULL, ${who.email})
      ON CONFLICT (account_id, reservation_id) DO UPDATE SET
        assignment = 'not_needed', cleaner = NULL, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    // If the checkout's clean is already in the record — its day passed, so
    // the record is frozen and no pass will rewrite it — it is corrected
    // here, or it would be paid on top of this one.
    await sql`UPDATE cleanings SET assignment = 'not_needed', cleaner = NULL, price = NULL, imported_at = now(),
                     decided_by = ${`manual:${who.email} (guest left early — cleaned ${date}, ${key})`}
               WHERE account_id = 1 AND key = ${resId} AND void_reason IS NULL`;
    // The checkout note is the latest row, so the existing words are kept and this is added.
    const latest = (await sql`SELECT notes FROM stay_notes WHERE account_id = 1 AND reservation_id = ${resId}
                                AND kind = 'checkout' ORDER BY id DESC LIMIT 1`)[0]?.notes as string | undefined;
    const line = `Guest left early — cleaned ${date}${cleaner ? ` by ${cleaner}` : ''}. No checkout clean needed.`;
    await sql`INSERT INTO stay_notes (account_id, reservation_id, kind, unit_id, unit_name, guest, notes, created_by)
              VALUES (1, ${resId}, 'checkout', ${unit.id}, ${unit.name}, ${guest},
                      ${latest ? `${latest}\n${line}` : line}, ${who.email})`;
    if (cfg.mode === 'live') syncInBackground(sql, env, waitUntil, resId);
  }
  return Response.json({ ok: true, key, price });
};

/** Live mode: the record and the Host Note follow at once, as for any board edit. */
function syncInBackground(sql: SqlFn, env: Env, waitUntil: (p: Promise<unknown>) => void, resId: string) {
  waitUntil((async () => {
    try {
      const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
      const s = await loadOps(sql, creds);
      await recordCleanings(sql, s);
      await pushHostNotes(sql, creds, s, [resId]);
    } catch { /* the scheduled pass retries whatever did not land */ }
  })());
}

function bad(message: string): Response {
  return Response.json({ ok: false, message }, { status: 400 });
}
