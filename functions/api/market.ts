/**
 * GET /api/market?listingId=…&from=…&to=…
 *
 * What the outside world sees: where the unit is published, and what a
 * guest is actually shown on Airbnb for the selected nights.
 *
 * Publication comes from Hostaway and is certain. The rating and the
 * quoted price come from the listing page and are best-effort — so the
 * two are reported separately and the second always says why it failed
 * when it does. A dashboard that shows a blank rating for "blocked by
 * Airbnb" and for "this listing has no reviews" is lying about one of
 * them.
 */
import { fetchListings } from '../_lib/hostaway.ts';
import { readListing } from '../_lib/airbnb.ts';
import { decrypt } from '../_lib/crypto.ts';
import { db, type Env } from '../_lib/db.ts';
import { getAccount, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { addDays, today } from '../../src/lib/dates.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const url = new URL(request.url);
  const listingId = String(url.searchParams.get('listingId') ?? '').trim();
  if (!listingId) return Response.json({ ok: false, error: 'listingId is required.' }, { status: 400 });

  const sql = db(env) as unknown as SqlFn;
  const account = await getAccount(sql);
  if (!account?.hasHostawayKey) return Response.json({ ok: false, error: 'not_configured' }, { status: 409 });

  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
  const listing = (await fetchListings(creds)).find(l => l.listingId === listingId);
  if (!listing) return Response.json({ ok: false, error: 'Unknown listing.' }, { status: 404 });

  const from = url.searchParams.get('from') || addDays(today(), 14);
  const to   = url.searchParams.get('to')   || addDays(from, 2);

  const airbnb = listing.channels.find(c => c.key === 'airbnb')!;

  // Publication is the part that is always answerable, so it is returned
  // whether or not the page read works.
  const base = {
    ok: true,
    channels: listing.channels,
    window: { from, to },
    guests: listing.capacity ?? 2
  };

  if (!airbnb.live || !airbnb.url) {
    return Response.json({
      ...base,
      page: null,
      message: airbnb.exportStatus
        ? `Airbnb export is "${airbnb.exportStatus}" with no live URL — nothing to read.`
        : 'This unit is not published to Airbnb, so it has no page, rating or public price there.'
    });
  }

  const keyRow = (await sql`SELECT jina_api_key_enc FROM accounts WHERE id = 1`) as
    { jina_api_key_enc: string | null }[];
  const jinaKey = keyRow[0]?.jina_api_key_enc
    ? await decrypt(keyRow[0].jina_api_key_enc, env.ENCRYPTION_KEY) : null;

  const page = await readListing(airbnb.url, from, to, listing.capacity ?? 2, jinaKey);

  // Recorded only when something was actually read. An append-only table
  // of nulls would bury the real observations it exists to keep, and
  // this is the series a pricing model would learn from.
  if (page.rating != null || page.nightly != null) {
    await sql`
      INSERT INTO price_observations
        (account_id, unit_id, window_start, stay_nights,
         hostaway_rate, airbnb_rate, airbnb_rating, airbnb_reviews, source, note)
      VALUES (1, ${listingId}, ${from},
              ${Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 864e5))},
              ${listing.basePrice}, ${page.nightly}, ${page.rating}, ${page.reviews},
              ${page.source}, ${page.problem})
    `;
  }

  return Response.json({ ...base, page });
};
