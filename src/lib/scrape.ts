/**
 * Pulling a rating and a nightly price out of a listing page.
 *
 * Pure string work, no fetch — so the awkward part (what real markup
 * looks like) is testable without a network, and the fragile part
 * (someone else's HTML changing) fails in a test rather than in a
 * dashboard.
 *
 * A LADDER, cheapest and most reliable first:
 *   1. JSON-LD  — a published schema.org contract, the only stage that
 *                 is meant to be machine-read
 *   2. embedded state JSON — specific key names only
 *   3. meta tags
 * A model is never asked to read a number a parser can find.
 */

export interface RatingRead {
  rating: number | null;
  /** 5 or 10 — what the number is out of, as printed. */
  scale: number;
  count: number | null;
  source: 'json-ld' | 'state-json' | 'meta' | null;
}

const EMPTY: RatingRead = { rating: null, scale: 5, count: null, source: null };

/** Everything lands on a 5-point scale so platforms compare. */
export function normalizeRating(rating: number | null, scale: number): number | null {
  if (rating == null || !Number.isFinite(rating)) return null;
  const s = Number(scale) || (rating > 5 ? 10 : 5);
  const out = s === 10 ? rating / 2 : rating;
  return out > 0 && out <= 5 ? Math.round(out * 100) / 100 : null;
}

function walkForAggregate(node: unknown, depth = 0): RatingRead | null {
  if (!node || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = walkForAggregate(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node !== 'object') return null;

  const o = node as Record<string, any>;
  const agg = o.aggregateRating ?? (String(o['@type']) === 'AggregateRating' ? o : null);
  if (agg && agg.ratingValue != null) {
    const rating = parseFloat(String(agg.ratingValue));
    if (Number.isFinite(rating) && rating > 0) {
      const count = parseFloat(String(agg.reviewCount ?? agg.ratingCount ?? ''));
      return {
        rating,
        scale: parseFloat(String(agg.bestRating ?? '')) || (rating > 5 ? 10 : 5),
        count: Number.isFinite(count) ? Math.round(count) : null,
        source: 'json-ld'
      };
    }
  }
  for (const k of Object.keys(o)) {
    const hit = walkForAggregate(o[k], depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function ratingFromJsonLd(html: string): RatingRead | null {
  const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const hit = walkForAggregate(JSON.parse(m[1]!.trim()));
      if (hit) return hit;
    } catch { /* one malformed block must not stop the others */ }
  }
  return null;
}

/*
 * Specific key names only.
 *
 * Generic ones — "score", "value", "rating" on its own — match all kinds
 * of unrelated numbers in a page this size and produce confident
 * nonsense. Every name here is one a platform actually uses.
 */
const RATING_KEYS = [
  'guestSatisfactionOverall', 'starRating', 'averageRating', 'avgRating',
  'reviewScore', 'ratingValue', 'overallRating', 'reviewRating',
  'reviewsScore', 'guestRating'
];
const COUNT_KEYS = [
  'reviewCount', 'reviewsCount', 'visibleReviewCount', 'numberOfReviews',
  'totalReviews', 'ratingCount', 'reviewScoreCount', 'reviewsTotal'
];

function firstNumberForKeys(html: string, keys: string[], min: number, max: number): number | null {
  for (const key of keys) {
    const re = new RegExp('"' + key + '"\\s*:\\s*"?(-?\\d+(?:\\.\\d+)?)"?', 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const n = parseFloat(m[1]!);
      if (Number.isFinite(n) && n >= min && n <= max) return n;
    }
  }
  return null;
}

export function ratingFromStateJson(html: string): RatingRead | null {
  const rating = firstNumberForKeys(html, RATING_KEYS, 0.5, 10);
  if (rating == null) return null;
  return {
    rating,
    scale: rating > 5 ? 10 : 5,
    count: firstNumberForKeys(html, COUNT_KEYS, 0, 1_000_000),
    source: 'state-json'
  };
}

export function ratingFromMeta(html: string): RatingRead | null {
  const val = html.match(/<meta[^>]+(?:itemprop|property|name)\s*=\s*["'][^"']*ratingValue[^"']*["'][^>]*content\s*=\s*["']([\d.]+)["']/i)
           ?? html.match(/content\s*=\s*["']([\d.]+)["'][^>]*(?:itemprop|property|name)\s*=\s*["'][^"']*ratingValue/i);
  if (!val) return null;
  const rating = parseFloat(val[1]!);
  if (!Number.isFinite(rating) || rating <= 0) return null;
  const cnt = html.match(/(?:itemprop|property|name)\s*=\s*["'][^"']*(?:reviewCount|ratingCount)[^"']*["'][^>]*content\s*=\s*["'](\d+)["']/i);
  return {
    rating, scale: rating > 5 ? 10 : 5,
    count: cnt ? parseInt(cnt[1]!, 10) : null,
    source: 'meta'
  };
}

export function readRating(html: string): RatingRead {
  if (!html) return EMPTY;
  return ratingFromJsonLd(html) ?? ratingFromStateJson(html) ?? ratingFromMeta(html) ?? EMPTY;
}

/*
 * The nightly price a GUEST is quoted.
 *
 * Deliberately narrow. Airbnb's page carries several money figures —
 * the total, the pre-discount strike-through, fees — and picking the
 * wrong one produces a comparison that is wrong by a factor rather than
 * by a margin. Anything not recognised comes back null, because "we
 * could not read it" is a usable answer and a wrong price is not.
 */
export interface PriceRead { nightly: number | null; source: string | null }

const PRICE_KEYS = [
  'priceWithoutDiscount', 'discountedPrice', 'amountFormatted',
  'rateWithServiceFee', 'basePrice', 'nightlyPrice', 'price'
];

export function readNightlyPrice(html: string, opts: { min?: number; max?: number } = {}): PriceRead {
  if (!html) return { nightly: null, source: null };
  const min = opts.min ?? 20;
  const max = opts.max ?? 5000;

  for (const key of PRICE_KEYS) {
    const re = new RegExp('"' + key + '"\\s*:\\s*"?\\$?([\\d,]+(?:\\.\\d+)?)"?', 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const n = parseFloat(m[1]!.replace(/,/g, ''));
      // A plausibility band, not a guess: a "price" of 3 or of 90,000 is
      // a different field that happens to share the name.
      if (Number.isFinite(n) && n >= min && n <= max) return { nightly: Math.round(n), source: key };
    }
  }
  return { nightly: null, source: null };
}
