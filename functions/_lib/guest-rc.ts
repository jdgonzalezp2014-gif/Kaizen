/**
 * Airbnb guests pay through Airbnb (owner, 2026-11-23: "for Airbnb all upselling in the guest portal goes through the
 * Resolution Center … we can offer the Stripe option but Airbnb is preferred").
 *
 *   POST /api/report-link?rc=1  { stayToken, purpose: 'checkin' | 'extra', extra? }  → { charge: { id, amount, label }, rcUrl }
 *
 * The bill is the server's (`stayLines`, the same as the card checkout), so the page cannot set the amount. It becomes an
 * upsell case + a pending Resolution Center charge (§178, method 'rc'): the case's Slack thread tells the team, the stay
 * page lists it under Pending payments, the guest sends the money in Airbnb and taps "I already paid" (`staySaidPaid`),
 * the team checks Airbnb and marks it received (`rcReceived` → settleCharge: the case Paid, an hour / nights set up in
 * Hostaway). The check-in keeps the charge in guest_flows.pay_session as 'rc:<id>' (guest-stay.ts reads it back).
 * A deposit is a hold on a card: Airbnb cannot hold, so a bill with one is refused here (the page offers the card).
 */
import type { SqlFn } from './accounts.ts';
import type { Env } from './db.ts';
import { stayLines } from './guest-pay.ts';
import { markStay, stayId } from './guest-stay.ts';
import { saveCaseMoney } from './claim-money.ts';
import { notifyClaim } from './slack.ts';
import { todayIn, type DateStr } from '../../src/lib/dates.ts';
import { AIRBNB_RESOLUTION, chargeLabel, extraNights, needOf } from '../../src/lib/upsell-charge.ts';

const GUEST = 'Guest (stay page)';
const bad = (message: string, status = 400) => Response.json({ ok: false, message }, { status, headers: { 'Cache-Control': 'no-store' } });
const ok = (c: { id: string; amount: number; label: string }) => Response.json({ ok: true, charge: c, rcUrl: AIRBNB_RESOLUTION }, { headers: { 'Cache-Control': 'no-store' } });

/** "1:00 PM" → 13. */
function hourOf(t: unknown): number | null {
  const m = /^(\d{1,2}):00\s*(AM|PM)$/i.exec(String(t ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]) % 12 + (m[2]!.toUpperCase() === 'PM' ? 12 : 0);
  return h >= 0 && h <= 23 ? h : null;
}

/** The portal's extra → the case's kind, and what settling it sets up in Hostaway. */
const CATEGORY: Record<string, string> = { 'extra-nights': 'Extra nights', 'early-checkin': 'Early check-in', 'late-checkout': 'Late checkout', pet: 'Pet fee' };

export async function stayRc(sql: SqlFn, env: Env, request: Request): Promise<Response> {
  const b = await request.json().catch(() => ({})) as { stayToken?: string; purpose?: string; extra?: { kind?: string; choice?: Record<string, unknown> } };
  const id = await stayId(env.ENCRYPTION_KEY, b.stayToken);
  if (!id) return bad('This stay link is not valid.', 403);
  const checkin = b.purpose === 'checkin';
  const x = await stayLines(sql, env, id, checkin ? 'checkin' : 'extra', b.extra);
  if (typeof x === 'string') return bad(x, 409);
  const { l, lines } = x;
  if (l.stay.channel !== 'airbnb') return bad('Paying through Airbnb is only for Airbnb bookings — pay by card.');
  if (lines.some(v => v.kind === 'hold')) return bad('The deposit is a hold on your card, which Airbnb cannot do. Choose the waiver to pay on Airbnb, or pay by card.');
  const amount = Math.round(lines.reduce((t, v) => t + Number(v.amount), 0) * 100) / 100;
  if (!(amount > 0) || amount > 5000) return bad('Nothing to pay.');

  // What the case is, and what paying it changes.
  const kind = checkin ? null : String(b.extra?.kind ?? '');
  const category = checkin ? 'Other upsell' : CATEGORY[kind!] ?? 'Other upsell';
  const need = needOf(category);
  const c = b.extra?.choice ?? {};
  const arrival = l.stay.arrival as DateStr, departure = l.stay.departure as DateStr;
  const hour = need === 'checkin' || need === 'checkout' ? hourOf(c.time) : null;
  const nights = need === 'nights' ? extraNights(arrival, departure, Math.max(0, Math.floor(Number(c.before) || 0)), Math.max(0, Math.floor(Number(c.after) || 0))) : [];
  if ((need === 'checkin' || need === 'checkout') && hour == null) return bad('Pick the time.');
  if (need === 'nights' && !nights.length) return bad('Pick your nights.');
  const label = (checkin ? `Online check-in: ${lines.map(v => v.label).join(' + ')}`
    : need === 'amount' ? `${lines[0]!.label}${c.qty && Number(c.qty) > 1 ? ` × ${Number(c.qty)}` : ''}` : chargeLabel(category, { nights, hour })).slice(0, 200);

  // The same ask again (a second tap, a reload) answers the request already open; a check-in whose bill changed replaces it.
  const [same] = await sql`SELECT id::text AS id, claim_id::text AS claim_id, amount::float8 AS amount, label FROM upsell_charges
                            WHERE account_id = 1 AND reservation_id = ${id} AND method = 'rc' AND status = 'pending' AND created_by = ${GUEST}
                              AND ((${checkin}::boolean AND label LIKE 'Online check-in:%') OR (NOT ${checkin}::boolean AND label = ${label}))
                            ORDER BY id DESC LIMIT 1` as { id: string; claim_id: string; amount: number; label: string }[];
  if (same && Math.abs(same.amount - amount) < 0.005 && same.label === label) {
    if (checkin) await markStay(sql, id, l.listingId, { paySession: `rc:${same.id}` });
    return ok({ id: same.id, amount: same.amount, label: same.label });
  }
  if (same && checkin) {
    await sql`UPDATE upsell_charges SET status = 'cancelled', cancelled_at = now(), cancelled_by = ${GUEST} WHERE account_id = 1 AND id::text = ${same.id} AND status = 'pending'`;
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${same.claim_id}, 'note', ${`Replaced — the guest changed the check-in: ${same.label} $${same.amount.toFixed(2)}.`}, ${GUEST})`;
    await sql`UPDATE claims SET status = 'Dismissed', resolved_on = COALESCE(resolved_on, ${todayIn('America/New_York')}::date) WHERE account_id = 1 AND id::text = ${same.claim_id} AND status = 'Open'`.catch(() => {});
  }

  const guest = l.stay.guest?.name ?? l.stay.guestFirst ?? null;
  const [k] = await sql`
    INSERT INTO claims (account_id, unit_id, occurred_on, category, severity, status, description, refund, created_by, reservation_id, reservation_label)
    VALUES (1, ${l.listingId || null}, ${todayIn('America/New_York')}, ${category}, 'Low', 'Open',
            ${`${label} — $${amount.toFixed(2)}. Chosen in the guest portal to pay through Airbnb's Resolution Center (the guest sends the money there). Check Airbnb, then Mark received.`},
            0, ${GUEST}, ${id}, ${l.label})
    RETURNING id::text AS id` as { id: string }[];
  const claimId = k!.id;
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by) VALUES (1, 'claim', ${claimId}, 'status', 'Claim opened — Open', ${GUEST})`;
  const [row] = await sql`
    INSERT INTO upsell_charges (account_id, claim_id, reservation_id, unit_id, unit_name, guest, guest_email, need, label, item, amount, nights, hour, method, livemode, created_by)
    VALUES (1, ${claimId}::bigint, ${id}, ${l.listingId || null}, ${l.stay.unitName}, ${guest}, ${l.stay.guest?.email ?? null}, ${need}, ${label},
            ${checkin ? 'checkin' : kind || 'other'}, ${amount}, ${nights}, ${hour}, 'rc', true, ${GUEST})
    RETURNING id::text AS id` as { id: string }[];
  await saveCaseMoney(sql, claimId, { requested: amount, collectedVia: 'Resolution Center' }, GUEST);
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'claim', ${claimId}, 'note', ${`The guest will pay through the Resolution Center: ${label} $${amount.toFixed(2)}${need === 'nights' ? ' — the nights are set up in Hostaway once it is received' : hour != null ? ' — the hour is set in Hostaway once it is received' : ''}.`}, ${GUEST})`;
  await notifyClaim(sql, env.ENCRYPTION_KEY, claimId, 'opened', GUEST).catch(() => {});
  if (checkin) await markStay(sql, id, l.listingId, { paySession: `rc:${row!.id}` });
  return ok({ id: row!.id, amount, label });
}
