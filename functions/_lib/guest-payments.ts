/**
 * Reads `guest_payments` (migration 119) — the guest portal's Stripe payments, written by guest-pay.ts recordSession.
 * A database without 119 answers no payments rather than failing the dashboard.
 */
import type { SqlFn } from './accounts.ts';
import type { GuestPayment, PaidLine } from '../../src/lib/guest-payments.ts';

type Row = { session_id: string; livemode: boolean; reservation_id: string | null; unit_id: string | null; unit_name: string | null; guest: string | null;
  lines: PaidLine[]; amount: number; fee: number | null; refunded: number; status: GuestPayment['status']; paid_on: string };

const shape = (r: Row): GuestPayment => ({ id: r.session_id, livemode: r.livemode, reservationId: r.reservation_id, unitId: r.unit_id, unitName: r.unit_name,
  guest: r.guest, lines: Array.isArray(r.lines) ? r.lines : [], amount: Number(r.amount), fee: r.fee == null ? null : Number(r.fee),
  refunded: Number(r.refunded), status: r.status, paidOn: r.paid_on });

export async function guestPaymentsBetween(sql: SqlFn, from: string, to: string): Promise<GuestPayment[]> {
  try {
    const rows = await sql`
      SELECT session_id, livemode, reservation_id, unit_id, unit_name, guest, lines, amount::float8 AS amount, fee::float8 AS fee,
             refunded::float8 AS refunded, status, paid_on::text AS paid_on
        FROM guest_payments WHERE account_id = 1 AND paid_on BETWEEN ${from} AND ${to}
       ORDER BY paid_on DESC, created_at DESC LIMIT 2000` as Row[];
    return rows.map(shape);
  } catch { return []; }
}
