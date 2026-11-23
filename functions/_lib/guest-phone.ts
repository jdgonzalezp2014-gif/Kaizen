/**
 * The guest's own mobile number (owner, 2026-11-23): typed or confirmed in the portal's check-in (guest_flows.flow.phone),
 * which beats the reservation's — Airbnb's is a relay that does not take texts. Used by the CRM and every SMS by Quo.
 */
import type { SqlFn } from './accounts.ts';

export async function confirmedPhone(sql: SqlFn, reservationId: string | null | undefined): Promise<string | null> {
  if (!reservationId) return null;
  const [r] = await (sql`SELECT flow->>'phone' AS phone FROM guest_flows WHERE account_id = 1 AND reservation_id = ${reservationId}` as Promise<{ phone: string | null }[]>)
    .catch(() => []);
  return r?.phone && /^\+\d{8,15}$/.test(r.phone) ? r.phone : null;
}
