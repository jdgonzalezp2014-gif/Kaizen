/**
 * The same sync, run from a terminal or a GitHub Action.
 *
 *   node --env-file=.env.local scripts/sync-units.mjs
 *
 * Uses Pool rather than the HTTP driver because this runs in Node, where
 * a real connection is available and cheaper across 27 statements.
 */
import { Pool, neonConfig } from '@neondatabase/serverless';
import { syncUnits } from '../functions/_lib/sync.ts';

neonConfig.webSocketConstructor = globalThis.WebSocket;

const { HOSTAWAY_ACCOUNT_ID, HOSTAWAY_API_KEY } = process.env;
if (!HOSTAWAY_ACCOUNT_ID || !HOSTAWAY_API_KEY) {
  console.error('Set HOSTAWAY_ACCOUNT_ID and HOSTAWAY_API_KEY (see .env.example).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL
});

// Adapts the template-tag shape syncUnits expects onto node-postgres'
// numbered placeholders, so one implementation serves both runtimes.
const sql = async (strings, ...values) => {
  const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), '');
  const { rows } = await pool.query(text, values);
  return rows;
};

try {
  const r = await syncUnits({ accountId: HOSTAWAY_ACCOUNT_ID, apiKey: HOSTAWAY_API_KEY }, sql);
  console.log(`${r.fetched} listing(s): ${r.active} active, ${r.inactive} inactive`);
  if (r.deactivated.length) console.log(`marked inactive (gone from Hostaway): ${r.deactivated.join(', ')}`);
  console.log();
  for (const u of r.units) {
    console.log(`  ${u.active ? '●' : '○'} ${u.id.padEnd(8)} ${u.name.slice(0, 22).padEnd(24)}` +
                `${(u.unitType || '—').padEnd(12)}${u.poolType}`);
  }
} finally {
  await pool.end();
}
