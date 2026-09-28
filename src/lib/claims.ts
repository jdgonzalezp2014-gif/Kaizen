/**
 * What a claim can be (§77) — one list for the Claims screen and the work
 * list, so a claim logged from either reads the same.
 *
 * A claim is a CASE a guest raised, and not every case needs a repair:
 * a late checkout, an early check-in, a noise complaint are claims with
 * no work order behind them. Work is linked to a claim only when there is
 * work to do.
 */
export const CLAIM_SEVERITY = ['Low', 'Medium', 'High', 'Critical'];
export const CLAIM_STATUS = ['Open', 'In progress', 'Resolved', 'Refunded', 'Dismissed'];
export const CLAIM_CATEGORIES = ['Late checkout', 'Early check-in', 'Cleanliness', 'Maintenance', 'Noise', 'Access',
                                 'Amenity', 'Wifi', 'Damage', 'Safety', 'Other'];
export const CLAIM_SOURCES = ['Airbnb', 'Booking.com', 'Vrbo', 'Expedia', 'Direct', 'In person'];
