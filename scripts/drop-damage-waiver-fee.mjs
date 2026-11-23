/**
 * Takes Hostaway's own "Damage Waiver" fee (type insuranceFee, $12/night, general + Vrbo rows) off every listing
 * (owner, 2026-11-23: "el fee podemos tumbarlo") — the guest portal charges the waiver or deposit now, so Hostaway's
 * fee would charge it twice. Each fee row as it was is kept in listing_text_changes (field listingFeeSetting:<id>, JSON),
 * so it can be added back with POST /listingFeeSettings/<listing>.
 *
 *   node --env-file=.env.local --experimental-strip-types scripts/drop-damage-waiver-fee.mjs --dry
 *   node --env-file=.env.local --experimental-strip-types scripts/drop-damage-waiver-fee.mjs
 */
import { neon } from '@neondatabase/serverless';
import { getCredentials } from '../functions/_lib/accounts.ts';
import { getAccessToken } from '../functions/_lib/hostaway.ts';

const DRY = process.argv.includes('--dry');
const unq = v => String(v ?? '').replace(/^"|"$/g, '');
const sql = neon(unq(process.env.DATABASE_URL));
const token = await getAccessToken(await getCredentials(sql, unq(process.env.ENCRYPTION_KEY)));
const API = 'https://api.hostaway.com/v1';
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const isWaiver = f => f.feeType === 'insuranceFee' || /damage waiver/i.test(String(f.feeTitle ?? ''));
const feesOf = async id => ((await (await fetch(`${API}/listingFeeSettings/${id}`, { headers: H })).json()).result ?? []);

const listings = (await (await fetch(`${API}/listings?limit=200`, { headers: H })).json()).result;
const tally = { taken: 0, failed: 0, listings: 0 };
for (const l of listings) {
  const fees = (await feesOf(l.id)).filter(isWaiver);
  if (!fees.length) continue;
  tally.listings++;
  for (const f of fees) {
    if (DRY) { console.log(`- ${l.id} ${l.name} · fee ${f.id} ${f.feeTitle} $${f.amount}/${f.feeAppliedPer} channel ${f.channelId}`); tally.taken++; continue; }
    const res = await fetch(`${API}/listingFeeSettings/${f.id}`, { method: 'DELETE', headers: H });
    const left = (await feesOf(l.id)).some(x => x.id === f.id);
    const ok = res.ok && !left;
    await sql`INSERT INTO listing_text_changes (account_id, listing_id, field, before, after, outcome, detail, changed_by)
              VALUES (1, ${String(l.id)}, ${'listingFeeSetting:' + f.id}, ${JSON.stringify(f)}, '', ${ok ? 'changed' : 'failed'},
                      ${ok ? 'Damage Waiver fee taken off (owner 2026-11-23)' : `HTTP ${res.status}${left ? ', still there' : ''}`}, 'juan-via-claude')`;
    tally[ok ? 'taken' : 'failed']++;
    console.log(`${ok ? '✓' : '✖'} ${l.id} ${l.name} · fee ${f.id} channel ${f.channelId}`);
  }
}
console.log(DRY ? 'Dry run —' : 'Done —', tally);
