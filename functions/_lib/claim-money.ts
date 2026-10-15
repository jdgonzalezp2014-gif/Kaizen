/**
 * A case's money, one way in (§167, owner 2026-10-15): Operations enters it on the case (/api/claims action
 * `money`, permission `claims`) and Finance can correct it (/api/claims-money, `claims.money`) — the same fields,
 * the same rules, one source. Requested is an estimate; received is what came in, dated the day it is entered
 * (`received_on` — the day Revenue counts it); an upsell's "Price charged" sends both.
 */
import type { SqlFn } from './accounts.ts';
import { CLAIM_CATEGORIES, COLLECTED_VIA, checkClaim } from '../../src/lib/claims.ts';
import { todayIn } from '../../src/lib/dates.ts';

export interface MoneyChange { requested?: unknown; received?: unknown; receivedOn?: unknown; collectedVia?: unknown; category?: unknown }
type Saved = { ok: true } | { ok: false; error: string; status: number };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const usd = (n: number) => `$${n.toFixed(2)}`;

export async function saveCaseMoney(sql: SqlFn, id: string, b: MoneyChange, by: string): Promise<Saved> {
  const bad = (error: string, status = 400): Saved => ({ ok: false, error, status });
  const amount = (v: unknown) => v === undefined ? undefined : v === null || v === '' ? 0 : Math.round(Number(v) * 100) / 100;
  const requested = amount(b.requested), received = amount(b.received);
  for (const n of [requested, received]) if (n !== undefined && (!Number.isFinite(n) || n < 0)) return bad('Amounts are dollars, not below zero.');
  const category = b.category === undefined ? undefined : b.category === null || b.category === '' ? null : String(b.category);
  if (category && !CLAIM_CATEGORIES.includes(category)) return bad('Unknown kind.');
  const via = b.collectedVia === undefined ? undefined : b.collectedVia === null || b.collectedVia === '' ? null : String(b.collectedVia);
  if (via && !COLLECTED_VIA.includes(via)) return bad('Collected how?');
  const sentDay = typeof b.receivedOn === 'string' && DAY.test(b.receivedOn) ? b.receivedOn : undefined;

  const [c] = await sql`SELECT status, category, requested::float8 AS requested, refund::float8 AS received, received_on::text AS received_on,
                               collected_via
                          FROM claims WHERE account_id = 1 AND id::text = ${id} AND deleted_at IS NULL` as
    { status: string; category: string | null; requested: number; received: number; received_on: string | null; collected_via: string | null }[];
  if (!c) return bad('That case is gone.', 404);
  const next = { requested: requested ?? c.requested, received: received ?? c.received, category: category !== undefined ? category : c.category };
  const wrong = checkClaim({ status: c.status, category: next.category, received: next.received });
  if (wrong) return bad(wrong);
  // The day follows the money: entered (or changed) today unless a day is sent; none once nothing is received.
  const receivedOn = next.received <= 0 ? null
    : received !== undefined && received !== c.received ? sentDay ?? todayIn('America/New_York')
    : sentDay ?? c.received_on ?? todayIn('America/New_York');

  await sql`UPDATE claims SET requested = ${next.requested}, refund = ${next.received}, received_on = ${receivedOn},
                              category = ${next.category}, collected_via = CASE WHEN ${via !== undefined} THEN ${via ?? null} ELSE collected_via END
             WHERE account_id = 1 AND id::text = ${id}`;

  // §167: the team sees the money now (the owner) — the activity log says what moved, so a correction is traceable.
  const lines = [
    next.requested !== c.requested ? `Requested ${usd(c.requested)} → ${usd(next.requested)}` : '',
    next.received !== c.received ? `Received ${usd(c.received)} → ${usd(next.received)}${receivedOn ? ` (${receivedOn})` : ''}` : '',
    next.received === c.received && receivedOn !== c.received_on && receivedOn ? `Received on ${receivedOn}` : '',
    via !== undefined && via !== c.collected_via ? `Collected via ${via ?? '—'}` : '',
    next.category !== c.category ? `Kind ${c.category ?? '—'} → ${next.category ?? '—'}` : ''
  ].filter(Boolean);
  if (lines.length) {
    await sql`INSERT INTO work_updates (account_id, subject, subject_id, kind, body, created_by)
              VALUES (1, 'claim', ${id}, 'change', ${lines.join(' · ')}, ${by})`;
  }
  return { ok: true };
}
