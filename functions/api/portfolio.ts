/**
 * GET /api/portfolio
 *
 * One call, everything a session needs: live Hostaway reservations and
 * listings, plus the costs and claims the team has entered. The browser
 * then computes every date range itself (CONTEXT.md §7), so this is hit
 * once on load rather than once per interaction — which is what makes a
 * 1–3 second Hostaway sweep acceptable here.
 */
import { fetchAllReservations, fetchListings } from '../_lib/hostaway.ts';
import { db, type Env } from '../_lib/db.ts';
import { getAccount, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { addDays, today } from '../../src/lib/dates.ts';

interface CostRowDb {
  unit_id: string | null; shared: boolean;
  start_date: string; end_date: string | null;
  category: string; frequency: string; amount: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const started = Date.now();
  const now = today();
  // Three years back by default. Reservations are fetched one call per
  // listing WITH a date range, so widening the window costs no extra
  // requests — only a larger response. Hostaway is the system of record
  // for booking history; there is no reason to ask it for less than it has.
  const from = addDays(now, -Number(env.LEDGER_BACK_DAYS ?? 1095));
  const to   = addDays(now,  Number(env.LEDGER_FWD_DAYS ?? 365));

  const sql = db(env) as unknown as SqlFn;

  // Credentials come from the account row, decrypted per request — the
  // same path every tenant uses. Nothing here reads the environment for
  // them, which is what stops this working for exactly one customer.
  const account = await getAccount(sql);
  if (!account?.hasHostawayKey) {
    return Response.json({
      ok: false, error: 'not_configured',
      message: 'No Hostaway credentials for this account. Add them in Settings.'
    }, { status: 409 });
  }
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);

  // Hostaway and Postgres are independent; there is no reason to wait for
  // one before starting the other.
  const [listings, reservations, expenses, claims, parkedRows] = await Promise.all([
    fetchListings(creds),
    fetchAllReservations(creds, from, to),
    sql`SELECT unit_id, shared, start_date, end_date, category, frequency, amount
        FROM expenses WHERE end_date IS NULL OR end_date >= ${from}` as unknown as Promise<CostRowDb[]>,
    sql`SELECT unit_id, occurred_on, category, severity, status, refund, repair_cost
        FROM claims WHERE occurred_on >= ${from}`,
    // The parked verdict, computed at sync time. Reading it costs one
    // cheap query; recomputing it would cost 27 calendar requests on
    // every dashboard load.
    sql`SELECT id FROM units WHERE account_id = 1 AND parked = TRUE` as unknown as Promise<{ id: string }[]>
  ]);

  // A unit blocked solid for the next 45 days is not taking bookings,
  // whatever Hostaway's flag says. Counting it drags every per-unit
  // average down and sets the portfolio target against units nobody
  // could book — 27 × the target instead of 23 × it, on this account.
  const parked = new Set((parkedRows as { id: string }[]).map(r => r.id));
  // Who the TARGET is measured against. The history is a different
  // question and counts every listing, archived ones included — see the
  // dataset the browser builds.
  const active = listings.filter(l => l.active && !parked.has(l.listingId));
  const perUnitTarget = account.targetNetPerUnit;

  return Response.json({
    meta: {
      user: who.email,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - started,
      window: { from, to },
      occFloorPct: account.occFloorPct,
      // Targets are derived, never stored: taking a unit offline must move
      // the target rather than make the portfolio look like it missed.
      targets: {
        perUnitNet: perUnitTarget,
        activeUnits: active.length,
        inactiveUnits: listings.length - active.length,
        parkedUnits: parked.size,
        portfolioNet: active.length * perUnitTarget,
        basis: `${active.length} unit(s) taking bookings × ${perUnitTarget}` +
               (parked.size ? ` · ${parked.size} parked, excluded` : '')
      }
    },
    listings,
    reservations,
    // Shape matches src/lib/finance.ts CostRow so the client can prorate
    // without a translation step.
    costs: expenses.map(e => ({
      listingId: e.unit_id ?? '',
      shared: e.shared || !e.unit_id,
      start: e.start_date,
      end: e.end_date ?? '',
      category: e.category,
      frequency: e.frequency,
      amount: Number(e.amount),
      source: e.frequency === 'Monthly' ? 'fixed' : 'variable'
    })),
    claims
  });
};
