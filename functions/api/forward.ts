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

  // The calendar is pulled for whichever is longer: the window being
  // studied, or the horizon the parked test needs. One fetch, both
  // questions — the alternative is a second sweep of 27 calendars.
  const horizon = Math.max(days, account.offlineAfterDays);
  const calTo = addDays(asOf, horizon - 1);
  const parkedThrough = addDays(asOf, account.offlineAfterDays - 1);

  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
  // What the cleaner is PAID, from the host's sheet. Hostaway only knows
  // what the guest is charged, and the gap between them is margin that
  // nothing else in this app would show.
  const [listings, costRows] = await Promise.all([
    fetchListings(creds),
    sql`SELECT id, cleaning_fee FROM units WHERE account_id = 1 AND cleaning_fee IS NOT NULL`
  ]) as [Awaited<ReturnType<typeof fetchListings>>, { id: string; cleaning_fee: string }[]];
  const cleaningCost = new Map(costRows.map(r => [r.id, Number(r.cleaning_fee)]));
  const calendars = await fetchCalendars(creds, listings.map(l => l.listingId), asOf, calTo);

  const units = listings.map(l => {
    const all = calendars[l.listingId] ?? [];
    const cal = all.filter(d => d.date <= to);

    // Hostaway's own "active" flag only says the listing exists. A unit
    // whose calendar is blocked solid for the next 45 days is not taking
    // bookings whatever the flag says, and counting it as active drags
    // every portfolio average towards zero and inflates the target.
    const probe = all.filter(d => d.date <= parkedThrough);
    const parked = probe.length > 0 && probe.every(d => !d.available &&
      !/reserv|book/i.test(d.status));
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
      // Hostaway's flag, kept separate from what the calendar shows.
      listedActive: l.active,
      parked,
      parkedDays: parked ? probe.length : 0,
      active: l.active && !parked,
      basePrice: l.basePrice,
      cleaningFeeCharged: l.cleaningFee,
      cleaningCost: cleaningCost.get(l.listingId) ?? null,
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
      hasCalendar: cal.length > 0,
      // Day-level state for the date picker, compact on purpose: 27
      // units over 45 nights is a lot of JSON in long form.
      //   o = open · s = sold · b = blocked
      days: cal.map(d => ({
        d: d.date,
        s: d.available ? 'o' : /reserv|book/i.test(d.status) ? 's' : 'b',
        p: Number(d.price) || null
      }))
    };
  });

  return Response.json({
    ok: true,
    meta: {
      asOf, days, to, tookMs: Date.now() - started,
      occFloorPct: account.occFloorPct,
      offlineAfterDays: account.offlineAfterDays,
      parkedThrough,
      generatedAt: new Date().toISOString()
    },
    units
  });
};
