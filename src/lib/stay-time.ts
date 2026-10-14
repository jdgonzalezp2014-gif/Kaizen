/**
 * A stay's check-in / check-out hour, as Kaizen writes it ("4:00 PM") and
 * as Hostaway keeps it on the reservation (`checkInTime` / `checkOutTime`:
 * a whole hour 0–23, no minutes — read on reservation 66996913, 2026-10-13).
 *
 * Whole hours only, by the owner's choice: a half hour cannot reach the
 * guest, and rounding it would show them a time nobody agreed to.
 */

export type StayEnd = 'checkin' | 'checkout';

/** "4:00 PM" → 16. Anything that is not a whole hour → null. */
export function hourOf(t: string | null | undefined): number | null {
  const m = /^(1[0-2]|0?[1-9]):(\d\d)\s?(AM|PM)$/i.exec(String(t ?? '').trim());
  if (!m || m[2] !== '00') return null;
  const h = Number(m[1]) % 12;
  return m[3]!.toUpperCase() === 'PM' ? h + 12 : h;
}

/** 16 → "4:00 PM", the board's own format (what turnover_overrides stores). */
export function timeOfHour(h: number): string {
  return `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
}

/** 16 → "4 PM", for a sentence. */
export function hourWord(h: number): string {
  return `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The hours a person can pick, midnight first. */
export const HOURS: number[] = Array.from({ length: 24 }, (_, h) => h);

const END_WORD: Record<StayEnd, string> = { checkin: 'check-in', checkout: 'check-out' };

/** The Notes log line for one attempt to send a time to Hostaway. */
export function syncLogLine(kind: StayEnd, hour: number | null, standard: boolean, ok: boolean, detail?: string | null): string {
  if (!ok) return `⚠ Hostaway: ${END_WORD[kind]} not changed — ${detail || 'no reason given'}`;
  return `⇄ Hostaway: ${END_WORD[kind]} ${hour == null ? '?' : hourWord(hour)}${standard ? " (the listing's standard)" : ''}`;
}

/** The latest attempt for one stay's end, as the board receives it. */
export interface TimePush { hour: number | null; standard: boolean; outcome: 'pushed' | 'failed'; detail: string | null; at: string }

export type SyncState =
  | { state: 'sent'; hour: number | null; standard: boolean }
  | { state: 'failed'; detail: string }
  | { state: 'pending' }
  | null;

/**
 * Whether the time the board shows is the one in Hostaway. `manual` is the
 * time a person set in Kaizen (null = back to the standard). A stay nobody
 * touched and nothing sent → null: nothing to say.
 *
 * Pending = the last attempt is not about what Kaizen holds now: the send
 * is still on its way, or it never ran.
 */
export function syncState(manual: string | null, last: TimePush | undefined): SyncState {
  if (!last) return manual ? { state: 'pending' } : null;
  const about = manual ? (!last.standard && last.hour === hourOf(manual)) : last.standard;
  if (!about) return { state: 'pending' };
  return last.outcome === 'pushed'
    ? { state: 'sent', hour: last.hour, standard: last.standard }
    : { state: 'failed', detail: last.detail || 'no reason given' };
}
