/**
 * Early check-in / late check-out reach the guest: the hour set on the
 * board is written on the Hostaway reservation (checkInTime / checkOutTime).
 * Cleared in Kaizen (back to the rule) → the listing's standard hour.
 *
 * Kaizen keeps the hour only until Hostaway confirms it (§156): then its
 * copy is cleared and the board reads the reservation again — so a change
 * made later in Hostaway itself is what the board shows.
 *
 * A change checked with the cleaner also (§156): closes the night after a
 * later check-out when asked, and reminds the cleaner in their own Slack
 * channel. Each part reports on its own; none undoes another.
 *
 * Every attempt leaves a row in stay_time_pushes — the board's ⇄ / ⚠ and
 * the Notes log read them — including when nothing could be sent.
 */
import type { SqlFn } from './accounts.ts';
import { blockNight, fetchReservationDetail, fetchStandardHours, updateReservationTimes,
         type HostawayCredentials, type StayHours } from './hostaway.ts';
import { slackApi, slackSetup } from './slack.ts';
import { hourOf, syncLogLine, timeReminder, type StayEnd } from '../../src/lib/stay-time.ts';

const FIELD: Record<StayEnd, keyof StayHours> = { checkin: 'checkInTime', checkout: 'checkOutTime' };

/** What the person confirmed in the board's pop-up. */
export interface TimeCheck { checkedWith: string; cleaner: string | null; blockNight: string | null }

export async function pushStayTimes(
  sql: SqlFn, creds: HostawayCredentials, encryptionKey: string, resId: string,
  changes: Partial<Record<StayEnd, string | null>>, by: string, check?: TimeCheck | null
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

  // Confirmed in Hostaway → Kaizen lets go of its copy (only if nobody changed it since).
  if (!failure) {
    for (const k of kinds) {
      const t = changes[k];
      if (t == null) continue;
      if (k === 'checkout') await sql`UPDATE turnover_overrides SET checkout_time = NULL, updated_at = now()
                                       WHERE account_id = 1 AND reservation_id = ${resId} AND checkout_time = ${t}`;
      else await sql`UPDATE turnover_overrides SET checkin_time = NULL, updated_at = now()
                      WHERE account_id = 1 AND reservation_id = ${resId} AND checkin_time = ${t}`;
    }
    await sql`DELETE FROM turnover_overrides WHERE account_id = 1 AND reservation_id = ${resId}
                AND assignment IS NULL AND deep IS NULL AND checkout_time IS NULL AND checkin_time IS NULL`;
  }

  const listingId = res?.listingMapId != null ? String(res.listingMapId) : null;
  const unit = listingId
    ? ((await sql`SELECT name FROM units WHERE account_id = 1 AND id = ${listingId}`)[0]?.name ?? null) : null;
  const guest = res ? String(res.guestName ?? '').trim() || null : null;
  const checkIn = /^\d{4}-\d{2}-\d{2}$/.test(String(res?.arrivalDate)) ? String(res!.arrivalDate) : null;
  const checkOut = /^\d{4}-\d{2}-\d{2}$/.test(String(res?.departureDate)) ? String(res!.departureDate) : null;

  // The night after a later check-out — only that reservation's own checkout day.
  let night: { date: string; ok: boolean; detail: string } | null = null;
  if (check?.blockNight && kinds.includes('checkout')) {
    if (!listingId || check.blockNight !== checkOut) {
      night = { date: check.blockNight, ok: false, detail: "it is not this stay's checkout day" };
    } else {
      try { night = { date: check.blockNight, ...(await blockNight(creds, listingId, check.blockNight)) }; }
      catch (e) { night = { date: check.blockNight, ok: false, detail: e instanceof Error ? e.message : String(e) }; }
    }
  }

  // The reminder, in the cleaner's own channel only (owner): none → said so in the row.
  let reminder: string | null = null;
  if (check) {
    const k = kinds[0]!;
    reminder = await remindCleaner(sql, encryptionKey, check.cleaner, {
      unit: unit ?? 'the unit', date: (k === 'checkout' ? checkOut : checkIn) ?? '', kind: k,
      hour: plan.get(k)?.hour ?? null, cleaner: check.checkedWith, night: night?.ok ? night.date : null
    }).catch(e => `not sent — ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const k of kinds) {
    const p = plan.get(k) ?? { hour: null, standard: changes[k] == null };
    const n = k === 'checkout' ? night : null;
    const line = syncLogLine(k, p.hour, p.standard, !failure, failure, { checkedWith: check?.checkedWith, night: n }) +
      (reminder && k === kinds[0] ? ` · Slack: ${reminder}` : '');
    await sql`INSERT INTO stay_time_pushes (account_id, reservation_id, kind, hour, standard, outcome, detail, note,
                                            unit_name, guest, check_in, created_by,
                                            checked_with, block_night, block_ok, block_detail, reminder)
              VALUES (1, ${resId}, ${k}, ${p.hour}, ${p.standard}, ${failure ? 'failed' : 'pushed'}, ${failure || null},
                      ${line}, ${unit}, ${guest}, ${checkIn}, ${by},
                      ${check?.checkedWith ?? null}, ${n?.date ?? null}, ${n ? n.ok : null}, ${n?.detail ?? null},
                      ${k === kinds[0] ? reminder : null})`;
  }
}

async function remindCleaner(sql: SqlFn, encryptionKey: string, cleaner: string | null,
                             m: Parameters<typeof timeReminder>[1]): Promise<string> {
  if (!cleaner) return 'not sent — no cleaner on this clean';
  const s = await slackSetup(sql, encryptionKey);
  const ch = s.config.cleaners?.[cleaner];
  if (!s.token) return 'not sent — Slack is not connected';
  if (!ch?.channelId) return `not sent — ${cleaner} has no channel`;
  const lang = ((await sql`SELECT lang FROM cleaners WHERE account_id = 1 AND name = ${cleaner}`)[0]?.lang as 'en' | 'es') ?? 'en';
  const r = await slackApi(s.token, 'chat.postMessage', { channel: ch.channelId, text: timeReminder(lang, m), unfurl_links: false });
  return r.ok ? `sent to #${ch.channelName}` : `not sent — ${r.error ?? 'Slack refused'}`;
}
