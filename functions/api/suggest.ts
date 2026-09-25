/**
 * POST /api/suggest — ask Gemini what to do with one unit.
 *
 * The context is assembled HERE, from live Hostaway data, rather than
 * accepted from the browser. A suggestion is only as trustworthy as the
 * figures behind it, and figures posted by a client are figures anyone
 * can post.
 *
 * The answer is advice and nothing else: it never writes to Hostaway.
 * It is recorded against the unit so that when a human later changes the
 * price, what the system had advised sits beside what they actually did,
 * and `alignment` can eventually answer whether the advice was worth
 * following.
 */
import { fetchListings, fetchCalendar } from '../_lib/hostaway.ts';
import { suggestPrice, fetchLocalEvents, type PricingContext } from '../_lib/gemini.ts';
import { decrypt } from '../_lib/crypto.ts';
import { db, type Env } from '../_lib/db.ts';
import { getAccount, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { addDays, today } from '../../src/lib/dates.ts';
import { findGaps, leadTimeDays, pickup, median, portfolioAskRatio } from '../../src/lib/revenue.ts';
import { fetchStudyReservations } from '../_lib/hostaway.ts';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const b = await request.json().catch(() => ({})) as { listingId?: string; from?: string; to?: string };
  const listingId = String(b.listingId ?? '').trim();
  if (!listingId) return Response.json({ ok: false, error: 'listingId is required.' }, { status: 400 });

  const sql = db(env) as unknown as SqlFn;
  const account = await getAccount(sql);
  if (!account) return Response.json({ ok: false, error: 'No account.' }, { status: 409 });

  const keyRows = (await sql`SELECT gemini_api_key_enc, gemini_model FROM accounts WHERE id = 1`) as
    { gemini_api_key_enc: string | null; gemini_model: string }[];
  const enc = keyRows[0]?.gemini_api_key_enc;
  if (!enc) {
    return Response.json({ ok: false, error: 'no_gemini_key',
      message: 'No Gemini API key for this account. Add one in Settings — ' +
               'aistudio.google.com/apikey issues them free.' }, { status: 409 });
  }
  const apiKey = await decrypt(enc, env.ENCRYPTION_KEY);
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);

  const from = b.from || today();
  const to = b.to || addDays(from, account.fwdStudyDays - 1);

  const [listings, cal, reservations, costRow] = await Promise.all([
    fetchListings(creds),
    fetchCalendar(creds, listingId, from, to),
    fetchStudyReservations(creds, from, to),
    sql`SELECT cleaning_fee FROM units WHERE account_id = 1 AND id = ${listingId}`
  ]) as [Awaited<ReturnType<typeof fetchListings>>,
         Awaited<ReturnType<typeof fetchCalendar>>,
         Awaited<ReturnType<typeof fetchStudyReservations>>,
         { cleaning_fee: string | null }[]];

  const listing = listings.find(l => l.listingId === listingId);
  if (!listing) return Response.json({ ok: false, error: 'Unknown listing.' }, { status: 404 });

  const days = cal.map(d => ({
    d: d.date,
    s: (d.available ? 'o' : /reserv|book/i.test(d.status) ? 's' : 'b') as 'o' | 's' | 'b',
    p: d.price, m: d.minStay
  }));
  const open = days.filter(d => d.s === 'o');
  const sold = days.filter(d => d.s === 's');
  const sellable = open.length + sold.length;
  const onBooks = sold.reduce((a, d) => a + (d.p ?? 0), 0);
  const mine = reservations.filter(r => r.listingId === listingId);
  const gaps = findGaps(days);

  // The portfolio benchmarks, from units that can actually be booked.
  const parked = (await sql`SELECT id FROM units WHERE account_id = 1 AND parked = TRUE`) as
    { id: string }[];
  const parkedSet = new Set(parked.map(p => p.id));
  const peerAdrs: number[] = [];
  const peerRatios: number[] = [];
  for (const l of listings) {
    if (parkedSet.has(l.listingId) || !l.active) continue;
    const rs = reservations.filter(r => r.listingId === l.listingId && r.nights > 0 && r.totalPaid > 0);
    const n = rs.reduce((a, r) => a + r.nights, 0);
    const v = rs.reduce((a, r) => a + (r.totalPaid - r.cleaningFee), 0);
    if (n > 0) {
      const peerAdr = v / n;
      peerAdrs.push(peerAdr);
      if (l.basePrice && peerAdr > 0) peerRatios.push(l.basePrice / peerAdr);
    }
  }

  const openPrices = open.map(d => d.p).filter((n): n is number => n != null && n > 0);
  const ctx: PricingContext = {
    name: listing.name,
    windowFrom: from, windowTo: to,
    nightsOpen: open.length, nightsSold: sold.length,
    nightsBlocked: days.length - sellable,
    occupancy: sellable ? Math.round((sold.length / sellable) * 100) / 100 : null,
    portfolioMedianOccupancy: null,
    adr: sold.length ? Math.round(onBooks / sold.length) : null,
    portfolioAdr: peerAdrs.length ? Math.round(median(peerAdrs)!) : null,
    portfolioAskRatio: peerRatios.length ? Math.round(median(peerRatios)! * 100) / 100 : null,
    openAsk: openPrices.length ? Math.round(openPrices.reduce((a, x) => a + x, 0) / openPrices.length) : null,
    basePrice: listing.basePrice,
    revpan: sellable ? Math.round(onBooks / sellable) : null,
    pickup7: pickup(mine, addDays(from, -7), from, to).nights,
    leadTimeDays: leadTimeDays(mine),
    lastBookedOn: mine.map(r => r.bookedOn).filter(Boolean).sort().pop() ?? null,
    weeklyDiscountPct: listing.weeklyDiscountPct,
    monthlyDiscountPct: listing.monthlyDiscountPct,
    cleaningCharged: listing.cleaningFee,
    cleaningCost: costRow[0]?.cleaning_fee == null ? null : Number(costRow[0].cleaning_fee),
    orphanNights: gaps.filter(g => g.orphaned).reduce((a, g) => a + g.nights, 0),
    gaps: gaps.map(g => ({ from: g.from, to: g.to, nights: g.nights, minStay: g.minStay, orphaned: g.orphaned })),
    unitType: null, bedrooms: listing.bedrooms, capacity: listing.capacity,
    city: listing.city, state: listing.state,
    localEvents: null
  };

  // Searched before the recommendation so the model can weigh it, and
  // kept optional: if the lookup fails the advice still happens, just
  // without this input.
  const model = keyRows[0]!.gemini_model || 'gemini-3.6-flash';
  const events = await fetchLocalEvents(apiKey, model, listing.city, listing.state, from, to);
  ctx.localEvents = events.text;

  let suggestion;
  try {
    suggestion = await suggestPrice(apiKey, model, ctx);
    suggestion.events = events.text;
    suggestion.eventSources = events.sources;
    suggestion.eventsError = events.error;
  } catch (err) {
    return Response.json({ ok: false, error: 'gemini_failed',
      message: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }

  // Recorded as advice, with push_status 'none' — nothing was changed.
  // When a human later moves this price, the advice is already on file
  // and `alignment` becomes answerable instead of anecdotal.
  const known = (await sql`SELECT 1 FROM units WHERE account_id = 1 AND id = ${listingId}`) as unknown[];
  if (known.length) {
    await sql`
      INSERT INTO pricing_decisions
        (account_id, unit_id, origin, basis, old_price, base_rate,
         window_start, window_end, occupancy_at, nights_open, nights_total,
         actor, suggested, note, push_status)
      VALUES (1, ${listingId}, 'agent', 'window', ${ctx.openAsk}, ${suggestion.suggestedRate},
              ${from}, ${to}, ${ctx.occupancy}, ${open.length}, ${sellable},
              ${who.email}, ${suggestion.action}, ${suggestion.reasoning}, 'none')
    `;
  }

  return Response.json({ ok: true, suggestion, context: ctx });
};
