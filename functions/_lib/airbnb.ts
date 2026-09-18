/**
 * Reading a live Airbnb listing page.
 *
 * Two facts about this, both measured rather than assumed:
 *
 *   · A plain request gets a 3 kB JavaScript shell with no rating, no
 *     price and no JSON-LD in it. There is nothing to parse.
 *   · Through a datacenter IP, the room URL redirects to Airbnb's home
 *     page — a 200 with the wrong document, which is worse than an
 *     error because it parses cleanly to nothing.
 *
 * So the fetch goes through a rendering reader, and every response is
 * checked for BEING THE RIGHT PAGE before anything is extracted. The
 * result always says which stage produced it, because "no rating on this
 * listing" and "we were served someone else's page" must never look the
 * same in a dashboard.
 */
import { readRating, readNightlyPrice, normalizeRating } from '../../src/lib/scrape.ts';

export interface PageRead {
  ok: boolean;
  /** 5-point rating, whatever the source scale was. */
  rating: number | null;
  reviews: number | null;
  nightly: number | null;
  source: string | null;
  /** Why it failed, in a sentence, when it did. */
  problem: string | null;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** The listing page for a specific stay, so the price is for those nights. */
export function stayUrl(base: string, from: string, to: string, guests = 2): string {
  const u = new URL(base);
  u.searchParams.set('check_in', from);
  u.searchParams.set('check_out', to);
  u.searchParams.set('adults', String(guests));
  return u.toString();
}

/**
 * Is this the listing page we asked for, or something else with a 200?
 *
 * Airbnb answers a blocked request with its home page or a soft 404,
 * both of which parse to "no rating found" and would otherwise be
 * reported as a listing with no reviews.
 */
export function looksLikeListing(html: string, roomId: string): string | null {
  if (!html || html.length < 20_000) return 'The page came back nearly empty — a JavaScript shell, not the listing.';
  if (/helpful_404|We can.t seem to find the page|page not found/i.test(html)) return 'Airbnb returned a "not found" page for this listing.';
  if (/captcha|are you a robot|access to this page has been denied/i.test(html)) return 'Airbnb served a bot challenge instead of the listing.';
  // The home page has neither the room id nor any per-listing markup.
  if (roomId && !html.includes(roomId)) return 'The reader was redirected away from the listing — Airbnb served a different page.';
  return null;
}

async function viaReader(url: string, jinaKey: string | null): Promise<{ html: string; status: number }> {
  const headers: Record<string, string> = {
    'X-Return-Format': 'html',
    'X-Timeout': '30',
    'x-no-cache': 'true'
  };
  if (jinaKey) headers['Authorization'] = `Bearer ${jinaKey}`;
  const r = await fetch('https://r.jina.ai/' + encodeURIComponent(url), { headers });
  return { html: r.ok ? await r.text() : '', status: r.status };
}

export async function readListing(
  base: string, from: string, to: string, guests: number, jinaKey: string | null
): Promise<PageRead> {
  const roomId = (base.match(/\/rooms\/(\d+)/) ?? [])[1] ?? '';
  const url = stayUrl(base, from, to, guests);
  const fail = (problem: string): PageRead =>
    ({ ok: false, rating: null, reviews: null, nightly: null, source: null, problem });

  // Stage 1: straight at the origin. Free and instant when it works,
  // and on this account it never does — kept because it costs one
  // request to find out and it is the only stage with no dependency.
  let html = '';
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml',
                 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'currency=USD' },
      redirect: 'follow'
    });
    if (r.ok) html = await r.text();
  } catch { /* fall through to the reader */ }

  let stage = 'direct';
  if (looksLikeListing(html, roomId)) {
    const r = await viaReader(url, jinaKey).catch(() => ({ html: '', status: 0 }));
    if (r.status === 429) {
      return fail(jinaKey
        ? 'The reader is rate-limited on this key right now.'
        : 'The reader is rate-limited. Add a Jina API key in Settings for a higher limit and residential egress.');
    }
    html = r.html;
    stage = 'reader';
  }

  const wrong = looksLikeListing(html, roomId);
  if (wrong) {
    return fail(jinaKey ? wrong
      : `${wrong} Airbnb blocks datacenter addresses; a Jina API key in Settings routes the request differently.`);
  }

  const rt = readRating(html);
  const pr = readNightlyPrice(html);
  return {
    ok: rt.rating != null || pr.nightly != null,
    rating: normalizeRating(rt.rating, rt.scale),
    reviews: rt.count,
    nightly: pr.nightly,
    source: `${stage}/${rt.source ?? pr.source ?? 'none'}`,
    problem: rt.rating == null && pr.nightly == null
      ? 'The page loaded but neither a rating nor a price could be read from it.' : null
  };
}
