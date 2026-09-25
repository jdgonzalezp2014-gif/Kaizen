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
  cleaningsSheetUrl: string | null;
  dailyNotesCsvUrl: string | null; dailyInspectionsCsvUrl: string | null;
  dailySettingsCsvUrl: string | null;
  repoApiUrl: string | null; hasRepoKey: boolean; repoAppUrl: string | null;
  allowedEmails: string[];
}
export interface Connection { ok: boolean; message: string; units?: number }
export interface Member {
  email: string; role: string;
  /** Cannot be removed or demoted by anyone else. Shown, never hidden. */
  is_primary?: boolean;
  added_at?: string;
}
export interface MemberAudit {
  actor: string; action: string; email: string; detail: string | null; at: string;
}
export interface RoleDef { key: string; name: string; permissions: string[]; builtin: boolean; members?: number }
export interface PermissionDef { key: string; label: string }
export interface SettingsResponse {
  ok: boolean; user: string;
  role: string;
  /** What the role permits; '*' is admin. */
  permissions: string[];
  tabs: string[];
  roles?: RoleDef[];
  catalog?: PermissionDef[];
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
  price: string | null; deep: boolean; urgency: string | null;
  /** From the sheet's Notes column, which is about the RESERVATION. */
  reservation_note: string | null;
  assignment: 'assigned' | 'tbd' | 'not_needed';
  future?: boolean;
  checkout_time?: string | null;
  /** 'rule', 'override:<email>', 'sheet', 'history'… — who chose the cleaner. */
  decided_by?: string | null;
}
export interface ExcludedCleaning {
  key: string; unit_name: string; checkout_on: string; cleaner: string | null;
  price: string | null; void_reason: string;
}
export type CleaningScope = 'done' | 'scheduled' | 'all';
export const getCleanings = (
  from = '', scope: CleaningScope = 'done', cleaners: string[] = [],
  to = '', include: string[] = []
) =>
  call<{ ok: boolean; today: string; scope: CleaningScope; sheetUrl: string | null;
         selected: string[];
         cleaners: { cleaner: string; n: number }[];
         states: Record<string, number>;
         cleanings: Cleaning[]; excluded: ExcludedCleaning[]; doneCount: number; scheduledAhead: number }>(
    `/api/cleaning-log?from=${from}&to=${to}&scope=${scope}` +
    `&cleaners=${encodeURIComponent(cleaners.join(','))}` +
    `&include=${include.join(',')}`);

/* ── operations ───────────────────────────────────────────────────── */

import type { BoardRow, BoardSummary, Cleaner, OpsRules, UnitInspection } from './lib/operations.ts';

export interface InspectionEntry {
  id: string; date: string; unit: string; by: string; result: string; notes: string;
  reservationId: string | null;
}
export interface NoteEntry {
  resId: string; kind: 'checkin' | 'checkout'; unit: string | null; guest: string | null;
  checkIn: string | null; notes: string; source: string; by: string; loggedAt: string;
}
export interface HostNotePush { resId: string; outcome: string; detail: string | null; at: string }
export interface OperationsResponse {
  ok: boolean; role: string; permissions: string[]; mode: 'shadow' | 'live';
  today: string; end: string; days: number; timeZone: string;
  /** The last day the next booking after each checkout was looked for. */
  lookaheadTo: string;
  sheetUrl: string | null; showMoney: boolean;
  rows: BoardRow[]; summary: BoardSummary; panel: UnitInspection[];
  inspectionLog: { done: InspectionEntry[]; scheduled: InspectionEntry[] };
  noteLog: NoteEntry[]; pushes: HostNotePush[];
  rules: OpsRules; extraInspectors: string[]; roster: Cleaner[];
  /** Units whose guests must have an ID and agreement on file (§73), by listing ID. */
  guestDocUnits: string[];
  sheet: { ok: boolean; problem: string | null; warning: string | null } | null;
  recorded: number | null; tookMs: number;
  error?: string; message?: string;
}
type Fail = { ok: false; error?: string; message?: string };

export const getOperations = (days = 10, refresh = false) =>
  call<OperationsResponse>(`/api/operations?days=${days}${refresh ? '&refresh=1' : ''}`);

export interface TurnoverSet {
  assignment?: 'assigned' | 'tbd' | 'not_needed' | null; cleaner?: string | null;
  deep?: boolean | null; checkoutTime?: string | null; checkinTime?: string | null;
}
export const saveTurnover = (body: {
  resId: string; set?: TurnoverSet;
  note?: { kind: 'checkin' | 'checkout'; text: string };
  unitId?: string; unit?: string; guest?: string; checkIn?: string;
}) => call<{ ok: true; push: 'queued' | 'shadow' | 'archived' } | Fail>('/api/turnover', {
  method: 'POST', body: JSON.stringify(body)
});

export const logInspection = (body: {
  id?: string; unit: string; date: string; inspector: string; result: string | null;
  notes: string; reservationId?: string | null;
}) => call<{ ok: true } | Fail>('/api/inspections', {
  method: 'POST', body: JSON.stringify({ action: 'log', ...body })
});
export const scheduleInspections = () =>
  call<{ ok: true; proposed: number; added: number } | Fail>('/api/inspections', {
    method: 'POST', body: JSON.stringify({ action: 'schedule' })
  });
export const cancelInspection = (id: string) =>
  call<{ ok: true } | Fail>(`/api/inspections?id=${id}`, { method: 'DELETE' });

export interface OpsSettings {
  ok: true; mode: 'shadow' | 'live'; rules: OpsRules; defaults: OpsRules;
  extraInspectors: string[]; roster: Cleaner[]; guestDocUnits: string[];
  counts: { inspections: number; notes: number; overrides: number };
}
export const getOpsSettings = () => call<OpsSettings | Fail>('/api/ops-settings');
export const saveOpsSettings = (body: Record<string, unknown>) =>
  call<{ ok: true; mode?: string; adopted?: number } | Fail>('/api/ops-settings', {
    method: 'POST', body: JSON.stringify(body)
  });
export interface CutoverPreview {
  roster: { name: string; tier: string }[]; rules: Record<string, number> | null;
  inspectors: string[]; inspections: { done: number; scheduled: number }; notes: number;
  problems: string[];
}
export const cutoverImport = (commit: boolean) =>
  call<{ ok: true; dryRun: boolean; preview: CutoverPreview } | Fail>('/api/ops-settings', {
    method: 'POST', body: JSON.stringify({ action: 'import', commit })
  });

/* ── the Data Repository ──────────────────────────────────────────── */

export interface RepoColumn {
  key: string; title: string; type: string; group: string;
  required: boolean; unique: boolean; options: string[] | null;
  reference: { table: string; column: string } | null;
  editable: boolean; system: boolean;
}
export interface RepoTable {
  key: string; title: string; section: string; idPrefix: string;
  nameFields: string[]; columns: RepoColumn[];
}
export interface RepoSection { key: string; title: string; tables: RepoTable[] }
export type RepoRow = Record<string, string | number | boolean>;
export interface RepoFile {
  fileId: string; name: string; mimeType: string; size: number; url: string; updatedAt: string;
  /** Set when the file lives in Drive (removing it trashes it there); absent for a pasted link. */
  driveFileId?: string | null;
}
type RepoFail = { ok: false; error?: string; message?: string };

export const getRepoMeta = () =>
  call<{ ok: true; meta: { sections: RepoSection[] }; appUrl: string | null } | RepoFail>(
    '/api/repository?op=meta');
export const getRepoRows = (table: string) =>
  call<{ ok: true; total: number; rows: RepoRow[]; tookMs: number } | RepoFail>(
    `/api/repository?op=list&table=${encodeURIComponent(table)}`);
export const getRepoDocs = (table: string, id: string, column: string) =>
  call<{ ok: true; folderUrl: string; files: RepoFile[] } | RepoFail>(
    `/api/repository?op=docs&table=${encodeURIComponent(table)}&id=${encodeURIComponent(id)}` +
    `&column=${encodeURIComponent(column)}`);
export interface RepoHit { section: string; table: string; title: string; total: number; rows: RepoRow[]; problem?: string }
export const searchRepo = (q: string) =>
  call<{ ok: true; q: string; results: RepoHit[]; searched: number } | RepoFail>(
    `/api/repository?op=search&q=${encodeURIComponent(q)}`);
export const revealRepoSecret = (table: string, id: string, column: string) =>
  call<{ ok: true; value: string } | RepoFail>('/api/repository-reveal', {
    method: 'POST', body: JSON.stringify({ table, id, column })
  });

/* ── roles ────────────────────────────────────────────────────────── */

export const can = (permissions: string[] | null | undefined, key: string) =>
  !!permissions && (permissions.includes('*') || permissions.includes(key));

export const getRoles = () =>
  call<{ ok: true; roles: RoleDef[]; catalog: PermissionDef[] } | { ok: false; message?: string }>('/api/roles');
export const saveRole = (role: { key?: string; name: string; permissions: string[] }) =>
  call<{ ok: true; key: string } | { ok: false; message?: string }>('/api/roles', {
    method: 'POST', body: JSON.stringify(role)
  });
export const deleteRole = (key: string) =>
  call<{ ok: true } | { ok: false; message?: string }>(`/api/roles?key=${encodeURIComponent(key)}`, { method: 'DELETE' });

/* ── the Data Repository: writes ──────────────────────────────────── */

export const repoEdit = (body: Record<string, unknown>) =>
  call<{ ok: true; data: any } | { ok: false; message?: string }>('/api/repository-edit', {
    method: 'POST', body: JSON.stringify(body)
  });
export const repoStructure = (body: Record<string, unknown>) =>
  call<{ ok: true; data: any } | { ok: false; message?: string }>('/api/repository-structure', {
    method: 'POST', body: JSON.stringify(body)
  });
/** A file to Drive, through Kaizen (§72). Multipart, so not through `call`'s JSON headers. */
export async function uploadRepoFile(table: string, id: string, column: string, file: File) {
  const form = new FormData();
  form.set('table', table); form.set('id', id); form.set('column', column); form.set('file', file);
  const res = await fetch('/api/repository-upload', { method: 'POST', body: form });
  return await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` })) as
    { ok: true; data: { fileId: string; url: string } } | { ok: false; message?: string };
}

/* ── Monday import (§74) ──────────────────────────────────────────── */

type ImportRead = { ok: true; name: string; rows: string[][] } | { ok: false; message?: string };
export async function importReadFile(file: File): Promise<ImportRead> {
  const form = new FormData();
  form.set('file', file);
  const res = await fetch('/api/repository-import', { method: 'POST', body: form });
  return await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` })) as ImportRead;
}
export const importReadLink = (link: string) =>
  call<ImportRead>('/api/repository-import', { method: 'POST', body: JSON.stringify({ op: 'read', link }) });
export const importCommit = (body: Record<string, unknown>) =>
  call<{ ok: true; key: string; records: number; secrets: number } | { ok: false; message?: string }>(
    '/api/repository-import', { method: 'POST', body: JSON.stringify({ ...body, op: 'commit' }) });

/* ── Google Drive (§72) ───────────────────────────────────────────── */

export interface DriveStatus {
  ok: true; clientId: string | null; hasSecret: boolean; connected: boolean; email: string | null;
  redirectUri: string; quota: { usage: number; limit: number | null } | null; problem: string | null;
  guestRootId: string | null;
}
export const getDrive = () => call<DriveStatus | { ok: false; error?: string }>('/api/google-drive');
export const driveAction = (body: Record<string, unknown>) =>
  call<{ ok: true; url?: string } | { ok: false; error?: string }>('/api/google-drive', {
    method: 'POST', body: JSON.stringify(body)
  });

/* ── guest documents (§73) ────────────────────────────────────────── */

export interface GuestFile { fileId: string; name: string; mimeType: string; url: string; updatedAt: string }
export interface StayDocs { folderUrl: string | null; id: GuestFile[]; agreement: GuestFile[] }
export const getGuestDocs = (stays: { resId: string; arrival: string; name: string }[]) =>
  call<{ ok: true; docs: Record<string, StayDocs> } | { ok: false; message?: string }>('/api/guest-docs', {
    method: 'POST', body: JSON.stringify({ action: 'status', stays })
  });
export const syncAgreement = (resId: string) =>
  call<{ ok: true; signed: boolean; available: boolean; pulled: boolean; docs: StayDocs } | { ok: false; message?: string }>(
    '/api/guest-docs', { method: 'POST', body: JSON.stringify({ action: 'agreement', resId }) });
export async function uploadGuestDoc(resId: string, kind: 'id' | 'agreement', file: File) {
  const form = new FormData();
  form.set('resId', resId); form.set('kind', kind); form.set('file', file);
  const res = await fetch('/api/guest-docs-upload', { method: 'POST', body: form });
  return await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` })) as
    { ok: true; docs: StayDocs } | { ok: false; message?: string };
}

export const getRepoDocsBatch = (table: string, column: string, ids: string[]) =>
  call<{ ok: true; docs: Record<string, { folderUrl: string; files: RepoFile[]; truncated: boolean }> } | { ok: false; message?: string }>(
    `/api/repository?op=docsbatch&table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}` +
    `&ids=${encodeURIComponent(ids.join(','))}`);
