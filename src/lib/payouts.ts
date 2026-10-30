/**
 * Paying an invoice — a cleaner's or a handyman's (owner, 2026-10-25). One
 * payout per invoice number: through Stripe Connect (a transfer to the
 * payee's connected account) or marked paid by hand. Pure: the server and
 * both pages read the same state.
 */
import type { DateStr } from './dates.ts';

export interface Payout {
  id: string; invoiceNumber: string; amount: number; method: 'stripe' | 'manual';
  stripeMode: 'test' | 'live' | null; transferId: string | null; note: string | null; by: string; at: string;
}

export type PayState =
  /** The period has not ended — the invoice can still grow. */
  | 'open'
  /** Nothing to pay in it. */
  | 'nothing'
  /** Ended, not paid. */
  | 'due'
  | 'paid'
  /** Paid, and the invoice moved since (a late approval, a correction): the difference is settled by hand. */
  | 'changed';

export function payState(inv: { open: boolean; total: number }, paid: Payout | null): PayState {
  if (paid) return Math.abs(paid.amount - inv.total) < 0.005 ? 'paid' : 'changed';
  if (inv.open) return 'open';
  return inv.total > 0 ? 'due' : 'nothing';
}

/** What can stop an ended invoice from being paid now — said to the team, not hidden. */
export function payBlockers(inv: { open: boolean; total: number; unpriced: number; pending: number }, today: DateStr, to: DateStr): string[] {
  const out: string[] = [];
  if (inv.open || to >= today) out.push('The period has not ended yet.');
  if (!(inv.total > 0)) out.push('Nothing to pay in this period.');
  if (inv.unpriced) out.push(`${inv.unpriced} job${inv.unpriced === 1 ? ' has' : 's have'} no pay yet — price ${inv.unpriced === 1 ? 'it' : 'them'} first.`);
  if (inv.pending) out.push(`${inv.pending} waiting for the team's approval — decide ${inv.pending === 1 ? 'it' : 'them'} first.`);
  return out;
}

/** The mode a Stripe secret (or restricted) key works in; null = not a Stripe key. */
export function stripeMode(key: string): 'test' | 'live' | null {
  const m = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.exec(key.trim());
  return m ? m[2] as 'test' | 'live' : null;
}

/** Dollars to Stripe's cents, without float drift ($19.99 → 1999). */
export const toCents = (amount: number) => Math.round(amount * 100);
