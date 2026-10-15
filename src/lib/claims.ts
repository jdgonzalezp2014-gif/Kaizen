/**
 * What a claim can be (§77) — one list for the Claims screen and the work
 * list, so a claim logged from either reads the same.
 *
 * A claim is a CASE a guest raised, and not every case needs a repair:
 * a late checkout, an early check-in, a noise complaint are claims with
 * no work order behind them. Work is linked to a claim only when there is
 * work to do.
 */
export const CLAIM_SEVERITY = ['Low', 'Medium', 'High', 'Critical'];
/** §167: 'Paid' = closed with money received (it was 'Refunded', which read as money going back to the guest). */
export const CLAIM_STATUS = ['Open', 'In progress', 'Resolved', 'Paid', 'Dismissed'];
export const isClosedClaim = (status: string | null | undefined) => status === 'Resolved' || status === 'Paid' || status === 'Dismissed';

/**
 * The day a case closed (§167, owner 2026-10-15). Kept while the case stays closed: the edit form and Slack save
 * the whole case without it, and stamping today on every edit moved a closed case's income into the month of the
 * edit. A date sent wins; a case closing now gets `today` (New York's — the caller's); an open case has none.
 */
export function closeDate(status: string, sent: string | null | undefined,
                          before: { status: string; resolved_on: string | null } | null, today: string): string | null {
  if (!isClosedClaim(status)) return null;
  if (sent && /^\d{4}-\d{2}-\d{2}$/.test(sent)) return sent;
  if (before && isClosedClaim(before.status) && before.resolved_on) return before.resolved_on;
  return today;
}
/**
 * §162 (owner, 2026-10-15): Claims & upselling — a pet fee or a late check-in is the same case (asked, received,
 * sometimes work behind it). A reservation ALTERATION is not upselling: its price is part of the reservation and
 * counted there — only when it is collected through the Resolution Center, or no price is recorded on the
 * reservation, is it logged here.
 */
export const UPSELL_CATEGORIES = ['Pet fee', 'Early check-in', 'Late check-in', 'Late checkout', 'Extra guest', 'Other upsell'];
export const CASE_CATEGORIES = ['Damage', 'Cleanliness', 'Maintenance', 'Noise', 'Access', 'Amenity', 'Wifi', 'Safety', 'Other'];
export const CLAIM_CATEGORIES = [...CASE_CATEGORIES, ...UPSELL_CATEGORIES];
export const isUpsell = (category: string | null | undefined) => !!category && UPSELL_CATEGORIES.includes(category);
export const CLAIM_SOURCES = ['Airbnb', 'Booking.com', 'Vrbo', 'Expedia', 'Direct', 'In person'];
/** How an upsell was collected (§167, SOP #3): an alteration counts only through the Resolution Center or unpriced. */
export const COLLECTED_VIA = ['Resolution Center', 'Not priced on the reservation', 'Direct'];

/**
 * A case as money (§167, owner 2026-10-15). Requested is an estimate — what was asked for. Received is what came in.
 * Repair work is what its work orders and purchases cost (`claim_work`), already in Costs on their own. When the
 * repair was charged to the owner, it is the owner's cost and the reimbursement is the owner's up to it — Kaizen
 * keeps only the difference. Result = what Kaizen kept − what Kaizen spent: a gain or a loss, signed.
 */
export interface CaseMoney { requested: number; received: number; repairWork: number; ownerWork: number }
export function caseResult(m: CaseMoney) {
  const ownerShare = Math.min(m.received, Math.max(0, m.ownerWork));
  const kept = m.received - ownerShare;
  const spent = Math.max(0, m.repairWork - Math.max(0, m.ownerWork));
  return { ownerShare, kept, spent, result: round2(kept - spent), overRequested: m.requested > 0 ? round2(m.received - m.requested) : 0 };
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What a case's status and money must agree on (§167) — null when they do. Closed with money is Paid; Paid needs
 * money. Money while the case is open is fine (a partial payment, more to come).
 */
export function checkClaim(c: { status: string; category: string | null; received: number }): string | null {
  const what = isUpsell(c.category) ? 'the price charged' : 'what was received';
  if (c.status === 'Paid' && !(c.received > 0)) return `Paid needs ${what} — enter it first.`;
  if ((c.status === 'Resolved' || c.status === 'Dismissed') && c.received > 0) {
    return `It received $${c.received.toFixed(2)} — close it as Paid.`;
  }
  return null;
}

/** "↗ Airbnb case" — the platform a case link points at, by its host (§88). */
export function caseHost(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
  if (/airbnb\./.test(host)) return 'Airbnb';
  if (/booking\.com$/.test(host)) return 'Booking.com';
  if (/vrbo\.|homeaway\./.test(host)) return 'Vrbo';
  if (/expedia\./.test(host)) return 'Expedia';
  return host;
}
/** A case link as typed: https only, trimmed — or nothing. */
export const cleanCaseUrl = (v: string) => { const t = v.trim(); return /^https:\/\/\S+$/.test(t) ? t : null; };
