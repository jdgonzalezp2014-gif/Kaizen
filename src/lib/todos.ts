/**
 * The to-do list's rules (§76): when a to-do is due, in words, and the
 * order the list is read in. Pure, so Home and Operations agree.
 */
import { addDays, daysBetween, type DateStr } from './dates.ts';

export interface Todo {
  id: string; title: string; unitIds: string[]; dueOn: DateStr | null;
  createdAt: string; createdBy: string | null;
  doneAt: string | null; doneBy: string | null;
}

export type Due = 'overdue' | 'today' | 'soon' | 'later' | 'none';

/** "Soon" is the coming week — what should be on someone's mind now. */
export function dueOf(t: Pick<Todo, 'dueOn'>, today: DateStr): Due {
  if (!t.dueOn) return 'none';
  if (t.dueOn < today) return 'overdue';
  if (t.dueOn === today) return 'today';
  return t.dueOn <= addDays(today, 7) ? 'soon' : 'later';
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Shape + word (the house rule): never colour alone. */
export function dueLabel(t: Pick<Todo, 'dueOn'>, today: DateStr): string {
  if (!t.dueOn) return '';
  const d = new Date(`${t.dueOn}T12:00:00Z`);
  const day = `${WEEKDAY[d.getUTCDay()]} ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const n = daysBetween(today, t.dueOn);
  if (n < 0) return `▲ overdue ${-n}d · ${day}`;
  if (n === 0) return '● today';
  if (n === 1) return `○ tomorrow · ${day}`;
  return `○ ${day}`;
}

/**
 * Open first — overdue, then by due day, then the undated ones in the order
 * they were written; done last, most recent first.
 */
export function sortTodos(list: Todo[]): Todo[] {
  return [...list].sort((a, b) => {
    if (!!a.doneAt !== !!b.doneAt) return a.doneAt ? 1 : -1;
    if (a.doneAt && b.doneAt) return b.doneAt.localeCompare(a.doneAt);
    if (a.dueOn !== b.dueOn) return !a.dueOn ? 1 : !b.dueOn ? -1 : a.dueOn.localeCompare(b.dueOn);
    return a.createdAt.localeCompare(b.createdAt);
  });
}
