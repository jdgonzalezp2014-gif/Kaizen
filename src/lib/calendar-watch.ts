/**
 * The calendar log: when a night was blocked, opened or booked — including
 * changes made in Hostaway itself, which keeps no history of its own (a
 * calendar day carries only its status and a note, never who or when).
 *
 * So Kaizen looks every hour and keeps the difference. One string of codes
 * per listing, a character a day from `from`, is the whole memory: the next
 * look is compared with it day by day, and only the days that changed are
 * written down. A change is therefore known to the hour, never the minute.
 */
import { addDays, daysBetween, type DateStr } from './dates.ts';

/** a open · b blocked · r booked · p pending · ? anything Hostaway adds later. */
export type DayCode = 'a' | 'b' | 'r' | 'p' | '?';

export function codeOf(status: string): DayCode {
  const s = status.toLowerCase();
  if (s === 'available') return 'a';
  if (s === 'blocked') return 'b';
  if (s === 'reserved' || s === 'booked') return 'r';
  if (s === 'pending') return 'p';
  return '?';
}

export const CODE_WORD: Record<DayCode, string> = {
  a: 'Open', b: 'Blocked', r: 'Booked', p: 'Pending', '?': 'Unknown'
};

export interface Look {
  from: DateStr;
  codes: string;
  /** Only the days that have one: Hostaway's note is the block's reason when someone wrote it. */
  notes: Record<DateStr, string>;
}

export interface DayChange { day: DateStr; was: DayCode; now: DayCode; note: string | null }

/**
 * Days whose status differs between two looks, over the dates both cover.
 * A day that slid out of the window (the past) or into it (a year ahead) is
 * not a change — it was simply not looked at before.
 */
export function diffLooks(prev: Look, next: Look): DayChange[] {
  const out: DayChange[] = [];
  const offset = daysBetween(prev.from, next.from);
  for (let i = 0; i < next.codes.length; i++) {
    const j = i + offset;
    if (j < 0 || j >= prev.codes.length) continue;
    const was = prev.codes[j] as DayCode;
    const now = next.codes[i] as DayCode;
    if (was === now) continue;
    const day = addDays(next.from, i);
    out.push({ day, was, now, note: next.notes[day] ?? prev.notes[day] ?? null });
  }
  return out;
}

export interface ChangeRow {
  unitId: string; day: DateStr; was: DayCode; now: DayCode;
  note: string | null; seenAt: string; since: string | null;
}

export interface ChangeRun extends Omit<ChangeRow, 'day'> { first: DateStr; last: DateStr; nights: number }

/**
 * Consecutive nights of one unit that changed the same way in the same look
 * read as one line: "Dec 20 – Jan 3 · Open → Blocked", not fifteen.
 * Expects rows newest look first, then unit, then day.
 */
export function runsOf(rows: ChangeRow[]): ChangeRun[] {
  const out: ChangeRun[] = [];
  for (const r of rows) {
    const p = out[out.length - 1];
    if (p && p.unitId === r.unitId && p.seenAt === r.seenAt && p.was === r.was && p.now === r.now &&
        p.note === r.note && addDays(p.last, 1) === r.day) {
      p.last = r.day; p.nights++;
      continue;
    }
    const { day, ...rest } = r;
    out.push({ ...rest, first: day, last: day, nights: 1 });
  }
  return out;
}

/** A block put on or taken off — the changes a person made, not a guest. */
export const isBlockChange = (r: { was: DayCode; now: DayCode }) => r.was === 'b' || r.now === 'b';
