/** Thin typed client. Every call goes to a Pages Function; none touch a credential. */

export interface Account {
  id: number; name: string;
  hostawayAccountId: string | null;
  hasHostawayKey: boolean;
  hasGeminiKey: boolean;
  hasJinaKey: boolean;
  hasIngestToken: boolean;
  hasQuoKey: boolean; quoFrom: string | null;
  quoRecipients: string[]; quoLive: boolean;
  geminiModel: string;
  targetNetPerUnit: number; occFloorPct: number; stayNights: number;
  fwdStudyDays: number; offlineAfterDays: number;
  cleaningsCsvUrl: string | null; feedCsvUrl: string | null;
  allowedEmails: string[];
}
export interface Connection { ok: boolean; message: string; units?: number }
export interface Member {
  email: string; role: 'admin' | 'ops';
  /** Cannot be removed or demoted by anyone else. Shown, never hidden. */
  is_primary?: boolean;
  added_at?: string;
}
export interface MemberAudit {
  actor: string; action: string; email: string; detail: string | null; at: string;
}
export interface SettingsResponse {
  ok: boolean; user: string;
  role: 'admin' | 'ops';
  tabs: string[];
  /** Null for an ops member: they get their identity and their tabs. */
  account: Account | null;
  connection: Connection | null;
  members?: Member[];
  audit?: MemberAudit[];
}

export interface ImportProblem { row: number; problem: string }
export interface ImportResult {
  ok: boolean; dryRun: boolean; kind: string;
  total?: number; ready?: number; written?: number; skipped?: number;
  problems?: ImportProblem[]; preview?: unknown[]; error?: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  // A failed call returns its reason rather than throwing a generic
  // Error, because every one of these has a message worth showing.
  if (!res.ok && !(body as { error?: unknown }).error) {
    throw new Error(`HTTP ${res.status}`);
  }
  return body as T;
}

export const getSettings = () => call<SettingsResponse>('/api/settings');

export const saveSettings = (body: Record<string, unknown>) =>
  call<{ ok: boolean; account?: Account; error?: string }>('/api/settings', {
    method: 'POST', body: JSON.stringify(body)
  });

export const importCsv = (kind: 'expenses' | 'claims', csv: string, opts: { commit?: boolean; dayFirst?: boolean } = {}) =>
  call<ImportResult>('/api/import', {
    method: 'POST', body: JSON.stringify({ kind, csv, ...opts })
  });

export const syncUnits = () =>
  call<{ ok: boolean; fetched?: number; active?: number; error?: string }>('/api/sync-units', { method: 'POST' });

/* ── forward window & pricing ─────────────────────────────────────── */

import type { ForwardUnit } from './lib/forward.ts';

export interface ForwardResponse {
  ok: boolean;
  meta: { asOf: string; days: number; to: string; tookMs: number; occFloorPct: number;
          offlineAfterDays: number; parkedThrough: string };
  units: ForwardUnit[];
  error?: string;
}

export const getForward = (asOf: string, days: number) =>
  call<ForwardResponse>(`/api/forward?asOf=${asOf}&days=${days}`);

export interface PriceChange {
  listingId: string;
  baseRate?: number | null;
  discountPct?: number | null;
  discountKind?: 'window' | 'weekly' | 'monthly';
  from?: string;
  to?: string;
  note?: string;
  confirmed?: boolean;
  recordOnly?: boolean;
}

export interface PriceResult {
  ok: boolean; id?: string; pushed?: string | false; detail?: string;
  message?: string; error?: string;
  occupancy?: number | null; nightsOpen?: number; nightsTotal?: number;
}

export const applyPrice = (body: PriceChange) =>
  call<PriceResult>('/api/pricing', { method: 'POST', body: JSON.stringify(body) });

/* ── expenses ─────────────────────────────────────────────────────── */

export interface FixedLine {
  id: string; label: string; unit_id: string | null; unit_name: string | null;
  shared: boolean; category: string; amount: string; notes: string | null;
}
export interface VariableExpense extends FixedLine {
  start_date: string; end_date: string | null; frequency: string; created_by: string;
}

export const getFixed = (month: string) =>
  call<{ ok: boolean; month: string; lines: FixedLine[]; carryable: FixedLine[] }>(`/api/expenses?month=${month}`);

export const getVariable = () =>
  call<{ ok: boolean; expenses: VariableExpense[] }>('/api/expenses');

export const postExpense = (body: Record<string, unknown>) =>
  call<{ ok: boolean; id?: string; added?: number; message?: string; error?: string }>('/api/expenses', {
    method: 'POST', body: JSON.stringify(body)
  });

export const deleteExpense = (id: string) =>
  call<{ ok: boolean; deleted: number }>(`/api/expenses?id=${id}`, { method: 'DELETE' });

export interface UnitRow {
  id: string; name: string;
  /** Listed in Hostaway AND taking bookings. */
  active: boolean;
  /** Hostaway's own flag, before the parked test. */
  listed: boolean;
  parked: boolean;
  cleaning_fee: string | null;
  cleaning_fee_source: string | null;
}
export const getUnits = () => call<{ ok: boolean; units: UnitRow[] }>('/api/units');
export const setCleaningCost = (id: string, cleaningFee: number | null) =>
  call<{ ok: boolean }>('/api/units', { method: 'POST', body: JSON.stringify({ id, cleaningFee }) });

export interface CleaningMatch { id: string; name: string; amount: number }
export const pullCleanings = (url: string, commit = false) =>
  call<{ ok: boolean; dryRun?: boolean; updated?: number; matched?: CleaningMatch[];
         unmatched?: string[]; message?: string; error?: string }>('/api/cleanings', {
    method: 'POST', body: JSON.stringify({ url, commit })
  });

export interface Suggestion {
  action: 'hold' | 'lower_rate' | 'raise_rate' | 'lower_minimum_stay' | 'adjust_discounts';
  suggestedRate: number | null;
  suggestedWeeklyDiscountPct: number | null;
  suggestedMonthlyDiscountPct: number | null;
  suggestedMinimumStay: number | null;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
  missing: string;
  eventNote?: string | null;
  events?: string | null;
  eventSources?: { title: string; uri: string }[];
  eventsError?: string | null;
}

export const askSuggestion = (listingId: string, from: string, to: string) =>
  call<{ ok: boolean; suggestion?: Suggestion; message?: string; error?: string }>('/api/suggest', {
    method: 'POST', body: JSON.stringify({ listingId, from, to })
  });

export interface ChannelStatus {
  key: string; label: string; exportStatus: string | null; url: string | null; live: boolean;
}
export interface PageRead {
  ok: boolean; rating: number | null; reviews: number | null;
  nightly: number | null; source: string | null; problem: string | null;
}
export interface StoredRead {
  rating: number | null; reviews: number | null;
  /** Per night, derived from the stay total. */
  nightly: number | null;
  /** The whole stay as a guest is quoted it, fees and tax included. */
  total: number | null;
  /** Our own nightly rate for the same stay, for the comparison. */
  ourRate: number | null;
  windowStart: string | null; windowEnd: string | null; nights: number | null;
  observedAt: string; source: string | null;
}
export interface PlatformRating {
  rating: number | null; reviews: number | null; url: string | null;
  observedAt: string; source: string | null;
}
export const getMarket = (listingId: string, from: string, to: string) =>
  call<{ ok: boolean; channels?: ChannelStatus[]; page?: PageRead | null;
         ratings?: Record<string, PlatformRating>;
         stored?: StoredRead | null;
         window?: { from: string; to: string }; message?: string; error?: string }>(
    `/api/market?listingId=${listingId}&from=${from}&to=${to}`);

export const newIngestToken = () =>
  call<{ ok: boolean; ingestToken?: string; error?: string }>('/api/settings', {
    method: 'POST', body: JSON.stringify({ newIngestToken: true })
  });

export interface FeedResult {
  ok: boolean; rows: number; written: number; duplicates: number;
  unmatched: string[]; problem: string | null;
}
export const pullFeed = (url: string) =>
  call<FeedResult>('/api/feed', { method: 'POST', body: JSON.stringify({ url }) });

export interface CronResult {
  ok: boolean;
  outcomes?: { checked: number; booked: number; expired: number; stillOpen: number };
  red?: number; changed?: number; quoLive?: boolean;
  alerts?: { unit: string; edge: string; outcome: string; segments: number }[];
  error?: string;
}
export const runCron = () => call<CronResult>('/api/cron', { method: 'POST' });

export interface Claim {
  id: string; unit_id: string | null; unit_name: string | null;
  occurred_on: string; category: string | null; severity: string; status: string;
  source: string | null; description: string | null;
  refund: string; repair_cost: string; resolved_on: string | null;
  created_by: string; created_at: string;
}
export const getClaims = () => call<{ ok: boolean; claims: Claim[] }>('/api/claims');
export const saveClaim = (body: Record<string, unknown>) =>
  call<{ ok: boolean; id?: string; error?: string }>('/api/claims', {
    method: 'POST', body: JSON.stringify(body)
  });
export const deleteClaim = (id: string) =>
  call<{ ok: boolean }>(`/api/claims?id=${id}`, { method: 'DELETE' });

export interface Cleaning {
  key: string; unit_id: string | null; unit_name: string;
  checkout_on: string; cleaner: string | null; guest: string | null;
  price: string | null; deep: boolean; urgency: string | null; notes: string | null;
  future?: boolean;
}
export type CleaningScope = 'done' | 'scheduled' | 'all';
export const getCleanings = (from = '', scope: CleaningScope = 'done') =>
  call<{ ok: boolean; today: string; scope: CleaningScope; cleanings: Cleaning[];
         doneCount: number; scheduledAhead: number }>(
    `/api/cleaning-log?from=${from}&scope=${scope}`);
