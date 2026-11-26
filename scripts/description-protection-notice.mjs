/**
 * Adds the damage-protection notice to the end of every active listing's description in Hostaway (owner, 2026-11-23):
 * the guest pays a $350 deposit (2026-11-23 evening; was $500), or a damage waiver — since 2026-11-26 one fee by stay length:
 * $55, $75 for 7+ nights, $99 monthly (was $12 a night with a $60 minimum, before that $300 / $70).
 *
 *   node --env-file=.env.local scripts/description-protection-notice.mjs --dry   show what would change
 *   node --env-file=.env.local scripts/description-protection-notice.mjs         change it
 *
 * Fields: `description` (direct / website / Expedia), `homeawayPropertyDescription` (Vrbo), `bookingcomPropertyDescription`
 * (Booking.com), and since 2026-11-23 (owner: "la información tiene que estar en Airbnb… en la descripción y al final de las
 * house rules") `airbnbNotes` (Airbnb's "Other details to note") and `houseRules` (shared by every channel, Airbnb included) —
 * the portal asks Airbnb guests for the waiver or deposit too (no "None of them" since 2026-11-26). Those two get it even when empty.
 * Each field's text as it was is kept in listing_text_changes; a field that already has this notice is left alone, and an
 * older notice (other amounts, any version) is replaced in place.
 */
import { neon } from '@neondatabase/serverless';
import { getCredentials } from '../functions/_lib/accounts.ts';
import { getAccessToken } from '../functions/_lib/hostaway.ts';

export const NOTICE = 'Damage protection: before check-in, guests complete our online check-in and choose either a refundable ' +
  '$350 security deposit (held on the card and released after check-out) or a non-refundable damage waiver: $55 per stay, ' +
  '$75 for stays of 7 nights or more, or $99 for monthly stays.';
const MARK = 'Damage protection: before check-in';
// airbnbSpace (owner, 2026-11-26: "the descriptions on Airbnb do not show it"): Airbnb's description is airbnbSummary (500 characters,
// full) + airbnbSpace ("The space") — the notice goes at the end of The space so it reads in the description itself.
const FIELDS = ['description', 'homeawayPropertyDescription', 'bookingcomPropertyDescription', 'airbnbSpace', 'airbnbNotes', 'houseRules'];
const ALWAYS = new Set(['airbnbSpace', 'airbnbNotes', 'houseRules']);   // an empty one does not fall back to `description`

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
  if (!active.has(id)) { tally.skipped++; continue; }
  const body = {}, before = {};
  for (const f of FIELDS) {
    const b = String(l[f] ?? '');
    if ((!b.trim() && !ALWAYS.has(f)) || b.includes(NOTICE)) continue;   // empty = the channel falls back to `description`
    // An older notice (other amounts) is replaced in place — the paragraph runs from MARK to the end of its line.
    before[f] = b; body[f] = b.includes(MARK) ? b.replace(new RegExp(`${MARK}[^\\n]*`), NOTICE) : b.trim() ? `${b.trimEnd()}\n\n${NOTICE}` : NOTICE;
  }
  const fs = Object.keys(body);
  if (!fs.length) { tally.already++; console.log(`= ${id} ${l.name} — already has it`); continue; }
  if (DRY) { tally.changed++; console.log(`+ ${id} ${l.name} — ${fs.join(', ')}`); continue; }

  const put = await fetch(`${API}/listings/${id}`, { method: 'PUT', headers: H, body: JSON.stringify(body) });
  let detail = put.ok ? '' : `HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`;
  const back = put.ok ? (await (await fetch(`${API}/listings/${id}`, { headers: H })).json()).result : null;
  let ok = true;
  for (const f of fs) {
    const took = !!back && String(back[f] ?? '').includes(NOTICE);
    ok &&= took;
    await sql`INSERT INTO listing_text_changes (account_id, listing_id, field, before, after, outcome, detail, changed_by)
              VALUES (1, ${id}, ${f}, ${before[f]}, ${body[f]}, ${took ? 'changed' : 'failed'}, ${took ? null : detail || 'Wrote, but it did not come back — not confirmed.'}, ${WHO})`;
  }
  tally[ok ? 'changed' : 'failed']++;
  console.log(`${ok ? '✓' : '✖'} ${id} ${l.name}${detail ? ` — ${detail}` : ''}`);
}
console.log(DRY ? 'Dry run —' : 'Done —', tally);
