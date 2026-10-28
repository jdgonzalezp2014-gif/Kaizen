/**
 * A handyman's page for the team and for themselves (owner, 2026-10-25) —
 * what loadCrewPage is for a cleaner: their work orders in a period, each
 * job's pay and charges, and the invoice (buildVendorInvoice decides it).
 *
 * A vendor is a name: the directory's (Setup → Vendors & handymen) or one
 * typed on a work order and never added there — both have work to pay.
 */
import type { SqlFn } from './accounts.ts';
import { addDays, todayIn } from '../../src/lib/dates.ts';
import { customPeriod, periodOf, recentPeriods, type InvoicePeriod, type Period } from '../../src/lib/crew.ts';
import { buildVendorInvoice, vendorInvoiceNumber, type VendorCharge, type VendorInvoice, type VendorJob } from '../../src/lib/vendor-pay.ts';
import { payoutOf } from './payouts.ts';
import type { Payout } from '../../src/lib/payouts.ts';

const TZ = 'America/New_York';
const PERIODS_SHOWN = 6;
/** Same caps as a cleaner's page (functions/_lib/crew.ts). */
export const CUSTOM_MAX_DAYS = 92, CUSTOM_AHEAD = 30;

export interface VendorInfo {
  name: string; inDirectory: boolean; active: boolean; trade: string | null; email: string | null; phone: string | null;
  invoicePeriod: InvoicePeriod;
}

/** Everyone with work to pay: the directory, then names only typed on a work order. */
export async function vendorNames(sql: SqlFn): Promise<(VendorInfo & { open: number; done: number })[]> {
  return await sql`
    WITH typed AS (
      SELECT min(btrim(w.vendor)) AS name, lower(btrim(w.vendor)) AS k,
             count(*) FILTER (WHERE w.status NOT IN ('completed', 'cancelled'))::int AS open,
             count(*) FILTER (WHERE w.status = 'completed')::int AS done
        FROM (SELECT t.vendor, t.status
                FROM todos t
               WHERE t.account_id = 1 AND t.kind = 'work_order' AND t.deleted_at IS NULL
                 AND NOT EXISTS (SELECT 1 FROM todos c WHERE c.account_id = t.account_id AND c.parent_id = t.id AND c.kind = 'work_order' AND c.deleted_at IS NULL)) w
       WHERE btrim(coalesce(w.vendor, '')) <> ''
       GROUP BY lower(btrim(w.vendor)))
    SELECT coalesce(v.name, t.name) AS name, v.id IS NOT NULL AS "inDirectory", coalesce(v.active, true) AS active,
           v.trade, v.email, v.phone, coalesce(v.invoice_period, 'monthly') AS "invoicePeriod",
           coalesce(t.open, 0) AS open, coalesce(t.done, 0) AS done
      FROM (SELECT * FROM vendors WHERE account_id = 1) v FULL JOIN typed t ON t.k = lower(v.name)
     ORDER BY (v.id IS NULL), coalesce(v.active, true) DESC, lower(coalesce(v.name, t.name))` as (VendorInfo & { open: number; done: number })[];
}

export async function findVendor(sql: SqlFn, name: string): Promise<VendorInfo | null> {
  const k = name.trim().toLowerCase();
  if (!k) return null;
  return (await vendorNames(sql)).find(v => v.name.toLowerCase() === k) ?? null;
}

/**
 * The vendor's work orders dated in [from, to] — a completed one by the New York day it was done,
 * an open one by its day set, else its deadline, else the day it was made. Cancelled ones are not work.
 */
export async function vendorJobs(sql: SqlFn, name: string, from: string, to: string): Promise<VendorJob[]> {
  const rows = await sql`
    SELECT * FROM (
      SELECT t.id::text, t.title, u.name AS unit, t.status, t.cost_actual::float AS pay, t.pay_fixed IS NOT NULL AS "payFixed",
             t.pay_note AS "payNote", t.pay_flag_note AS "flagNote", t.pay_void AS "voidReason", t.charge_owner AS "chargeOwner",
             t.resolution_note AS resolution,
             (CASE WHEN t.status = 'completed' THEN (coalesce(t.done_at, t.updated_at) AT TIME ZONE ${TZ})::date
                   ELSE coalesce(t.scheduled_on, p.scheduled_on, t.due_on, (t.created_at AT TIME ZONE ${TZ})::date) END)::text AS date
        FROM todos t
        LEFT JOIN todos p ON p.account_id = t.account_id AND p.id = t.parent_id AND p.kind = 'work_order' AND p.deleted_at IS NULL
        LEFT JOIN units u ON u.account_id = t.account_id AND u.id = coalesce(t.unit_ids[1], p.unit_ids[1])
       WHERE t.account_id = 1 AND t.kind = 'work_order' AND t.deleted_at IS NULL AND t.status <> 'cancelled'
         -- A repair holding work-order items is their folder, not a job of its own (owner, 2026-10-27) — unless it carries a cost.
         AND lower(btrim(t.vendor)) = ${name.trim().toLowerCase()}
         AND (t.cost_actual IS NOT NULL OR NOT EXISTS (SELECT 1 FROM todos c WHERE c.account_id = t.account_id AND c.parent_id = t.id AND c.kind = 'work_order' AND c.deleted_at IS NULL))) j
     WHERE j.date >= ${from} AND j.date <= ${to}
     ORDER BY j.date, j.id::bigint` as Omit<VendorJob, 'charges'>[];
  const nums = rows.map(r => Number(r.id));
  const [charges, photos] = rows.length ? await Promise.all([sql`
    SELECT id::text, todo_id::text AS "todoId", amount::float AS amount, description, status, decision_note AS "decisionNote", photos
      FROM field_expenses WHERE account_id = 1 AND source = 'vendor' AND todo_id = ANY(${nums}::bigint[])
     ORDER BY id`, sql`
    SELECT todo_id::text AS "todoId", stage, name, url FROM work_photos WHERE account_id = 1 AND todo_id = ANY(${nums}::bigint[]) ORDER BY id`]) as
    [(VendorCharge & { todoId: string })[], ({ todoId: string; stage: 'before' | 'after'; name: string; url: string })[]] : [[], []];
  return rows.map(r => ({ ...r, charges: charges.filter(c => c.todoId === r.id).map(({ todoId: _, ...c }) => c),
                         photos: photos.filter(p => p.todoId === r.id).map(({ todoId: _, ...p }) => p) }));
}

export interface VendorPage {
  vendor: VendorInfo; today: string; periods: Period[]; period: Period;
  jobs: VendorJob[];
  /** Work orders not closed yet, whatever their date — what is still to be done and priced. */
  openJobs: VendorJob[];
  invoice: VendorInvoice;
  /** How this invoice was paid; none for the team's own span (pay goes by invoice period). */
  payout: Payout | null;
}

/**
 * Their finished jobs of the last `days` (owner, 2026-10-27: "past jobs — to add extras and see what was paid"), newest
 * first, each with the invoice it belongs to and whether that invoice was paid. The same jobs and pay as their Pay tab
 * (vendorJobs), the payouts read in one query.
 */
export async function vendorPast(sql: SqlFn, name: string, days = 90) {
  const v = await findVendor(sql, name);
  if (!v) return [];
  const today = todayIn(TZ);
  const jobs = (await vendorJobs(sql, v.name, addDays(today, -days), today)).filter(j => j.status === 'completed').reverse();
  const numberOf = (d: string) => vendorInvoiceNumber(v.name, periodOf(d, v.invoicePeriod));
  const nums = [...new Set(jobs.map(j => numberOf(j.date)))];
  const paid = nums.length ? await sql`SELECT invoice_number AS n, method, to_char(created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS at
                                         FROM payouts WHERE account_id = 1 AND invoice_number = ANY(${nums})` as { n: string; method: string; at: string }[] : [];
  return jobs.map(j => { const p = paid.find(x => x.n === numberOf(j.date)); return { ...j, invoice: numberOf(j.date), paid: p ? { at: p.at, method: p.method } : null }; });
}

/** Whether the invoice a job done on `date` belongs to is already paid — then an extra on it would never be paid. */
export async function periodPaid(sql: SqlFn, name: string, date: string): Promise<boolean> {
  const v = await findVendor(sql, name);
  return !!v && !!(await payoutOf(sql, vendorInvoiceNumber(v.name, periodOf(date, v.invoicePeriod))));
}

/** `asked` = a period's first day (or the span's first day with `askedTo`), as a cleaner's page reads them. */
export async function loadVendorPage(sql: SqlFn, name: string, asked?: string | null, askedTo?: string | null): Promise<VendorPage | null> {
  const v = await findVendor(sql, name);
  if (!v) return null;
  const today = todayIn(TZ);
  const periods = recentPeriods(today, v.invoicePeriod, PERIODS_SHOWN);
  const isDay = (d?: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const custom = isDay(asked) && isDay(askedTo) && asked <= askedTo && askedTo <= addDays(today, CUSTOM_AHEAD) &&
    askedTo <= addDays(asked, CUSTOM_MAX_DAYS);
  const period = custom ? customPeriod(asked, askedTo)
    : isDay(asked) && asked <= today ? periodOf(asked, v.invoicePeriod) : periods[0]!;
  const [jobs, open] = await Promise.all([
    vendorJobs(sql, v.name, period.from, period.to),
    vendorJobs(sql, v.name, '1900-01-01', '2999-12-31').then(js => js.filter(j => j.status !== 'completed'))
  ]);
  const invoice = buildVendorInvoice(v.name, period, jobs, today);
  return { vendor: v, today, periods, period, jobs, openJobs: open, invoice,
           payout: period.custom ? null : await payoutOf(sql, invoice.number) };
}
