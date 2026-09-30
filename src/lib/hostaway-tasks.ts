/**
 * Kaizen work ↔ Hostaway tasks (§93) — the mapping, with no I/O.
 *
 * Hostaway's task has no "updated at", so each linked to-do keeps the
 * state both sides last agreed on (SyncState). A pull compares Hostaway's
 * task with it field by field: a field that moved there was changed there.
 * Kaizen's own edits are pushed as they happen, so they never need finding.
 *
 * Times: Hostaway reads and writes `canStartFrom` / `shouldEndBy` as UTC
 * "YYYY-MM-DD HH:mm:ss" (checked 2026-09-30); Kaizen's dates are New York days.
 */
import type { Priority, TaskKind, TaskStatus } from './todos.ts';

export type HostawayStatus = 'pending' | 'confirmed' | 'inProgress' | 'completed' | 'cancelled';

export interface HostawayTask {
  id: number; listingMapId: number | null; reservationId: number | null; autoTaskId: number | null;
  assigneeUserId: number | null; createdByUserId: number | null;
  title: string; description: string | null; canStartFrom: string | null; shouldEndBy: string | null;
  status: string; resolutionNote: string | null; cost: number | null; costCurrency: string | null;
  completedAt: string | null;
}
export interface HostawayUser { id: number; email: string | null; firstName: string | null; lastName: string | null }

/** What syncs, both ways — as Hostaway holds it. */
export interface SyncState {
  title: string;
  /** The description without Kaizen's footer. */
  description: string;
  status: HostawayStatus;
  assigneeUserId: number | null;
  /** The deadline as a New York day. */
  due: string | null;
  cost: number | null;
}

/** The fields of a Kaizen to-do the mirror needs. */
export interface WorkForSync {
  id: string; title: string; description: string | null; kind: TaskKind; status: TaskStatus; priority: Priority;
  unitIds: string[]; reservationId: string | null; dueOn: string | null; scheduledOn: string | null;
  assignee: string | null; vendor: string | null; costEstimate: number | null; costActual: number | null; createdAt: string;
}

const TZ = 'America/New_York';

export const toHostawayStatus = (s: TaskStatus): HostawayStatus =>
  s === 'in_progress' ? 'inProgress' : s === 'done' ? 'completed' : s === 'cancelled' ? 'cancelled' : 'pending';

/** "Confirmed" is the assignee accepting it — still to do. */
export const fromHostawayStatus = (s: string): TaskStatus =>
  s === 'inProgress' ? 'in_progress' : s === 'completed' ? 'done' : s === 'cancelled' ? 'cancelled' : 'open';

const asStatus = (s: string): HostawayStatus =>
  (['pending', 'confirmed', 'inProgress', 'completed', 'cancelled'] as const).find(x => x === s) ?? 'pending';

/* ── time ───────────────────────────────────────────────────────────── */

/** A New York wall-clock time as Hostaway's UTC string. */
export function nyToUtc(day: string, hh: number, mm = 0): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  // New York is UTC-4 or UTC-5; take the offset that gives back the asked-for hour.
  for (const off of [4, 5]) {
    const t = new Date(Date.UTC(y, m - 1, d, hh + off, mm));
    const back = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(t);
    if (Number(back) === hh) return t.toISOString().slice(0, 19).replace('T', ' ');
  }
  return new Date(Date.UTC(y, m - 1, d, hh + 5, mm)).toISOString().slice(0, 19).replace('T', ' ');
}

/** Hostaway's UTC string as a New York day. */
export function utcToNyDay(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = new Date(`${s.replace(' ', 'T')}Z`);
  if (!Number.isFinite(t.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
}

/* ── people ─────────────────────────────────────────────────────────── */

export const userName = (u: HostawayUser) => [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email || `User ${u.id}`;

/** Kaizen's owner is free text: a Hostaway user by email, full name or first name — or nobody. */
export function matchUser(text: string | null, users: HostawayUser[]): HostawayUser | null {
  const q = (text ?? '').trim().toLowerCase();
  if (!q) return null;
  return users.find(u => (u.email ?? '').toLowerCase() === q)
    ?? users.find(u => userName(u).toLowerCase() === q)
    ?? (users.filter(u => (u.firstName ?? '').trim().toLowerCase() === q).length === 1
        ? users.find(u => (u.firstName ?? '').trim().toLowerCase() === q)! : null);
}

/* ── the description footer ─────────────────────────────────────────── */

export const FOOTER_MARK = '\n\n— Kaizen OS';

/** Kaizen's own description, without the footer it adds for Hostaway readers. */
export const coreOf = (description: string | null | undefined) => (description ?? '').split(FOOTER_MARK)[0]!.trim();

function footer(w: WorkForSync, owner: string | null, unitNames: string[]): string {
  const bits = [`${w.kind === 'work_order' ? 'Repair' : 'To-do'} #${w.id}`];
  if (w.priority !== 'normal') bits.push(w.priority === 'urgent' ? 'URGENT' : 'High priority');
  if (unitNames.length > 1) bits.push(`Listings: ${unitNames.join(', ')}`);
  if (owner) bits.push(`Owner: ${owner}`);
  if (w.vendor) bits.push(`Vendor: ${w.vendor}`);
  if (w.costEstimate != null && w.costActual == null) bits.push(`Estimate $${w.costEstimate.toFixed(2)}`);
  return `${FOOTER_MARK} · ${bits.join(' · ')}`;
}

/* ── Kaizen → Hostaway ──────────────────────────────────────────────── */

/**
 * The body for POST /tasks or PUT /tasks/{id}. A to-do on several
 * listings goes on the first; the footer names the rest. An owner who is
 * not a Hostaway user (a vendor, a cleaner) is named in the footer.
 */
export function toHostawayBody(w: WorkForSync, users: HostawayUser[], unitNames: string[] = []) {
  const user = matchUser(w.assignee, users);
  const start = w.scheduledOn ?? w.dueOn ?? w.createdAt.slice(0, 10);
  const core = coreOf(w.description);
  return {
    listingMapId: w.unitIds[0] ? Number(w.unitIds[0]) : null,
    reservationId: w.reservationId ? Number(w.reservationId) : null,
    title: w.kind === 'work_order' ? `🔧 ${w.title}` : w.title,
    description: `${core}${footer(w, user ? null : w.assignee, unitNames)}`.trim(),
    canStartFrom: nyToUtc(start, 9),
    shouldEndBy: w.dueOn ? nyToUtc(w.dueOn, 23, 59) : null,
    status: toHostawayStatus(w.status),
    assigneeUserId: user?.id ?? null,
    cost: w.costActual,
    costCurrency: w.costActual != null ? 'USD' : null
  };
}

/* ── Hostaway → Kaizen ──────────────────────────────────────────────── */

const cleanTitle = (t: string) => t.replace(/^🔧\s*/, '').trim();

export function stateOf(h: Pick<HostawayTask, 'title' | 'description' | 'status' | 'assigneeUserId' | 'shouldEndBy' | 'cost'>): SyncState {
  return {
    title: cleanTitle(h.title ?? ''), description: coreOf(h.description), status: asStatus(h.status),
    assigneeUserId: h.assigneeUserId ?? null, due: utcToNyDay(h.shouldEndBy),
    cost: h.cost == null ? null : Number(h.cost)
  };
}

/** A change to apply to the Kaizen to-do, and the timeline line that says so. */
export interface PulledChange {
  patch: { title?: string; description?: string | null; status?: TaskStatus; assignee?: string | null; dueOn?: string | null; costActual?: number | null };
  said: string[];
}

/**
 * What moved in Hostaway since the two sides last agreed. Only fields
 * that differ from the snapshot count: a field nobody touched there never
 * overwrites what Kaizen holds.
 */
export function changesFrom(prev: SyncState, now: SyncState, users: HostawayUser[]): PulledChange {
  const patch: PulledChange['patch'] = {};
  const said: string[] = [];
  if (now.status !== prev.status && fromHostawayStatus(now.status) !== fromHostawayStatus(prev.status)) {
    patch.status = fromHostawayStatus(now.status);
    said.push(`status ${now.status === 'inProgress' ? 'in progress' : now.status}`);
  }
  if (now.title !== prev.title && now.title) { patch.title = now.title; said.push(`title “${now.title}”`); }
  if (now.description !== prev.description) { patch.description = now.description || null; said.push('description'); }
  if (now.assigneeUserId !== prev.assigneeUserId) {
    const u = users.find(x => x.id === now.assigneeUserId);
    patch.assignee = u ? userName(u) : null;
    said.push(u ? `assigned to ${userName(u)}` : 'unassigned');
  }
  if (now.due !== prev.due) { patch.dueOn = now.due; said.push(now.due ? `deadline ${now.due}` : 'no deadline'); }
  if (now.cost !== prev.cost) { patch.costActual = now.cost; said.push(now.cost == null ? 'cost cleared' : `cost $${now.cost.toFixed(2)}`); }
  return { patch, said };
}

export const sameState = (a: SyncState, b: SyncState) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A task the team wrote by hand in Hostaway, still open — it becomes
 * Kaizen work. Automatic tasks (the per-reservation "Cleaning – …") never do.
 */
export const importable = (h: HostawayTask) => h.autoTaskId == null && !['completed', 'cancelled'].includes(h.status);
