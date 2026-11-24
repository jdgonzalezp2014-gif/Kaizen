/**
 * Airbnb deposit test (owner, 2026-11-23): every listing's notice says "$350 deposit or the damage waiver" and the guest
 * portal offers both everywhere, but on half the listings (group B, random by unit type) Hostaway's own
 * `refundableDamageDeposit` is $350 too — so on Airbnb the deposit is mandatory there; group A keeps $0 (deposit only in
 * the description, the guest can drop it for the waiver). The field is shared by every channel.
 * The field as it was is kept in listing_text_changes (field refundableDamageDeposit).
 *
 *   node --env-file=.env.local --experimental-strip-types scripts/airbnb-deposit-split.mjs --dry
 *   node --env-file=.env.local --experimental-strip-types scripts/airbnb-deposit-split.mjs
 */
import { neon } from '@neondatabase/serverless';
import { getCredentials } from '../functions/_lib/accounts.ts';
import { getAccessToken } from '../functions/_lib/hostaway.ts';

export const DEPOSIT = 350;
/** Group B — Hostaway deposit $350 (mandatory on Airbnb). Group A is every other active listing ($0). */
export const GROUP_B = ['366047', '366041', '586503', '586508', '366052', '608866', '469625', '589742', '462372', '583200', '466736'];

const DRY = process.argv.includes('--dry');
const unq = v => String(v ?? '').replace(/^"|"$/g, '');
const sql = neon(unq(process.env.DATABASE_URL));
const token = await getAccessToken(await getCredentials(sql, unq(process.env.ENCRYPTION_KEY)));
const API = 'https://api.hostaway.com/v1';
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const listings = (await (await fetch(`${API}/listings?limit=200`, { headers: H })).json()).result;
const active = new Set((await sql`SELECT id FROM units WHERE active`).map(r => String(r.id)));
const tally = { changed: 0, already: 0, failed: 0 };

for (const l of listings) {
  const id = String(l.id);
  if (!active.has(id)) continue;
  const want = GROUP_B.includes(id) ? DEPOSIT : 0, was = Number(l.refundableDamageDeposit ?? 0);
  if (was === want) { tally.already++; continue; }
  if (DRY) { tally.changed++; console.log(`+ ${id} ${l.name} — ${was} → ${want}`); continue; }
  const put = await fetch(`${API}/listings/${id}`, { method: 'PUT', headers: H, body: JSON.stringify({ refundableDamageDeposit: want }) });
  const back = put.ok ? (await (await fetch(`${API}/listings/${id}`, { headers: H })).json()).result : null;
  const ok = Number(back?.refundableDamageDeposit) === want;
  const detail = ok ? null : put.ok ? 'Wrote, but it did not come back — not confirmed.' : `HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`;
  await sql`INSERT INTO listing_text_changes (account_id, listing_id, field, before, after, outcome, detail, changed_by)
            VALUES (1, ${id}, 'refundableDamageDeposit', ${String(was)}, ${String(want)}, ${ok ? 'changed' : 'failed'}, ${detail}, 'kaizen-script')`;
  tally[ok ? 'changed' : 'failed']++;
  console.log(`${ok ? '✓' : '✖'} ${id} ${l.name} — ${was} → ${want}${detail ? ` — ${detail}` : ''}`);
}
console.log(DRY ? 'Dry run —' : 'Done —', tally);
