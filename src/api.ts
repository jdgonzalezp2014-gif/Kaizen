/** Thin typed client. Every call goes to a Pages Function; none touch a credential. */

export interface Account {
  id: number; name: string;
  hostawayAccountId: string | null;
  hasHostawayKey: boolean;
  hasGeminiKey: boolean;
  hasJinaKey: boolean;
  hasIngestToken: boolean;
  geminiModel: string;
  targetNetPerUnit: number; occFloorPct: number; stayNights: number;
  fwdStudyDays: number; offlineAfterDays: number; cleaningsCsvUrl: string | null;
  allowedEmails: string[];
}
export interface Connection { ok: boolean; message: string; units?: number }
export interface SettingsResponse { ok: boolean; user: string; account: Account; connection: Connection }

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
  rating: number | null; reviews: number | null; nightly: number | null;
  observedAt: string; source: string | null;
}
export const getMarket = (listingId: string, from: string, to: string) =>
  call<{ ok: boolean; channels?: ChannelStatus[]; page?: PageRead | null;
         stored?: StoredRead | null;
         window?: { from: string; to: string }; message?: string; error?: string }>(
    `/api/market?listingId=${listingId}&from=${from}&to=${to}`);

export const newIngestToken = () =>
  call<{ ok: boolean; ingestToken?: string; error?: string }>('/api/settings', {
    method: 'POST', body: JSON.stringify({ newIngestToken: true })
  });
