/**
 * Importing the Apps Script feed.
 *
 * Apps Script scrapes where scraping works, writes a sheet, and
 * publishes it as CSV. This reads that CSV. No inbound request means no
 * Cloudflare Access bypass and no shared token — and the sheet stays
 * something a person can open and check, which a POST body never is.
 *
 * The same shape as the cleanings import, which is the one integration
 * here that worked on the first try.
 */
import { parseCsv, parseAmount, pick } from './csv.ts';

/**
 * The platforms the feed can carry, and the scale each one prints on.
 *
 * Booking.com and Expedia score out of 10. Stored raw, an 8.6 sits
 * beside an Airbnb 4.8 and reads as the better property — so everything
 * is converted to a 5-point scale on the way in, once, here.
 *
 * Listed with blank ratings on purpose: the columns exist in the sheet
 * before the scraping does, so filling them later is a spreadsheet
 * change rather than a schema change on both sides.
 */
const PLATFORMS: { key: string; label: string; scale: number }[] = [
  { key: 'airbnb',     label: 'Airbnb',      scale: 5 },
  { key: 'bookingcom', label: 'Booking',     scale: 10 },
  { key: 'vrbo',       label: 'VRBO',        scale: 5 },
  { key: 'expedia',    label: 'Expedia',     scale: 10 },
  { key: 'direct',     label: 'Web Portal',  scale: 5 }
];

/**
 * Hostaway's own rating is never imported, and this is a correctness
 * rule rather than a preference.
 *
 * Listings get RECYCLED in this portfolio — an id is reused for a
 * different unit — and Hostaway carries review counts across that reuse.
 * It will also report reviews that are not visible on the platform at
 * all. So its rating is not merely incomplete, it is describing a
 * different property, and an average that includes it is confidently
 * wrong in a way no amount of it being "extra data" repairs.
 *
 * Ratings come from scraping the live page or they do not come at all.
 */
const NEVER_IMPORT = /hostaway|internal/i;

export function toFive(raw: number | null, scale: number): number | null {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  // Trust the number over the declared scale when they disagree: a 9.2
  // in a column labelled /5 is a ten-point score in the wrong column,
  // and halving it is right while rejecting it loses a real reading.
  const s = raw > 5 ? 10 : scale;
  const out = s === 10 ? raw / 2 : raw;
  return out > 0 && out <= 5 ? Math.round(out * 100) / 100 : null;
}

export interface FeedResult {
  ok: boolean;
  rows: number;
  written: number;
  duplicates: number;
  unmatched: string[];
  problem: string | null;
}

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export async function importFeed(sql: Sql, url: string): Promise<FeedResult> {
  const fail = (problem: string): FeedResult =>
    ({ ok: false, rows: 0, written: 0, duplicates: 0, unmatched: [], problem });

  if (!/^https:\/\/docs\.google\.com\//.test(url)) {
    return fail('That is not a docs.google.com URL. Paste the published-CSV link, not the editing link.');
  }

  let csv: string;
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    csv = await res.text();
  } catch (e) {
    return fail(`Could not read the feed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // A sheet that is shared but not PUBLISHED serves a sign-in page with
  // a 200 and a body full of HTML, which parses to zero rows and reads
  // as "the feed is empty" rather than "it was never readable".
  if (/^\s*</.test(csv)) {
    return fail('That URL returned a web page, not CSV — the sheet is shared but not published. ' +
                'Use File → Share → Publish to web.');
  }

  const units = (await sql`SELECT id, name FROM units WHERE account_id = 1`) as
    { id: string; name: string }[];
  if (!units.length) return fail('No units synced yet — rows are matched by name and id.');

  const byId = new Set(units.map(u => u.id));
  const byName = new Map(units.map(u => [u.name.toLowerCase().replace(/\s+/g, ''), u.id]));

  const rows = parseCsv(csv);
  const unmatched: string[] = [];
  let written = 0, duplicates = 0;

  for (const r of rows) {
    const rawId = pick(r, 'listing id', 'listingid', 'unit id');
    const name = pick(r, 'unit', 'internal name', 'listing', 'name');
    const id = rawId && byId.has(rawId) ? rawId
             : byName.get(name.toLowerCase().replace(/\s+/g, ''));
    if (!id) {
      const label = name || rawId || '(blank)';
      if (!unmatched.includes(label)) unmatched.push(label);
      continue;
    }

    const rating = parseAmount(pick(r, 'airbnb rating', 'rating', 'airbnb star'));
    const total = parseAmount(pick(r, 'airbnb total', 'total', 'stay total'));
    const nights = parseAmount(pick(r, 'nights', 'stay nights'));
    // The feed carries the total; the nightly figure is derived here so
    // one place owns that division. A total stored as a nightly rate is
    // wrong by a factor, and this project has made that mistake before.
    const nightly = (total != null && nights != null && nights > 0)
      ? Math.round(total / nights) : parseAmount(pick(r, 'airbnb nightly', 'nightly'));

    if (rating == null && total == null && nightly == null) continue;

    const windowStart = pick(r, 'check-in', 'checkin', 'window start') || null;
    const readAt = pick(r, 'read at', 'readat', 'observed at', 'updated') || '';
    // Identifies the READING, not the row: re-importing an unchanged
    // sheet becomes a no-op instead of a second identical observation.
    const feedKey = `${id}|${windowStart ?? ''}|${readAt}`;

    const out = (await sql`
      INSERT INTO price_observations
        (account_id, unit_id, window_start, window_end, stay_nights,
         hostaway_rate, airbnb_rate, airbnb_total, airbnb_rating, airbnb_reviews,
         source, feed_key)
      VALUES (1, ${id}, ${windowStart}, ${pick(r, 'check-out', 'checkout', 'window end') || null},
              ${nights}, ${parseAmount(pick(r, 'per night', 'hostaway rate'))},
              ${nightly}, ${total}, ${rating},
              ${parseAmount(pick(r, 'airbnb reviews', 'reviews', 'airbnb count'))},
              'sheet-feed', ${feedKey})
      ON CONFLICT (account_id, feed_key) WHERE feed_key IS NOT NULL DO NOTHING
      RETURNING id
    `) as unknown[];

    if (out.length) written++; else duplicates++;

    // Per-platform state, upserted: this is what each channel says about
    // the unit NOW, not a series. Blank columns leave the row alone
    // rather than overwriting a known rating with a null — the sheet not
    // carrying Booking yet must not erase a Booking rating that arrived
    // some other way.
    for (const pf of PLATFORMS) {
      if (NEVER_IMPORT.test(pf.label)) continue;
      const rating = toFive(parseAmount(pick(r, `${pf.label} rating`, `${pf.label} star`)), pf.scale);
      const reviews = parseAmount(pick(r, `${pf.label} reviews`, `${pf.label} count`));
      const url = pick(r, `${pf.label} url`, `${pf.label} link`, pf.label);
      if (rating == null && reviews == null && !url) continue;

      await sql`
        INSERT INTO listing_platforms
          (account_id, unit_id, platform, listed, url, rating, reviews, source, observed_at)
        VALUES (1, ${id}, ${pf.key}, ${url ? true : null}, ${url || null},
                ${rating}, ${reviews == null ? null : Math.round(reviews)}, 'sheet-feed', now())
        ON CONFLICT (account_id, unit_id, platform) DO UPDATE SET
          listed  = COALESCE(EXCLUDED.listed,  listing_platforms.listed),
          url     = COALESCE(EXCLUDED.url,     listing_platforms.url),
          rating  = COALESCE(EXCLUDED.rating,  listing_platforms.rating),
          reviews = COALESCE(EXCLUDED.reviews, listing_platforms.reviews),
          source = EXCLUDED.source, observed_at = now()
      `;
    }
  }

  return { ok: true, rows: rows.length, written, duplicates, unmatched, problem: null };
}
