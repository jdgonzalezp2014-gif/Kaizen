/**
 * Kaizen work ↔ Hostaway tasks (§93, §94) — the mapping, with no I/O.
 *
 * Since §94 Kaizen's task IS Hostaway's task — same statuses, priority,
 * owner, supervisor, listing, stay, start and finish, cost, resolution —
 * so this is a copy, field for field. Only Kaizen's extras (the kind, the
 * vendor, the estimate, sub-tasks, the claim) stay Kaizen's; the first
 * three are named in a footer on the description for Hostaway readers,
 * which Kaizen strips when reading back.
 *
 * Hostaway's task has no "updated at", so each linked task keeps the state
 * both sides last agreed on (SyncState). A pull compares Hostaway's task
 * with it field by field: a field that moved there was changed there.
 *
 * Times: Hostaway reads and writes `canStartFrom` / `shouldEndBy` as UTC
 * "YYYY-MM-DD HH:mm:ss" (checked 2026-09-30); Kaizen's are New York.
 * Priority: Hostaway takes a number and does not document a scale; Kaizen
 * writes none/low/medium/high/urgent as null/1/2/3/4 (PRIORITY_NUMBER).
 */
import type { Priority, TaskKind, TaskStatus } from './todos.ts';

export type HostawayStatus = 'pending' | 'confirmed' | 'inProgress' | 'completed' | 'cancelled';

export interface HostawayTask {
  id: number; listingMapId: number | null; reservationId: number | null; autoTaskId: number | null;
  assigneeUserId: number | null; supervisorUserId: number | null; createdByUserId: number | null;
  title: string; description: string | null; canStartFrom: string | null; shouldEndBy: string | null;
  status: string; priority: number | null; resolutionNote: string | null; cost: number | null; costCurrency: string | null;
  completedAt: string | null;
}
export interface HostawayUser { id: number; email: string | null; firstName: string | null; lastName: string | null }

/** What syncs, both ways — as Hostaway holds it, times as New York "YYYY-MM-DD HH:MM". */
export interface SyncState {
  title: string;
  /** Without Kaizen's footer. */
  description: string;
  status: HostawayStatus;
  priority: number | null;
  assigneeUserId: number | null;
  supervisorUserId: number | null;
  listingMapId: number | null;
  reservationId: number | null;
  start: string | null;
  end: string | null;
  cost: number | null;
  resolutionNote: string;
}

/** The fields of a Kaizen task the mirror needs. */
export interface WorkForSync {
  id: string; title: string; description: string | null; kind: TaskKind; status: TaskStatus; priority: Priority;
  unitIds: string[]; reservationId: string | null;
  scheduledOn: string | null; startTime: string | null; dueOn: string | null; dueTime: string | null;
  assigneeUserId: number | null; supervisorUserId: number | null;
  vendor: string | null; costEstimate: number | null; costActual: number | null; resolutionNote: string | null;
}

const TZ = 'America/New_York';
/** When a day is given without a time. */
export const DEFAULT_START = '09:00';
export const DEFAULT_END = '23:59';

export const toHostawayStatus = (s: TaskStatus): HostawayStatus => s === 'in_progress' ? 'inProgress' : s;
export const fromHostawayStatus = (s: string): TaskStatus =>
  s === 'inProgress' ? 'in_progress' : (['confirmed', 'completed', 'cancelled'] as const).find(x => x === s) ?? 'pending';
const asStatus = (s: string): HostawayStatus => toHostawayStatus(fromHostawayStatus(s));

export const PRIORITY_NUMBER: Record<Priority, number | null> = { none: null, low: 1, medium: 2, high: 3, urgent: 4 };
const BY_NUMBER: Priority[] = ['none', 'low', 'medium', 'high', 'urgent'];
/** Anything above 4 is urgent; nothing, or 0, is none. */
export const priorityOf = (n: number | null | undefined): Priority => BY_NUMBER[Math.min(Math.max(Math.round(n ?? 0), 0), 4)]!;

/* ── time ───────────────────────────────────────────────────────────── */

/** A New York wall-clock time as Hostaway's UTC string. */
export function nyToUtc(day: string, time = '00:00'): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  // New York is UTC-4 or UTC-5; take the offset that gives back the asked-for hour.
  for (const off of [4, 5]) {
    const t = new Date(Date.UTC(y, m - 1, d, hh + off, mm));
    const back = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(t);
    if (Number(back) === hh) return t.toISOString().slice(0, 19).replace('T', ' ');
  }
  return new Date(Date.UTC(y, m - 1, d, hh + 5, mm)).toISOString().slice(0, 19).replace('T', ' ');
}

/** Hostaway's UTC string as New York "YYYY-MM-DD HH:MM". */
export function utcToNy(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = new Date(`${s.replace(' ', 'T')}Z`);
  if (!Number.isFinite(t.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(t).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
export const utcToNyDay = (s: string | null | undefined) => utcToNy(s)?.slice(0, 10) ?? null;

/** A day and an optional time as "YYYY-MM-DD HH:MM", the default filling a missing time. */
const at = (day: string | null, time: string | null, dflt: string) => day ? `${day} ${(time ?? dflt).slice(0, 5)}` : null;
/** Back into a day and a time — the default time reads as "no time". */
const split = (v: string | null, dflt: string): { day: string | null; time: string | null } =>
  !v ? { day: null, time: null } : { day: v.slice(0, 10), time: v.slice(11, 16) === dflt ? null : v.slice(11, 16) };

/* ── people ─────────────────────────────────────────────────────────── */

export const userName = (u: HostawayUser) => [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || `User ${u.id}`;

/* ── the description footer ─────────────────────────────────────────── */

export const FOOTER_MARK = '\n\n— Kaizen OS';

/** Kaizen's own description, without the footer it adds for Hostaway readers. */
export const coreOf = (description: string | null | undefined) => (description ?? '').split(FOOTER_MARK)[0]!.trim();

/** What only Kaizen holds, said for Hostaway readers. */
function footer(w: WorkForSync): string {
  const bits = [`${w.kind === 'work_order' ? 'Repair' : 'To-do'} #${w.id}`];
  if (w.vendor) bits.push(`Vendor: ${w.vendor}`);
  if (w.costEstimate != null && w.costActual == null) bits.push(`Estimate $${w.costEstimate.toFixed(2)}`);
  return `${FOOTER_MARK} · ${bits.join(' · ')}`;
}

/* ── Kaizen → Hostaway ──────────────────────────────────────────────── */

/** The body for POST /tasks or PUT /tasks/{id}: the same task, field for field. */
export function toHostawayBody(w: WorkForSync) {
  const start = at(w.scheduledOn, w.startTime, DEFAULT_START);
  const end = at(w.dueOn, w.dueTime, DEFAULT_END);
  return {
    listingMapId: w.unitIds[0] ? Number(w.unitIds[0]) : null,
    reservationId: w.reservationId ? Number(w.reservationId) : null,
    title: w.kind === 'work_order' ? `🔧 ${w.title}` : w.title,
    description: `${coreOf(w.description)}${footer(w)}`.trim(),
    canStartFrom: start ? nyToUtc(start.slice(0, 10), start.slice(11)) : null,
    shouldEndBy: end ? nyToUtc(end.slice(0, 10), end.slice(11)) : null,
    status: toHostawayStatus(w.status),
    priority: PRIORITY_NUMBER[w.priority],
    assigneeUserId: w.assigneeUserId,
    supervisorUserId: w.supervisorUserId,
    cost: w.costActual,
    costCurrency: w.costActual != null ? 'USD' : null,
    resolutionNote: w.resolutionNote
  };
}

/* ── Hostaway → Kaizen ──────────────────────────────────────────────── */

const cleanTitle = (t: string) => t.replace(/^🔧\s*/, '').trim();

export function stateOf(h: Pick<HostawayTask, 'title' | 'description' | 'status' | 'priority' | 'assigneeUserId' | 'supervisorUserId'
  | 'listingMapId' | 'reservationId' | 'canStartFrom' | 'shouldEndBy' | 'cost' | 'resolutionNote'>): SyncState {
  return {
    title: cleanTitle(h.title ?? ''), description: coreOf(h.description), status: asStatus(h.status),
    priority: h.priority || null, assigneeUserId: h.assigneeUserId ?? null, supervisorUserId: h.supervisorUserId ?? null,
    listingMapId: h.listingMapId ?? null, reservationId: h.reservationId ?? null,
    start: utcToNy(h.canStartFrom), end: utcToNy(h.shouldEndBy),
    cost: h.cost == null ? null : Number(h.cost), resolutionNote: (h.resolutionNote ?? '').trim()
  };
}

/** The Kaizen fields a Hostaway task sets. */
export interface WorkPatch {
  title?: string; description?: string | null; status?: TaskStatus; priority?: Priority;
  assigneeUserId?: number | null; assignee?: string | null; supervisorUserId?: number | null; supervisor?: string | null;
  unitIds?: string[]; reservationId?: string | null;
  scheduledOn?: string | null; startTime?: string | null; dueOn?: string | null; dueTime?: string | null;
  costActual?: number | null; resolutionNote?: string | null;
}

const nameOf = (id: number | null, users: HostawayUser[]) => { const u = users.find(x => x.id === id); return u ? userName(u) : null; };

/** Everything a Hostaway task says, as Kaizen fields — for a task that comes in from Hostaway. */
export function workFromState(s: SyncState, users: HostawayUser[]): Required<Omit<WorkPatch, never>> {
  const st = split(s.start, DEFAULT_START), en = split(s.end, DEFAULT_END);
  return {
    title: s.title, description: s.description || null, status: fromHostawayStatus(s.status), priority: priorityOf(s.priority),
    assigneeUserId: s.assigneeUserId, assignee: nameOf(s.assigneeUserId, users),
    supervisorUserId: s.supervisorUserId, supervisor: nameOf(s.supervisorUserId, users),
    unitIds: s.listingMapId != null ? [String(s.listingMapId)] : [], reservationId: s.reservationId != null ? String(s.reservationId) : null,
    scheduledOn: st.day, startTime: st.time, dueOn: en.day, dueTime: en.time,
    costActual: s.cost, resolutionNote: s.resolutionNote || null
  };
}

/**
 * What moved in Hostaway since the two sides last agreed. Only fields that
 * differ from the snapshot count: a field nobody touched there never
 * overwrites what Kaizen holds.
 */
export function changesFrom(prev: SyncState, now: SyncState, users: HostawayUser[]): { patch: WorkPatch; said: string[] } {
  const w = workFromState(now, users);
  const patch: WorkPatch = {};
  const said: string[] = [];
  const moved = <K extends keyof SyncState>(k: K) => JSON.stringify(prev[k]) !== JSON.stringify(now[k]);
  if (moved('status')) { patch.status = w.status; said.push(`status ${now.status === 'inProgress' ? 'in progress' : now.status}`); }
  if (moved('title') && now.title) { patch.title = w.title; said.push(`title “${now.title}”`); }
  if (moved('description')) { patch.description = w.description; said.push('description'); }
  if (moved('priority')) { patch.priority = w.priority; said.push(`priority ${w.priority}`); }
  if (moved('assigneeUserId')) { patch.assigneeUserId = w.assigneeUserId; patch.assignee = w.assignee; said.push(w.assignee ? `assigned to ${w.assignee}` : 'unassigned'); }
  if (moved('supervisorUserId')) { patch.supervisorUserId = w.supervisorUserId; patch.supervisor = w.supervisor; said.push(w.supervisor ? `supervisor ${w.supervisor}` : 'no supervisor'); }
  if (moved('listingMapId')) { patch.unitIds = w.unitIds; said.push(w.unitIds.length ? 'listing changed' : 'no listing'); }
  if (moved('reservationId')) { patch.reservationId = w.reservationId; said.push(w.reservationId ? 'stay changed' : 'no stay'); }
  if (moved('start')) { patch.scheduledOn = w.scheduledOn; patch.startTime = w.startTime; said.push(now.start ? `start ${now.start}` : 'no start'); }
  if (moved('end')) { patch.dueOn = w.dueOn; patch.dueTime = w.dueTime; said.push(now.end ? `finish by ${now.end}` : 'no finish-by'); }
  if (moved('cost')) { patch.costActual = w.costActual; said.push(now.cost == null ? 'cost cleared' : `cost $${now.cost.toFixed(2)}`); }
  if (moved('resolutionNote')) { patch.resolutionNote = w.resolutionNote; if (now.resolutionNote) said.push(`resolution “${now.resolutionNote}”`); }
  return { patch, said };
}

export const sameState = (a: SyncState, b: SyncState) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A task the team wrote by hand in Hostaway, still open — it becomes
 * Kaizen work. Automatic tasks (the per-reservation "Cleaning – …") never do:
 * cleans are the board's, not the team's to-do list.
 */
export const importable = (h: HostawayTask) => h.autoTaskId == null && !['completed', 'cancelled'].includes(h.status);
