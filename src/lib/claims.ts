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
export const CLAIM_STATUS = ['Open', 'In progress', 'Resolved', 'Refunded', 'Dismissed'];
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
