/**
 * One place that turns numbers into text.
 *
 * Locale is pinned to en-US deliberately. `toLocaleString()` with no
 * locale follows the BROWSER, and on a Spanish-locale machine $66,819
 * renders as "$66.819" — which reads as sixty-six dollars and change.
 * The figures here are US dollars from a US portfolio; the reader's OS
 * language is not a reason to reformat them into a different number.
 */
const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const NUM2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const money = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : `$${NUM.format(Math.round(n))}`;

/** For costs, where cents are typed by a human and must survive. */
export const money2 = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : `$${NUM2.format(n)}`;

export const pct = (n: number | null | undefined, digits = 0): string =>
  n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(digits)}%`;

/** Signed, for a difference against a benchmark. */
export const points = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${Math.round(n)}`;

export const nights = (n: number): string => `${NUM.format(n)} night${n === 1 ? '' : 's'}`;
