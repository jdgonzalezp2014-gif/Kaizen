/**
 * The rules of work (§76, §77): to-dos and work orders, their status in
 * words, when they are due, and the order a list is read in. Pure, so
 * Home, Operations and Claims agree.
 */
import { addDays, daysBetween, type DateStr } from './dates.ts';

export type TaskKind = 'task' | 'work_order';
export type TaskStatus = 'open' | 'in_progress' | 'waiting' | 'done' | 'cancelled';
export type Priority = 'normal' | 'high' | 'urgent';

export interface Todo {
  id: string; title: string; unitIds: string[]; dueOn: DateStr | null;
  createdAt: string; createdBy: string | null;
  /** When it was closed (done or cancelled), and by whom. */
  doneAt: string | null; doneBy: string | null;
  kind: TaskKind; status: TaskStatus; priority: Priority;
  assignee: string | null;
  /** The claim this work resolves, if any. */
  claimId: string | null;
  /** Work orders: who does it, when, and what it costs. */
  vendor: string | null; scheduledOn: DateStr | null;
  costEstimate: number | null; costActual: number | null;
  /** How many updates it has — the timeline itself is read when it is opened. */
  updates: number;
  /** The detail, so the title can stay a title (§78). */
  description: string | null;
  /** The task this is a sub-task of; one level deep. */
  parentId: string | null;
  /** The stay it is about, when there is one (§84). */
  reservationId: string | null; reservationLabel: string | null;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const md = (d: DateStr) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
/** "Jason Smith · Sep 25 → Sep 29" — how a stay is named wherever work points at it. */
export const stayLabel = (guest: string, arrival: DateStr, departure: DateStr) =>
  `${guest.trim() || 'Guest'} · ${md(arrival)} → ${md(departure)}`;

/** The list's filters (§78). Empty = no filter. */
export interface WorkFilter {
  kind?: '' | TaskKind;
  /** 'urgent' = urgent only; 'high' = high or urgent. */
  priority?: '' | 'high' | 'urgent';
  due?: '' | 'overdue' | 'today' | 'week' | 'none';
  unitId?: string;
}

export const isFiltering = (f: WorkFilter) => !!(f.kind || f.priority || f.due || f.unitId);

export function matchesFilter(t: Todo, f: WorkFilter, today: DateStr): boolean {
  if (f.kind && t.kind !== f.kind) return false;
  if (f.priority === 'urgent' && t.priority !== 'urgent') return false;
  if (f.priority === 'high' && t.priority === 'normal') return false;
  if (f.unitId && !t.unitIds.includes(f.unitId)) return false;
  if (f.due) {
    const d = dueOf(t, today);
    if (f.due === 'overdue' && d !== 'overdue') return false;
    if (f.due === 'today' && d !== 'today') return false;
    // "This week" counts what is already late too: it is due this week at the latest.
    if (f.due === 'week' && !(d === 'overdue' || d === 'today' || d === 'soon')) return false;
    if (f.due === 'none' && d !== 'none') return false;
  }
  return true;
}

/** Sub-tasks by parent, and how far along each parent is. */
export function childrenBy(list: Todo[]): Map<string, Todo[]> {
  const m = new Map<string, Todo[]>();
  for (const t of list) if (t.parentId) m.set(t.parentId, [...(m.get(t.parentId) ?? []), t]);
  return m;
}
export function progress(children: Todo[] | undefined): { done: number; total: number } {
  const live = (children ?? []).filter(c => c.status !== 'cancelled');
  return { done: live.filter(c => c.status === 'done').length, total: live.length };
}

export interface WorkUpdate {
  id: string; kind: 'note' | 'status' | 'change'; body: string; createdBy: string | null; createdAt: string;
}

export const STATUSES: TaskStatus[] = ['open', 'in_progress', 'waiting', 'done', 'cancelled'];

/** Shape + word, never colour alone (the house rule). */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  open: '○ To do', in_progress: '◐ In progress', waiting: '‖ Waiting', done: '✓ Done', cancelled: '✕ Cancelled'
};
export const PRIORITY_LABEL: Record<Priority, string> = { normal: 'Normal', high: '▲ High', urgent: '▲▲ Urgent' };
export const KIND_LABEL: Record<TaskKind, string> = { task: 'To-do', work_order: '🔧 Work order' };

export const isClosed = (s: TaskStatus) => s === 'done' || s === 'cancelled';

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

export function shortDay(d: DateStr): string {
  const x = new Date(`${d}T12:00:00Z`);
  return `${WEEKDAY[x.getUTCDay()]} ${MONTH[x.getUTCMonth()]} ${x.getUTCDate()}`;
}

export function dueLabel(t: Pick<Todo, 'dueOn'>, today: DateStr): string {
  if (!t.dueOn) return '';
  const day = shortDay(t.dueOn);
  const n = daysBetween(today, t.dueOn);
  if (n < 0) return `▲ overdue ${-n}d · ${day}`;
  if (n === 0) return '● today';
  if (n === 1) return `○ tomorrow · ${day}`;
  return `○ ${day}`;
}

const closed = (t: Pick<Todo, 'status' | 'doneAt'>) => isClosed(t.status) || !!t.doneAt;

/**
 * Open work first: urgent at the very top, then by deadline (undated after
 * dated), high before normal on the same day, then in the order written.
 * Closed last, most recently closed first.
 */
export function sortTodos(list: Todo[]): Todo[] {
  const rank = (p: Priority) => p === 'urgent' ? 0 : p === 'high' ? 1 : 2;
  return [...list].sort((a, b) => {
    if (closed(a) !== closed(b)) return closed(a) ? 1 : -1;
    if (closed(a)) return (b.doneAt ?? '').localeCompare(a.doneAt ?? '');
    if ((a.priority === 'urgent') !== (b.priority === 'urgent')) return a.priority === 'urgent' ? -1 : 1;
    if (a.dueOn !== b.dueOn) return !a.dueOn ? 1 : !b.dueOn ? -1 : a.dueOn.localeCompare(b.dueOn);
    if (a.priority !== b.priority) return rank(a.priority) - rank(b.priority);
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** What a claim's work has cost so far: actual where known, else the estimate. */
export function workCost(list: Todo[]): { actual: number; estimated: number; open: number } {
  let actual = 0, estimated = 0, open = 0;
  for (const t of list) {
    if (t.status === 'cancelled') continue;
    if (!isClosed(t.status)) open++;
    if (t.costActual != null) actual += t.costActual;
    else if (t.costEstimate != null) estimated += t.costEstimate;
  }
  return { actual, estimated, open };
}
