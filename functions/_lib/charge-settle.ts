/**
 * A paid upsell charge settles its case and only then moves Hostaway (owner, 2026-11-19, §178 round 2: "only block
 * with a confirmed payment"). Reached three ways, and only the first moves anything (`status = 'pending'` guard):
 * the guest's return from Stripe and Stripe's webhook (guest-pay.ts recordSession), the clock's sweep (`sweepCharges`,
 * for when no webhook is set), and the team marking Resolution Center money received (`rc`).
 *
 * Money: live card or RC → the case gets the price and closes as Paid — Revenue counts it there, once (the
 * guest_payments row carries `claim_id`, so Portal sales leaves it out). Test card → the charge reads paid and the case
 * gets a note; test money is never income and never touches Hostaway (a test card must not block a real calendar).
 *
 * Then Hostaway (src/lib/upsell-charge.ts `applyPlan`): an hour → the reservation's check-in / check-out (the board's
 * own path); extra nights on a direct booking → the reservation's dates; on a channel booking → the nights blocked and
 * an urgent to-do (door code, clean, messages — the reservation still ends on its old day). Every write is read back;
 * a refusal is an urgent to-do too ("paid but not applied"), never silence.
 */
import type { SqlFn } from './accounts.ts';
import { getCredentials } from './accounts.ts';
import { saveCaseMoney } from './claim-money.ts';
import { notifyClaim } from './slack.ts';
import { fetchCalendar, fetchReservationDetail, getAccessToken } from './hostaway.ts';
import { pushStayTimes } from './stay-times.ts';
import { mirrorTodos } from './inventory.ts';
import { todayIn } from '../../src/lib/dates.ts';
import { applyPlan, followUp, hourLabel, runsOf, type ChargeNeed } from '../../src/lib/upsell-charge.ts';

const HOSTAWAY = 'https://api.hostaway.com/v1';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const note = (sql: SqlFn, claimId: string, body: string, by = 'Stripe') =>
  sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by) VALUES (1, 'claim', ${claimId}, 'note', ${body}, ${by})`;

/** Only the fields sent — never the whole reservation (the rule of hostaway.ts). */
async function put(token: string, path: string, body: unknown) {
  const res = await fetch(`${HOSTAWAY}${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Cache-control': 'no-cache' }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, text: (await res.text()).slice(0, 200) };
}

type Row = { id: string; claim_id: string; reservation_id: string; unit_id: string | null; unit_name: string | null; guest: string | null;
  need: ChargeNeed; nights: string[]; hour: number | null; amount: number; label: string; method: 'card' | 'rc' };

/** Moves Hostaway for a paid charge. Returns what happened in words, or throws the reason. */
async function apply(sql: SqlFn, ek: string, c: Row, by: string): Promise<{ holds: string[]; followUp: { title: string; description: string } | null }> {
  const creds = await getCredentials(sql, ek);
  const r = await fetchReservationDetail(creds, c.reservation_id);
  if (!r) throw new Error('Hostaway did not return the reservation.');
  if (/cancel|declin|expir/i.test(String(r.status ?? ''))) throw new Error(`the reservation is ${r.status} in Hostaway`);
  const stay = { channel: String(r.channelName ?? ''), arrival: DAY.test(String(r.arrivalDate)) ? String(r.arrivalDate) : null,
                 departure: DAY.test(String(r.departureDate)) ? String(r.departureDate) : null };
  const listing = r.listingMapId != null ? String(r.listingMapId) : c.unit_id;
  const plan = applyPlan(c, stay);
  if (plan.kind === 'none') return { holds: [], followUp: null };

  if (plan.kind === 'hour') {
    await pushStayTimes(sql, creds, ek, c.reservation_id, { [plan.field]: hourLabel(plan.hour) }, by, null);
    const [p] = await sql`SELECT outcome, detail FROM stay_time_pushes WHERE account_id = 1 AND reservation_id = ${c.reservation_id} AND kind = ${plan.field}
                           ORDER BY id DESC LIMIT 1` as { outcome: string; detail: string | null }[];
    if (p?.outcome !== 'pushed') throw new Error(`Hostaway did not take the ${plan.field === 'checkin' ? 'check-in' : 'check-out'} hour: ${p?.detail ?? 'no answer'}`);
    return { holds: [`${plan.field === 'checkin' ? 'check-in' : 'check-out'} ${hourLabel(plan.hour)} set on the reservation`], followUp: null };
  }

  if (!listing) throw new Error('the reservation has no listing');
  const sorted = [...c.nights].sort();
  const token = await getAccessToken(creds);
  // Still free? Between the link and the payment someone may have booked them.
  const days = await fetchCalendar(creds, listing, sorted[0]!, sorted[sorted.length - 1]!, token);
  const taken = sorted.filter(d => !days.find(x => x.date === d)?.available);
  if (taken.length) throw new Error(`${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} no longer free — refund that part or arrange it with the guest`);

  if (plan.kind === 'extend') {
    const before = Number(r.totalPrice);
    const w = await put(token, `/reservations/${encodeURIComponent(c.reservation_id)}`, { arrivalDate: plan.arrival, departureDate: plan.departure });
    const back = w.ok ? await fetchReservationDetail(creds, c.reservation_id) : null;
    if (back && String(back.arrivalDate) === plan.arrival && String(back.departureDate) === plan.departure) {
      const after = Number(back.totalPrice);
      const holds = [`reservation extended in Hostaway: ${plan.arrival} → ${plan.departure}`];
      // The extension was paid through Stripe: a total Hostaway raised on its own would count the nights twice.
      if (Number.isFinite(before) && Number.isFinite(after) && Math.abs(after - before) > 0.5) {
        holds.push(`Hostaway changed the reservation total ${before.toFixed(2)} → ${after.toFixed(2)}: set it back to ${before.toFixed(2)} (the nights were paid by card) or they count twice`);
      }
      return { holds, followUp: null };
    }
    // Refused (or did not stick): fall through to the block, so the nights are held all the same.
  }

  for (const run of runsOf(sorted)) {
    const w = await put(token, `/listings/${encodeURIComponent(listing)}/calendar`, { startDate: run.from, endDate: run.to, isAvailable: 0 });
    if (!w.ok) throw new Error(`Hostaway answered ${w.status} blocking ${run.from}–${run.to}: ${w.text}`);
  }
  const after = await fetchCalendar(creds, listing, sorted[0]!, sorted[sorted.length - 1]!, token);
  const open = sorted.filter(d => after.find(x => x.date === d)?.available !== false);
  if (open.length) throw new Error(`Hostaway accepted the block but ${open.join(', ')} still read open`);
  return { holds: [`${sorted.length} night${sorted.length === 1 ? '' : 's'} blocked in Hostaway (${sorted[0]}${sorted.length > 1 ? ` – ${sorted[sorted.length - 1]}` : ''})`],
           followUp: followUp(c.unit_name ?? 'the unit', c.guest, stay, sorted) };
}

/** An urgent to-do on the stay and the case, announced and mirrored like any other work. */
async function urgentTodo(sql: SqlFn, ek: string, c: Row, t: { title: string; description: string }) {
  const [res] = await sql`SELECT reservation_label FROM claims WHERE account_id = 1 AND id::text = ${c.claim_id}` as { reservation_label: string | null }[];
  const [row] = await sql`INSERT INTO todos (account_id, title, description, unit_ids, created_by, kind, status, priority, due_on, claim_id, reservation_id, reservation_label)
                          VALUES (1, ${t.title.slice(0, 300)}, ${t.description}, ${c.unit_id ? [c.unit_id] : []}, 'Kaizen', 'task', 'pending', 'urgent',
                                  ${todayIn('America/New_York')}::date, ${c.claim_id}, ${c.reservation_id}, ${res?.reservation_label ?? null})
                          RETURNING id::text AS id` as { id: string }[];
  await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
            VALUES (1, 'task', ${row!.id}, 'status', 'To-do created by Kaizen (upsell paid).', 'Kaizen')`;
  await mirrorTodos(sql, ek, [row!.id], 'Kaizen').catch(() => {});
  return row!.id;
}

export interface Settle { via: 'card' | 'rc'; sessionId?: string | null; livemode: boolean; amount?: number; by?: string }

export async function settleCharge(sql: SqlFn, chargeId: string, s: Settle, encryptionKey?: string): Promise<{ ok: boolean; message?: string }> {
  const by = s.by ?? (s.via === 'rc' ? 'the team' : 'Stripe');
  const [c] = await sql`UPDATE upsell_charges SET status = 'paid', paid_at = now(), session_id = COALESCE(${s.sessionId ?? null}, session_id), livemode = ${s.livemode},
                                amount = COALESCE(${s.amount ?? null}::numeric, amount)
                         WHERE account_id = 1 AND id::text = ${chargeId} AND status = 'pending' AND method = ${s.via}
                         RETURNING id::text AS id, claim_id::text AS claim_id, reservation_id, unit_id, unit_name, guest, need, nights, hour,
                                   amount::float8 AS amount, label, method` as Row[];
  if (!c) return { ok: false, message: 'It is not pending any more.' };
  const usd = `$${c.amount.toFixed(2)}`;
  const word = s.via === 'rc' ? 'the Resolution Center' : 'Stripe';
  if (!s.livemode) {
    await note(sql, c.claim_id, `Test payment through Stripe: ${c.label} ${usd} — sandbox: not income, and nothing changed in Hostaway.`);
    return { ok: true };
  }
  // The money first: whatever Hostaway answers next, the payment is on the case.
  try {
    const [k] = await sql`SELECT status, refund::float8 AS received FROM claims WHERE account_id = 1 AND id::text = ${c.claim_id}` as { status: string; received: number }[];
    if (k) {
      await saveCaseMoney(sql, c.claim_id, { received: Math.round((k.received + c.amount) * 100) / 100, collectedVia: s.via === 'rc' ? 'Resolution Center' : 'Stripe' }, by);
      await note(sql, c.claim_id, `Paid through ${word}: ${c.label} ${usd}.`, by);
      if (k.status !== 'Paid') {
        await sql`UPDATE claims SET status = 'Paid', resolved_on = COALESCE(resolved_on, ${todayIn('America/New_York')}::date) WHERE account_id = 1 AND id::text = ${c.claim_id}`;
        await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by) VALUES (1, 'claim', ${c.claim_id}, 'status', ${`${k.status} → Paid`}, ${by})`;
        if (encryptionKey) await notifyClaim(sql, encryptionKey, c.claim_id, 'changed', by, '→ Paid').catch(() => {});
      }
    }
  } catch (e) {
    await note(sql, c.claim_id, `Paid through ${word} (${c.label} ${usd}), but the case could not be updated: ${e instanceof Error ? e.message : String(e)} — enter the price by hand.`).catch(() => {});
  }
  if (!encryptionKey) return { ok: true };
  // Then Hostaway — only now that the money is in.
  try {
    const done = await apply(sql, encryptionKey, c, by);
    const todo = done.followUp ? await urgentTodo(sql, encryptionKey, c, done.followUp) : null;
    await sql`UPDATE upsell_charges SET applied_at = now(), holds = ${done.holds}, todo_id = ${todo} WHERE account_id = 1 AND id = ${c.id}::bigint`;
    if (done.holds.length) await note(sql, c.claim_id, `Set up in Hostaway: ${done.holds.join(' · ')}${todo ? ` · to-do #${todo} for the door code, the clean and the messages` : ''}.`, 'Kaizen');
  } catch (e) {
    const why = (e instanceof Error ? e.message : String(e)).replace(/\.+$/, '');
    const todo = await urgentTodo(sql, encryptionKey, c, { title: `Paid upsell not set up — ${c.unit_name ?? 'unit'}: ${c.label}`,
      description: `${c.guest ?? 'The guest'} paid ${usd} through ${word} for ${c.label}, but Kaizen could not set it up in Hostaway: ${why}.\nDo it by hand in Hostaway, or refund the guest.` }).catch(() => null);
    await sql`UPDATE upsell_charges SET apply_error = ${why}, todo_id = ${todo} WHERE account_id = 1 AND id = ${c.id}::bigint`;
    await note(sql, c.claim_id, `Paid, but NOT set up in Hostaway: ${why}.${todo ? ` Urgent to-do #${todo}.` : ''}`, 'Kaizen').catch(() => {});
  }
  return { ok: true };
}

/**
 * A refund in Stripe follows the case (owner: "align"): what was refunded comes off the case's received; refunded in
 * full → the case is Resolved with nothing received. Hostaway is not undone on its own — the guest may still be staying.
 */
export async function syncChargeRefund(sql: SqlFn, chargeId: string, refundedTotal: number): Promise<void> {
  const [c] = await sql`SELECT claim_id::text AS claim_id, refunded::float8 AS refunded, livemode, status, label FROM upsell_charges
                         WHERE account_id = 1 AND id::text = ${chargeId}` as { claim_id: string; refunded: number; livemode: boolean; status: string; label: string }[];
  if (!c || c.status !== 'paid' || !c.livemode || !(refundedTotal > c.refunded + 0.004)) return;
  const delta = Math.round((refundedTotal - c.refunded) * 100) / 100;
  const [took] = await sql`UPDATE upsell_charges SET refunded = ${refundedTotal} WHERE account_id = 1 AND id::text = ${chargeId} AND refunded = ${c.refunded} RETURNING id` as { id: string }[];
  if (!took) return;
  const [k] = await sql`SELECT status, refund::float8 AS received FROM claims WHERE account_id = 1 AND id::text = ${c.claim_id}` as { status: string; received: number }[];
  if (!k) return;
  const left = Math.max(0, Math.round((k.received - delta) * 100) / 100);
  // Paid needs money (checkClaim): with nothing left the case is Resolved first, then its money goes to zero.
  if (left <= 0 && k.status === 'Paid') {
    await sql`UPDATE claims SET status = 'Resolved' WHERE account_id = 1 AND id::text = ${c.claim_id}`;
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by) VALUES (1, 'claim', ${c.claim_id}, 'status', 'Paid → Resolved (refunded)', 'Stripe')`;
  }
  await saveCaseMoney(sql, c.claim_id, { received: left }, 'Stripe');
  await note(sql, c.claim_id, `Refunded $${delta.toFixed(2)} through Stripe (${c.label}). Hostaway is not undone on its own — reopen the nights or put the hour back if the guest is not using them.`);
}
