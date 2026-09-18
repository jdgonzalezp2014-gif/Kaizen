/**
 * POST /api/cron — the scheduled pass.
 *
 * Three jobs that all need to happen on a clock rather than on a page
 * load, in the order their dependencies run:
 *
 *   1. resolve outcomes  — close decisions whose windows have settled
 *   2. evaluate alerts   — diff today's red listings against what has
 *                          already been announced
 *   3. send              — staged unless QUO is explicitly live
 *
 * Deliberately has no UI. It is called by a scheduler, or by hand with
 * the ingest token while there is no scheduler.
 */
import { fetchListings, fetchCalendars, fetchAllReservations } from '../_lib/hostaway.ts';
import { resolveOutcomes } from '../_lib/outcomes.ts';
import { sendSms } from '../_lib/quo.ts';
import { decrypt } from '../_lib/crypto.ts';
import { db, type Env } from '../_lib/db.ts';
import { getAccount, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify } from '../_lib/auth.ts';
import { addDays, today } from '../../src/lib/dates.ts';
import { rank, type ForwardUnit } from '../../src/lib/forward.ts';
import {
  findGaps, leadTimeDays, pickup, median, portfolioAskRatio, verdict
} from '../../src/lib/revenue.ts';
import { redListings, edges, compose } from '../../src/lib/alerts.ts';

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const sql = db(env) as unknown as SqlFn;

  // Either a signed-in person or the ingest token. A scheduler has no
  // browser, and the token is already the credential machines use here.
  const who = identify(request, env);
  if (!who) {
    const rows = (await sql`SELECT ingest_token_enc FROM accounts WHERE id = 1`) as
      { ingest_token_enc: string | null }[];
    const expected = rows[0]?.ingest_token_enc
      ? await decrypt(rows[0].ingest_token_enc, env.ENCRYPTION_KEY) : null;
    const given = request.headers.get('X-Kaizen-Ingest') ?? '';
    if (!expected || given !== expected) {
      return Response.json({ ok: false, error: 'unauthenticated' }, { status: 403 });
    }
  }

  const account = await getAccount(sql);
  if (!account?.hasHostawayKey) {
    return Response.json({ ok: false, error: 'not_configured' }, { status: 409 });
  }
  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);
  const now = today();

  // ── 1. close what has settled ────────────────────────────────────
  const outcomes = await resolveOutcomes(sql as never, creds, now);

  // ── 2. who is red ────────────────────────────────────────────────
  const to = addDays(now, account.fwdStudyDays - 1);
  const [listings, reservations] = await Promise.all([
    fetchListings(creds),
    fetchAllReservations(creds, addDays(now, -400), addDays(now, 400))
  ]);
  const calendars = await fetchCalendars(creds, listings.map(l => l.listingId), now, to);
  const parked = new Set(((await sql`SELECT id FROM units WHERE account_id = 1 AND parked`) as
    { id: string }[]).map(r => r.id));
  const costRows = (await sql`
    SELECT id, cleaning_fee FROM units WHERE account_id = 1 AND cleaning_fee IS NOT NULL
  `) as { id: string; cleaning_fee: string }[];
  const cleaning = new Map(costRows.map(r => [r.id, Number(r.cleaning_fee)]));

  const units: ForwardUnit[] = listings.map(l => {
    const cal = calendars[l.listingId] ?? [];
    const open = cal.filter(d => d.available);
    const sold = cal.filter(d => !d.available && /reserv|book/i.test(d.status));
    const sellable = open.length + sold.length;
    const onBooks = sold.reduce((a, d) => a + (Number(d.price) || 0), 0);
    const mine = reservations.filter(r => r.listingId === l.listingId);
    const prices = open.map(d => Number(d.price)).filter(n => Number.isFinite(n) && n > 0);
    const ask = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : null;
    return {
      listingId: l.listingId, name: l.name, city: l.city, state: l.state,
      listedActive: l.active, specialStatus: l.specialStatus,
      parked: parked.has(l.listingId), parkedDays: 0,
      active: l.active && !parked.has(l.listingId),
      basePrice: l.basePrice, cleaningFeeCharged: l.cleaningFee,
      cleaningCost: cleaning.get(l.listingId) ?? null,
      weeklyDiscountPct: l.weeklyDiscountPct, monthlyDiscountPct: l.monthlyDiscountPct,
      nights: cal.length, nightsOpen: open.length, nightsSold: sold.length,
      nightsBlocked: cal.length - sellable,
      occupancy: sellable ? sold.length / sellable : null,
      onBooks, askAvg: ask, openAsk: ask,
      revpan: sellable ? Math.round(onBooks / sellable) : null,
      adr: sold.length ? Math.round(onBooks / sold.length) : null,
      leadTime: leadTimeDays(mine),
      pickup7: pickup(mine, addDays(now, -7), now, to).nights,
      lastBookedOn: mine.map(r => r.bookedOn).filter(Boolean).sort().pop() ?? null,
      openDates: open.map(d => d.date), hasCalendar: cal.length > 0,
      days: cal.map(d => ({
        d: d.date, s: d.available ? 'o' : /reserv|book/i.test(d.status) ? 's' : 'b',
        p: d.price, m: d.minStay
      }))
    };
  });

  const ranked = rank(units, account.occFloorPct / 100);
  const live = ranked.filter(u => u.active);
  const pAdr = median(live.filter(u => u.adr).map(u => u.adr as number));
  const pRatio = portfolioAskRatio(live);

  const verdictOf = (u: typeof ranked[number]) => {
    const gaps = findGaps(u.days).filter(g => g.orphaned);
    return verdict({
      occupancy: u.occupancy, nightsOpen: u.nightsOpen, pickup7: u.pickup7,
      leadTime: u.leadTime, adr: u.adr, openAsk: u.openAsk, lastBookedOn: u.lastBookedOn,
      orphanNights: gaps.reduce((a, g) => a + g.nights, 0), orphanRuns: gaps.length,
      portfolioAdr: pAdr == null ? null : Math.round(pAdr),
      portfolioAskRatio: pRatio, today: now
    }).kind;
  };

  const conditions = redListings(ranked, verdictOf);
  const known = (await sql`
    SELECT unit_id AS "unitId", kind, status FROM alert_state WHERE account_id = 1
  `) as { unitId: string; kind: string; status: string }[];
  const changed = edges(conditions, known);

  // ── 3. say it, or stage it ───────────────────────────────────────
  const keyRow = (await sql`
    SELECT quo_api_key_enc, quo_from, quo_recipients, quo_live FROM accounts WHERE id = 1
  `) as { quo_api_key_enc: string | null; quo_from: string | null;
          quo_recipients: string[]; quo_live: boolean }[];
  const q = keyRow[0];
  const quo = {
    apiKey: q?.quo_api_key_enc ? await decrypt(q.quo_api_key_enc, env.ENCRYPTION_KEY) : null,
    from: q?.quo_from ?? null,
    recipients: q?.quo_recipients ?? [],
    live: q?.quo_live === true
  };

  const sent: unknown[] = [];
  for (const e of changed) {
    const r = await sendSms(quo, compose(e));
    await sql`
      INSERT INTO alert_log (account_id, unit_id, kind, edge, body, segments, recipients, outcome, detail)
      VALUES (1, ${e.unitId}, ${e.kind}, ${e.edge}, ${r.body}, ${r.segments},
              ${r.recipients}, ${r.outcome}, ${r.detail})
    `;
    // State moves whether or not the message went out. A send that failed
    // must not re-announce the same condition on every run; the failure
    // is in the log, where it can be seen and acted on.
    if (e.edge === 'begin') {
      await sql`
        INSERT INTO alert_state (account_id, unit_id, kind, status, detail, last_sent_at)
        VALUES (1, ${e.unitId}, ${e.kind}, 'open', ${e.detail}, now())
        ON CONFLICT (account_id, unit_id, kind) DO UPDATE SET
          status = 'open', detail = EXCLUDED.detail, opened_at = now(),
          resolved_at = NULL, last_sent_at = now()
      `;
    } else {
      await sql`
        UPDATE alert_state SET status = 'resolved', resolved_at = now(), last_sent_at = now()
         WHERE account_id = 1 AND unit_id = ${e.unitId} AND kind = ${e.kind}
      `;
    }
    sent.push({ unit: e.unitName, edge: e.edge, outcome: r.outcome, segments: r.segments });
  }

  return Response.json({
    ok: true,
    outcomes,
    red: conditions.filter(c => c.active).length,
    changed: changed.length,
    quoLive: quo.live,
    alerts: sent
  });
};
