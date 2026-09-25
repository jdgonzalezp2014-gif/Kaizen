/**
 * Per-account settings and credentials.
 *
 * Hostaway credentials live here rather than in deployment environment
 * variables so a second customer is a row, not a second deployment. They
 * are stored encrypted; see crypto.ts for why the master key stays in
 * the environment.
 */
import { decrypt, encrypt } from './crypto.ts';
import type { HostawayCredentials } from './hostaway.ts';

export type SqlFn = (strings: TemplateStringsArray, ...values: any[]) => Promise<any[]>;

export interface Account {
  id: number;
  name: string;
  hostawayAccountId: string | null;
  hasHostawayKey: boolean;
  hasGeminiKey: boolean;
  hasJinaKey: boolean;
  hasIngestToken: boolean;
  hasQuoKey: boolean;
  quoFrom: string | null;
  quoRecipients: string[];
  quoLive: boolean;
  geminiModel: string;
  targetNetPerUnit: number;
  occFloorPct: number;
  stayNights: number;
  /** The forward window this account studies by default, in days. */
  fwdStudyDays: number;
  /** Blocked solid for this many days ahead = parked, not active. */
  offlineAfterDays: number;
  /** Published-CSV URL of the sheet holding what cleaners are PAID. */
  cleaningsCsvUrl: string | null;
  /** Published CSV the Apps Script scraper writes to. */
  feedCsvUrl: string | null;
  /** Editing link of the daily file, for "open the sheet". */
  cleaningsSheetUrl: string | null;
  /** Published-CSV links for the daily file's other logs. */
  dailyNotesCsvUrl: string | null;
  dailyInspectionsCsvUrl: string | null;
  dailySettingsCsvUrl: string | null;
  /** Data Repository: the API deployment, whether a key is stored, the app link. */
  repoApiUrl: string | null;
  hasRepoKey: boolean;
  repoAppUrl: string | null;
  allowedEmails: string[];
}

interface AccountRow {
  id: number; name: string;
  hostaway_account_id: string | null;
  hostaway_api_key_enc: string | null;
  gemini_api_key_enc: string | null;
  jina_api_key_enc: string | null;
  ingest_token_enc: string | null;
  quo_api_key_enc: string | null;
  quo_from: string | null;
  quo_recipients: string[];
  quo_live: boolean;
  gemini_model: string;
  target_net_per_unit: string;
  occ_floor_pct: number;
  stay_nights: number;
  fwd_study_days: number;
  offline_after_days: number;
  cleanings_csv_url: string | null;
  feed_csv_url: string | null;
  cleanings_sheet_url: string | null;
  daily_notes_csv_url: string | null;
  daily_inspections_csv_url: string | null;
  daily_settings_csv_url: string | null;
  repo_api_url: string | null;
  repo_api_key_enc: string | null;
  repo_app_url: string | null;
  allowed_emails: string[];
}

/**
 * Safe to send to a browser: it says WHETHER a key is stored, never what
 * it is. The plaintext only ever travels inward.
 */
export async function getAccount(sql: SqlFn, accountId = 1): Promise<Account | null> {
  const rows = await sql`
    SELECT id, name, hostaway_account_id, hostaway_api_key_enc,
           gemini_api_key_enc, gemini_model, jina_api_key_enc, ingest_token_enc,
           quo_api_key_enc, quo_from, quo_recipients, quo_live,
           target_net_per_unit, occ_floor_pct, stay_nights,
           fwd_study_days, offline_after_days, cleanings_csv_url, feed_csv_url, allowed_emails,
           cleanings_sheet_url, daily_notes_csv_url, daily_inspections_csv_url,
           daily_settings_csv_url, repo_api_url, repo_api_key_enc, repo_app_url
    FROM accounts WHERE id = ${accountId}
  ` as AccountRow[];

  const r = rows[0];
  if (!r) return null;

  return {
    id: r.id,
    name: r.name,
    hostawayAccountId: r.hostaway_account_id,
    hasHostawayKey: Boolean(r.hostaway_api_key_enc),
    hasGeminiKey: Boolean(r.gemini_api_key_enc),
    hasJinaKey: Boolean(r.jina_api_key_enc),
    hasIngestToken: Boolean(r.ingest_token_enc),
    hasQuoKey: Boolean(r.quo_api_key_enc),
    quoFrom: r.quo_from,
    quoRecipients: r.quo_recipients ?? [],
    quoLive: r.quo_live === true,
    geminiModel: r.gemini_model ?? 'gemini-3.6-flash',
    targetNetPerUnit: Number(r.target_net_per_unit),
    occFloorPct: r.occ_floor_pct,
    stayNights: r.stay_nights,
    fwdStudyDays: r.fwd_study_days ?? 30,
    offlineAfterDays: r.offline_after_days ?? 45,
    cleaningsCsvUrl: r.cleanings_csv_url,
    feedCsvUrl: r.feed_csv_url,
    cleaningsSheetUrl: r.cleanings_sheet_url,
    dailyNotesCsvUrl: r.daily_notes_csv_url,
    dailyInspectionsCsvUrl: r.daily_inspections_csv_url,
    dailySettingsCsvUrl: r.daily_settings_csv_url,
    repoApiUrl: r.repo_api_url,
    hasRepoKey: Boolean(r.repo_api_key_enc),
    repoAppUrl: r.repo_app_url,
    allowedEmails: r.allowed_emails ?? []
  };
}

/**
 * The caller's role, for endpoints that answer both roles but not with
 * the same fields. The middleware decides whether a route may be reached
 * at all; this decides what it may show once it is.
 *
 * No member row means admin — the same rule as the middleware, for the
 * same reason (roles arrived after people did). Local dev is admin too,
 * since there is nobody to be.
 */
export async function roleOf(sql: SqlFn, who: { email: string; local: boolean }): Promise<'admin' | 'ops'> {
  if (who.local) return 'admin';
  const rows = await sql`
    SELECT role FROM members WHERE account_id = 1 AND email = ${who.email.trim().toLowerCase()}
  ` as { role: string }[];
  return rows[0]?.role === 'ops' ? 'ops' : 'admin';
}

/** The Data Repository API, decrypted. Server-side only. */
export async function getRepoCredentials(
  sql: SqlFn, encryptionKey: string
): Promise<{ url: string; key: string } | null> {
  const rows = await sql`
    SELECT repo_api_url, repo_api_key_enc FROM accounts WHERE id = 1
  ` as { repo_api_url: string | null; repo_api_key_enc: string | null }[];
  const r = rows[0];
  if (!r?.repo_api_url || !r.repo_api_key_enc) return null;
  return { url: r.repo_api_url, key: await decrypt(r.repo_api_key_enc, encryptionKey) };
}

/**
 * Decrypted credentials, for server-side use only.
 *
 * Throws rather than returning null when they are missing: a caller that
 * silently proceeds without credentials produces an empty dashboard that
 * looks like a portfolio with no bookings.
 */
export async function getCredentials(
  sql: SqlFn, encryptionKey: string, accountId = 1
): Promise<HostawayCredentials> {
  const rows = await sql`
    SELECT hostaway_account_id, hostaway_api_key_enc
    FROM accounts WHERE id = ${accountId}
  ` as { hostaway_account_id: string | null; hostaway_api_key_enc: string | null }[];

  const r = rows[0];
  if (!r?.hostaway_account_id || !r.hostaway_api_key_enc) {
    throw new Error(
      'No Hostaway credentials for this account. Add them in Settings, ' +
      'or run: npm run set:credentials'
    );
  }

  return {
    accountId: r.hostaway_account_id,
    apiKey: await decrypt(r.hostaway_api_key_enc, encryptionKey)
  };
}

export async function saveCredentials(
  sql: SqlFn, encryptionKey: string,
  hostawayAccountId: string, hostawayApiKey: string, accountId = 1
): Promise<void> {
  const enc = await encrypt(hostawayApiKey, encryptionKey);
  await sql`
    UPDATE accounts
       SET hostaway_account_id = ${hostawayAccountId},
           hostaway_api_key_enc = ${enc}
     WHERE id = ${accountId}
  `;
}
