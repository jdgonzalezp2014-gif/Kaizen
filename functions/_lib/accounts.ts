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
  allowedEmails: string[];
}

interface AccountRow {
  id: number; name: string;
  hostaway_account_id: string | null;
  hostaway_api_key_enc: string | null;
  gemini_api_key_enc: string | null;
  gemini_model: string;
  target_net_per_unit: string;
  occ_floor_pct: number;
  stay_nights: number;
  fwd_study_days: number;
  offline_after_days: number;
  cleanings_csv_url: string | null;
  allowed_emails: string[];
}

/**
 * Safe to send to a browser: it says WHETHER a key is stored, never what
 * it is. The plaintext only ever travels inward.
 */
export async function getAccount(sql: SqlFn, accountId = 1): Promise<Account | null> {
  const rows = await sql`
    SELECT id, name, hostaway_account_id, hostaway_api_key_enc,
           gemini_api_key_enc, gemini_model,
           target_net_per_unit, occ_floor_pct, stay_nights,
           fwd_study_days, offline_after_days, cleanings_csv_url, allowed_emails
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
    geminiModel: r.gemini_model ?? 'gemini-3.6-flash',
    targetNetPerUnit: Number(r.target_net_per_unit),
    occFloorPct: r.occ_floor_pct,
    stayNights: r.stay_nights,
    fwdStudyDays: r.fwd_study_days ?? 30,
    offlineAfterDays: r.offline_after_days ?? 45,
    cleaningsCsvUrl: r.cleanings_csv_url,
    allowedEmails: r.allowed_emails ?? []
  };
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
