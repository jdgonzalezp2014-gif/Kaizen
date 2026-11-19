/**
 * A paid upsell charge settles its case (owner, 2026-11-19) — called by guest-pay.ts recordSession, so the page's
 * check and Stripe's webhook both land here and only the first one moves anything (`status = 'pending'` guard).
 *
 * Live money: the case gets the price (received, collected via Stripe) and closes as Paid — Revenue counts it there,
 * once; the guest_payments row carries `claim_id` so Portal sales does not count it again. Test money (sandbox): the
 * charge reads paid so the team can try the flow, and the case only gets a note — test money is never income.
 */
import type { SqlFn } from './accounts.ts';
import { saveCaseMoney } from './claim-money.ts';
import { notifyClaim } from './slack.ts';
import { todayIn } from '../../src/lib/dates.ts';

export async function settleCharge(sql: SqlFn, chargeId: string, sessionId: string, livemode: boolean, encryptionKey?: string): Promise<void> {
  const [c] = await sql`UPDATE upsell_charges SET status = 'paid', paid_at = now(), session_id = ${sessionId}, livemode = ${livemode}
                         WHERE account_id = 1 AND id::text = ${chargeId} AND status = 'pending'
                         RETURNING claim_id::text AS claim_id, amount::float8 AS amount, label` as { claim_id: string; amount: number; label: string }[];
  if (!c) return;
  const usd = `$${c.amount.toFixed(2)}`;
  if (!livemode) {
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${c.claim_id}, 'note', ${`Test payment through Stripe: ${c.label} ${usd} — sandbox, not counted as income.`}, 'Stripe')`;
    return;
  }
  // The charge is already paid; if the case cannot follow, say so on the case instead of losing it.
  try {
    const [k] = await sql`SELECT status, refund::float8 AS received FROM claims WHERE account_id = 1 AND id::text = ${c.claim_id}` as { status: string; received: number }[];
    if (!k) return;
    await saveCaseMoney(sql, c.claim_id, { received: Math.round((k.received + c.amount) * 100) / 100, collectedVia: 'Stripe' }, 'Stripe');
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${c.claim_id}, 'note', ${`Paid by the guest through Stripe: ${c.label} ${usd}.`}, 'Stripe')`;
    if (k.status !== 'Paid') {
      await sql`UPDATE claims SET status = 'Paid', resolved_on = COALESCE(resolved_on, ${todayIn('America/New_York')}::date)
                 WHERE account_id = 1 AND id::text = ${c.claim_id}`;
      await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
                VALUES (1, 'claim', ${c.claim_id}, 'status', ${`${k.status} → Paid`}, 'Stripe')`;
      if (encryptionKey) await notifyClaim(sql, encryptionKey, c.claim_id, 'changed', 'Stripe', '→ Paid').catch(() => {});
    }
  } catch (e) {
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${c.claim_id}, 'note', ${`Paid through Stripe (${c.label} ${usd}), but the case could not be updated: ${e instanceof Error ? e.message : String(e)} — enter the price by hand.`}, 'Stripe')`.catch(() => {});
  }
}
