/**
 * Paying an invoice — a cleaner's or a handyman's (owner, 2026-10-25). One
 * payout per invoice number: through Wise (a transfer from Kaizen's Wise
 * balance to the payee's bank, owner 2026-10-28) or marked paid by hand.
 * Pure: the server and both pages read the same state.
 */
import type { DateStr } from './dates.ts';

export interface Payout {
  id: string; invoiceNumber: string; amount: number; method: 'wise' | 'manual';
  env: WiseEnv | null; transferId: string | null; status: string | null; fee: number | null; note: string | null; by: string; at: string;
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

export type WiseEnv = 'sandbox' | 'live';

/** A US routing number (ABA): 9 digits whose weighted sum (3, 7, 1, …) is a multiple of 10 — catches a typo before Wise does. */
export function routingValid(v: string): boolean {
  if (!/^\d{9}$/.test(v)) return false;
  const d = [...v].map(Number);
  return (3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!)) % 10 === 0;
}
export const accountNumberValid = (v: string) => /^\d{4,17}$/.test(v);

/** Wise's transfer states that will not move again; any other is refreshed when the card opens. */
export const WISE_FINAL = ['outgoing_payment_sent', 'cancelled', 'funds_refunded', 'bounced_back', 'charged_back'];

/** Wise's state in a few words for the card; null = nothing worth saying (sent). */
export function wiseStatusLabel(s: string | null): { text: string; bad: boolean } | null {
  if (!s || s === 'outgoing_payment_sent') return null;
  if (['cancelled', 'funds_refunded', 'bounced_back', 'charged_back'].includes(s))
    return { text: `Wise: ${s.replace(/_/g, ' ')} — the money came back; pay again or by hand`, bad: true };
  return { text: 'Wise: on its way', bad: false };
}

/** A stable id per invoice and amount: a retry finds Wise's same transfer instead of paying twice. */
export function transferUuid(hex: string): string {
  const h = hex.slice(0, 32).split('');
  h[12] = '5'; h[16] = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  const x = h.join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Dollars to cents, without float drift ($19.99 → 1999). */
export const toCents = (amount: number) => Math.round(amount * 100);
