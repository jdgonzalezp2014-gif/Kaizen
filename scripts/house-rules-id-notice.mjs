/**
 * Adds the identity-verification notice to every listing's house rules in
 * Hostaway (§89) — once, at the end, keeping every word already there.
 *
 *   node --env-file=.env.local scripts/house-rules-id-notice.mjs --dry   show what would change
 *   node --env-file=.env.local scripts/house-rules-id-notice.mjs         change it
 *
 * Each write changes ONLY houseRules and is read back to confirm; the text
 * as it was is kept in listing_text_changes, so any listing can be put back.
 * A listing that already has the notice is left alone.
 */
import { neon } from '@neondatabase/serverless';
import { getCredentials } from '../functions/_lib/accounts.ts';
import { getAccessToken } from '../functions/_lib/hostaway.ts';

export const NOTICE = 'Identity verification: This property is subject to local regulations that require us to verify the ' +
  'identity of every guest. After booking, the main guest will be asked to provide a valid government-issued photo ID and ' +
  'to sign the rental agreement before check-in instructions are shared.';
const MARK = 'subject to local regulations that require us to verify the identity';

const DRY = process.argv.includes('--dry');
const WHO = process.argv.find(a => a.startsWith('--by='))?.slice(5) ?? 'kaizen-script';
const unq = v => String(v ?? '').replace(/^"|"$/g, '');
const sql = neon(unq(process.env.DATABASE_URL));
const token = await getAccessToken(await getCredentials(sql, unq(process.env.ENCRYPTION_KEY)));
const API = 'https://api.hostaway.com/v1';
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const listings = (await (await fetch(`${API}/listings?limit=200`, { headers: H })).json()).result;
const active = new Set((await sql`SELECT id FROM units WHERE active`).map(r => String(r.id)));
const tally = { changed: 0, already: 0, skipped: 0, failed: 0 };

for (const l of listings) {
  const id = String(l.id);
  const before = String(l.houseRules ?? '');
  if (!active.has(id)) { tally.skipped++; console.log(`· ${id} ${l.name} — not active in Kaizen, left alone`); continue; }
  if (before.includes(MARK)) { tally.already++; console.log(`= ${id} ${l.name} — already has it`); continue; }
  const after = before.trim() ? `${before.trimEnd()}\n\n${NOTICE}` : NOTICE;
  if (DRY) { tally.changed++; console.log(`+ ${id} ${l.name} — would add it (${before.length} → ${after.length} chars)`); continue; }

  const put = await fetch(`${API}/listings/${id}`, { method: 'PUT', headers: H, body: JSON.stringify({ houseRules: after }) });
  let outcome = 'failed', detail = '';
  if (!put.ok) detail = `HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`;
  else {
    const back = (await (await fetch(`${API}/listings/${id}`, { headers: H })).json()).result;
    if (String(back?.houseRules ?? '').includes(MARK)) outcome = 'changed';
    else detail = 'Wrote, but the notice did not come back — not confirmed.';
  }
  await sql`INSERT INTO listing_text_changes (account_id, listing_id, field, before, after, outcome, detail, changed_by)
            VALUES (1, ${id}, 'houseRules', ${before}, ${after}, ${outcome}, ${detail || null}, ${WHO})`;
  tally[outcome === 'changed' ? 'changed' : 'failed']++;
  console.log(`${outcome === 'changed' ? '✓' : '✖'} ${id} ${l.name}${detail ? ` — ${detail}` : ''}`);
}
console.log(DRY ? 'Dry run —' : 'Done —', tally);
