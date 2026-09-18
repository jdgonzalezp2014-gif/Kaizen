/**
 * Closing the loop on a price decision.
 *
 * Without this the decision log is a pile of intentions: twelve rows
 * saying what someone meant to achieve and nothing saying whether it
 * happened. "Record for training" only becomes training when the outcome
 * is attached, and the outcome can only be read later — which is exactly
 * why nothing had read it.
 *
 * Deliberately has no UI. It runs, it writes, and the answer shows up
 * when someone asks the log a question.
 */
import { fetchCalendar, type HostawayCredentials } from './hostaway.ts';

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

interface Pending {
  id: string;
  unit_id: string;
  window_start: string | null;
  window_end: string | null;
  detected_at: string;
  nights_open: number | null;
}

export interface ResolveResult {
  checked: number;
  booked: number;
  expired: number;
  stillOpen: number;
}

const DAY = 86_400_000;

/**
 * A decision is resolved when its window has passed, or when every night
 * it was aimed at has sold.
 *
 * `booked` counts nights that were open at decision time and are not any
 * more. That is not proof the decision caused it — nothing here can show
 * causation — so the column says what happened, and whether the advice
 * was worth following is a question answered by many rows, not one.
 */
export async function resolveOutcomes(
  sql: Sql, creds: HostawayCredentials, today: string
): Promise<ResolveResult> {
  const pending = (await sql`
    SELECT id, unit_id, window_start, window_end, detected_at, nights_open
      FROM pricing_decisions
     WHERE account_id = 1 AND outcome = 'pending' AND window_start IS NOT NULL
     ORDER BY detected_at
     LIMIT 60
  `) as Pending[];

  const out: ResolveResult = { checked: 0, booked: 0, expired: 0, stillOpen: 0 };

  for (const d of pending) {
    const from = d.window_start!;
    const to = d.window_end ?? from;
    out.checked++;

    // A window entirely in the past can never be read from the calendar
    // again — Hostaway returns nothing for it — so it is settled from
    // what we knew rather than left pending forever.
    if (to < today) {
      await sql`
        UPDATE pricing_decisions
           SET outcome = 'expired empty', resolved_at = now()
         WHERE account_id = 1 AND id = ${d.id}
      `;
      out.expired++;
      continue;
    }

    let days;
    try {
      days = await fetchCalendar(creds, d.unit_id, from, to);
    } catch {
      // A calendar we could not read is not a decision that failed.
      out.stillOpen++;
      continue;
    }
    if (!days.length) { out.stillOpen++; continue; }

    const stillOpen = days.filter(x => x.available).length;
    const wasOpen = d.nights_open ?? days.length;

    if (stillOpen === 0 && wasOpen > 0) {
      const daysToBook = Math.max(0, Math.round((Date.now() - Date.parse(d.detected_at)) / DAY));
      await sql`
        UPDATE pricing_decisions
           SET outcome = 'booked', resolved_at = now(), days_to_book = ${daysToBook}
         WHERE account_id = 1 AND id = ${d.id}
      `;
      out.booked++;
    } else if (wasOpen === 0) {
      // Nothing was open when it was made, so there was never a gap for
      // it to fill. Scored separately rather than as a failure.
      await sql`
        UPDATE pricing_decisions
           SET outcome = 'no open gap', resolved_at = now()
         WHERE account_id = 1 AND id = ${d.id}
      `;
      out.expired++;
    } else {
      out.stillOpen++;
    }
  }

  return out;
}
