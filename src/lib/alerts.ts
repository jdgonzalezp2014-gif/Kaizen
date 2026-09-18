/**
 * Deciding what is worth interrupting someone for.
 *
 * Pure. The rule that governs everything here comes from the client
 * spec and is the difference between an alert channel people read and
 * one they mute:
 *
 *     ALERT ON THE CHANGE, NOT ON THE STATE.
 *
 * "Still 0%, tenth straight day" is true, useless, and trains people to
 * ignore the channel — so that when the message that mattered arrives,
 * it arrives to an audience that stopped reading. A condition that has
 * just BEGUN is news. One that has just ENDED is news. One that is
 * simply still true is silence.
 */
import type { RankedUnit } from './forward.ts';
import type { VerdictKind } from './revenue.ts';

export type AlertKind = 'red-listing';

export interface AlertCondition {
  unitId: string;
  unitName: string;
  kind: AlertKind;
  /** True while the condition holds. */
  active: boolean;
  /** One line, already short enough to read on a phone. */
  detail: string;
}

/**
 * A listing is "red" when it needs a decision AND the money at stake is
 * worth a phone buzzing.
 *
 * The exposure floor is what keeps this honest. Twenty-three units under
 * an occupancy floor is not twenty-three alerts; it is a dashboard. An
 * alert is for the handful where waiting until Monday costs real money.
 */
export function redListings(
  units: RankedUnit[],
  verdictOf: (u: RankedUnit) => VerdictKind,
  opts: { minExposure?: number } = {}
): AlertCondition[] {
  const floor = opts.minExposure ?? 2000;

  return units
    .filter(u => u.active)
    .map(u => {
      const kind = verdictOf(u);
      // 'early' is explicitly NOT red: a unit that books three days out
      // is not in trouble for being empty in week four, and alerting on
      // it is how a channel earns its mute.
      const bad = kind === 'overpriced' || kind === 'stuck' || kind === 'unbookable';
      const active = bad && u.exposure >= floor;
      return {
        unitId: u.listingId,
        unitName: u.name,
        kind: 'red-listing' as const,
        active,
        detail: active ? describe(u, kind) : ''
      };
    })
    .filter(c => c.active || true);   // both edges are needed; the caller diffs
}

function describe(u: RankedUnit, kind: VerdictKind): string {
  const money = `$${Math.round(u.exposure).toLocaleString('en-US')}`;
  const occ = u.occupancy == null ? '?' : `${Math.round(u.occupancy * 100)}%`;
  if (kind === 'unbookable') return `${u.nightsOpen} open nights blocked by minimum stay, ${money} at stake`;
  if (kind === 'overpriced') return `${occ} booked, asking $${u.openAsk ?? '?'} vs $${u.adr ?? '?'} achieved, ${money} open`;
  return `${occ} booked, no pickup in 7 days, ${money} open`;
}

export type Edge = 'begin' | 'resolve';

export interface AlertEdge {
  unitId: string;
  unitName: string;
  kind: AlertKind;
  edge: Edge;
  detail: string;
}

/**
 * The diff: what changed since the last run.
 *
 * `known` is what we have already announced and not yet retracted.
 * Anything true in both is silence.
 */
export function edges(
  conditions: AlertCondition[],
  known: { unitId: string; kind: string; status: string }[]
): AlertEdge[] {
  const openKey = new Set(
    known.filter(k => k.status === 'open').map(k => `${k.unitId}|${k.kind}`)
  );
  const out: AlertEdge[] = [];

  for (const c of conditions) {
    const key = `${c.unitId}|${c.kind}`;
    const wasOpen = openKey.has(key);
    if (c.active && !wasOpen) out.push({ ...c, edge: 'begin' });
    else if (!c.active && wasOpen) {
      out.push({ ...c, edge: 'resolve', detail: 'back above the line' });
    }
  }
  return out;
}

/**
 * The message itself.
 *
 * Short because it is read on a lock screen, and because every 160
 * characters is another segment billed. The unit name comes first: the
 * reader wants to know WHICH unit before they want to know why.
 */
export function compose(e: AlertEdge): string {
  if (e.edge === 'resolve') return `${e.unitName}: resolved - ${e.detail}.`;
  return `${e.unitName}: ${e.detail}. Open Kaizen OS to price it.`;
}
