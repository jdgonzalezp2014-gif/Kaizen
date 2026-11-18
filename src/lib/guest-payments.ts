/**
 * What the guest portal sold, as money (owner, 2026-11-17): every Stripe payment the portal takes is Kaizen's income —
 * the damage waiver and each extra, by kind — and what Stripe keeps is a cost ("Payment fees"). Extras are paid on the
 * spot; nothing waits for the team's OK, so a payment IS the sale.
 *
 * Pure: the server records `guest_payments` rows (functions/_lib/guest-pay.ts); this turns them into income and cost
 * rows for the same proration as everything else. Test-mode payments are kept and listed, never counted.
 */
import type { CostRow, IncomeRow } from './finance.ts';

/** One line of a payment. `item` = an upsell kind, `waiver` or `deposit`; `hold` = held on the card, not charged. */
export interface PaidLine { item: string; label: string; amount: number; hold?: boolean }

export interface GuestPayment {
  id: string;                 // the Checkout Session
  livemode: boolean;
  reservationId: string | null;
  unitId: string | null;      // the Hostaway listing, when the page knew it
  unitName: string | null;
  guest: string | null;
  lines: PaidLine[];
  amount: number;             // what Stripe collected (a held payment: what was authorised)
  fee: number | null;         // Stripe's fee, once the charge settled
  refunded: number;
  status: 'paid' | 'held' | 'refunded';
  paidOn: string;             // YYYY-MM-DD, the day the guest paid
}

export const ITEM_LABEL: Record<string, string> = {
  waiver: 'Damage waiver', deposit: 'Security deposit', 'extra-nights': 'Extra nights', 'early-checkin': 'Early check-in',
  'late-checkout': 'Late check-out', 'mid-clean': 'Mid-stay clean', pet: 'Pet fee', crib: 'Crib', welcome: 'Welcome basket',
  parking: 'Covered parking',
};
export const itemLabel = (item: string) => ITEM_LABEL[item] ?? item.replace(/[-_]/g, ' ').replace(/^./, c => c.toUpperCase());

export const PAYMENT_FEES = 'Payment fees';

/**
 * Stripe metadata holds 500 characters a value: the lines travel as `item:amount` (held lines `~item:amount`), and the
 * labels are rebuilt from the item. Eight lines at most (the checkout's own limit) fit easily.
 */
export function encodeLines(lines: PaidLine[]): string {
  return lines.map(l => `${l.hold ? '~' : ''}${l.item.replace(/[^a-z0-9-]/gi, '').slice(0, 24) || 'other'}:${Math.round(l.amount * 100) / 100}`).join('|').slice(0, 500);
}
export function decodeLines(s: string | null | undefined): PaidLine[] {
  return String(s ?? '').split('|').map(x => /^(~?)([a-z0-9-]+):(\d+(?:\.\d+)?)$/i.exec(x.trim())).filter(Boolean)
    .map(m => ({ item: m![2]!, label: itemLabel(m![2]!), amount: Number(m![3]), ...(m![1] ? { hold: true } : {}) }));
}

/** What was charged (not held), less what was refunded, line by line — refunds come off every line in proportion. */
export function keptLines(p: Pick<GuestPayment, 'lines' | 'refunded' | 'status'>): PaidLine[] {
  if (p.status !== 'paid') return [];
  const charged = p.lines.filter(l => !l.hold);
  const gross = charged.reduce((a, l) => a + l.amount, 0);
  const k = gross > 0 ? Math.max(0, gross - p.refunded) / gross : 0;
  return charged.map(l => ({ ...l, amount: Math.round(l.amount * k * 100) / 100 })).filter(l => l.amount > 0);
}

/** Income for the books: live payments only, one row per kept line, dated the day the guest paid. */
export function portalIncome(ps: GuestPayment[]): IncomeRow[] {
  return ps.filter(p => p.livemode).flatMap(p => keptLines(p).map(l => ({ unitId: p.unitId, on: p.paidOn, amount: l.amount, kind: 'portal' as const })));
}

/** Stripe's fee on each live payment, a one-off cost the day it was paid (shared when the unit is unknown). */
export function portalFeeCosts(ps: GuestPayment[]): CostRow[] {
  return ps.filter(p => p.livemode && (p.fee ?? 0) > 0).map(p => ({ listingId: p.unitId ?? '', shared: !p.unitId, start: p.paidOn, end: p.paidOn,
    category: PAYMENT_FEES, frequency: 'One-time', amount: p.fee!, source: 'variable' as const }));
}

/** Sales by item over a set of payments: what Revenue → Portal sales shows. */
export function salesByItem(ps: GuestPayment[]): { item: string; label: string; count: number; amount: number }[] {
  const m = new Map<string, { count: number; amount: number }>();
  for (const p of ps) for (const l of keptLines(p)) { const e = m.get(l.item) ?? { count: 0, amount: 0 }; e.count++; e.amount += l.amount; m.set(l.item, e); }
  return [...m.entries()].map(([item, e]) => ({ item, label: itemLabel(item), count: e.count, amount: Math.round(e.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount);
}
