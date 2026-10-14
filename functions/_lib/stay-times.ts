/**
 * Early check-in / late check-out reach the guest: the hour set on the
 * board is written on the Hostaway reservation (checkInTime / checkOutTime).
 * Cleared in Kaizen (back to the rule) → the listing's standard hour.
 *
 * Every attempt leaves a row in stay_time_pushes — the board's ⇄ / ⚠ and
 * the Notes log read them — including when nothing could be sent.
 */
import type { SqlFn } from './accounts.ts';
import { fetchReservationDetail, fetchStandardHours, updateReservationTimes,
         type HostawayCredentials, type StayHours } from './hostaway.ts';
import { hourOf, syncLogLine, type StayEnd } from '../../src/lib/stay-time.ts';

const FIELD: Record<StayEnd, keyof StayHours> = { checkin: 'checkInTime', checkout: 'checkOutTime' };

export async function pushStayTimes(
  sql: SqlFn, creds: HostawayCredentials, resId: string,
  changes: Partial<Record<StayEnd, string | null>>, by: string
): Promise<void> {
  const kinds = Object.keys(changes) as StayEnd[];
  if (!kinds.length) return;
  const plan = new Map<StayEnd, { hour: number | null; standard: boolean }>();
  let failure = '';
  let res: Record<string, unknown> | null = null;
  try {
    res = await fetchReservationDetail(creds, resId);
    if (!res) failure = 'Could not read the reservation in Hostaway.';
    const needStandard = kinds.some(k => changes[k] == null);
    const std = needStandard && res ? await fetchStandardHours(creds, String(res.listingMapId ?? '')) : null;
    for (const k of kinds) {
      const t = changes[k];
      if (t == null) plan.set(k, { hour: std ? std[FIELD[k]] : null, standard: true });
      else plan.set(k, { hour: hourOf(t), standard: false });
    }
    if (!failure && needStandard && !std) failure = "Could not read the listing's standard hours.";
    if (!failure && [...plan.values()].some(p => p.hour == null)) failure = 'Whole hours only — Hostaway keeps the hour, not minutes.';
    if (!failure) {
      const body: StayHours = {};
      for (const [k, p] of plan) body[FIELD[k]] = p.hour!;
      const w = await updateReservationTimes(creds, resId, body);
      if (!w.ok) failure = w.detail;
    }
  } catch (e) { failure = e instanceof Error ? e.message : String(e); }

  const unit = res?.listingMapId != null
    ? ((await sql`SELECT name FROM units WHERE account_id = 1 AND id = ${String(res.listingMapId)}`)[0]?.name ?? null) : null;
  const guest = res ? String(res.guestName ?? '').trim() || null : null;
  const checkIn = /^\d{4}-\d{2}-\d{2}$/.test(String(res?.arrivalDate)) ? String(res!.arrivalDate) : null;
  for (const k of kinds) {
    const p = plan.get(k) ?? { hour: null, standard: changes[k] == null };
    await sql`INSERT INTO stay_time_pushes (account_id, reservation_id, kind, hour, standard, outcome, detail, note,
                                            unit_name, guest, check_in, created_by)
              VALUES (1, ${resId}, ${k}, ${p.hour}, ${p.standard}, ${failure ? 'failed' : 'pushed'}, ${failure || null},
                      ${syncLogLine(k, p.hour, p.standard, !failure, failure)}, ${unit}, ${guest}, ${checkIn}, ${by})`;
  }
}
