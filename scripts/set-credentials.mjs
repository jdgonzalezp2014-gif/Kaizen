/**
 * Stores this account's Hostaway credentials, encrypted.
 *
 *   node --env-file=.env.local scripts/set-credentials.mjs
 *
 * A bootstrap, not the long-term path — the Settings screen will do this
 * through the app. It exists so the pipeline can be proven against real
 * data before there is a screen to type into.
 *
 * It verifies against Hostaway before writing. Storing a credential that
 * turns out to be wrong just moves the failure somewhere less obvious.
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { saveCredentials, getAccount } from '../functions/_lib/accounts.ts';
import { getAccessToken } from '../functions/_lib/hostaway.ts';

neonConfig.webSocketConstructor = globalThis.WebSocket;

const { HOSTAWAY_ACCOUNT_ID, HOSTAWAY_API_KEY, ENCRYPTION_KEY } = process.env;

if (!ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY is not set. Generate one with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"\n' +
    'then add it to .env.local AND to Cloudflare\'s environment variables.');
  process.exit(1);
}
if (!HOSTAWAY_ACCOUNT_ID || !HOSTAWAY_API_KEY) {
  console.error('Set HOSTAWAY_ACCOUNT_ID and HOSTAWAY_API_KEY in .env.local first.\n' +
    'They are in the old Apps Script project under Project Settings > Script Properties, ' +
    'as HA_ACCOUNT_ID and HA_API_KEY.');
  process.exit(1);
}

console.log('Verifying against Hostaway…');
try {
  await getAccessToken({ accountId: HOSTAWAY_ACCOUNT_ID, apiKey: HOSTAWAY_API_KEY });
  console.log('  ✅ credentials accepted');
} catch (err) {
  console.error(`  ❌ ${err.message}`);
  console.error('Not stored.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
});
const sql = async (strings, ...values) => {
  const text = strings.reduce((a, s, i) => a + s + (i < values.length ? `$${i + 1}` : ''), '');
  const { rows } = await pool.query(text, values);
  return rows;
};

try {
  await saveCredentials(sql, ENCRYPTION_KEY, HOSTAWAY_ACCOUNT_ID, HOSTAWAY_API_KEY);
  const acct = await getAccount(sql);
  console.log(`\nStored for account ${acct.id} (${acct.name}).`);
  console.log(`  Hostaway account: ${acct.hostawayAccountId}`);
  console.log(`  API key stored:   ${acct.hasHostawayKey ? 'yes, encrypted' : 'NO'}`);
  console.log('\nNext: npm run sync:units');
} finally {
  await pool.end();
}
