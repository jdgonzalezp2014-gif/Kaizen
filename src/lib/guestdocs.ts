/**
 * Which stays must have the guest's ID and signed agreement on file (§73).
 *
 * The P2 building's own requirement — the daily file's
 * MANUAL_DOC_UNIT_PREFIX. Everywhere else an ID is not asked for, and the
 * agreement is whatever Hostaway hands over. One definition, so the board
 * and anything that reports on it cannot drift apart.
 */
export const GUEST_ID_UNITS = /^P2/i;

export const needsGuestDocs = (unit: string) => GUEST_ID_UNITS.test(unit.trim());
