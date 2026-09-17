/**
 * Migration runner.
 *
 * Applies every file in db/migrations/ in filename order, exactly once,
 * recording what it ran in `_migrations`. Re-running is a no-op, which
 * is the property that matters: a migration you are afraid to run twice
 * is one nobody runs at all.
 *
 * Uses the UNPOOLED connection. Neon's pooler multiplexes sessions, and
 * DDL plus advisory locks want a session to themselves.
 *
 * Each file runs inside a transaction, so a syntax error halfway down
 * leaves no half-built schema behind.
 *
 *   node --env-file=.env.local scripts/migrate.mjs [--dry]
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, neonConfig } from '@neondatabase/serverless';

// Node 24 ships a global WebSocket; the driver needs to be handed it.
neonConfig.webSocketConstructor = globalThis.WebSocket;

const DIR = 'db/migrations';
const dry = process.argv.includes('--dry');

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.error('No DATABASE_URL_UNPOOLED or DATABASE_URL. Run: neon link');
  process.exit(1);
}

const pool = new Pool({ connectionString: url });

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows: done } = await pool.query('SELECT filename FROM _migrations');
  const applied = new Set(done.map(r => r.filename));

  const files = (await readdir(DIR)).filter(f => f.endsWith('.sql')).sort();
  const pending = files.filter(f => !applied.has(f));

  if (!pending.length) {
    console.log(`Nothing to apply — ${files.length} migration(s) already recorded.`);
    process.exit(0);
  }

  console.log(`${pending.length} pending: ${pending.join(', ')}`);
  if (dry) process.exit(0);

  for (const file of pending) {
    const sql = await readFile(join(DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  ✅ ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  ❌ ${file}\n     ${err.message}`);
      process.exitCode = 1;
      break;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
