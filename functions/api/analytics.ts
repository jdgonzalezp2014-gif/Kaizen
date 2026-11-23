/**
 * GET /api/analytics?from=&to= — the rows behind Finance → Analytics (owner, 2026-11-23).
 *
 * The range asked for AND the one just before it, of the same length, so the executive summary can say "vs the
 * previous week" without a second round trip. Hostaway is read live (reservations, reviews), as everywhere in
 * finance; the money is the `expenses` table — everything spent reaches it (§137) — plus Stripe's fee on portal sales,
 * the same lines Revenue counts. Monthly lines (rent, utilities) are left out: a week's share of them waits for the
 * monthly view (finance.md, open items). The screen computes every figure (src/lib/analytics.ts).
 */
import { fetchGuestReviews, fetchListings, fetchReservationsTouching } from '../_lib/hostaway.ts';
import { db, type Env } from '../_lib/db.ts';
import { getAccount, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { addDays, daysBetween, todayIn } from '../../src/lib/dates.ts';
import { caseResult, isUpsell } from '../../src/lib/claims.ts';
import { portalFeeCosts, portalIncome } from '../../src/lib/guest-payments.ts';
import { guestPaymentsBetween } from '../_lib/guest-payments.ts';
import { weekOf } from '../../src/lib/analytics.ts';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** A quarter at most: the range is two Hostaway sweeps wide (it and the one before). */
const MAX_DAYS = 92;

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const url = new URL(request.url);
  const qf = url.searchParams.get('from') ?? '', qt = url.searchParams.get('to') ?? '';
  // Default: the last full week, Sunday to Saturday — the one there is something to say about.
  const last = weekOf(addDays(todayIn('America/New_York'), -7));
  let from = ISO.test(qf) ? qf : last.from;
  let to = ISO.test(qt) && qt >= from ? qt : (ISO.test(qf) ? addDays(from, 6) : last.to);
  if (daysBetween(from, to) >= MAX_DAYS) to = addDays(from, MAX_DAYS - 1);
  const len = daysBetween(from, to) + 1;
  const prevFrom = addDays(from, -len), prevTo = addDays(from, -1);

  const sql = db(env) as unknown as SqlFn;
  const account = await getAccount(sql);
  if (!account?.hasHostawayKey) {
    return Response.json({ ok: false, error: 'not_configured', message: 'No Hostaway credentials for this account. Add them in Settings.' }, { status: 409 });
  }
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);

  // Reviews are an extra: if Hostaway refuses them, the money and the nights still answer.
  let reviewError: string | null = null;
  const reviewsOr = <T,>(p: Promise<T[]>) => p.catch(e => { reviewError = e instanceof Error ? e.message : String(e); return [] as T[]; });

  const [listings, stays, costs, cleans, parked, claims, portal, reviews, departures, pending] = await Promise.all([
    fetchListings(creds),
    fetchReservationsTouching(creds, prevFrom, to),
    // One-offs only. The cleaner comes from the line's own note ('Cleaner: X · clean key', written by syncCleaningCosts).
    sql`SELECT e.id::text AS id, e.start_date::text AS on, e.unit_id, e.category, e.amount::float8 AS amount, e.label, e.source,
               CASE WHEN e.source IN ('cleaning', 'cleaning_extra') THEN substring(e.notes from '^Cleaner: (.*?) · clean') END AS cleaner
          FROM expenses e
         WHERE e.account_id = 1 AND e.frequency = 'One-time' AND e.start_date BETWEEN ${prevFrom} AND ${to}`,
    // The cleans themselves — priced or not yet — for the count and who did them.
    sql`SELECT key, checkout_on::text AS on, unit_id, unit_name, cleaner, price::float8 AS price, deep
          FROM cleanings
         WHERE account_id = 1 AND void_reason IS NULL AND assignment = 'assigned' AND checkout_on BETWEEN ${prevFrom} AND ${to}`,
    sql`SELECT id FROM units WHERE account_id = 1 AND parked = TRUE`,
    // Claims & upsells, Kaizen's part, dated when received — the same rows /api/portfolio counts (§167).
    sql`SELECT c.unit_id, c.received_on::text AS on_day, c.category, c.refund::float8 AS received, COALESCE(w.owner_work, 0)::float8 AS owner_work
          FROM claims c LEFT JOIN claim_work w ON w.account_id = c.account_id AND w.claim_id = c.id::text
         WHERE c.account_id = 1 AND c.deleted_at IS NULL AND c.refund > 0 AND c.received_on BETWEEN ${prevFrom} AND ${to}`,
    guestPaymentsBetween(sql, prevFrom, to),
    reviewsOr(fetchGuestReviews(creds, { submittedFrom: prevFrom, submittedTo: to })),
    // Who checked out in the range and whether they reviewed yet — the response rate.
    reviewsOr(fetchGuestReviews(creds, { departureFrom: from, departureTo: to })),
    // Owner, 2026-11-23: "every expense has to show". Money asked for in the field (a handyman's labour or materials, a
    // cleaner's purchase) reaches Costs only once approved — so what still waits is listed apart, any age, never summed in.
    sql`SELECT id::text, (created_at AT TIME ZONE 'America/New_York')::date::text AS on, source, by_name, unit_id, category,
               amount::float8 AS amount, description, todo_id::text AS todo_id
          FROM field_expenses WHERE account_id = 1 AND status = 'pending' ORDER BY created_at`
  ]);

  const parkedIds = new Set((parked as { id: string }[]).map(r => r.id));
  const fees = portalFeeCosts(portal).map((c, i) => ({
    id: `fee-${i}`, on: c.start, unit_id: c.listingId || null, category: c.category, amount: c.amount, label: 'Stripe fee — guest portal', source: 'stripe', cleaner: null
  }));

  return Response.json({
    ok: true,
    range: { from, to, days: len }, previous: { from: prevFrom, to: prevTo },
    asOf: todayIn('America/New_York'),
    units: listings.map(l => ({ id: l.listingId, name: l.name, live: l.active && !parkedIds.has(l.listingId) })),
    stays: stays.map(s => ({
      listingId: s.listingId, reservationId: s.reservationId, arrival: s.arrival, departure: s.departure, guestName: s.guestName ?? null,
      totalPaid: s.totalPaid, cleaningFee: s.cleaningFee, taxes: s.taxes, channelFee: s.channelFee, channel: s.channel
    })),
    costs: [...(costs as Record<string, unknown>[]).map(c => ({
      id: c.id, on: c.on, unitId: c.unit_id ?? null, category: c.category, amount: c.amount, label: c.label ?? null, source: c.source ?? 'manual', cleaner: c.cleaner ?? null
    })), ...fees.map(f => ({ id: f.id, on: f.on, unitId: f.unit_id, category: f.category, amount: f.amount, label: f.label, source: f.source, cleaner: null }))],
    cleans: (cleans as Record<string, unknown>[]).map(c => ({
      key: c.key, on: c.on, unitId: c.unit_id ?? null, unit: c.unit_name, cleaner: c.cleaner ?? null, price: c.price ?? null, deep: !!c.deep
    })),
    income: [...(claims as { unit_id: string | null; on_day: string; category: string | null; received: number; owner_work: number }[])
      .map(c => ({ unitId: c.unit_id, on: c.on_day, amount: caseResult({ requested: 0, received: c.received, repairWork: 0, ownerWork: c.owner_work }).kept,
                   kind: isUpsell(c.category) ? 'upsell' : 'claim' }))
      .filter(c => c.amount > 0), ...portalIncome(portal)],
    pending: (pending as Record<string, unknown>[]).map(p => ({
      id: p.id, on: p.on, who: p.by_name, kind: p.source === 'vendor' ? 'Handyman' : p.source === 'cleaner' ? 'Cleaner' : 'Helper',
      unitId: p.unit_id ?? null, category: p.category, amount: p.amount, description: p.description, todoId: p.todo_id ?? null
    })),
    reviews, departures: departures.map(d => ({ listingId: d.listingId, status: d.status })),
    reviewError
  });
};
