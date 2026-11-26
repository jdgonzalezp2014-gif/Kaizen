/**
 * Guest Services → Payments (owner, 2026-11-26): what each guest paid in the portal and what was done with it — refunds,
 * deposits released or kept — and which listings have Hostaway's refundable deposit switched on. Pure: the money rules the
 * screen and the server share, so the buttons never offer what the server would refuse.
 */
import type { GuestPayment, PaidLine } from './guest-payments.ts';

/** Stripe keeps a card hold about 7 days (online card payments); after that it lapses and nothing can be captured. */
export const HOLD_DAYS = 7;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The charges in a payment (not the held deposit). */
export const chargesOf = (lines: PaidLine[]) => r2(lines.filter(l => !l.hold).reduce((a, l) => a + l.amount, 0));
/** The deposit held in a payment. */
export const holdOf = (lines: PaidLine[]) => r2(lines.filter(l => l.hold).reduce((a, l) => a + l.amount, 0));

/** What can still be refunded: what was captured, less what came back already. Only a paid (captured) payment. */
export function refundable(p: Pick<GuestPayment, 'status' | 'amount' | 'refunded'>): number {
  return p.status === 'paid' ? Math.max(0, r2(p.amount - p.refunded)) : 0;
}

/** The last day the hold can be captured (YYYY-MM-DD, UTC) — created + 7 days. */
export function holdEndsOn(createdIso: string): string {
  const d = new Date(createdIso);
  d.setUTCDate(d.getUTCDate() + HOLD_DAYS);
  return d.toISOString().slice(0, 10);
}

/**
 * Keeping part of a deposit = capturing the charges plus what is kept; the rest of the hold goes back to the guest.
 * Null when the amount is not between $0.01 and the deposit.
 */
export function captureFor(lines: PaidLine[], keep: number): number | null {
  const hold = holdOf(lines);
  if (!(keep > 0) || r2(keep) > hold) return null;
  return r2(chargesOf(lines) + keep);
}

/** Damage protection a completed check-in picked. */
export type ProtectionPick = 'waiver' | 'deposit' | 'none' | 'unknown';
export const pickOf = (v: unknown): ProtectionPick => v === 'waiver' || v === 'deposit' || v === 'none' ? v : 'unknown';

export interface PickTally { completed: number; waiver: number; deposit: number; none: number; unknown: number }
export function tally(picks: ProtectionPick[]): PickTally {
  const t: PickTally = { completed: picks.length, waiver: 0, deposit: 0, none: 0, unknown: 0 };
  for (const p of picks) t[p]++;
  return t;
}
/** "40%" of the completed check-ins; "—" with none. */
export const share = (n: number, of: number) => of > 0 ? `${Math.round((n / of) * 100)}%` : '—';
