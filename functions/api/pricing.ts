/**
 * POST /api/pricing — change a unit's price, and record why.
 *
 * The recording is the point. A rate change that fills a slow window is
 * the only evidence this system will ever have about what its own
 * pricing is worth, and it can only be captured at the moment it is
 * made: the occupancy that PROMPTED a discount is unrecoverable
 * afterwards, because by then the discount has already changed it.
 *
 * Order matters here. The decision is written BEFORE the push, so a
 * Hostaway write that half-succeeds still leaves a record saying what
 * was attempted. The row is then updated with what actually landed. A
 * push that fails is a row with push_status='failed', never a missing
 * row — the log is worthless if it only contains the writes that worked.
 */
import {
  updateCalendarPrice, updateListingDiscounts, fetchCalendar
} from '../_lib/hostaway.ts';
import { db, type Env } from '../_lib/db.ts';
import { getAccount, getCredentials, type SqlFn } from '../_lib/accounts.ts';
import { identify, unauthorised } from '../_lib/auth.ts';
import { addDays, today } from '../../src/lib/dates.ts';

interface Body {
  listingId?: string;
  /** New nightly rate. Omit to leave the calendar alone. */
  baseRate?: number | null;
  /** Percent off, 0–90. */
  discountPct?: number | null;
  discountKind?: 'window' | 'weekly' | 'monthly';
  from?: string;
  to?: string;
  note?: string;
  /** Must be true. The client shows what will change and asks first. */
  confirmed?: boolean;
  /** Record the intent without touching Hostaway. */
  recordOnly?: boolean;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();

  const b = await request.json().catch(() => ({})) as Body;
  const listingId = String(b.listingId ?? '').trim();
  if (!listingId) return Response.json({ ok: false, error: 'listingId is required.' }, { status: 400 });

  const kind = b.discountKind ?? 'window';
  const hasRate = b.baseRate != null && Number.isFinite(Number(b.baseRate));
  const hasDisc = b.discountPct != null && Number.isFinite(Number(b.discountPct));
  if (!hasRate && !hasDisc) {
    return Response.json({ ok: false, error: 'Nothing to change: supply a base rate, a discount, or both.' }, { status: 400 });
  }

  const sql = db(env) as unknown as SqlFn;
  const account = await getAccount(sql);
  if (!account) return Response.json({ ok: false, error: 'No account.' }, { status: 409 });

  const now = today();
  const from = b.from || now;
  const to   = b.to   || addDays(now, account.fwdStudyDays);

  // A rate written to the wrong month is worse than no rate at all, and
  // a reversed range silently writes nothing.
  if (to < from) return Response.json({ ok: false, error: 'End date is before start date.' }, { status: 400 });

  // pricing_decisions carries a foreign key to units, so a price change
  // attempted before the first listing sync would fail on the INSERT
  // with a constraint error. That is a setup step, not a bug, and it
  // should read like one.
  const known = await sql`SELECT 1 FROM units WHERE account_id = 1 AND id = ${listingId}` as unknown[];
  if (!known.length) {
    return Response.json({ ok: false, error: 'unit_not_synced',
      message: 'This unit is not in the local database yet. Run Settings → Sync listings first — ' +
               'price decisions are recorded against it and would otherwise have nothing to attach to.'
    }, { status: 409 });
  }

  const creds = await getCredentials(sql, env.ENCRYPTION_KEY);

  // The evidence, captured before anything changes it.
  let occupancy: number | null = null, open = 0, total = 0, oldPrice: number | null = null;
  try {
    const days = await fetchCalendar(creds, listingId, from, to);
    total = days.length;
    open  = days.filter(d => d.available).length;
    occupancy = total ? (total - open) / total : null;
    oldPrice = Number(days[0]?.price) || null;
  } catch { /* evidence is nice to have; the decision still gets recorded */ }

  const rows = await sql`
    INSERT INTO pricing_decisions
      (account_id, unit_id, origin, basis, old_price, new_price, direction,
       base_rate, discount_pct, discount_kind, window_start, window_end,
       occupancy_at, nights_open, nights_total, actor, note, push_status)
    VALUES
      (1, ${listingId}, 'manual', ${kind === 'window' ? 'window' : 'avg30'},
       ${oldPrice}, ${hasRate ? Number(b.baseRate) : null},
       ${hasRate && oldPrice != null ? (Number(b.baseRate) >= oldPrice ? 'up' : 'down') : null},
       ${hasRate ? Number(b.baseRate) : null}, ${hasDisc ? Number(b.discountPct) : null},
       ${hasDisc ? kind : null}, ${from}, ${to},
       ${occupancy}, ${open}, ${total}, ${who.email}, ${b.note ?? null}, 'none')
    RETURNING id
  ` as { id: string }[];
  const id = rows[0]!.id;

  if (b.recordOnly === true) {
    return Response.json({ ok: true, id, pushed: false, occupancy, nightsOpen: open, nightsTotal: total,
      message: 'Recorded. Hostaway was not changed.' });
  }
  if (b.confirmed !== true) {
    return Response.json({ ok: false, id, error: 'not_confirmed',
      message: 'This changes live guest-facing prices. Re-send with confirmed: true.' }, { status: 428 });
  }

  const details: string[] = [];
  let allOk = true, anyOk = false;

  if (hasRate) {
    const r = await updateCalendarPrice(creds, listingId, from, to, Number(b.baseRate));
    details.push(`Nightly rate: ${r.detail}`);
    r.ok ? (anyOk = true) : (allOk = false);
  }
  if (hasDisc) {
    if (kind === 'window') {
      // A window markdown is not a Hostaway object — it is a lower
      // nightly price for those dates. Applied against the rate being
      // set, or against what the calendar already had.
      const basis = hasRate ? Number(b.baseRate) : oldPrice;
      if (basis == null) {
        details.push('Window discount: skipped — no base rate to discount from.');
        allOk = false;
      } else {
        const marked = Math.round(basis * (1 - Number(b.discountPct) / 100));
        const r = await updateCalendarPrice(creds, listingId, from, to, marked);
        details.push(`Window discount ${b.discountPct}% (${basis} → ${marked}): ${r.detail}`);
        r.ok ? (anyOk = true) : (allOk = false);
      }
    } else {
      const r = await updateListingDiscounts(creds, listingId,
        kind === 'weekly' ? { weeklyPct: Number(b.discountPct) } : { monthlyPct: Number(b.discountPct) });
      details.push(`${kind} discount: ${r.detail}`);
      r.ok ? (anyOk = true) : (allOk = false);
    }
  }

  const status = allOk ? 'applied' : anyOk ? 'partial' : 'failed';
  const detail = details.join(' · ');
  await sql`
    UPDATE pricing_decisions
       SET push_status = ${status}, pushed_at = now(), push_detail = ${detail}
     WHERE account_id = 1 AND id = ${id}
  `;

  return Response.json({
    ok: status === 'applied', id, pushed: status, detail,
    occupancy, nightsOpen: open, nightsTotal: total,
    message: status === 'applied' ? 'Applied in Hostaway and recorded.'
           : status === 'partial' ? 'Partly applied — see detail. The attempt is recorded either way.'
           : 'Hostaway did not accept the change. It is recorded as failed, not as done.'
  }, { status: status === 'applied' ? 200 : 207 });
};

/** GET /api/pricing — the decision log, newest first. */
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const who = identify(request, env);
  if (!who) return unauthorised();
  const sql = db(env);
  const unit = new URL(request.url).searchParams.get('unit');
  const rows = unit
    ? await sql`SELECT * FROM pricing_decisions WHERE account_id = 1 AND unit_id = ${unit}
                ORDER BY detected_at DESC LIMIT 200`
    : await sql`SELECT * FROM pricing_decisions WHERE account_id = 1
                ORDER BY detected_at DESC LIMIT 200`;
  return Response.json({ ok: true, decisions: rows });
};
