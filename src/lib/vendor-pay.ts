/**
 * A handyman's pay (owner, 2026-10-25) — the cleaner's page, for repairs.
 * A vendor's jobs are the work orders with their name; a job's pay is the
 * work order's cost (`cost_actual`: the approved charges, or what the team
 * typed or corrected). The invoice is per weekly or monthly period, like a
 * cleaner's (periodOf / customPeriod from crew.ts), dated by the New York day
 * the job was completed.
 *
 * Pure: the server reads the work orders, this decides what is billed — the
 * team's view, the handyman's page and the payout all use it, so they can
 * never show different totals.
 */
import type { DateStr } from './dates.ts';
import type { Period } from './crew.ts';

export interface VendorCharge {
  id: string; amount: number; description: string; status: 'pending' | 'approved' | 'denied';
  decisionNote: string | null; photos: { name: string; url: string }[];
}

export interface VendorJob {
  id: string; title: string; unit: string | null;
  /** Completed: the day it was done; open: the day set, else its deadline, else the day it was made. */
  date: DateStr;
  /** The work order's status (pending / confirmed / in_progress / completed). */
  status: string;
  /** What the job pays: the work order's cost. Null = not priced yet. */
  pay: number | null;
  /** The team set the pay by hand: approved charges no longer change it. */
  payFixed: boolean;
  /** Why the pay was corrected — the handyman reads it. */
  payNote: string | null;
  /** Flagged by the team; the handyman reads it. Does not change the pay by itself. */
  flagNote: string | null;
  /** Not paid, and why. */
  voidReason: string | null;
  /** The owner pays it back (Hostaway); the vendor is still paid by Kaizen. */
  chargeOwner: boolean;
  resolution: string | null;
  charges: VendorCharge[];
  /** Owner, 2026-10-28: the handyman's photos before / after — audited where the pay is. */
  photos?: { stage: 'before' | 'after'; name: string; url: string }[];
}

/** How a "not paid" the team set begins — the handyman reads the rest. */
export const VENDOR_VOID = 'not paid by the team — ';

/** A job counts on the invoice: done and not taken off the pay. */
export const isPaidJob = (j: VendorJob) => j.status === 'completed' && !j.voidReason;

export interface VendorInvoice {
  number: string;
  period: Period;
  /** The period has not ended: the invoice can still grow. */
  open: boolean;
  lines: { id: string; date: DateStr; unit: string | null; title: string; amount: number | null; flag: string | null }[];
  /** Done in the period but not paid, with the reason. */
  excluded: { id: string; date: DateStr; unit: string | null; title: string; reason: string }[];
  /** Charges on the period's jobs still waiting for the team — the total can still move. */
  pendingCharges: number;
  /** Done jobs with no pay yet — counted, never as $0. */
  unpriced: number;
  total: number;
}

const slug = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'VENDOR';

/** "KZ-V-…": a vendor's invoice never shares a number with a cleaner's of the same name. */
export const vendorInvoiceNumber = (name: string, period: Period) => `KZ-V-${slug(name)}-${period.from.replace(/-/g, '')}`;

export function buildVendorInvoice(name: string, period: Period, jobs: VendorJob[], today: DateStr): VendorInvoice {
  const done = jobs.filter(j => j.status === 'completed' && j.date >= period.from && j.date <= period.to)
    .sort((a, b) => a.date.localeCompare(b.date) || Number(a.id) - Number(b.id));
  const billed = done.filter(isPaidJob);
  const lines = billed.map(j => ({ id: j.id, date: j.date, unit: j.unit, title: j.title, amount: j.pay, flag: j.flagNote }));
  return {
    number: vendorInvoiceNumber(name, period),
    period, open: period.to >= today,
    lines,
    excluded: done.filter(j => j.voidReason).map(j => ({ id: j.id, date: j.date, unit: j.unit, title: j.title, reason: j.voidReason! })),
    pendingCharges: billed.reduce((n, j) => n + j.charges.filter(c => c.status === 'pending').length, 0),
    unpriced: lines.filter(l => l.amount == null).length,
    total: Math.round(lines.reduce((a, l) => a + (l.amount ?? 0), 0) * 100) / 100
  };
}

/**
 * The pay a flag leaves: unchanged, minus a deduction, or a pay typed instead.
 * Throws a plain message when the result would not be a pay.
 */
export function flaggedPay(current: number | null, how: 'none' | 'deduct' | 'pay', value: number | null): number | null {
  if (how === 'none') return current;
  if (value == null || !Number.isFinite(value) || value < 0) throw new Error(how === 'deduct' ? 'The deduction is a number (0 or more).' : 'The pay is a number (0 or more).');
  if (how === 'pay') return Math.round(value * 100) / 100;
  if (current == null) throw new Error('This job has no pay yet to deduct from — type the pay instead.');
  if (value > current) throw new Error(`The deduction is more than the pay ($${current.toFixed(2)}).`);
  return Math.round((current - value) * 100) / 100;
}

/**
 * A job waiting for its pay check (owner, 2026-10-28): done, with a vendor, and either charges the team has not
 * decided or no price at all. `charges` counts every charge it ever had, decided ones too.
 */
export interface PayCheckJob {
  id: string; title: string; vendor: string; cost: number | null; flag: string | null;
  pending: number; pendingSum: number; charges: number;
}

const m2 = (n: number) => `$${n.toFixed(2)}`;

/** "Validate pay — Tim: Towel bar is broken · $40.00 charged" / "Validate pay — Tim: 4 jobs · $160.00 charged, 1 with no price". */
export function payCheckTitle(jobs: PayCheckJob[]): string {
  const who = [...new Set(jobs.map(j => j.vendor))].join(', ');
  const sum = jobs.reduce((a, j) => a + j.pendingSum, 0);
  const unpriced = jobs.filter(j => !j.pending).length;
  const what = jobs.length === 1 ? jobs[0]!.title : `${jobs.length} jobs`;
  const money = [sum > 0 && `${m2(sum)} charged`, unpriced > 0 && (jobs.length === 1 ? 'no price yet' : `${unpriced} with no price`)].filter(Boolean).join(', ');
  return `Validate pay — ${who}: ${what}${money ? ` · ${money}` : ''}`.slice(0, 300);
}

/** One line per job — what the team checks, in the sub-task's description. */
export function payCheckText(jobs: PayCheckJob[]): string {
  return jobs.map(j => `#${j.id} ${j.title} — ${j.pending ? `${m2(j.pendingSum)} in ${j.pending} charge${j.pending === 1 ? '' : 's'} waiting` : 'no price yet'}`
    + (j.flag ? ` · ⚑ flagged: ${j.flag}` : '')).join('\n');
}

/**
 * Why the pay check cannot be completed yet, or null. A flagged job's charges are never approved in bulk — the team
 * decides them one by one (or removes the flag); a job with no price would go on the invoice as "not priced".
 */
export function payCheckBlock(jobs: PayCheckJob[]): string | null {
  const flagged = jobs.filter(j => j.flag && j.pending);
  if (flagged.length) return `${flagged.map(j => `#${j.id}`).join(', ')} ${flagged.length === 1 ? 'is' : 'are'} flagged — approve or deny ${flagged.length === 1 ? 'its' : 'their'} charges one by one, or remove the flag, then validate.`;
  const unpriced = jobs.filter(j => !j.pending && j.cost == null);
  if (unpriced.length) return `${unpriced.map(j => `#${j.id}`).join(', ')} ${unpriced.length === 1 ? 'has' : 'have'} no price — set the Cost on the job, or take it off the pay (Operations → Handymen → Not paid), then validate.`;
  return null;
}
