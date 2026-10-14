/**
 * Repository ↔ Hostaway checks (§149, §155): does what the team keeps in Repository → Units say the same
 * as the live listing? Pure — the API brings the two sides, this decides.
 *
 * A check is one row of CHECKS: the Repository columns and the Hostaway listing fields (as Hostaway
 * names them, read and written under the same name) that must agree. Each belongs to a SECTION, which
 * is also the column group in the Units tables — the grid folds a section into one column.
 * Adding a check = an entry here + its column in the three Units tables.
 */

/** The Units tables a check reads; every one has the same columns. */
export const UNIT_TABLES = ['cortland_legacy', 'houses', 'the_links'];

export type SectionKey = 'settings' | 'description' | 'rules' | 'fees' | 'hostaway';
export const SECTIONS: { key: SectionKey; label: string; note: string }[] = [
  { key: 'settings', label: 'House settings', note: 'Wi-Fi, check-in / check-out hours and guests — what guests and cleaners are told.' },
  { key: 'description', label: 'House description', note: 'The listing\'s texts, as guests read them.' },
  { key: 'rules', label: 'House rules', note: 'Hostaway keeps one text: the original rules, then the additions (Add: …) appended at the end, numbered on.' },
  { key: 'fees', label: 'Fees', note: 'What the guest is charged. Each fee is explained to guests by its Add in House rules.' },
  { key: 'hostaway', label: 'Hostaway settings', note: 'Mapped for later: copied into the Repository to keep, never sent from here.' },
];

/**
 * text/longtext compare as written · money: an amount, 0 = none · number: a count (0 counts) ·
 * hour: an hour of the day (Hostaway 16 = "4 PM" in the Repository) · bool: Hostaway 1/0 = a checkbox ·
 * rules: the house rules, composed from the original + the additions.
 */
export type FieldKind = 'text' | 'longtext' | 'money' | 'number' | 'hour' | 'bool' | 'rules';
export interface CheckField { label: string; repo: string; hostaway: string; kind: FieldKind }
/** `send: false` — compared and copied into the Repository, never written to Hostaway from here. */
export interface CheckDef { key: string; label: string; section: SectionKey; note: string; fields: CheckField[]; send: boolean }

/** The additions appended to the house rules, in this order (§155). */
export const RULE_ADDS = ['rule_add_pet_fee', 'rule_add_lost_fob', 'rule_add_extra_guest', 'rule_add_other'];

const one = (section: SectionKey, repo: string, label: string, hostaway: string, kind: FieldKind, note = '', send = section !== 'hostaway'): CheckDef =>
  ({ key: repo, label, section, note, send, fields: [{ label, repo, hostaway, kind }] });

export const CHECKS: CheckDef[] = [
  { key: 'wifi', label: 'Wi-Fi', section: 'settings', send: true, note: 'What guests and cleaners get comes from Hostaway first.', fields: [
    { label: 'Network', repo: 'wifi_network', hostaway: 'wifiUsername', kind: 'text' },
    { label: 'Password', repo: 'password_2', hostaway: 'wifiPassword', kind: 'text' }] },
  one('settings', 'checkin_from', 'Check-in from', 'checkInTimeStart', 'hour'),
  one('settings', 'checkin_until', 'Check-in until', 'checkInTimeEnd', 'hour'),
  one('settings', 'checkout_time', 'Check-out by', 'checkOutTime', 'hour'),
  one('settings', 'max_guests', 'Max guests', 'personCapacity', 'number'),
  one('settings', 'guests_included', 'Guests included in the price', 'guestsIncluded', 'number'),

  one('description', 'listing_title', 'Listing title', 'name', 'text', 'The public title, on every channel.'),
  one('description', 'description', 'Description', 'description', 'longtext'),
  one('description', 'summary', 'Summary', 'airbnbSummary', 'longtext'),
  one('description', 'the_space', 'The space', 'airbnbSpace', 'longtext'),
  one('description', 'guest_access', 'Guest access', 'airbnbAccess', 'longtext'),
  one('description', 'interaction', 'Interaction with guests', 'airbnbInteraction', 'longtext'),
  one('description', 'neighborhood', 'The neighborhood', 'airbnbNeighborhoodOverview', 'longtext'),
  one('description', 'getting_around', 'Getting around', 'airbnbTransit', 'longtext'),
  one('description', 'other_notes', 'Other things to note', 'airbnbNotes', 'longtext'),

  one('rules', 'house_rules', 'House rules', 'houseRules', 'rules', 'The original rules plus every Add, as one text.'),

  one('fees', 'cleaning_fee', 'Cleaning fee (guest)', 'cleaningFee', 'money', 'What the guest is charged to clean — revenue, not the cleaner\'s pay.'),
  one('fees', 'extra_guest_fee', 'Extra guest fee (per night)', 'priceForExtraPerson', 'money', 'Per guest over "Guests included", per night.'),
  one('fees', 'pet_fee', 'Pet fee (Airbnb)', 'airbnbPetFeeAmount', 'money', 'Hostaway keeps it as an Airbnb setting.'),
  one('fees', 'damage_deposit', 'Refundable damage deposit', 'refundableDamageDeposit', 'money'),
  one('fees', 'checkin_fee', 'Check-in fee', 'checkinFee', 'money'),
  one('fees', 'insurance_fee', 'Insurance (per night)', 'fee:insuranceFee', 'money', 'A custom fee in Hostaway — copied here, changed only in Hostaway for now.', false),
  one('fees', 'tax_rent_pct', 'Rent tax (%)', 'propertyRentTax', 'money'),
  one('fees', 'tax_stay', 'Tax per stay', 'guestStayTax', 'money'),
  one('fees', 'tax_nightly', 'Tax per night', 'guestNightlyTax', 'money'),
  one('fees', 'tax_per_person_night', 'Tax per guest per night', 'guestPerPersonPerNightTax', 'money'),

  one('hostaway', 'hw_bedrooms', 'Bedrooms', 'bedroomsNumber', 'number'),
  one('hostaway', 'hw_beds', 'Beds', 'bedsNumber', 'number'),
  one('hostaway', 'hw_bathrooms', 'Bathrooms', 'bathroomsNumber', 'number'),
  one('hostaway', 'hw_size', 'Size (as in Hostaway)', 'squareMeters', 'number', 'Hostaway calls it square meters; the account fills it in square feet.'),
  one('hostaway', 'hw_room_type', 'Room type', 'roomType', 'text'),
  one('hostaway', 'hw_min_nights', 'Min nights', 'minNights', 'number'),
  one('hostaway', 'hw_max_nights', 'Max nights', 'maxNights', 'number'),
  one('hostaway', 'hw_cancellation', 'Cancellation policy', 'cancellationPolicy', 'text'),
  one('hostaway', 'hw_instant_book', 'Instant booking', 'instantBookable', 'bool'),
  one('hostaway', 'hw_same_day', 'Same-day booking', 'allowSameDayBooking', 'bool'),
  one('hostaway', 'hw_address', 'Address', 'address', 'text'),
  one('hostaway', 'hw_public_address', 'Public address', 'publicAddress', 'text'),
  one('hostaway', 'hw_contact_name', 'Contact name', 'contactName', 'text'),
  one('hostaway', 'hw_contact_phone', 'Contact phone', 'contactPhone1', 'text'),
  one('hostaway', 'hw_time_zone', 'Time zone', 'timeZoneName', 'text'),
  one('hostaway', 'hw_airbnb_title', 'Airbnb title', 'airbnbName', 'text'),
  one('hostaway', 'hw_vrbo_title', 'Vrbo title', 'homeawayPropertyName', 'text'),
  one('hostaway', 'hw_vrbo_headline', 'Vrbo headline', 'homeawayPropertyHeadline', 'text'),
  one('hostaway', 'hw_vrbo_description', 'Vrbo description', 'homeawayPropertyDescription', 'longtext'),
  one('hostaway', 'hw_booking_title', 'Booking.com title', 'bookingcomPropertyName', 'text'),
  one('hostaway', 'hw_booking_room', 'Booking.com room name', 'bookingcomPropertyRoomName', 'text'),
  one('hostaway', 'hw_booking_description', 'Booking.com description', 'bookingcomPropertyDescription', 'longtext'),
];

/** Every Repository column a check keeps in step with Hostaway — the grid marks them ⇄. */
export const SYNCED_COLUMNS = new Set([...CHECKS.flatMap(c => c.fields.map(f => f.repo)), ...RULE_ADDS]);

/** `case` = equal but for capitals (an SSID is case-sensitive, so it is still shown). */
export type CheckStatus = 'match' | 'case' | 'differ' | 'no-repository' | 'no-hostaway' | 'empty';

const hourLabel = (h: number) => `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
/** The Repository's choices for an hour column. */
export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => hourLabel(h));

function parseHour(s: string): number | null {
  const m = s.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const ap = m[3]?.[0];
  if (ap) { if (h < 1 || h > 12) return null; h = h % 12 + (ap === 'p' ? 12 : 0); }
  return h >= 0 && h < 24 ? h : null;
}

/** One side's value as compared and shown: '' = nothing there. */
export function norm(kind: FieldKind, v: unknown): string {
  if (kind === 'bool') {
    if (v === true || /^(1|true|yes)$/i.test(String(v ?? '').trim())) return 'Yes';
    if (v === false || /^(0|false|no)$/i.test(String(v ?? '').trim())) return 'No';
    return '';
  }
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (kind === 'money') {
    const n = Number(s.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) && n !== 0 ? n.toFixed(2) : '';
  }
  if (kind === 'number') { const n = Number(s); return Number.isFinite(n) ? String(n) : s; }
  if (kind === 'hour') { const h = parseHour(s); return h === null ? s : hourLabel(h); }
  // Hostaway and a pasted text differ in line endings and trailing spaces — not a difference anyone sees.
  if (kind === 'longtext' || kind === 'rules') return s.replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd()).join('\n').trim();
  return s;
}

/** The value a Hostaway field holds; `fee:<type>` = that custom fee's amount (all channels). */
export function hostawayValue(listing: Record<string, unknown>, field: string): unknown {
  if (!field.startsWith('fee:')) return listing[field];
  const fees = Array.isArray(listing.listingFeeSetting) ? listing.listingFeeSetting as Record<string, unknown>[] : [];
  return fees.find(f => f.feeType === field.slice(4) && !Number(f.channelId))?.amount ?? '';
}

/* ── house rules: the original + the additions ─────────────────────── */

const lastNumber = (text: string) => {
  const all = [...text.matchAll(/^\s*(\d+)\s*\./gm)];
  return all.length ? Number(all[all.length - 1]![1]) : 0;
};

/** The rules as Hostaway should hold them: the original, then each Add, numbered on if the original is numbered. */
export function composeRules(vals: Record<string, unknown>): string {
  const base = norm('rules', vals.house_rules);
  const adds = RULE_ADDS.map(k => norm('rules', vals[k])).filter(Boolean);
  let n = lastNumber(base);
  const parts = adds.map(a => n && !/^\d+\s*\./.test(a) ? `${++n}. ${a}` : a);
  return [base, ...parts].filter(Boolean).join('\n\n');
}

/** Hostaway's rules minus the Adds the record already has at the end — what is left is the original. */
export function splitRules(text: string, vals: Record<string, unknown>): string {
  let rest = norm('rules', text);
  for (const k of [...RULE_ADDS].reverse()) {
    const add = norm('rules', vals[k]);
    if (!add || !rest.endsWith(add)) continue;
    const before = rest.slice(0, rest.length - add.length);
    const m = before.match(/(^|\n\n)(\d+\.\s*)?$/);
    if (m) rest = before.slice(0, before.length - m[0].length).trim();
  }
  return rest;
}

const money = (v: unknown) => { const n = Number(norm('money', v)); return n ? `$${Number.isInteger(n) ? n : n.toFixed(2)}` : ''; };

/** A first wording for each empty Add, from the record's own fees — the team rewrites it as they like. */
export function draftAdds(vals: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const has = (k: string) => !!norm('rules', vals[k]);
  const pet = money(vals.pet_fee), fob = money(vals.fob_replacement_fee), extra = money(vals.extra_guest_fee);
  const included = norm('number', vals.guests_included), max = norm('number', vals.max_guests);
  if (pet && !has('rule_add_pet_fee'))
    out.rule_add_pet_fee = `Pet fee: ${pet} per pet, per stay. Pets must be disclosed and approved before arrival.`;
  if (fob && !has('rule_add_lost_fob'))
    out.rule_add_lost_fob = `Keys and fobs: a key or access fob that is lost or not returned at check-out is charged ${fob} to replace.`;
  if (extra && included && !has('rule_add_extra_guest'))
    out.rule_add_extra_guest = `Extra guests: the price includes ${included} guests; each additional guest is ${extra} per night${max ? ` (maximum ${max} guests)` : ''}.`;
  return out;
}

/* ── comparing and writing ─────────────────────────────────────────── */

export interface FieldResult { label: string; repo: string; hostaway: string; status: CheckStatus }
export interface CheckResult { key: string; status: CheckStatus; fields: FieldResult[] }

function fieldStatus(repo: string, hostaway: string): CheckStatus {
  if (!repo && !hostaway) return 'empty';
  if (!repo) return 'no-repository';
  if (!hostaway) return 'no-hostaway';
  if (repo === hostaway) return 'match';
  return repo.toLowerCase() === hostaway.toLowerCase() ? 'case' : 'differ';
}

/** The worst field decides the check: a real difference over a missing side over capitals over a match. */
const RANK: CheckStatus[] = ['differ', 'no-repository', 'no-hostaway', 'case', 'match', 'empty'];

export function runCheck(def: CheckDef, repoVals: Record<string, unknown>, listing: Record<string, unknown>): CheckResult {
  const fields = def.fields.map(f => {
    const repo = f.kind === 'rules' ? composeRules(repoVals) : norm(f.kind, repoVals[f.repo]);
    const hostaway = norm(f.kind, hostawayValue(listing, f.hostaway));
    return { label: f.label, repo, hostaway, status: fieldStatus(repo, hostaway) };
  });
  const filled = fields.filter(f => f.status !== 'empty');
  const status = filled.length ? RANK.find(s => filled.some(f => f.status === s))! : 'empty';
  return { key: def.key, status, fields };
}

const toRepo = (kind: FieldKind, v: string): string | number | boolean =>
  kind === 'money' || kind === 'number' ? Number(v) : kind === 'bool' ? v === 'Yes' : v;
const toHostaway = (kind: FieldKind, v: string): string | number =>
  kind === 'money' || kind === 'number' ? Number(v) : kind === 'bool' ? (v === 'Yes' ? 1 : 0) : kind === 'hour' ? parseHour(v) ?? v : v;

/**
 * What a write sets: Repository columns from Hostaway, or Hostaway fields from the Repository.
 * The house rules copy into the Repository as the original only — the record's Adds stay where they are.
 */
export function writePlan(def: CheckDef, result: CheckResult, to: 'repository' | 'hostaway', repoVals: Record<string, unknown> = {}): Record<string, string | number | boolean> | string {
  if (to === 'hostaway' && !def.send) return `${def.label} is changed in Hostaway only.`;
  const out: Record<string, string | number | boolean> = {};
  for (const [i, f] of def.fields.entries()) {
    const v = to === 'repository' ? result.fields[i]!.hostaway : result.fields[i]!.repo;
    if (!v) return `${f.label} is empty in ${to === 'repository' ? 'Hostaway' : 'the Repository'} — nothing to copy.`;
    if (to === 'repository') out[f.repo] = f.kind === 'rules' ? splitRules(v, repoVals) : toRepo(f.kind, v);
    else out[f.hostaway] = toHostaway(f.kind, v);
  }
  return out;
}

/** 1-based line where two texts first part ways (0 = the same) — so a long text says where to look. */
export function firstDiffLine(a: string, b: string): number {
  const x = a.split('\n'), y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return i + 1;
  return 0;
}
