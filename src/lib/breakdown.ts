/**
 * Where the money came from, and where it went.
 *
 * Pure. Both sides use the SAME window arithmetic as the headline
 * figures — `reservationContribution` and `prorateCosts` — rather than
 * re-deriving totals. A breakdown whose parts do not add up to the
 * number above it is worse than no breakdown at all.
 */
import {
  reservationContribution, prorateCosts,
  type CostRow, type Period, type Reservation
} from './finance.ts';

export interface ChannelRow {
  channel: string;
  revenue: number;
  nights: number;
  bookings: number;
  adr: number | null;
  share: number;
}

/**
 * Hostaway spells the same channel several ways depending on where the
 * booking came from — `airbnbOfficial`, `Airbnb`, `homeaway`. Grouped
 * loosely on purpose: four spellings of Airbnb in a channel report is
 * not a finding, it is a data-cleaning bug on display.
 */
export function channelLabel(raw: string | undefined): string {
  const c = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!c) return 'Unknown';
  if (c.includes('airbnb')) return 'Airbnb';
  // Direct is tested BEFORE Booking.com, because Hostaway's own direct
  // booking engine is spelled `bookingengine` and a substring test for
  // "booking" claims it for the OTA — quietly moving commission-free
  // revenue into the channel you pay 15% to, which is exactly backwards
  // for any decision made from this table.
  if (c.includes('bookingengine') || c.includes('direct') || c.includes('website')) return 'Direct';
  if (c.includes('booking')) return 'Booking.com';
  if (c.includes('vrbo') || c.includes('homeaway') || c.includes('expedia')) return 'Vrbo / Expedia';
  if (c.includes('marriott') || c.includes('homes')) return 'Marriott';
  // An iCal import is not a sales channel. These are owner holds and
  // cross-platform blocks: they occupy nights and earn nothing, and
  // listing them as "custom Ical" alongside Airbnb invites someone to
  // read a $0 ADR as a pricing failure rather than a blocked calendar.
  if (c.includes('ical') || c.includes('block')) return 'Blocked (iCal)';
  // Anything unrecognised keeps its own name, split at camelCase and
  // capitalised — a channel we have not seen before should read as a
  // channel, not as a field dump.
  const spaced = String(raw).replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function byChannel(reservations: Reservation[], p: Period): ChannelRow[] {
  const acc = new Map<string, { revenue: number; nights: number; bookings: number }>();

  for (const r of reservations) {
    const c = reservationContribution(r, p);
    if (!c) continue;
    const key = channelLabel(r.channel);
    const e = acc.get(key) ?? { revenue: 0, nights: 0, bookings: 0 };
    e.revenue += c.revenue; e.nights += c.nights; e.bookings++;
    acc.set(key, e);
  }

  const total = [...acc.values()].reduce((a, e) => a + e.revenue, 0);
  return [...acc.entries()]
    .map(([channel, e]) => ({
      channel, revenue: e.revenue, nights: e.nights, bookings: e.bookings,
      adr: e.nights ? e.revenue / e.nights : null,
      share: total > 0 ? e.revenue / total : 0
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

export interface CostLine {
  category: string;
  total: number;
  fixed: number;
  variable: number;
  share: number;
}

/**
 * Costs by category across the whole portfolio for the window.
 *
 * Shared costs are already divided across units by `prorateCosts`, so
 * summing the per-unit breakdowns reproduces the portfolio figure
 * exactly — no separate path that could drift from it.
 */
export function byCategory(costs: CostRow[], listingIds: string[], p: Period): CostLine[] {
  const per = prorateCosts(costs, listingIds, p);
  const acc = new Map<string, { total: number; fixed: number; variable: number }>();

  // Which categories are fixed vs variable is a property of the ROWS, so
  // the split is taken from them rather than guessed from the name.
  const fixedCats = new Set(costs.filter(c => c.frequency === 'Monthly').map(c => c.category));

  for (const id of listingIds) {
    const b = per[id];
    if (!b) continue;
    for (const [cat, amount] of Object.entries(b.byCategory)) {
      const e = acc.get(cat) ?? { total: 0, fixed: 0, variable: 0 };
      e.total += amount;
      if (fixedCats.has(cat)) e.fixed += amount; else e.variable += amount;
      acc.set(cat, e);
    }
  }

  const total = [...acc.values()].reduce((a, e) => a + e.total, 0);
  return [...acc.entries()]
    .map(([category, e]) => ({ ...e, category, share: total > 0 ? e.total / total : 0 }))
    .sort((a, b) => b.total - a.total);
}
