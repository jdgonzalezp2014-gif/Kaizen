/**
 * Turning Hostaway's raw fields into the two facts pricing needs: what
 * kind of unit this is, and whether it has a pool.
 *
 * Both were wrong in the previous system in ways that were silent, so
 * the rules here are narrower than they look.
 */

/**
 * "Pool" as a substring is not a pool.
 *
 * A pool TABLE is furniture, a WHIRLpool is a bathtub, pool TOYS are a
 * box in a closet — and each of those was enough to put a listing into
 * the "has a pool" comp set and price it against homes with an actual
 * swimming pool. One real listing in this portfolio carries `Pool table`,
 * `Ping pong table`, `Swimming pool` AND a bare `Pool`, which is exactly
 * the case a substring test gets wrong.
 */
const NOT_A_POOL = /pool\s*(table|cue|stick|noodles?|toys?|floats?|towels?|cover)|billiard|whirlpool|carpool/i;
const PRIVATE_POOL = /private\s*(swimming\s*)?pool|plunge\s*pool|infinity\s*pool|piscina\s*privada/i;
const SHARED_POOL = /(shared|communal|community|common|complex|resort|building)\s*(swimming\s*)?pool|piscina\s*(compartida|comun)/i;
// Word boundary, not substring — this is what keeps "whirlpool" out even
// if the exclusion list above ever misses a spelling.
const ANY_POOL = /(^|[^a-z])(swimming\s*)?pool([^a-z]|$)|piscina/i;

export type PoolType = 'None' | 'Shared' | 'Private';

/**
 * An unqualified "Pool" is reported as Shared, deliberately. Claiming a
 * private pool a unit may not have is the more expensive mistake: it
 * prices the unit against premium inventory it cannot compete with.
 */
export function poolType(amenities: string[]): PoolType {
  const real = amenities.filter(a => !NOT_A_POOL.test(a));
  if (real.some(a => PRIVATE_POOL.test(a))) return 'Private';
  if (real.some(a => SHARED_POOL.test(a))) return 'Shared';
  if (real.some(a => ANY_POOL.test(a))) return 'Shared';
  return 'None';
}

/**
 * Hostaway returns a numeric `propertyTypeId` and, on this account, no
 * name for it. The mapping is account-specific, so it is configuration
 * rather than a constant.
 *
 * Confirmed against this portfolio by three independent signals
 * agreeing: the CL-prefixed units the owner identified as apartments all
 * carry id 1; all 17 id-1 listings report building amenities (lift, gym,
 * communal pool, key-card access) and only 1 of 10 id-2 does; and every
 * listing whose name independently says "House" carries id 2.
 */
export const DEFAULT_PROPERTY_TYPES: Record<string, string> = { '1': 'Apartment', '2': 'House' };

const NAME_HINTS: [string, RegExp][] = [
  ['Apartment', /apartment|apartamento|\bapto\b|\bdepto\b|rental\s*unit|\bflat\b/i],
  ['Condo',     /condo|condominium/i],
  ['Townhouse', /town\s*house|townhome/i],
  ['Cabin',     /cabin|caba[ñn]a|lodge/i],
  ['Villa',     /villa|chalet/i],
  ['House',     /\bhouse\b|\bcasa\b|\bhome\b|residence/i]
];

export function unitTypeFromName(name: string): string {
  for (const [label, re] of NAME_HINTS) if (re.test(name)) return label;
  return '';
}

/**
 * A configured mapping beats a guess from the listing name, which beats
 * nothing. Returns '' when there is nothing to go on — better than a
 * fabricated type, because an empty type means "do not filter on this"
 * while a wrong one silently prices a cabin like an apartment.
 */
export function unitType(
  propertyTypeId: number | null,
  name: string,
  map: Record<string, string> = DEFAULT_PROPERTY_TYPES
): string {
  if (propertyTypeId != null && map[String(propertyTypeId)]) return map[String(propertyTypeId)]!;
  return unitTypeFromName(name);
}

/**
 * Comparable families. Airbnb says "Entire condo" for most US
 * apartments, so matching on the exact label throws away most of the
 * real comp set. A guest choosing between a 2BR condo and a 2BR rental
 * unit in the same suburb is choosing between two of the same thing; a
 * detached house is not.
 */
const FAMILIES: Record<string, string> = {
  Apartment: 'apartment', Condo: 'apartment', Loft: 'apartment', Aparthotel: 'apartment',
  House: 'house', Townhouse: 'house', Villa: 'house', Cottage: 'house',
  Cabin: 'house', Guesthouse: 'house'
};

export function unitFamily(type: string): string {
  return FAMILIES[type] ?? '';
}
