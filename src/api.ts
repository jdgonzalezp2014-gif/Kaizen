/** Thin typed client. Every call goes to a Pages Function; none touch a credential. */

export interface Account {
  id: number; name: string;
  hostawayAccountId: string | null;
  hasHostawayKey: boolean;
  hasGeminiKey: boolean;
  hasClaudeKey: boolean;
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
          offlineAfterDays: number; parkedThrough: string; generatedAt?: string };
  units: ForwardUnit[];
  error?: string;
}

export const getForward = (asOf: string, days: number, cached = false) =>
  call<ForwardResponse>(`/api/forward?asOf=${asOf}&days=${days}${cached ? '&cache=1' : ''}`);

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
  /** 'repair' = written by a completed repair (§95), external_ref = its task. */
  source?: string | null; external_ref?: string | null;
}

export const getFixed = (month: string) =>
  call<{ ok: boolean; month: string; lines: FixedLine[]; carryable: FixedLine[] }>(`/api/expenses?month=${month}`);

export const getVariable = (from?: string, to?: string) =>
  call<{ ok: boolean; expenses: VariableExpense[]; capped?: boolean }>(`/api/expenses${from || to ? `?from=${from ?? ''}&to=${to ?? ''}` : ''}`);

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
  /** §162: the repair work — the sum of the work orders' and purchase orders' costs on the case, computed by the
   *  server; `owner_work` the part of it charged to the owner. §167: the team enters requested / received. */
  repair_work: number; owner_work: number; resolved_on: string | null;
  requested: number; received: number; received_on: string | null; collected_via: string | null;
  created_by: string; created_at: string;
  /** The stay it is about, when there is one (§84). */
  reservation_id: string | null; reservation_label: string | null;
  /** The case on Airbnb / Booking.com / Vrbo (§88). */
  case_url: string | null;
}
export const getClaims = () => call<{ ok: boolean; claims: Claim[] }>('/api/claims');
/** §167: a case's money — requested, received (its day), how an upsell was collected — from Operations. */
export interface CaseMoneyChange { requested?: number; received?: number; receivedOn?: string; collectedVia?: string | null; category?: string | null }
export const saveCaseMoney = (id: string, change: CaseMoneyChange) =>
  call<{ ok: boolean; error?: string }>('/api/claims', { method: 'POST', body: JSON.stringify({ action: 'money', id, ...change }) });
export const saveClaim = (body: Record<string, unknown>) =>
  call<{ ok: boolean; id?: string; error?: string }>('/api/claims', {
    method: 'POST', body: JSON.stringify(body)
  });
/** §162: Claims & upselling as money — Finance's view (`claims.money`); §167: Finance can correct the same fields. */
export interface ClaimMoney {
  id: string; unit_id: string | null; unit_name: string | null; occurred_on: string; resolved_on: string | null;
  category: string | null; status: string; source: string | null; description: string | null;
  reservation_label: string | null; case_url: string | null;
  requested: number; received: number; received_on: string | null; collected_via: string | null;
  repair_work: number; owner_work: number;
}
export const getClaimsMoney = (from: string, to: string) =>
  call<{ ok: true; cases: ClaimMoney[] } | { ok: false; message?: string }>(`/api/claims-money?from=${from}&to=${to}`);
export const saveClaimMoney = (body: { id: string } & CaseMoneyChange) =>
  call<{ ok: boolean; message?: string }>('/api/claims-money', { method: 'POST', body: JSON.stringify(body) });
export const deleteClaim = (id: string) =>
  call<{ ok: boolean }>(`/api/claims?id=${id}`, { method: 'DELETE' });
/** Undo a removal (§86). */
export const restoreClaim = (id: string) =>
  call<{ ok: boolean; error?: string }>('/api/claims', { method: 'POST', body: JSON.stringify({ action: 'restore', id }) });

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
  /** 'checkout', or a manual clean's kind (§79). */
  kind?: string | null;
  /** Flagged by hand (§122) — the cleaner reads it; corrected by the team (§123); held after a cancellation (§123). */
  flag_note?: string | null; edit_note?: string | null; needs_confirm?: string | null;
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

import type { AssignRule, BoardRow, BoardSummary, Cleaner, OpsRules, UnitInspection } from './lib/operations.ts';
import type { TimePush } from './lib/stay-time.ts';

export interface InspectionEntry {
  id: string; date: string; unit: string; by: string; result: string; notes: string;
  reservationId: string | null;
  /** §133: walked as a checklist and not finished; has a checklist report. */
  started?: boolean; checklist?: boolean;
  /** §135: sent from the inspector's link (who sent it) — waiting for the team's review. */
  sentBy?: string | null;
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
  /** The latest time sent to the Hostaway reservation, by `${resId}:${checkin|checkout}`. */
  timePushes: Record<string, TimePush>;
  rules: OpsRules; extraInspectors: string[]; roster: Cleaner[];
  /** Which rule decides who cleans (§121). */
  assignRule: AssignRule;
  /** What cleaners can already see on their page (§127) — the board marks it 👁. */
  crewView?: { published: boolean; autoDays: number; days: number };
  /** Units whose guests must have an ID and agreement on file (§73), by listing ID. */
  guestDocUnits: string[];
  /** Cleans no checkout scheduled (§79), in the window. */
  manualCleans: ManualClean[];
  /** Cleans flagged by hand (§124), by record key (reservation ID or MAN-n): the note the cleaner reads. */
  flags: Record<string, { note: string; by: string | null }>;
  /** §133: what an inspection asked each clean to do, by its key (reservation or MAN-n). */
  cleanTasks?: Record<string, string[]>;
  sheet: { ok: boolean; problem: string | null; warning: string | null } | null;
  recorded: number | null; tookMs: number;
  error?: string; message?: string;
}
type Fail = { ok: false; error?: string; message?: string };

export type ManualCleanKind = 'early_departure' | 'mid_stay' | 'extra';
export interface ManualClean {
  key: string; unitId: string | null; unit: string; date: string; cleaner: string | null; assignment: string;
  price: number | null; deep: boolean; kind: ManualCleanKind; resId: string | null; guest: string | null;
  note: string | null; by: string | null;
}
export interface StayOnDay { resId: string; guest: string; arrival: string; departure: string; channel: string }
export const getStaysOnDay = (unitId: string, date: string) =>
  call<{ ok: true; stays: StayOnDay[] } | Fail>(`/api/stays?unitId=${encodeURIComponent(unitId)}&date=${date}`);
export const manualClean = (body: Record<string, unknown>) =>
  call<{ ok: true; key?: string; price?: number | null; restored?: boolean } | Fail>('/api/manual-clean', {
    method: 'POST', body: JSON.stringify(body)
  });

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
  resendTime?: 'checkin' | 'checkout';
  /** A time change checked with the cleaner (§156): who said yes, and the night to close after a late check-out. */
  timeCheck?: { checkedWith: string; cleaner: string | null; blockNight: string | null };
}) => call<{ ok: true; push: 'queued' | 'shadow' | 'archived'; time: 'queued' | null } | Fail>('/api/turnover', {
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
export const rescheduleInspection = (id: string, date: string, inspector?: string) =>
  call<{ ok: true } | Fail>('/api/inspections', {
    method: 'POST', body: JSON.stringify({ action: 'reschedule', id, date, inspector })
  });
export const cancelInspection = (id: string) =>
  call<{ ok: true } | Fail>(`/api/inspections?id=${id}`, { method: 'DELETE' });

export interface OpsSettings {
  /** §136: what cleaners get at each active unit — presence only, never a code. */
  access?: { unit: string; recordId: string | null; lockType: string | null; kind: string | null;
             missing: ('address' | 'access' | 'code' | 'lockbox' | 'wifi')[];
             has: { address: boolean; code: 'repository' | 'hostaway' | null; lockbox: boolean; fob: string | null; wifi: boolean } }[];
  ok: true; mode: 'shadow' | 'live'; rules: OpsRules; defaults: OpsRules;
  extraInspectors: string[]; roster: Cleaner[]; guestDocUnits: string[];
  assignRule: AssignRule;
  /** The schedule on the crew pages (§122). */
  crewCalendar: boolean; crewCalendarDays: number;
  /** Unpublished, the rule's picks show on a cleaner's page this many days ahead (§127). */
  crewAutoDays: number;
  /** Zone → its active units' names (§121). */
  zones: Record<string, string[]>;
  counts: { inspections: number; notes: number; overrides: number };
  hostawayTasks: HostawayTasksState;
}
/** §93: work ↔ Hostaway tasks, as Setup shows it. */
export interface HostawayTasksState { mode: 'off' | 'mirror'; pulledAt: string | null; linked: number; errors: number; imported: number; unsent: number }
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
/** The board under a proposed roster and rules, by levels (or stars), against the board as it is (§121, §125). */
export interface AssignPreview {
  from: string; to: string; rule: AssignRule; proposedRule: AssignRule; cleans: number; changed: number;
  /** Cleans left TBD waiting for a booking under the proposal (§125). */
  waiting?: number;
  changes: { date: string; unit: string; resId: string; required: number | string | null; now: string | null; then: string | null;
             priceNow: number | null; priceThen: number | null; below: boolean; manual: boolean }[];
  unassigned: { now: number; then: number };
  cost: { now: number; then: number }; unpriced: { now: number; then: number };
}
export const previewAssign = (roster: Cleaner[], rules: Record<string, unknown>) =>
  call<{ ok: true; preview: AssignPreview } | Fail>('/api/ops-settings', {
    method: 'POST', body: JSON.stringify({ action: 'previewAssign', roster, rules })
  });
export const cutoverImport = (commit: boolean) =>
  call<{ ok: true; dryRun: boolean; preview: CutoverPreview } | Fail>('/api/ops-settings', {
    method: 'POST', body: JSON.stringify({ action: 'import', commit })
  });

/* ── the crew pages (§122) ────────────────────────────────────────── */

import type { CrewClean, CrewExtra, Invoice, InvoicePeriod, Movement, Period } from './lib/crew.ts';

export interface CrewUpcoming {
  /** §133: what an inspection asked this clean to do. */
  tasks?: string[];
  key: string; date: string; unit: string; beds: number | null; time: string; deep: boolean;
  sameDay: boolean; checkIn: string | null; price: number | null; manual: string | null;
  /** When the cleaner confirmed it (owner, 2026-10-17); null = not yet. */
  accepted?: string | null;
}
export interface CrewPage {
  /** `level` only reaches the team's view (§122): cleaners are not shown their rating. */
  cleaner: { name: string; level?: 'high' | 'standard' | 'manual'; invoicePeriod: InvoicePeriod; active: boolean; lang: 'en' | 'es' };
  today: string; periods: Period[]; period: Period;
  cleans: CrewClean[]; extras: CrewExtra[]; invoice: Invoice; extraFrom: string;
  /** Published SOPs for the cleaner's page (§128). */
  help?: { title: string; purpose: string | null; steps: { text: string; detail?: string }[]; body: string | null; lang?: 'en' | 'es' }[];
  /** §134: what they can report — the supplies and the units. */
  supplies?: { items: SupplyItem[]; units: { id: string; name: string }[] };
  /** §134: each recent or coming clean's photos and done, by key. */
  field?: Record<string, CleanFieldState>;
  /** §136: how to get in, for today's cleans only; the address of the coming ones. */
  access?: Record<string, import('./lib/unit-access.ts').UnitAccess>;
  /** §150: where each clean's supplies come from (label only; the code is in today's `access`). */
  places?: Record<string, NonNullable<import('./lib/unit-access.ts').UnitAccess['supplies']>>;
  addresses?: Record<string, string>;
  /** §134: the photos of those cleans (ids for crewPhoto), by key. */
  fieldPhotos?: Record<string, { id: string; stage: 'before' | 'after' }[]>;
  upcoming: {
    enabled: boolean; days: number; through: string | null; rows: CrewUpcoming[]; problem: string | null;
    autoDays: number; confirmed: { at: string; through: string } | null; movements: Movement[];
  };
}
export interface CrewSchedule {
  enabled: boolean; autoDays: number; confirmed: { at: string; by: string; through: string } | null;
  movements: (Movement & { cleaner: string })[]; problem: string | null;
}
/**
 * Whose page it is is decided by the server — by the sign-in, or by the
 * secret link (`token`), which goes to its own route and nowhere else.
 */
const crewPath = (token?: string | null) => token ? '/api/crew-link' : '/api/crew';
const crewHeaders = (token?: string | null): Record<string, string> => token ? { 'X-Crew-Token': token } : {};
export const getCrew = (period?: string | null, token?: string | null) =>
  call<({ ok: true } & CrewPage) | Fail>(`${crewPath(token)}${period ? `?period=${period}` : ''}`, { headers: crewHeaders(token) });
export const crewAction = (body: Record<string, unknown>, token?: string | null) =>
  call<{ ok: true } | Fail>(crewPath(token), { method: 'POST', headers: crewHeaders(token), body: JSON.stringify(body) });
/** An extra with evidence, or more evidence on one: multipart, so the browser sets the boundary. */
export async function crewUpload(fields: Record<string, string>, files: File[], token?: string | null) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append('file', f);
  const res = await fetch(crewPath(token), { method: 'POST', headers: crewHeaders(token), body: form });
  return await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` })) as { ok: true } | Fail;
}

/* ── inventory (§134) ─────────────────────────────────────────────── */

export interface SupplyItem { id: string; name: string; measure: string; category: string }
export interface InvItemRow extends SupplyItem { perClean: number | null; reorderAt: number | null; active: boolean;
  /** §150: supplies are what cleans consume; furniture is the house's things. */ kind?: 'supply' | 'furniture';
  /** Where to buy it; `pack` = how many of its measure come in one (a Walmart/Amazon product, owner 2026-10-15). */ buyOptions?: { label: string; url: string; pack?: number | null }[];
  /** Owner, 2026-10-14: `name` reads "Name — Size"; `baseName` and `size` are what is edited. */ baseName?: string; size?: string | null }
export interface InvLevel {
  itemId: string; qty: number | null; countedAt: string | null; missingSince: string | null;
  /** §150: the average per clean of what cleaners reported, over the units this place supplies (else the item's estimate). */
  perClean: number | null; learned: boolean; reportedCleans: number;
  /** What the next cleans of its units will take out; the minimum here (`minOwn`: set for this place, else the item's). */
  need: number; min: number | null; minOwn: boolean; toOrder: number;
  /** A closet refilled from a storage (owner, 2026-10-15): what to move into it from there — it is not bought for. */
  toRefill?: number;
}
/** A place (§150): a Repository record `table/ROW-id` — a storage or a house's closet; null = moves of units with no place. */
export interface InvPlace { place: string | null; name: string; self: boolean;
  /** Owner, 2026-10-15: a storage (or a house's closet) holds supplies; a house holds its furniture. One key can be both views. */
  view?: 'storage' | 'house';
  /** A house: where its supplies come from (a storage key, or its own key when it keeps its closet). */
  supplies?: string | null; units: { id: string; name: string; recordId: string | null; cleansAhead: number }[]; items: InvLevel[];
  /** A closet refilled from a storage: that storage's key. A storage: the closets it refills (owner, 2026-10-15). */
  from?: string | null; refills?: string[];
  /** §150: items "not kept here". */ hidden: string[];
  /** The latest photos / note of how the place looked at a count (owner, 2026-10-14). */
  look?: { note: string | null; photos: { name: string; url: string }[]; byName: string; counted: number; at: string } | null }
export interface InvMove {
  id: string; item: string; place: string | null; unit: string | null; kind: 'count' | 'used' | 'purchase' | 'adjust' | 'missing' | 'taken'; qty: number;
  note: string | null; byName: string; source: 'team' | 'cleaner' | 'link'; photos: { name: string; url: string }[]; at: string;
}
export interface Inventory {
  items: InvItemRow[]; places: InvPlace[]; recent: InvMove[]; aheadDays: number; windowDays: number;
  /** Active units whose Repository `storage` is blank or names no record (§150). */
  unassigned: { id: string; name: string; recordId: string | null; cleansAhead: number }[];
  /** Orders (shopping to-dos) not closed, with their lines — a purchase can start from one (§150). */
  orders: { todoId: string; title: string; lines: { itemId: string; place: string; qty: number; /** where it is bought, when not its linked store */ at?: string }[]; at: string; purchases: number;
    /** The to-do's listing and what was asked (its description) — the cart opens the same anywhere. */ unitIds?: string[] | null; asked?: string | null }[];
  /** The field's open to-dos (a clean's supplies request, a problem) an order can be attached to (§150). */
  fieldTodos: { id: string; title: string; group: 'problem' | 'request' }[];
  /** The order kept as a draft (§150), if any. */
  draft: { lines: { itemId: string; place: string; qty: number; at?: string }[]; forTodo: string | null; savedBy: string; savedAt: string } | null;
  /** Setup → Inventory: a "Low stock at <place>" to-do on its own. */
  lowStockTasks: boolean;
  /** §150: purchases someone paid with their own money, not paid back yet. */
  toPayBack: { id: string; paidBy: string; total: number; note: string | null; todo: string | null; at: string; photos: { name: string; url: string }[] }[];
}
export const getInventory = () => call<({ ok: true } & Inventory) | Fail>('/api/inventory');
export const inventoryAction = (body: Record<string, unknown>) =>
  call<({ ok: true; todoId?: string; itemId?: string } & Inventory) | Fail>('/api/inventory', { method: 'POST', body: JSON.stringify(body) });
/** A purchase with its receipt (multipart, §150). */
export const inventoryUpload = (form: FormData) =>
  fetch('/api/inventory', { method: 'POST', body: form }).then(r => r.json() as Promise<({ ok: true } & Inventory) | Fail>);
export const inventoryItemAction = (body: Record<string, unknown>) =>
  call<{ ok: true; items: InvItemRow[] } | Fail>('/api/inventory-items', { method: 'POST', body: JSON.stringify(body) });

/** Whoever helps on one clean, by the link the cleaner sent (§134): no account, the token is the only credential. */
/** A clean as the field reports it (§134): photos before/after (in Drive) and done. */
export interface CleanFieldState {
  before: number; after: number; folderUrl: string | null; done: { by: string; at: string } | null;
  /** The required "what I took from the storage" step: lines, or nothing — null until answered. */
  supplies: { lines: number; none: boolean } | null;
}
export interface ReportTeam {
  team: string; lang: 'en' | 'es'; items: SupplyItem[]; clean: { unit: string; date: string; until: string }; state?: CleanFieldState;
  /** §136: how to get in, while the link lasts. */ access?: import('./lib/unit-access.ts').UnitAccess | null;
}
export const getReportLink = (token: string) =>
  call<({ ok: true } & ReportTeam) | Fail>('/api/report-link', { headers: { 'X-Report-Token': token } });
/** Any field report — JSON fields, plus photos when there are some (multipart, the browser sets the boundary). */
export async function sendFieldReport(url: string, headers: Record<string, string>, fields: Record<string, string>, files: File[]) {
  const init: RequestInit = files.length
    ? { method: 'POST', headers, body: (() => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); for (const x of files) f.append('file', x); return f; })() }
    : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(fields) };
  const res = await fetch(url, init);
  return await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` })) as { ok: true; state?: CleanFieldState } | Fail;
}
export const crewReport = (fields: Record<string, string>, files: File[], token?: string | null) =>
  sendFieldReport(crewPath(token), crewHeaders(token), fields, files);
export interface CleanLink { link: string; unit: string; date: string; expires: string }
export const crewCleanLink = (key: string, token?: string | null) =>
  call<({ ok: true } & CleanLink) | Fail>(crewPath(token), { method: 'POST', headers: crewHeaders(token), body: JSON.stringify({ action: 'cleanLink', key }) });

/** Money paid in the field, waiting for the team's approval before it reaches Costs (§137). */
export interface FieldExpense {
  id: string; source: 'cleaner' | 'link' | 'vendor'; byName: string; cleaningKey: string | null; todoId: string | null;
  unitId: string | null; unit: string | null; category: string; amount: number; description: string; photos: { name: string; url: string }[]; at: string;
}

export interface PendingExtra {
  id: string; cleaner: string; key: string; amount: number; description: string; createdAt: string;
  unit: string; date: string; price: number | null;
  files?: { id: string; name: string; url: string }[];
}
/** A clean held after a cancellation on or after arrival (§123), waiting for a person. */
export interface ToConfirm { key: string; unit: string; date: string; beds: number | null; deep: boolean; guest: string | null; note: string }
export const getCrewAdmin = (cleaner?: string | null, period?: string | null, to?: string | null) =>
  call<{ ok: true; pending: PendingExtra[]; fieldPending?: FieldExpense[]; page: CrewPage | null; schedule: CrewSchedule; toConfirm: ToConfirm[] } | Fail>(
    `/api/crew-admin?${new URLSearchParams({ ...(cleaner ? { cleaner } : {}), ...(period ? { period } : {}), ...(period && to ? { to } : {}) })}`);
/** A cleaner's page through the same server code that answers the cleaner — for "View as cleaner". */
export const getCrewAsCleaner = (cleaner: string, period?: string | null) =>
  call<({ ok: true } & CrewPage) | Fail>(`/api/crew-admin?${new URLSearchParams({ view: 'cleaner', cleaner, ...(period ? { period } : {}) })}`);
/**
 * One photo of a clean, as an object URL for an <img> (§134): fetched with the page's own credential —
 * the secret link's header, the sign-in, or the team's preview — since an <img> cannot send a header.
 */
export async function crewPhoto(id: string, door: { token?: string | null; asCleaner?: string }): Promise<string> {
  const url = door.asCleaner ? `/api/crew-admin?${new URLSearchParams({ view: 'cleaner', cleaner: door.asCleaner, photo: id })}`
    : `${crewPath(door.token)}?photo=${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: crewHeaders(door.token) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}
export const crewAdminAction = (body: Record<string, unknown>) =>
  call<{ ok: true } | Fail>('/api/crew-admin', { method: 'POST', body: JSON.stringify(body) });
export const crewLink = (name: string, revoke = false) =>
  call<{ ok: true; link: string | null } | Fail>('/api/ops-settings', {
    method: 'POST', body: JSON.stringify({ action: 'crewLink', name, revoke })
  });

/* ── inspections as a checklist (§133) ───────────────────────────── */

import type { Area, AreaDef, CheckResult, InspectionItem, Outcome, Section, UnitType } from './lib/inspection.ts';

export interface RunCheck {
  id: string; itemId: string | null; area: Area; n: number; label: string; result: CheckResult | null;
  note: string | null; photos: { name: string; url: string }[]; outcome: Outcome | null;
  /** §150: what to buy, when it is bought — a supply and how many. */
  supplyId?: string | null; supplyQty?: number | null;
  todoId?: string | null; cleanTaskId?: string | null;
}
export interface InspectionRunData {
  inspection: { id: string; unitId: string | null; unit: string; date: string; inspector: string | null;
                result: string | null; notes: string | null; finished: boolean };
  sections: Section[]; rooms: { bedrooms: number; bathrooms: number };
  checks: RunCheck[]; nextClean: { key: string; date: string; cleaner: string | null } | null;
  inspectors: string[]; today: string;
  /** §150: the supplies list, for the 🔍 on a purchase. */
  supplies?: { id: string; name: string; measure: string }[];
}
export const getRun = (id: string) => call<({ ok: true } & InspectionRunData) | Fail>(`/api/inspection-run?id=${encodeURIComponent(id)}`);
export const runAction = <T extends object = Record<string, unknown>>(body: Record<string, unknown>) =>
  call<({ ok: true } & T) | Fail>('/api/inspection-run', { method: 'POST', body: JSON.stringify(body) });
/** Photos onto one finding: multipart, so the browser sets the boundary. */
export async function runPhotos(inspectionId: string, checkId: string, files: File[]) {
  const form = new FormData();
  form.append('inspectionId', inspectionId); form.append('checkId', checkId);
  for (const f of files) form.append('file', f);
  const res = await fetch('/api/inspection-run', { method: 'POST', body: form });
  return await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` })) as
    { ok: true; photos: { name: string; url: string }[] } | Fail;
}
/* §135: the inspector's link — /report#i=<token>, through the field door (/api/report-link). */
export interface InspectLinkData {
  inspection: { unit: string; date: string; inspector: string | null; until: string };
  sections: Section[]; checks: RunCheck[]; lang: 'en' | 'es'; sent: { at: string; by: string } | null;
}
const inspectHeaders = (token: string) => ({ 'X-Inspect-Token': token });
export const getInspectLink = (token: string) =>
  call<({ ok: true } & InspectLinkData) | Fail>('/api/report-link', { headers: inspectHeaders(token) });
export const inspectAction = (token: string, body: Record<string, unknown>) =>
  call<({ ok: true; checkId?: string } & InspectLinkData) | Fail>('/api/report-link', {
    method: 'POST', headers: { ...inspectHeaders(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export async function inspectPhotos(token: string, reporter: string, checkId: string, files: File[]) {
  const form = new FormData();
  form.append('reporter', reporter); form.append('checkId', checkId);
  for (const f of files) form.append('file', f);
  const res = await fetch('/api/report-link', { method: 'POST', headers: inspectHeaders(token), body: form });
  return await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` })) as ({ ok: true } & InspectLinkData) | Fail;
}
export interface InspectionLink { link: string; unit: string; date: string; expires: string }
export const inspectionLinkFor = (inspectionId: string) => runAction<InspectionLink>({ action: 'link', inspectionId });
/** The checklist setup (§138): items, areas, and the active units with house/apartment from the Repository. */
export interface ChecklistSetupData { ok: true; items: InspectionItem[]; areas: AreaDef[]; units: { id: string; name: string; type: UnitType }[]; switchedOff?: boolean;
  /** §150: what a "purchase" item can preset. */ supplies: { id: string; name: string; measure: string }[] }
export const getInspectionItems = () => call<ChecklistSetupData | Fail>('/api/inspection-items');
export const saveInspectionItem = (body: Record<string, unknown>) =>
  call<ChecklistSetupData | Fail>('/api/inspection-items', { method: 'POST', body: JSON.stringify(body) });

export interface Vendor { id: string; name: string; trade: string | null; phone: string | null; email: string | null; notes: string | null; active: boolean }
export const getVendors = () => call<{ ok: true; vendors: Vendor[] } | Fail>('/api/vendors');
export const saveVendor = (body: Record<string, unknown>) =>
  call<{ ok: true; vendors: Vendor[] } | Fail>('/api/vendors', { method: 'POST', body: JSON.stringify(body) });

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

export type RepoArchived = RepoTable & { sectionTitle: string; archivedAt: string };
export const getRepoMeta = () =>
  call<{ ok: true; meta: { sections: RepoSection[]; archived?: RepoArchived[] }; appUrl: string | null } | RepoFail>(
    '/api/repository?op=meta');
export const getRepoRows = (table: string, archived = false) =>
  call<{ ok: true; total: number; rows: RepoRow[]; tookMs: number } | RepoFail>(
    `/api/repository?op=list&table=${encodeURIComponent(table)}${archived ? '&archived=1' : ''}`);
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
/* §149, §155: Repository → Units against the live Hostaway listings, by section. */
export interface RepoCheckDef { key: string; label: string; section: import('./lib/repo-checks.ts').SectionKey; note: string; send: boolean; fields: string[]; long: boolean }
export interface RepoCheckUnit {
  unitId: string; unit: string; table: string | null; recordId: string | null; record: string | null;
  checks: import('./lib/repo-checks.ts').CheckResult[];
}
export const getRepoCheck = () =>
  call<{ ok: true; sections: typeof import('./lib/repo-checks.ts').SECTIONS; checks: RepoCheckDef[]; units: RepoCheckUnit[] } | { ok: false; message?: string }>('/api/repository-check');
export const fixRepoCheck = (body: { unitId: string; checks?: string[]; to?: 'repository' | 'hostaway'; op?: 'draft-adds' }) =>
  call<{ ok: true; unit: RepoCheckUnit } | { ok: false; message?: string }>('/api/repository-check', {
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

/* ── to-dos (§76) ──────────────────────────────────────────────────── */

export type { Todo } from './lib/todos.ts';
type TodosResult = { ok: true; todos: import('./lib/todos.ts').Todo[] } | { ok: false; message?: string };
export interface HostawaySync { skipped?: string; changed: number; imported: number; unlinked: number; retried: number }
/** §94: Hostaway's users — owners and supervisors are theirs. */
export interface Person { id: number; name: string; email: string | null }
export const getPeople = () => call<{ ok: boolean; people?: Person[] }>('/api/todos?people=1');
/** §93: ask Hostaway for what the team changed there (at most every two minutes unless forced). */
export const syncHostawayTasks = (force = false) =>
  call<{ ok: true; sync: HostawaySync; todos: import('./lib/todos.ts').Todo[] } | { ok: false; message?: string }>('/api/todos', {
    method: 'POST', body: JSON.stringify({ action: 'hostawaySync', force }) });
export const getTodos = (claimId?: string) =>
  call<TodosResult>(`/api/todos${claimId ? `?claim=${encodeURIComponent(claimId)}` : ''}`);
/** The done log (§87): closed (and optionally removed) work in a range of days. */
export const getDoneLog = (from: string, to: string, removed: boolean) =>
  call<{ ok: true; rows: import('./lib/todos.ts').AuditRow[] } | { ok: false; message?: string }>(
    `/api/todos?history=1&from=${from}&to=${to}${removed ? '&removed=1' : ''}`);
export const todoAction = (body: Record<string, unknown>) =>
  call<TodosResult & { id?: string }>('/api/todos', { method: 'POST', body: JSON.stringify(body) });

/** §166: has any work moved? Two signatures to compare with the last answer, and the new to-dos after `after`. */
export interface LiveFresh { id: string; event: 'new' | 'completed' | 'cancelled'; title: string; kind: string; priority: string; createdBy: string | null; createdAt: string; order: boolean; units: string | null }
export const getLive = (after?: string, since?: string) =>
  call<{ ok: true; todos: string; claims: string; top: string; at: string; fresh: LiveFresh[] } | { ok: false; message?: string }>(
    `/api/todos?live=1${after ? `&after=${encodeURIComponent(after)}` : ''}${since ? `&since=${encodeURIComponent(since)}` : ''}`);

/* ── updates — the timeline of a task or a claim (§77) ──────────────── */

export type { WorkUpdate } from './lib/todos.ts';
type UpdatesResult = { ok: true; updates: import('./lib/todos.ts').WorkUpdate[] } | { ok: false; message?: string; error?: string };
export const getTaskUpdates = (id: string) => call<UpdatesResult>(`/api/todos?updates=${encodeURIComponent(id)}`);
/** A to-do's files (owner, Oct 2026): in Drive, from Kaizen or from Slack. */
export interface TodoFile { id: string; name: string; url: string; mime: string | null; source: 'app' | 'slack'; by: string; at: string }
type FilesResult = { ok: true; files: TodoFile[] } | Fail;
export const getTodoFiles = (todoId: string) => call<FilesResult>(`/api/todo-files?todoId=${encodeURIComponent(todoId)}`);
export const uploadTodoFiles = (todoId: string, files: File[]) => {
  const f = new FormData();
  f.append('todoId', todoId);
  for (const x of files) f.append('file', x);
  return fetch('/api/todo-files', { method: 'POST', body: f }).then(r => r.json() as Promise<FilesResult>);
};
export const removeTodoFile = (id: string) => call<FilesResult>('/api/todo-files', { method: 'POST', body: JSON.stringify({ action: 'remove', id }) });
export const getClaimUpdates = (id: string) => call<UpdatesResult>(`/api/claims?updates=${encodeURIComponent(id)}`);
export const postClaimNote = (id: string, body: string) =>
  call<{ ok: boolean; error?: string }>('/api/claims', { method: 'POST', body: JSON.stringify({ action: 'note', id, body }) });

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

/* ── SOPs (§92) ──────────────────────────────────────────────────────── */
import type { Sop, SopSection, SopVersion } from './lib/sops.ts';
export interface SopsResult { ok: boolean; canEdit?: boolean; sections?: SopSection[]; sops?: Sop[]; error?: string }
export const getSops = () => call<SopsResult>('/api/sops');
export const getSopVersions = (id: string) =>
  call<{ ok: boolean; versions?: SopVersion[]; error?: string }>(`/api/sops?versions=${encodeURIComponent(id)}`);
export const sopAction = (body: Record<string, unknown>) =>
  call<{ ok: boolean; sop?: Sop; key?: string; newVersion?: boolean; error?: string }>('/api/sops', { method: 'POST', body: JSON.stringify(body) });

/* ── Slack (§99) ─────────────────────────────────────────────────────── */
import type { SlackConfig } from './lib/slack.ts';
export interface SlackState { ok: boolean; hasToken?: boolean; hasSecret?: boolean; config?: SlackConfig; error?: string; grantedScopes?: string[] | null }
export const getSlack = () => call<SlackState>('/api/slack-settings');
export const slackAction = (body: Record<string, unknown>) =>
  call<SlackState & { team?: string; bot?: string; channels?: { id: string; name: string; private: boolean; member: boolean }[];
                      missing?: number; channel?: { channelId: string; channelName: string };
                      message?: { text: string; blocks: { type: string; text?: { text: string } }[] } }>('/api/slack-settings', { method: 'POST', body: JSON.stringify(body) });

/* ── handymen (§137) ─────────────────────────────────────────────── */

/** One work order as its handyman sees it. */
export interface WorkPage {
  work: { id: string; title: string; description: string | null; unit: string | null; scheduledOn: string | null; startTime: string | null;
          dueOn: string | null; status: string; vendor: string | null; accepted: { at: string; by: string | null } | null; resolution: string | null };
  today: string; address: string | null;
  /** How to get in — only on the day set. */
  access: import('./lib/unit-access.ts').UnitAccess | null;
  photos: { before: number; after: number };
  charges: { id: string; amount: number; description: string; status: 'pending' | 'approved' | 'denied'; decisionNote: string | null }[];
}
type WorkAnswer = { ok: true; page: WorkPage } | Fail;
async function workSend(url: string, headers: Record<string, string>, fields: Record<string, string>, files: File[]): Promise<WorkAnswer> {
  const init: RequestInit = files.length
    ? { method: 'POST', headers, body: (() => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); for (const x of files) f.append('file', x); return f; })() }
    : { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(fields) };
  const res = await fetch(url, init);
  return await res.json().catch(() => ({ ok: false, message: `HTTP ${res.status}` })) as WorkAnswer;
}
/** The link the team sends for one work order. */
export const getWorkLink = (token: string) =>
  call<({ ok: true; vendor: string; page: WorkPage }) | Fail>('/api/report-link', { headers: { 'X-Work-Token': token } });
export const workLinkAct = (token: string, fields: Record<string, string>, files: File[]) =>
  workSend('/api/report-link', { 'X-Work-Token': token }, fields, files);
/** A handyman signed in: their work orders. */
export const getVendorWork = () => call<({ ok: true; vendor: string; works: WorkPage[] }) | Fail>('/api/vendor');
export const vendorAct = (todoId: string, fields: Record<string, string>, files: File[]) =>
  workSend('/api/vendor', {}, { ...fields, todoId }, files);
/** The team: the link for a work order's vendor. */
export const vendorLink = (id: string) =>
  call<({ ok: true; link: string; vendor: string; phone: string | null; title: string; unit: string | null; day: string; expires: string }) | Fail>(
    '/api/todos', { method: 'POST', body: JSON.stringify({ action: 'vendorLink', id }) });

/* Reports (owner, 2026-10-15): bugs and requests about Kaizen. */
import type { ReportRow } from './lib/reports.ts';
export const getReports = () => call<{ ok: boolean; all: boolean; me: string; reports: ReportRow[]; message?: string }>('/api/reports');
export const postReport = (body: Record<string, unknown>) =>
  call<{ ok: boolean; id?: string; message?: string }>('/api/reports', { method: 'POST', body: JSON.stringify(body) });
