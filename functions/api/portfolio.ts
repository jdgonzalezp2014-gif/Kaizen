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
import { appConfig, configNumber, db, type Env } from '../_lib/db.ts';
import { userEmail } from '../_lib/auth.ts';
import { addDays, today } from '../../src/lib/dates.ts';

interface CostRowDb {
  unit_id: string | null; shared: boolean;
  start_date: string; end_date: string | null;
  category: string; frequency: string; amount: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const started = Date.now();
  const now = today();
  // Wide enough that any range the UI can ask for is already in hand.
  const from = addDays(now, -Number(env.LEDGER_BACK_DAYS ?? 400));
  const to   = addDays(now,  Number(env.LEDGER_FWD_DAYS ?? 365));

  const creds = { accountId: env.HOSTAWAY_ACCOUNT_ID, apiKey: env.HOSTAWAY_API_KEY };
  const sql = db(env);

  // Hostaway and Postgres are independent; there is no reason to wait for
  // one before starting the other.
  const [listings, reservations, expenses, claims, cfg] = await Promise.all([
    fetchListings(creds),
    fetchAllReservations(creds, from, to),
    sql`SELECT unit_id, shared, start_date, end_date, category, frequency, amount
        FROM expenses WHERE end_date IS NULL OR end_date >= ${from}` as unknown as Promise<CostRowDb[]>,
    sql`SELECT unit_id, occurred_on, category, severity, status, refund, repair_cost
        FROM claims WHERE occurred_on >= ${from}`,
    appConfig(env)
  ]);

  const active = listings.filter(l => l.active);
  const perUnitTarget = configNumber(cfg, 'TARGET_NET_PER_UNIT', 1500);

  return Response.json({
    meta: {
      user: userEmail(request),
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - started,
      window: { from, to },
      // Targets are derived, never stored: taking a unit offline must move
      // the target rather than make the portfolio look like it missed.
      targets: {
        perUnitNet: perUnitTarget,
        activeUnits: active.length,
        inactiveUnits: listings.length - active.length,
        portfolioNet: active.length * perUnitTarget,
        basis: `${active.length} active unit(s) × ${perUnitTarget}`
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
