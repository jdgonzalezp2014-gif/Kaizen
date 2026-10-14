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

/** What else the attempt carried: who it was checked with, and the night closed after a late check-out. */
export interface SyncExtras { checkedWith?: string | null; night?: { date: string; ok: boolean; detail?: string | null } | null }

/** The Notes log line for one attempt to send a time to Hostaway. */
export function syncLogLine(kind: StayEnd, hour: number | null, standard: boolean, ok: boolean, detail?: string | null,
                            extras: SyncExtras = {}): string {
  const head = !ok
    ? `⚠ Hostaway: ${END_WORD[kind]} not changed — ${detail || 'no reason given'}`
    : `⇄ Hostaway: ${END_WORD[kind]} ${hour == null ? '?' : hourWord(hour)}${standard ? " (the listing's standard)" : ''}`;
  const n = extras.night;
  return head +
    (extras.checkedWith ? ` · checked with ${extras.checkedWith}` : '') +
    (n ? (n.ok ? ` · night of ${n.date} blocked` : ` · ⚠ night of ${n.date} not blocked — ${n.detail || 'no reason given'}`) : '');
}

/**
 * The time the board shows for one end of a stay (§156): a time set in Kaizen
 * and not yet confirmed in Hostaway, else the reservation's own hour in
 * Hostaway (what the guest was given), else the board's fixed default.
 */
export function stayTime(kaizen: string | null | undefined, reservationHour: number | null | undefined, fallback: string):
  { time: string; from: 'kaizen' | 'hostaway' | 'default' } {
  if (kaizen) return { time: kaizen, from: 'kaizen' };
  if (reservationHour != null) return { time: timeOfHour(reservationHour), from: 'hostaway' };
  return { time: fallback, from: 'default' };
}

/**
 * An agreed time — early check-in / late check-out — is one that is not the
 * listing's standard. A time only in Kaizen counts; with no standard known,
 * only Kaizen's does.
 */
export function isAgreedTime(from: 'kaizen' | 'hostaway' | 'default', hour: number | null, standardHour: number | null | undefined): boolean {
  if (from === 'kaizen') return true;
  return from === 'hostaway' && hour != null && standardHour != null && hour !== standardHour;
}

/**
 * The night to close after a check-out moved later: the one starting that
 * day, if no guest arrives that day (then the night is theirs already).
 * Only for a check-out later than the listing's standard.
 */
export function nightToBlock(kind: StayEnd, date: string, newHour: number | null, standardHour: number | null | undefined,
                             nextArrival: string | null | undefined): string | null {
  if (kind !== 'checkout' || newHour == null) return null;
  if (newHour <= (standardHour ?? 10)) return null;
  if (nextArrival && nextArrival <= date) return null;
  return date;
}

/** The Slack reminder after a time change was checked with the cleaner — in the reader's language. */
export function timeReminder(lang: 'en' | 'es', m: { unit: string; date: string; kind: StayEnd; hour: number | null;
                                                    cleaner: string | null; night?: string | null }): string {
  const t = m.hour == null ? (lang === 'es' ? 'la hora estándar' : 'the standard time') : hourWord(m.hour);
  if (lang === 'es') {
    return `⏰ *${m.unit}* ${m.date}: ${m.kind === 'checkout' ? 'el check-out ahora es a las' : 'el check-in ahora es a las'} *${t}*` +
      (m.kind === 'checkout' ? ' — la limpieza empieza después.' : ' — la limpieza debe estar lista antes.') +
      (m.night ? ` La noche del ${m.night} quedó bloqueada.` : '');
  }
  return `⏰ *${m.unit}* ${m.date}: ${m.kind === 'checkout' ? 'check-out moved to' : 'check-in moved to'} *${t}*` +
    (m.kind === 'checkout' ? ' — the clean starts after it.' : ' — the clean must be done before it.') +
    (m.cleaner ? ` Checked with ${m.cleaner}.` : '') +
    (m.night ? ` The night of ${m.night} is blocked.` : '');
}

/** The latest attempt for one stay's end, as the board receives it. */
export interface TimePush { hour: number | null; standard: boolean; outcome: 'pushed' | 'failed'; detail: string | null; at: string }

export type SyncState =
  | { state: 'sent'; hour: number | null; standard: boolean }
  | { state: 'failed'; detail: string }
  | { state: 'pending' }
  | null;

/**
 * Whether the time the board shows is the one in Hostaway (§156). `kaizen` is
 * a time held in Kaizen — kept only until Hostaway confirms it, then cleared,
 * so the board reads the reservation again. `reservationHour` is what the
 * reservation has now.
 *
 * - Kaizen holds one: the last attempt about it failed → failed; else it is
 *   on its way (or never ran) → pending.
 * - Kaizen holds none: the board shows Hostaway's own hour. A send that
 *   landed and still matches → sent; otherwise nothing to say.
 */
export function syncState(kaizen: string | null, reservationHour: number | null | undefined, last: TimePush | undefined): SyncState {
  if (kaizen) {
    const about = last && !last.standard && last.hour === hourOf(kaizen);
    return about && last.outcome === 'failed' ? { state: 'failed', detail: last.detail || 'no reason given' } : { state: 'pending' };
  }
  if (last?.outcome === 'pushed' && last.hour != null && last.hour === reservationHour) {
    return { state: 'sent', hour: last.hour, standard: last.standard };
  }
  return null;
}
