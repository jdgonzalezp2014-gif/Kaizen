/**
 * Postgres over HTTP.
 *
 * `@neondatabase/serverless`, not `pg` — and this is a hard constraint,
 * not a preference. The Workers runtime has no raw TCP sockets, so the
 * ordinary node-postgres driver cannot connect at all. Neon's driver
 * speaks HTTP for one-shot queries, which also means no pool to warm and
 * no connection to leak across an isolate that may be discarded between
 * requests.
 */
import { neon } from '@neondatabase/serverless';

export interface Env {
  DATABASE_URL: string;
  HOSTAWAY_ACCOUNT_ID: string;
  HOSTAWAY_API_KEY: string;
  QUO_API_KEY?: string;
  QUO_FROM?: string;
  // How far either side of today to pull reservations. Wide enough that
  // any range the UI offers is already in hand; overridable per
  // environment without a deploy.
  LEDGER_BACK_DAYS?: string;
  LEDGER_FWD_DAYS?: string;
}

export function db(env: Env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set for this environment.');
  return neon(env.DATABASE_URL);
}

/** Config a human edits without a deploy — targets, thresholds. */
export async function appConfig(env: Env): Promise<Record<string, string>> {
  const sql = db(env);
  const rows = await sql`SELECT key, value FROM app_config` as { key: string; value: string }[];
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export function configNumber(cfg: Record<string, string>, key: string, fallback: number): number {
  const n = Number(cfg[key]);
  return Number.isFinite(n) ? n : fallback;
}
