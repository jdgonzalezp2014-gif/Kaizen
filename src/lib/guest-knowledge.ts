/**
 * What the guest AI knows (audit 2026-11-19). Before this it saw only the portal's guide (address, Wi-Fi, times, parking,
 * rules) — not the listing's own text, capacity, beds, fees, cancellation policy, amenities, the booking's guests/pets/
 * hours, the work open on the stay, the company's general policies or the other listings. Guests ask exactly those
 * (from 70 real messages: towels, a TV per bedroom, distance to a venue, early check-in, other units, discounts, refunds,
 * hot water / AC). Pure: lines a model can quote, built from the Repository record, Hostaway's reservation and listing.
 *
 * Two guards live here, not in the prompt alone:
 *   · codes: any digits after "code / lockbox / pin / gate / keypad…" are withheld — records carry door codes in odd
 *     fields (e.g. Elevator: "Front door code: …"), and the arrival instructions are where codes travel;
 *   · stage: before a booking (inquiry, cancelled) the exact address, Wi-Fi, arrival steps and phone are left out —
 *     Airbnb shows them only once booked, and a reply must not hand them over earlier.
 */

/** Digits that follow a word for an access code — withheld, whatever field they sit in. */
const CODE_RE = /\b(codes?|c[oó]digo|lock ?box|key ?box|key ?safe|pin|gate|combo|combination|keypad|passcode|door)\b([^\d\n]{0,24})(\d[\d #*-]{2,}\d|\d{3,})/gi;
export const scrubCodes = (t: string) => t.replace(CODE_RE, (_m, w: string, gap: string) => `${w}${gap}[withheld]`);

const text = (v: unknown, max: number) => {
  const t = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : '';
};

/**
 * The Repository record's guest-safe fields, by name (a whitelist: lease, logins, vendor contacts, cleaner codes and
 * storage never reach a guest reply). What the portal guide already gives (Wi-Fi, address, check-in/out, parking notes,
 * guest access, house rules) is not repeated here.
 */
const LISTING: { key: string; label: string; max: number; booked?: true; money?: true }[] = [
  { key: 'listing_title', label: 'Listing title', max: 160 },
  { key: 'property_type', label: 'Property type', max: 60 },
  { key: 'hw_room_type', label: 'Room type', max: 60 },
  { key: 'hw_public_address', label: 'Area', max: 160 },
  { key: 'max_guests', label: 'Max guests', max: 10 },
  { key: 'guests_included', label: 'Guests included in the price', max: 10 },
  { key: 'hw_bedrooms', label: 'Bedrooms', max: 10 },
  { key: 'hw_beds', label: 'Beds', max: 10 },
  { key: 'hw_bathrooms', label: 'Bathrooms', max: 10 },
  { key: 'hw_size', label: 'Size', max: 30 },
  { key: 'floor', label: 'Floor', max: 30 },
  { key: 'elevator', label: 'Elevator', max: 160 },
  { key: 'checkin_until', label: 'Self check-in until', max: 30 },
  { key: 'hw_min_nights', label: 'Minimum nights', max: 10 },
  { key: 'hw_max_nights', label: 'Maximum nights', max: 10 },
  { key: 'hw_cancellation', label: 'Cancellation policy', max: 60 },
  { key: 'cleaning_fee', label: 'Cleaning fee', max: 20, money: true },
  { key: 'extra_guest_fee', label: 'Extra guest fee per night (beyond the guests included)', max: 20, money: true },
  { key: 'pet_fee', label: 'Pet fee', max: 20, money: true },
  { key: 'insurance_fee', label: 'Damage waiver per night', max: 20, money: true },
  { key: 'waiver_price', label: 'Damage waiver price', max: 20, money: true },
  { key: 'waiver_cap', label: 'Damage waiver covers up to', max: 20, money: true },
  { key: 'damage_deposit', label: 'Refundable damage deposit', max: 20, money: true },
  { key: 'deposit_hold', label: 'Security deposit hold', max: 20, money: true },
  { key: 'checkin_fee', label: 'Check-in fee', max: 20, money: true },
  { key: 'fob_replacement_fee', label: 'Lost key / fob fee', max: 20, money: true },
  { key: 'summary', label: 'Summary', max: 700 },
  { key: 'description', label: 'Description', max: 2000 },
  { key: 'the_space', label: 'The space', max: 1500 },
  { key: 'interaction', label: 'Interaction with guests', max: 500 },
  { key: 'neighborhood', label: 'The neighborhood', max: 1000 },
  { key: 'getting_around', label: 'Getting around', max: 700 },
  { key: 'other_notes', label: 'Other things to note', max: 1200 },
  { key: 'utilities', label: 'Utilities', max: 300, booked: true },
];
const money = (v: string) => /^\d+(\.\d+)?$/.test(v) ? `$${v}` : v;
/**
 * The area, never the street: the Repository's "Public address" holds the full street address on real records
 * ("15201Pleasant Ridge Way, Frisco, Texas, ...", 2026-11-19) - a part with a house number goes.
 */
export const areaOf = (v: unknown) => (typeof v === 'string' ? v : '').split(',').map(x => x.trim())
  .filter(x => x && !(/\d/.test(x) && /[a-z]/i.test(x)) && !/^united states$/i.test(x)).join(', ');

export function listingFacts(vals: Record<string, unknown> | null | undefined, booked: boolean): string[] {
  if (!vals) return [];
  return LISTING.filter(f => booked || !f.booked).flatMap(f => {
    const v = f.key === 'hw_public_address' ? areaOf(vals[f.key]) : text(vals[f.key], f.max);
    if (!v || /^(none|n\/?a|-)$/i.test(v)) return [];
    return [`${f.label}: ${f.money ? money(v) : v}`];
  });
}

/** Hostaway's amenity list (listingAmenities, present ones), as one line. */
export function amenityLine(names: string[]): string {
  const uniq = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  return uniq.length ? `Amenities (Hostaway): ${uniq.join(', ').slice(0, 2500)}` : '';
}
/** listingAmenities from GET /listings/{id}?includeResources=1 → the names marked present. */
export function amenitiesOf(listing: unknown): string[] {
  const a = (listing as { listingAmenities?: unknown } | null)?.listingAmenities;
  return Array.isArray(a) ? a.filter(x => x && typeof x === 'object' && (x as { isPresent?: unknown }).isPresent !== 0)
    .map(x => String((x as { amenityName?: unknown }).amenityName ?? '')).filter(Boolean) : [];
}

const hour = (h: unknown) => {
  const n = Number(h);
  return Number.isInteger(n) && n >= 0 && n <= 23 && h !== null && h !== '' ? `${n % 12 || 12} ${n < 12 ? 'AM' : 'PM'}` : '';
};
const count = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * This booking, as Hostaway holds it (GET /reservations/{id}): who comes, how long, its own hours (an approved early
 * check-in changes them here first), what was paid. The guest's booking note is the guest speaking.
 */
export function stayFacts(d: Record<string, unknown> | null | undefined, extra: { channel?: string; payment?: string | null; agreement?: string | null; idVerified?: boolean; checkinDone?: boolean } = {}): string[] {
  const L: string[] = [];
  if (extra.channel) L.push(`Booked through: ${extra.channel}`);
  if (d) {
    const who = [['adult', d.adults], ['child', d.children], ['infant', d.infants], ['pet', d.pets]]
      .map(([w, v]) => [w as string, count(v)] as const).filter(([, n]) => n > 0).map(([w, n]) => `${n} ${w}${n === 1 ? '' : w === 'child' ? 'ren' : 's'}`);
    const total = count(d.numberOfGuests);
    if (who.length || total) L.push(`Party: ${who.join(', ') || `${total} guests`}${total && who.length ? ` (${total} guests)` : ''}${count(d.pets) ? '' : ' · no pets booked'}`);
    if (count(d.nights)) L.push(`Nights: ${count(d.nights)}`);
    const cin = hour(d.checkInTime), cout = hour(d.checkOutTime);
    if (cin || cout) L.push(`This booking's hours: check-in ${cin || '?'}, check-out ${cout || '?'}`);
    const cur = typeof d.currency === 'string' ? d.currency : 'USD';
    if (count(d.totalPrice)) L.push(`Booking total: ${count(d.totalPrice).toFixed(2)} ${cur}${count(d.remainingBalance) ? ` · balance due ${count(d.remainingBalance).toFixed(2)} ${cur}` : ''}`);
    const note = text(d.guestNote, 400) || text(d.comment, 400);
    if (note) L.push(`Guest's note at booking (the guest speaking): ${note.replace(/\s+/g, ' ')}`);
  }
  if (extra.payment) L.push(`Payment: ${extra.payment}`);
  if (extra.agreement) L.push(`Rental agreement: ${extra.agreement}`);
  if (extra.idVerified != null) L.push(`ID verified: ${extra.idVerified ? 'yes' : 'no'}`);
  if (extra.checkinDone != null) L.push(`Online check-in: ${extra.checkinDone ? 'done' : 'not done'}`);
  return L;
}

/** The to-dos open on this stay — so "is someone coming?" gets a true answer. Internal: names and costs stay out. */
export function workFacts(todos: { title: string; status: string; kind?: string | null; dueOn?: string | null }[]): string[] {
  return todos.slice(0, 6).map(t => `${t.kind === 'repair' ? 'Repair' : 'Task'}: ${text(t.title, 140)} — ${t.status}${t.dueOn ? `, planned ${t.dueOn}` : ''}`);
}

/** The other listings, for "do you have another unit / something nearby?" — never their availability (the team checks). */
export function portfolioFacts(units: { name: string; title?: string | null; area?: string | null; bedrooms?: unknown; guests?: unknown }[], current: string): string[] {
  return units.filter(u => u.name !== current).slice(0, 40).map(u =>
    `${text(u.title, 90) || u.name}${areaOf(u.area) ? ` — ${text(areaOf(u.area), 60)}` : ''}${count(u.bedrooms) ? ` · ${count(u.bedrooms)} bd` : ''}${count(u.guests) ? ` · up to ${count(u.guests)} guests` : ''}`);
}
