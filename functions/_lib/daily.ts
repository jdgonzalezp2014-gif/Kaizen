/**
 * Reading the operations sheet — the "daily file".
 *
 * Only its LOGS are read, never Main. Main is a view the sheet redraws on
 * every refresh: day bars and banners between the rows, dates printed
 * without a year, and the reservation id kept in a cell NOTE, which a CSV
 * export drops. Parsing that would be parsing a picture of a table. The
 * logs are real tables keyed on the reservation id, and everything Main
 * shows is either in them or in Hostaway.
 *
 * Read-only, and never stored. The sheet is maintained daily by the
 * people doing the work; a copy here would be a second version of the
 * truth that is behind the first the moment somebody types.
 */
import { parseCsvFrom, pick } from './csv.ts';

/* ── fetching ─────────────────────────────────────────────────────── */

export interface CsvRead { ok: boolean; text: string; problem: string | null }

/** A published tab, read as text — or the reason it could not be. */
export async function fetchPublishedCsv(url: string): Promise<CsvRead> {
  if (!/^https:\/\/docs\.google\.com\//.test(url)) {
    return { ok: false, text: '', problem: 'Not a docs.google.com link — paste the published-CSV URL.' };
  }
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return { ok: false, text: '', problem: `The sheet answered HTTP ${res.status}.` };
    const text = await res.text();
    // Shared but not PUBLISHED serves a sign-in page with a 200, which
    // parses to zero rows and would read as "nothing logged" rather than
    // "never readable". Different facts; say which.
    if (/^\s*</.test(text)) {
      return { ok: false, text: '', problem: 'That link returned a web page, not CSV — the tab is shared but not published.' };
    }
    return { ok: true, text, problem: null };
  } catch (e) {
    return { ok: false, text: '', problem: `Could not read the sheet: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/* ── dates ────────────────────────────────────────────────────────── */

/**
 * yyyy-mm-dd from whatever the sheet printed.
 *
 * The published CSV exports DISPLAY values, so the shape depends on each
 * column's number format: the Inspection Log is formatted `yyyy-mm-dd`,
 * the Notes Log's timestamps come out as `9/14/2026 10:32:00`. The sheet
 * runs in a US locale, so a slashed date is month-first.
 */
export function isoDay(raw: string): string {
  const s = (raw ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return `${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`;
  return '';
}

/* ── Notes Log ────────────────────────────────────────────────────── */

export interface NoteEntry {
  /** As the sheet printed it — shown, and used to order same-day edits. */
  loggedAt: string;
  loggedOn: string;
  checkIn: string;
  unit: string;
  guest: string;
  kind: 'checkin' | 'checkout' | 'other';
  notes: string;
  resId: string;
}

/**
 * Every note, oldest first as the sheet keeps them. The log is
 * append-only: one row per CHANGE, so the current note for a stay is the
 * last row for that (reservation, kind).
 */
export function parseNotesLog(csv: string): NoteEntry[] | null {
  const rows = parseCsvFrom(csv, ['unit', 'type', 'notes']);
  if (!rows) return null;
  return rows.map(r => {
    const type = pick(r, 'type').toLowerCase();
    const kind: NoteEntry['kind'] = type.includes('in') && !type.includes('out') ? 'checkin'
      : type.includes('out') ? 'checkout' : 'other';
    const loggedAt = pick(r, 'logged at', 'logged', 'timestamp');
    return {
      loggedAt,
      loggedOn: isoDay(loggedAt),
      checkIn: isoDay(pick(r, 'check-in', 'checkin', 'arrival')),
      unit: pick(r, 'unit'),
      guest: pick(r, 'guest'),
      kind,
      notes: pick(r, 'notes'),
      resId: pick(r, 'res id', 'reservation id')
    };
  }).filter(n => n.unit || n.resId);
}

/** The current note per reservation and kind: the last one logged. */
export function latestNotes(entries: NoteEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    if (!e.resId) continue;
    // A later blank IS the current note — someone cleared it — so it
    // overwrites rather than being skipped.
    out.set(`${e.resId}|${e.kind}`, e.notes);
  }
  return out;
}

/* ── Inspection Log ───────────────────────────────────────────────── */

export interface InspectionEntry {
  date: string; unit: string; by: string; result: string; notes: string;
}

/**
 * Split into what was DONE and what is only SCHEDULED.
 *
 * Auto-schedule writes rows with a blank result and a future date. The
 * sheet refuses to count those as inspections — a planned visit resetting
 * the "days since" clock would silence the very reminder that asked for
 * it — and so does this.
 */
export function parseInspectionLog(csv: string, today: string):
  { done: InspectionEntry[]; scheduled: InspectionEntry[] } | null {
  const rows = parseCsvFrom(csv, ['date', 'unit', 'result']);
  if (!rows) return null;
  const done: InspectionEntry[] = [];
  const scheduled: InspectionEntry[] = [];
  for (const r of rows) {
    const date = isoDay(pick(r, 'date'));
    const unit = pick(r, 'unit');
    if (!date || !unit) continue;
    const e: InspectionEntry = {
      date, unit, by: pick(r, 'inspected by', 'inspector', 'by'),
      result: pick(r, 'result'), notes: pick(r, 'notes')
    };
    (e.result && date <= today ? done : scheduled).push(e);
  }
  done.sort((a, b) => b.date.localeCompare(a.date));
  scheduled.sort((a, b) => a.date.localeCompare(b.date));
  return { done, scheduled };
}

/* ── _Settings ────────────────────────────────────────────────────── */

export interface DailyCleaner {
  name: string;
  tier: 'high' | 'mid' | 'low' | string;
  /** Pay per bedroom count. A blank is "no rate", never zero. */
  rates: Record<string, number | null>;
  /** Deep-clean card. A blank falls back to `rates` for that size. */
  deepRates: Record<string, number | null>;
}

export interface DailySettings {
  /** Where the numbers came from. Defaults are labelled as such on screen. */
  source: 'sheet' | 'defaults';
  cleanerHighThreshold: number;
  cleanerLowThreshold: number;
  longStayPromoteNights: number;
  deepCleanNights: number;
  longVacancyDays: number;
  nextResValueHorizonDays: number;
  inspectionIntervalDays: number;
  inspectionSoonDays: number;
  inspectionValueTrigger: number;
  cleaners: DailyCleaner[];
  inspectors: string[];
}

/**
 * The sheet's compiled-in defaults (`00 Config`). Used only when the
 * `_Settings` tab is not published — and the source says so, because the
 * live values are edited from a dialog and routinely differ from these.
 */
export const DAILY_DEFAULTS: DailySettings = {
  source: 'defaults',
  cleanerHighThreshold: 1500,
  cleanerLowThreshold: 900,
  longStayPromoteNights: 20,
  deepCleanNights: 20,
  longVacancyDays: 25,
  nextResValueHorizonDays: 30,
  inspectionIntervalDays: 30,
  inspectionSoonDays: 24,
  inspectionValueTrigger: 2000,
  cleaners: [],
  inspectors: []
};

const NUMERIC_KEYS = [
  'cleanerHighThreshold', 'cleanerLowThreshold', 'longStayPromoteNights', 'deepCleanNights',
  'longVacancyDays', 'nextResValueHorizonDays', 'inspectionIntervalDays',
  'inspectionSoonDays', 'inspectionValueTrigger'
] as const;

function rateCard(raw: string): Record<string, number | null> {
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw || '{}'); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object') return {};
  const out: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    const n = v === '' || v === null ? NaN : Number(v);
    out[k] = Number.isFinite(n) ? n : null;
  }
  return out;
}

/**
 * `kind | key | value | value2 | value3 | label`, one row per setting,
 * cleaner or extra inspector. Keys are matched as the sheet writes them
 * (camelCase), so they are read from the RAW row rather than through the
 * header normaliser.
 */
export function parseDailySettings(csv: string): DailySettings | null {
  const rows = parseCsvFrom(csv, ['kind', 'key', 'value']);
  if (!rows) return null;
  const s: DailySettings = { ...DAILY_DEFAULTS, source: 'sheet', cleaners: [], inspectors: [] };
  for (const r of rows) {
    const kind = (r.kind ?? '').trim();
    const key = (r.key ?? '').trim();
    if (kind === 'num' && (NUMERIC_KEYS as readonly string[]).includes(key)) {
      const n = Number(r.value);
      if (Number.isFinite(n)) (s as unknown as Record<string, number>)[key] = n;
    } else if (kind === 'cleaner' && key) {
      s.cleaners.push({
        name: key, tier: (r.value ?? '').trim() || 'mid',
        rates: rateCard(r.value2 ?? ''), deepRates: rateCard(r.value3 ?? '')
      });
    } else if (kind === 'inspector' && key) {
      s.inspectors.push(key);
    }
  }
  return s;
}
