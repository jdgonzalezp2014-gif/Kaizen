/**
 * GET /api/forward?asOf=yyyy-MM-dd&days=30
 *
 * What the next N nights look like from a chosen day — by default today.
 *
 * This is a different question from the one /api/portfolio answers, and
 * the difference is the reason it is a separate call. The portfolio view
 * is a LEDGER: money that happened. This is a FORECAST: nights that have
 * not happened yet, and which can still be changed by a price. A unit
 * can have had an excellent quarter and be sitting on three weeks of
 * empty calendar, and nothing in a trailing view will say so.
 *
 * The calendar is the source, not reservations: a night is open only if
 * Hostaway says it is bookable. Blocked nights (an owner stay, a
 * renovation, an iCal hold) are neither sold nor sellable, and counting
 * them as vacancy invents a discount opportunity that does not exist —
 * which is exactly the kind of confident wrong answer that gets a price
 * cut on a unit that was never available.
 */
import { fetchListings, fetchCalendars } from '../_lib/hostaway.ts';
import { db, type Env } from '../_lib/db.ts';
import { getAccount, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { addDays, today } from '../../src/lib/dates.ts';

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const started = Date.now();
  const sql = db(env) as unknown as SqlFn;
  const account = await getAccount(sql);
  if (!account?.hasHostawayKey) {
    return Response.json({ ok: false, error: 'not_configured' }, { status: 409 });
  }

  const url = new URL(request.url);
  const asOf = url.searchParams.get('asOf') || today();
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || account.fwdStudyDays));
  const to = addDays(asOf, days - 1);

  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
  const listings = await fetchListings(creds);
  const calendars = await fetchCalendars(creds, listings.map(l => l.listingId), asOf, to);

  const units = listings.map(l => {
    const cal = calendars[l.listingId] ?? [];
    const open = cal.filter(d => d.available);
    const sold = cal.filter(d => !d.available && /reserv|book/i.test(d.status));
    // Blocked is its own category, never folded into either. A unit that
    // is 100% blocked is not 100% occupied and not 100% empty; it is out
    // of service, and the only honest thing to do is say so.
    const blocked = cal.filter(d => !d.available && !/reserv|book/i.test(d.status));
    const sellable = open.length + sold.length;

    const openPrices = open.map(d => Number(d.price)).filter(n => Number.isFinite(n) && n > 0);
    const askAvg = openPrices.length
      ? Math.round(openPrices.reduce((a, b) => a + b, 0) / openPrices.length) : null;

    return {
      listingId: l.listingId,
      name: l.name,
      active: l.active,
      basePrice: l.basePrice,
      cleaningFeeCharged: l.cleaningFee,
      weeklyDiscountPct: l.weeklyDiscountPct,
      monthlyDiscountPct: l.monthlyDiscountPct,
      nights: cal.length,
      nightsOpen: open.length,
      nightsSold: sold.length,
      nightsBlocked: blocked.length,
      // Denominator is sellable nights, not calendar nights. See above.
      occupancy: sellable ? sold.length / sellable : null,
      // Revenue already on the books for the window, at calendar prices.
      onBooks: sold.reduce((a, d) => a + (Number(d.price) || 0), 0),
      askAvg,
      // The nights a discount could actually act on, soonest first —
      // this is what a pricing decision is aimed at.
      openDates: open.map(d => d.date),
      // A unit with no calendar at all is unknown, not empty.
      hasCalendar: cal.length > 0
    };
  });

  return Response.json({
    ok: true,
    meta: {
      asOf, days, to, tookMs: Date.now() - started,
      occFloorPct: account.occFloorPct,
      generatedAt: new Date().toISOString()
    },
    units
  });
};
