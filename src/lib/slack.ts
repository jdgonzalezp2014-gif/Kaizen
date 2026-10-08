/**
 * Slack (§99) — what Kaizen says there, and the forms it opens. Pure, so
 * the server and the tests agree; the calls to Slack live in
 * functions/_lib/slack.ts.
 *
 * Messages are Block Kit: a line to read, the facts in small print, and
 * the buttons that act on it — acting from Slack runs as the Kaizen member
 * whose email the Slack user has, with that member's permissions.
 */
import { channelLabel } from './breakdown.ts';
import { COST_CATEGORIES, amountIn, guessCategory } from './costs.ts';

export type Topic = 'tasks' | 'reservations' | 'claims' | 'escalations';
export const TOPICS: { key: Topic; label: string; what: string }[] = [
  { key: 'tasks', label: 'Tasks', what: 'to-dos and repairs: new, assigned, completed, changed in Hostaway' },
  { key: 'reservations', label: 'Reservations', what: 'the reminder: check-ins, cleans, and what is missing' },
  { key: 'claims', label: 'Claims', what: 'opened, status changes' },
  { key: 'escalations', label: 'Escalations', what: 'Hostaway AI escalations (when connected)' }
];

export interface SlackConfig {
  /** Channel id per topic, and its name for display. */
  channels?: Partial<Record<Topic, { id: string; name: string }>>;
  events?: { taskCreated?: boolean; taskAssigned?: boolean; taskClosed?: boolean; fromHostaway?: boolean; claimOpened?: boolean; claimChanged?: boolean };
  /** New York hours for the reservations reminder; null = off. */
  digest?: { morning?: number | null; afternoon?: number | null };
  /** Where Kaizen is, for links back from Slack. */
  appUrl?: string;
  /** One channel per cleaner (prepared, §99): no message goes there on a clock. */
  cleaners?: Record<string, { channelId: string; channelName: string; slackUserId?: string | null; email?: string | null }>;
  team?: string;
  /** Hostaway user id → Slack user id (§100): who a task's owner is in Slack, and who "Take it" makes the owner. */
  people?: Record<string, string>;
  /** The tasks' check-in and check-out (§107): local times in `tz` ("HH:MM"); null = off. */
  taskCheck?: { tz?: string; checkin?: string | null; checkout?: string | null };
  /** The SOP "Kaizen in Slack" (§101): what /kaizen help shows, and where "How to use this" leads. */
  helpSopId?: string;
  /** Direct messages to people (§100). 'test' sends every one to `testUser` instead, saying who it was for. */
  dm?: { mode: 'off' | 'test' | 'on'; testUser?: string | null };
}

/** Where "❓ How to use this" leads: the SOP in Kaizen (§101). */
export const helpUrlOf = (c: SlackConfig) => c.appUrl && c.helpSopId ? `${c.appUrl}/?sop=${encodeURIComponent(c.helpSopId)}` : undefined;

/** Where a direct message for this Hostaway user goes — and whether it is a test stand-in. */
export function dmTarget(c: SlackConfig, hostawayUserId: number | string | null | undefined): { to: string; standIn: boolean } | null {
  const mode = c.dm?.mode ?? 'test';
  if (mode === 'off' || hostawayUserId == null) return null;
  const real = c.people?.[String(hostawayUserId)];
  if (mode === 'test') return c.dm?.testUser ? { to: c.dm.testUser, standIn: real !== c.dm.testUser } : null;
  return real ? { to: real, standIn: false } : null;
}
/** The Hostaway user a Slack user is (for "Take it"). */
export const hostawayUserOf = (c: SlackConfig, slackUserId: string) =>
  Object.entries(c.people ?? {}).find(([, slack]) => slack === slackUserId)?.[0] ?? null;

/** Suggested links, Hostaway user → Slack user: the same email, else the same full name. */
export function suggestPeople(hostaway: { id: number; name: string; email: string | null }[],
                              slack: { id: string; name: string; email: string | null }[]): Record<string, string> {
  const out: Record<string, string> = {};
  const norm = (x: string | null) => (x ?? '').trim().toLowerCase();
  for (const h of hostaway) {
    const m = slack.find(u => norm(u.email) && norm(u.email) === norm(h.email)) ?? slack.find(u => norm(u.name) && norm(u.name) === norm(h.name));
    if (m) out[String(h.id)] = m.id;
  }
  return out;
}

export const DEFAULT_EVENTS: Required<NonNullable<SlackConfig['events']>> = {
  taskCreated: true, taskAssigned: true, taskClosed: true, fromHostaway: true, claimOpened: true, claimChanged: true
};
export const DEFAULT_DIGEST = { morning: 8, afternoon: 15 };
export const eventsOf = (c: SlackConfig) => ({ ...DEFAULT_EVENTS, ...(c.events ?? {}) });

/** Slack's mrkdwn needs & < > escaped; everything typed by a person goes through this. */
export const esc = (s: string | null | undefined) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Block = Record<string, unknown>;
const mrk = (text: string) => ({ type: 'mrkdwn', text });
const plain = (text: string) => ({ type: 'plain_text', text: text.slice(0, 75), emoji: true });
const section = (text: string, accessory?: Block): Block => ({ type: 'section', text: mrk(text), ...(accessory ? { accessory } : {}) });
const context = (...texts: string[]): Block => ({ type: 'context', elements: texts.filter(Boolean).map(mrk) });
const button = (text: string, action_id: string, value: string, style?: 'primary' | 'danger'): Block =>
  ({ type: 'button', text: plain(text), action_id, value, ...(style ? { style } : {}) });
const link = (url: string, text: string) => `<${url}|${esc(text)}>`;

/* ── tasks ──────────────────────────────────────────────────────────── */

export interface TaskLite {
  id: string; title: string; kind: 'task' | 'work_order'; status: string; priority: string;
  unit?: string | null; assignee?: string | null; dueOn?: string | null; reservationLabel?: string | null; description?: string | null;
}
const STATUS_WORD: Record<string, string> = { pending: 'Pending', confirmed: 'Confirmed', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const day = (d: string) => `${MON[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;

export function taskFacts(t: TaskLite): string {
  return [t.unit, t.reservationLabel ? `🛏 ${t.reservationLabel}` : '', t.dueOn ? `finish by ${day(t.dueOn)}` : '',
          t.assignee ? `owner ${t.assignee}` : '' /* §108: only when there is one */, ['high', 'urgent'].includes(t.priority) ? `▲ ${t.priority}` : '',
          STATUS_WORD[t.status] ?? t.status].filter(Boolean).map(esc).join(' · ');
}
const what = (t: TaskLite) => t.kind === 'work_order' ? '🔧 Repair' : '☐ To-do';

/** "Task created / assigned / completed / changed in Hostaway" — with the buttons to act on it. */
/**
 * "💬 Comment on a task…" (§111): a menu of the tasks a message lists —
 * a text line cannot open a pop-up in Slack, a menu can. Choosing one
 * opens its card with the comment box ready. Late first, then due today.
 */
export function pickTask(list: { id?: string; title: string; unit?: string | null; overdue?: boolean; dueToday?: boolean }[]): Block[] {
  const withId = list.filter((t): t is typeof t & { id: string } => !!t.id);
  if (!withId.length) return [];
  const ordered = [...withId.filter(t => t.overdue), ...withId.filter(t => !t.overdue && t.dueToday), ...withId.filter(t => !t.overdue && !t.dueToday)];
  const label = (t: typeof ordered[number]) => {
    const s = `${t.overdue ? '▲ ' : t.dueToday ? '● ' : ''}${t.title}${t.unit ? ` · ${t.unit}` : ''}`;
    return s.length <= 75 ? s : `${s.slice(0, 74)}…`;
  };
  return [{ type: 'actions', elements: [{ type: 'static_select', action_id: 'task_pick', placeholder: plain('💬 Comment on a task…'),
    options: ordered.slice(0, 100).map(t => ({ text: plain(label(t)), value: t.id })) }] }];
}

export function taskMessage(t: TaskLite, event: string, by: string, appUrl?: string): { text: string; blocks: Block[] } {
  const closed = t.status === 'completed' || t.status === 'cancelled';
  const title = `${what(t)} ${event}: *${esc(t.title)}*`;
  return {
    text: `${what(t)} ${event}: ${t.title}`,
    blocks: [
      section(title),
      context(taskFacts(t), by ? `by ${esc(by)}` : ''),
      { type: 'actions', elements: [
        ...(closed ? [button('↺ Reopen', 'task_reopen', t.id)] : [
          button('✓ Complete', 'task_complete', t.id, 'primary'),
          ...(t.status !== 'in_progress' ? [button('▶ Start', 'task_start', t.id)] : [])
        ]),
        button('💬 Comment', 'task_open', t.id),
        ...(appUrl ? [{ type: 'button', text: plain('Kaizen ↗'), url: `${appUrl}/`, action_id: 'open_kaizen' }] : [])
      ] }
    ]
  };
}

/** /kaizen tasks — every open task, each with a menu. */
export function taskList(list: TaskLite[], appUrl?: string): Block[] {
  if (!list.length) return [section('Nothing open. ✓')];
  const blocks: Block[] = [section(`*Open work — ${list.length}*`)];
  for (const t of list.slice(0, 40)) {
    blocks.push(section(`${t.kind === 'work_order' ? '🔧' : '☐'} *${esc(t.title)}*\n${taskFacts(t)}`, {
      type: 'overflow', action_id: 'task_menu', options: [
        { text: plain('💬 Open & comment'), value: `open:${t.id}` },
        { text: plain('✓ Complete'), value: `complete:${t.id}` }, { text: plain('▶ Start'), value: `start:${t.id}` },
        { text: plain('✎ Edit'), value: `edit:${t.id}` }, { text: plain('🗑 Remove'), value: `remove:${t.id}` }
      ]
    }));
  }
  if (list.length > 40) blocks.push(context(`…and ${list.length - 40} more${appUrl ? ` — ${link(appUrl, 'open Kaizen')}` : ''}`));
  blocks.push(...pickTask(list));
  blocks.push({ type: 'actions', elements: [button('+ To-do', 'task_new', 'task'), button('+ Repair', 'task_new_repair', 'work_order')] });
  return blocks;
}

/* ── claims ─────────────────────────────────────────────────────────── */

export interface ClaimLite { id: string; unit?: string | null; category?: string | null; severity: string; status: string; description?: string | null; days?: number; caseUrl?: string | null }
export const CLAIM_STATUSES = ['Open', 'In progress', 'Resolved', 'Refunded', 'Dismissed'];
const claimTitle = (c: ClaimLite) => `${c.unit ?? 'Portfolio'} · ${(c.description || c.category || 'Claim').slice(0, 80)}`;
const sevMark = (s: string) => s === 'Critical' || s === 'High' ? '🔴' : s === 'Medium' ? '🟠' : '⚪';

export function claimMessage(c: ClaimLite, event: string, by: string): { text: string; blocks: Block[] } {
  return {
    text: `⚑ Claim ${event}: ${claimTitle(c)}`,
    blocks: [
      section(`${sevMark(c.severity)} ⚑ Claim ${event}: *${esc(claimTitle(c))}*`),
      context([c.category, c.severity, c.status].filter(Boolean).map(esc).join(' · '), c.caseUrl ? link(c.caseUrl, 'platform case') : '', by ? `by ${esc(by)}` : ''),
      { type: 'actions', elements: [claimStatusSelect(c), button('💬 Comment', 'claim_open', c.id), button('✎ Edit', 'claim_edit', c.id)] }
    ]
  };
}
const claimStatusSelect = (c: ClaimLite): Block => ({
  type: 'static_select', action_id: 'claim_status', placeholder: plain('Status'),
  options: CLAIM_STATUSES.map(s => ({ text: plain(s), value: `${s}|${c.id}` })),
  initial_option: { text: plain(c.status), value: `${c.status}|${c.id}` }
});


/**
 * One claim in a list: the facts, then its controls in a row — a status
 * select, Edit and Remove. Not an overflow menu: Slack allows five
 * options there, and a claim has five statuses plus edit and remove.
 */
function claimRows(c: ClaimLite): Block[] {
  return [
    section(`${sevMark(c.severity)} *${esc(claimTitle(c))}*\n${[c.category, c.severity, c.days != null ? `${c.days}d open` : ''].filter(Boolean).map(esc).join(' · ')}${c.caseUrl ? ` · ${link(c.caseUrl, 'case')}` : ''}`),
    { type: 'actions', elements: [claimStatusSelect(c), button('💬 Comment', 'claim_open', c.id), button('✎ Edit', 'claim_edit', c.id), button('🗑 Remove', 'claim_remove', c.id, 'danger')] }
  ];
}

export interface ClaimCard extends ClaimLite {
  source?: string | null; refund?: number; repairCost?: number;
  updates: { who: string; when: string; body: string }[];
}

/**
 * A claim's card (§113): the case, what people wrote on it, and the box
 * to add to it — as a task's card. "Add comment" saves it and the card
 * stays open with it in. Status and edit stay on the list's row.
 */
export function claimCard(c: ClaimCard, note?: string, root?: 'claims', focus = false): Block {
  const f = (label: string, v: string | null | undefined) => v ? mrk(`*${label}*\n${esc(v)}`) : null;
  const money = (n?: number) => n ? `$${n.toFixed(2)}` : null;
  const fields = [f('Status', c.status), f('Severity', c.severity), f('Category', c.category), f('Listing', c.unit ?? 'Portfolio'),
    f('Source', c.source), f('Open for', c.days != null ? `${c.days} day${c.days === 1 ? '' : 's'}` : null),
    f('Refund', money(c.refund)), f('Repair cost', money(c.repairCost))].filter(Boolean).slice(0, 10);
  return {
    type: 'modal', callback_id: 'claim_card', private_metadata: JSON.stringify({ id: c.id, ...(root ? { root } : {}) }),
    title: plain('Claim'), submit: plain('Add comment'), close: plain('Close'),
    blocks: [
      { type: 'header', text: plain(claimTitle(c).slice(0, 150)) },
      ...(note ? [context(note)] : []),
      { type: 'section', fields },
      ...(c.description ? [section(esc(c.description).slice(0, 2900))] : []),
      ...(c.caseUrl ? [context(link(c.caseUrl, '↗ Platform case'))] : []),
      { type: 'divider' },
      section(c.updates.length ? `*Comments* · ${c.updates.length}` : '_No comments yet._'),
      ...c.updates.slice(-10).map(u => context(`*${esc(u.who)}* · ${esc(u.when)}`, esc(u.body).slice(0, 1500))),
      input('update', 'Add a comment', { ...text(null, true), ...(focus ? { focus_on_load: true } : {}) })
    ]
  };
}

export function claimList(list: ClaimLite[]): Block[] {
  if (!list.length) return [section('No open claims. ✓')];
  const blocks: Block[] = [section(`*Open claims — ${list.length}*`)];
  for (const c of list.slice(0, 30)) blocks.push(...claimRows(c));
  blocks.push({ type: 'actions', elements: [button('+ Claim', 'claim_new', 'claim')] });
  return blocks;
}

/* ── the reservations reminder ──────────────────────────────────────── */

export interface DigestInput {
  today: string; tomorrow: string;
  arrivals: { resId?: string; date: string; time: string; unit: string; guest: string; agreement: 'signed' | 'not_signed' | null; needsId: boolean; idInDrive: boolean | null }[];
  departures: { resId?: string; date: string; time: string; unit: string; cleaner: string | null; assigned: boolean; notNeeded: boolean; sameDay: boolean }[];
  /** Every open top-level task, flagged when late or due today. */
  tasks: { id?: string; title: string; unit?: string | null; overdue: boolean; dueToday: boolean; owner?: string | null }[];
  claims: { label: string; severity: string; days: number }[];
}

/** What is missing before a guest arrives — the line that asks for a person. */
export function missingFor(a: DigestInput['arrivals'][number], cleanOpen: boolean): string[] {
  const m: string[] = [];
  if (a.agreement === 'not_signed') m.push('agreement not signed');
  if (a.needsId && a.idInDrive === false) m.push('ID not in Drive');
  if (cleanOpen) m.push('clean not assigned');
  return m;
}

/** The days a reminder covers: the morning, today and tomorrow; the afternoon, tomorrow. */
export const daysOf = (d: Pick<DigestInput, 'today' | 'tomorrow'>, kind: 'morning' | 'afternoon') => kind === 'morning' ? [d.today, d.tomorrow] : [d.tomorrow];
const manage = (action_id: string, days: string[], urgent: boolean): Block =>
  ({ type: 'button', text: plain('Manage'), action_id, value: JSON.stringify({ days }), ...(urgent ? { style: 'primary' } : {}) });

/**
 * The reminder (§102): one short message — a line per section with what
 * matters (how many, what is missing) and a "Manage" button that opens the
 * section in a pop-up, where it is worked. Reading and acting are apart:
 * the channel gets one message, the work happens in the pop-ups.
 * Morning: today and tomorrow, plus tasks and claims. Afternoon: what is
 * still missing for tomorrow.
 */
export function digestMessage(d: DigestInput, kind: 'morning' | 'afternoon', appUrl?: string, helpUrl?: string): { text: string; blocks: Block[]; missing: number } {
  const days = daysOf(d, kind);
  const word = (x: string) => x === d.today ? 'today' : 'tomorrow';
  const ins = d.arrivals.filter(a => days.includes(a.date));
  const outs = d.departures.filter(o => days.includes(o.date) && !o.notNeeded);
  const unsigned = ins.filter(a => a.agreement === 'not_signed').length;
  const noId = ins.filter(a => a.needsId && a.idInDrive === false).length;
  const open = outs.filter(o => !o.assigned).length;
  const missing = unsigned + noId + open;
  const per = <T extends { date: string }>(xs: T[]) => days.map(x => { const n = xs.filter(y => y.date === x).length; return `${n || 'none'} ${word(x)}`; }).join(' · ');
  const same = outs.filter(o => o.sameDay).length;

  const blocks: Block[] = [
    section(`${kind === 'morning' ? `*☀ Today, ${day(d.today)}*` : `*🕒 Before tomorrow, ${day(d.tomorrow)}*`}  ·  ${missing ? `▲ ${missing} thing${missing === 1 ? '' : 's'} need you` : '✓ Nothing missing'}`),
    { type: 'divider' },
    section(`*🛬 Check-ins* · ${per(ins)}\n${[unsigned ? `▲ ${unsigned} not signed` : '', noId ? `▲ ${noId} ID not in Drive` : ''].filter(Boolean).join(' · ') || (ins.length ? '✓ all signed' : '—')}`,
      manage('sec_checkins', days, unsigned + noId > 0)),
    section(`*🧹 Cleans* · ${per(outs)}${same ? ` · ⚡ ${same} same-day` : ''}\n${open ? `▲ ${open} not assigned` : outs.length ? '✓ all assigned' : '—'}`,
      manage('sec_cleans', days, open > 0))
  ];
  if (kind === 'morning') {
    const late = d.tasks.filter(t => t.overdue).length, due = d.tasks.filter(t => t.dueToday).length;
    // §109: the morning carries the tasks' check-in — the overdue and due-today ones by name; Manage has them all.
    const named = [...d.tasks.filter(t => t.overdue).map(t => taskLine(t, '▲')), ...d.tasks.filter(t => t.dueToday && !t.overdue).map(t => taskLine(t, '●'))];
    blocks.push(section(`*☐ Tasks* · ${d.tasks.length} open\n${[late ? `▲ ${late} overdue` : '', due ? `● ${due} due today` : ''].filter(Boolean).join(' · ') || '✓ nothing overdue'}`,
      manage('sec_tasks', days, late > 0)));
    if (named.length) blocks.push(context(listOf(named, 6).join('\n')));
    blocks.push(...pickTask(d.tasks));
    const serious = d.claims.filter(c => c.severity === 'High' || c.severity === 'Critical').length;
    blocks.push(section(`*⚑ Claims* · ${d.claims.length} open\n${serious ? `🔴 ${serious} high or critical` : d.claims.length ? d.claims.slice(0, 2).map(c => esc(c.label)).join(' · ') : '✓ none open'}`,
      manage('sec_claims', days, serious > 0)));
  }
  blocks.push(context(appUrl ? link(appUrl, 'Open Kaizen') : '', helpUrl ? link(helpUrl, '❓ How to use this') : ''));
  const head = kind === 'morning' ? `Today ${day(d.today)}` : `Before tomorrow ${day(d.tomorrow)}`;
  return { text: `${head}: ${missing ? `${missing} missing` : 'nothing missing'}`, blocks, missing };
}

/* ── the sections' pop-ups (§102) ───────────────────────────────────── */

const dayLabel = (x: string, today: string) => x === today ? `Today · ${day(x)}` : `Tomorrow · ${day(x)}`;
const noteBlocks = (note?: string) => note ? [context(note)] : [];

/** Check-ins: each arrival with what is missing, and the way to fix it — assign the clean, or the reservation in Hostaway. */
export function checkinsModal(d: Pick<DigestInput, 'today' | 'arrivals' | 'departures'>, days: string[], canEdit: boolean, note?: string): Block {
  const blocks: Block[] = [...noteBlocks(note)];
  for (const x of days) {
    const ins = d.arrivals.filter(a => a.date === x);
    blocks.push({ type: 'header', text: plain(`${dayLabel(x, d.today)} · ${ins.length} check-in${ins.length === 1 ? '' : 's'}`) });
    if (!ins.length) blocks.push(section('_No arrivals._'));
    for (const a of ins) {
      const out = d.departures.find(o => o.date === x && o.unit === a.unit && !o.notNeeded);
      const cleanOpen = !!out && !out.assigned;
      const miss = missingFor(a, cleanOpen);
      const facts = [a.agreement === 'signed' ? '✓ signed' : a.agreement === 'not_signed' ? '▲ not signed' : '',
                     a.needsId ? (a.idInDrive ? '✓ ID in Drive' : a.idInDrive === false ? '▲ ID not in Drive' : 'ID: unknown') : '',
                     out ? (out.assigned ? `cleaned by ${esc(out.cleaner ?? '')}` : '▲ clean not assigned') : 'no checkout before'].filter(Boolean).join(' · ');
      blocks.push(section(`${miss.length ? '▲' : '✓'} *${esc(a.unit)}* ${esc(a.time)} · ${esc(a.guest)}\n${facts}`,
        cleanOpen && canEdit && out?.resId ? { type: 'button', text: plain('Assign clean'), action_id: 'clean_change', style: 'primary',
                                               value: JSON.stringify({ resId: out.resId, unit: out.unit, date: x, from: 'checkins', days }) }
          : a.resId ? hostawayButton(a.resId) : undefined));
    }
  }
  return { type: 'modal', callback_id: 'sec_checkins', private_metadata: JSON.stringify({ days }), title: plain('Check-ins'), close: plain('Close'),
           blocks: [...blocks.slice(0, 98), context('↗ Hostaway opens the reservation, to send the guest portal link again.')] };
}

/** Tasks: every open one, each with its menu; new ones from here; a removal can be undone in place. */
export function tasksModal(list: (TaskLite & { overdue?: boolean; dueToday?: boolean })[], note?: string, undo?: { id: string; title: string }): Block {
  const late = list.filter(t => t.overdue).length;
  const blocks: Block[] = [
    section(`*${list.length} open*${late ? ` · ▲ ${late} overdue` : ''}`),
    { type: 'actions', elements: [button('+ To-do', 'task_new', 'task'), button('+ Repair', 'task_new_repair', 'work_order')] },
    ...pickTask(list),
    ...noteBlocks(note),
    ...(undo ? [section(`Removed *${esc(undo.title)}*.`, button('Undo', 'task_restore', undo.id))] : []),
    { type: 'divider' }
  ];
  for (const t of list.slice(0, 40)) {
    blocks.push(section(`${t.overdue ? '▲ ' : t.dueToday ? '● ' : ''}${t.kind === 'work_order' ? '🔧' : '☐'} *${esc(t.title)}*\n${taskFacts(t)}`, {
      type: 'overflow', action_id: 'task_menu', options: [
        { text: plain('💬 Open & comment'), value: `open:${t.id}` }, { text: plain('✓ Complete'), value: `complete:${t.id}` },
        { text: plain('▶ Start'), value: `start:${t.id}` }, { text: plain('✎ Edit'), value: `edit:${t.id}` }, { text: plain('🗑 Remove'), value: `remove:${t.id}` }
      ]
    }));
  }
  if (!list.length) blocks.push(section('Nothing open. ✓'));
  return { type: 'modal', callback_id: 'sec_tasks', private_metadata: JSON.stringify({}), title: plain('Tasks'), close: plain('Close'), blocks };
}

/** Claims: every open one, with status, edit and remove in its menu; new ones from here. */
export function claimsModal(list: ClaimLite[], note?: string, undo?: { id: string; title: string }): Block {
  const blocks: Block[] = [
    section(`*${list.length} open*`),
    { type: 'actions', elements: [button('+ Claim', 'claim_new', 'claim')] },
    ...noteBlocks(note),
    ...(undo ? [section(`Removed *${esc(undo.title)}*.`, button('Undo', 'claim_restore', undo.id))] : []),
    { type: 'divider' }
  ];
  for (const c of list.slice(0, 30)) blocks.push(...claimRows(c));
  if (!list.length) blocks.push(section('No open claims. ✓'));
  return { type: 'modal', callback_id: 'sec_claims', private_metadata: JSON.stringify({}), title: plain('Claims'), close: plain('Close'), blocks };
}

/** Which reminders are due at this New York hour, not yet sent today. */
export function dueDigests(hour: number, today: string, cfg: SlackConfig, sent: Set<string>): ('morning' | 'afternoon')[] {
  const d = { ...DEFAULT_DIGEST, ...(cfg.digest ?? {}) };
  const out: ('morning' | 'afternoon')[] = [];
  for (const k of ['morning', 'afternoon'] as const) {
    const h = d[k];
    // A morning not sent by the afternoon's hour is stale — the afternoon one says what still matters.
    const stale = k === 'morning' && d.afternoon != null && d.afternoon > (h ?? 0) && hour >= d.afternoon;
    if (h != null && hour >= h && !stale && !sent.has(`digest:${k}:${today}`)) out.push(k);
  }
  return out;
}

/** A reservation in Hostaway — the same address the app links to (src/lib/operations.ts). */
const HOSTAWAY_RES = (resId: string) => `https://dashboard.hostaway.com/reservations/${encodeURIComponent(resId)}`;
const hostawayButton = (resId: string): Block => ({ type: 'button', text: plain('↗ Hostaway'), url: HOSTAWAY_RES(resId), action_id: `open_hostaway_${resId}` });

/** "Assign cleaner" (§100): who cleans this checkout — or that none is needed. */
export function cleanAssignModal(c: { resId: string; unit: string; date: string; from?: 'cleans' | 'checkins'; days?: string[] }, cleaners: string[]): Block {
  return {
    type: 'modal', callback_id: 'clean_assign_save', private_metadata: JSON.stringify(c),
    title: plain('Assign cleaner'), submit: plain('Assign'), close: plain('Cancel'),
    blocks: [
      section(`*${esc(c.unit)}* · checkout ${day(c.date)}`),
      input('cleaner', 'Cleaner', select([...cleaners.map(n => ({ value: n, label: n })), { value: '__not_needed', label: 'No clean needed' },
                                          { value: '__rule', label: 'Let the rule decide (automatic)' }]), false)
    ]
  };
}

/* ── a day's cleans (§101) ──────────────────────────────────────────── */

export interface CleanRow {
  resId: string; time: string; unit: string; beds: number | null; cleaner: string | null;
  state: 'assigned' | 'open' | 'not_needed'; sameDay: boolean; deep: boolean; byHand: boolean;
  /** The stay leaving (§116) — the size of the job. `total` only for roles that see booking values. */
  out?: { guest: string; nights: number; guests: number | null; channel: string; total?: number | null };
  /** The next arrival in that unit — how much time the clean has. Guest details only when it is on the board. */
  next?: { date: string; time?: string | null; guest?: string | null; nights?: number | null; guests?: number | null; gapDays: number; total?: number | null } | null;
}

const $ = (n?: number | null) => n ? `$${Math.round(n).toLocaleString('en-US')}` : '';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** The stay leaving and the next one arriving, one line each (§116). */
export function cleanContext(r: CleanRow, date: string): string[] {
  const lines: string[] = [];
  if (r.out) lines.push(`↗ Out: ${[esc(r.out.guest), plural(r.out.nights, 'night'), r.out.guests ? plural(r.out.guests, 'guest') : '', esc(channelLabel(r.out.channel)), $(r.out.total)].filter(Boolean).join(' · ')}`);
  if (r.next === null) lines.push('↘ Next in: _nothing booked yet_');
  else if (r.next) {
    const when = r.next.date === date ? `*same day*${r.next.time ? ` ${esc(r.next.time)}` : ''}` : `${day(r.next.date)} (${plural(r.next.gapDays, 'day')} empty)`;
    lines.push(`↘ Next in: ${[when, r.next.guest ? esc(r.next.guest) : '', r.next.nights ? plural(r.next.nights, 'night') : '',
      r.next.guests ? plural(r.next.guests, 'guest') : '', $(r.next.total)].filter(Boolean).join(' · ')}`);
  }
  return lines;
}

/** A pop-up that is there at once — Slack waits 3 seconds, the board takes longer — and is filled when ready. */
export const loadingModal = (title: string, callback = 'loading'): Block => ({
  type: 'modal', callback_id: callback, title: plain(title), close: plain('Close'),
  blocks: [section('⏳ Reading the board…')]
});

/** The day's cleans: who, when, what kind — each with "Change". */
export function cleansModal(date: string, label: string, rows: CleanRow[], canEdit: boolean, note?: string, switchTo?: { today: string; tomorrow: string }): Block {
  const open = rows.filter(r => r.state === 'open').length;
  return {
    type: 'modal', callback_id: 'cleans', private_metadata: JSON.stringify({ date }), title: plain(`Cleans · ${label}`), close: plain('Close'),
    blocks: [
      // §102: today and tomorrow in the same pop-up.
      ...(switchTo ? [{ type: 'actions', elements: [switchTo.today, switchTo.tomorrow].map(x =>
        ({ type: 'button', text: plain(x === switchTo.today ? 'Today' : 'Tomorrow'), action_id: `cleans_day_${x}`, value: x, ...(x === date ? { style: 'primary' } : {}) })) }] : []),
      section(`*${day(date)}* · ${rows.filter(r => r.state !== 'not_needed').length} clean${rows.length === 1 ? '' : 's'}${open ? ` · ▲ ${open} not assigned` : ' · ✓ all assigned'}`),
      ...(note ? [context(note)] : []),
      { type: 'divider' },
      ...(rows.length ? rows.map(r => section(
        `${r.state === 'open' ? '▲' : r.state === 'not_needed' ? '○' : '✓'} *${esc(r.time)} · ${esc(r.unit)}*${r.beds ? ` ${r.beds}BR` : ''}\n` +
        [[r.state === 'assigned' ? esc(r.cleaner ?? '') : r.state === 'open' ? '_not assigned_' : '_no clean needed_',
          r.sameDay ? '⚡ same-day' : '', r.deep ? 'deep clean' : '', r.byHand ? 'set by hand' : ''].filter(Boolean).join(' · '),
         ...cleanContext(r, date)].join('\n'),
        canEdit ? { type: 'button', text: plain(r.state === 'open' ? 'Assign' : 'Change'), action_id: 'clean_change',
                    value: JSON.stringify({ resId: r.resId, unit: r.unit, date }), ...(r.state === 'open' ? { style: 'primary' } : {}) } : undefined
      )) : [section('_No checkouts that day._')]),
      context('Changes here are the board’s: in live mode Kaizen also updates the Host Note in Hostaway.')
    ]
  };
}

/** /kaizen help: the SOP "Kaizen in Slack", its steps and what each one opens to, with the way to the full page. */
export function helpBlocks(sop: { title: string; purpose: string | null; steps: { text: string; detail?: string }[] } | null, url?: string): Block[] {
  if (!sop) return [section(HELP)];
  const blocks: Block[] = [section(`*📘 ${esc(sop.title)}*${sop.purpose ? `\n${esc(sop.purpose)}` : ''}`)];
  sop.steps.slice(0, 12).forEach((st, i) => {
    blocks.push(section(`*${i + 1}. ${esc(st.text)}*${st.detail ? `\n${esc(st.detail).replace(/\*\*/g, '*').slice(0, 900)}` : ''}`));
  });
  if (url) blocks.push({ type: 'actions', elements: [{ type: 'button', text: plain('📘 Open the SOP in Kaizen'), url, action_id: 'open_kaizen' }] });
  return blocks;
}

/* ── the task card (§100) ───────────────────────────────────────────── */

export interface TaskCard extends TaskLite {
  supervisor?: string | null; scheduledOn?: string | null; vendor?: string | null; costActual?: number | null; costEstimate?: number | null;
  resolutionNote?: string | null; children: { title: string; status: string }[];
  updates: { when: string; who: string; body: string }[];
}

/**
 * One task, in a pop-up that is the whole job: what it is, where it
 * stands, its sub-tasks and latest comments, the buttons that move it, and
 * a box to add a comment — refreshed in place after every action.
 */
export function taskCard(t: TaskCard, note?: string, root?: 'tasks', focus = false): Block {
  const closed = t.status === 'completed' || t.status === 'cancelled';
  const f = (label: string, v: string | null | undefined) => v ? mrk(`*${label}*\n${esc(v)}`) : null;
  const fields = [
    f('Status', STATUS_WORD[t.status] ?? t.status), f('Owner', t.assignee ?? 'Nobody'),
    f('Priority', t.priority !== 'none' ? t.priority[0]!.toUpperCase() + t.priority.slice(1) : null), f('Listing', t.unit),
    f('Start from', t.scheduledOn ? day(t.scheduledOn) : null), f('Finish by', t.dueOn ? day(t.dueOn) : null),
    f('Supervisor', t.supervisor), f('Stay', t.reservationLabel), f('Vendor', t.vendor),
    f('Cost', t.costActual != null ? `$${t.costActual.toFixed(2)}` : t.costEstimate != null ? `~$${t.costEstimate.toFixed(2)} estimated` : null)
  ].filter(Boolean).slice(0, 10);
  return {
    type: 'modal', callback_id: 'task_card', private_metadata: JSON.stringify({ id: t.id, ...(root ? { root } : {}) }),
    title: plain(t.kind === 'work_order' ? 'Repair' : 'To-do'), submit: plain('Add comment'), close: plain('Close'),
    blocks: [
      { type: 'header', text: plain(t.title.slice(0, 150)) },
      ...(note ? [context(note)] : []),
      { type: 'section', fields },
      ...(t.description ? [section(esc(t.description).slice(0, 2900))] : []),
      ...(closed && t.resolutionNote ? [context(`Resolution: ${esc(t.resolutionNote)}`)] : []),
      { type: 'actions', elements: [
        ...(closed ? [button('↺ Reopen', 'card_reopen', t.id)] : [
          button('✓ Complete', 'card_complete', t.id, 'primary'),
          ...(t.status !== 'in_progress' ? [button('▶ Start', 'card_start', t.id)] : [])
        ]),
        button('🙋 Take it', 'card_take', t.id),
        button('✎ Edit', 'card_edit', t.id)
      ] },
      ...(t.children.length ? [{ type: 'divider' }, section(`*Sub-tasks* · ${t.children.filter(c => c.status === 'completed').length}/${t.children.length}\n` +
        t.children.map(c => `${c.status === 'completed' ? '✓' : '☐'} ${esc(c.title)}`).join('\n'))] : []),
      { type: 'divider' },
      section(t.updates.length ? `*Latest comments*` : '_No comments yet._'),
      ...t.updates.map(u => context(`*${esc(u.who)}* · ${esc(u.when)}`, esc(u.body).slice(0, 1500))),
      // Opened to comment (§111): the cursor waits in the box.
      input('update', 'Add a comment', { ...text(null, true), ...(focus ? { focus_on_load: true } : {}) })
    ]
  };
}

/* ── a cleaner's schedule (prepared: sent by hand only) ─────────────── */

export function cleanerMessage(name: string, cleans: { date: string; time: string; unit: string; beds?: number | null; deep?: boolean; sameDay?: boolean; note?: string | null }[]): { text: string; blocks: Block[] } {
  const lines = cleans.map(c => `• *${day(c.date)}* ${esc(c.time)} · *${esc(c.unit)}*${c.beds ? ` ${c.beds}BR` : ''}${c.sameDay ? ' · ⚡ same-day' : ''}${c.deep ? ' · deep clean' : ''}${c.note ? `\n   _${esc(c.note)}_` : ''}`);
  return {
    text: `Upcoming cleans for ${name}: ${cleans.length}`,
    blocks: [section(`*🧹 Upcoming cleans — ${esc(name)}*`), section(lines.length ? lines.join('\n') : 'Nothing scheduled.'),
             context('Times and assignments can still change — the latest is always on the board.')]
  };
}

/* ── /kaizen ────────────────────────────────────────────────────────── */

export type Verb = 'help' | 'tasks' | 'task' | 'repair' | 'claims' | 'claim' | 'cost' | 'today' | 'cleans';
export function parseCommand(text: string): { verb: Verb; arg: string } {
  const t = (text ?? '').trim();
  const [first = '', ...rest] = t.split(/\s+/);
  const v = first.toLowerCase();
  const map: Record<string, Verb> = { '': 'help', help: 'help', tasks: 'tasks', todos: 'tasks', list: 'tasks', task: 'task', todo: 'task', new: 'task',
    repair: 'repair', claims: 'claims', claim: 'claim', cost: 'cost', expense: 'cost', today: 'today', digest: 'today', cleans: 'cleans', cleanings: 'cleans', cleaning: 'cleans' };
  return map[v] ? { verb: map[v]!, arg: rest.join(' ') } : { verb: 'task', arg: t };
}
export const HELP = [
  '*/kaizen tasks* — open to-dos and repairs, each with a menu (complete, start, edit, remove)',
  '*/kaizen task Fix the AC* — a new to-do (a form opens)', '*/kaizen repair Leak under sink* — a new repair',
  '*/kaizen claims* — open claims (status, edit, remove)', '*/kaizen claim Missing fob* — a new claim',
  '*/kaizen cost 45 towels P2-4308* — log a cost (a form asks every field)',
  '*/kaizen help* or *@Kaizen* — buttons to every pop-up: Tasks · Claims · Check-ins · Cleans',
  '*/kaizen today* — check-ins, cleans and what is missing, now',
  '*/kaizen cleans* (or *cleans tomorrow*) — the day’s cleans, and change who cleans',
  '⚡ *Shortcuts* — New task · Report a repair · New claim from anywhere; *Create task from message* in any message’s ⋯ menu',
  '*@Kaizen new Fix the AC in P2-4308* — in any channel: the to-do is made at once, with *✎ Add details* (also *repair*, *claim*, *tasks*, *today*, *help*)',
  '*@Kaizen* _comment_ in a task’s thread — saved on the task; *@Kaizen comments* — what was said so far'
].join('\n');

/* ── forms (modals) ─────────────────────────────────────────────────── */

export interface Opt { value: string; label: string }
const opt = (o: Opt) => ({ text: plain(o.label), value: o.value });
const input = (block_id: string, label: string, element: Block, optional = true): Block =>
  ({ type: 'input', block_id, label: plain(label), element: { action_id: 'v', ...element }, optional });
const select = (options: Opt[], initial?: string | null): Block => {
  const o = options.slice(0, 100);
  const init = o.find(x => x.value === initial);
  return { type: 'static_select', options: o.map(opt), ...(init ? { initial_option: opt(init) } : {}) };
};
const text = (initial?: string | null, multiline = false): Block =>
  ({ type: 'plain_text_input', multiline, ...(initial ? { initial_value: initial } : {}) });
const date = (initial?: string | null): Block => ({ type: 'datepicker', ...(initial ? { initial_date: initial } : {}) });

/* ── a cost (§117) ── */

export interface CostForm { what?: string | null; amount?: number | null; category?: string | null; unitId?: string | null; date?: string | null }

/** What a few words already say about a cost — every field is still shown and confirmed. */
export function costFromWords(words: string, units: Opt[], today: string): CostForm {
  const unitId = guessUnit(words, units);
  return { what: words.trim() || null, amount: amountIn(words), category: guessCategory(words, null), unitId, date: today };
}

export const SHARED_UNIT = '__shared';
/** A one-off cost, as Costs → One-offs records it: every field required, nothing saved until Save. */
export function costModal(f: CostForm, units: Opt[]): Block {
  return {
    type: 'modal', callback_id: 'cost_save', private_metadata: '{}', title: plain('Log a cost'), submit: plain('Save'), close: plain('Cancel'),
    blocks: [
      input('what', 'What for', { ...text(f.what), placeholder: plain('e.g. towels and soap from Costco') }, false),
      input('amount', 'Amount ($)', { ...text(f.amount != null ? String(f.amount) : null), placeholder: plain('45.50') }, false),
      input('category', 'Category', { ...select(COST_CATEGORIES.map(c => ({ value: c, label: c })), f.category), placeholder: plain('Choose') }, false),
      input('unit', 'Listing', { ...select([{ value: SHARED_UNIT, label: 'Shared — split across live units' }, ...units], f.unitId), placeholder: plain('Choose') }, false),
      input('date', 'Date', date(f.date), false),
      context('Saved in Costs → One-offs, as you. A cost on a repair is recorded by the repair itself.')
    ]
  };
}

/** A submitted cost form, as /api/expenses takes it — or the field that is wrong. */
export function readCostForm(state: State): { body: Record<string, unknown> } | { error: { block: string; message: string } } {
  const raw = String(val(state, 'amount')?.value ?? '').replace(/[$,\s]/g, '');
  const amount = Number(raw);
  if (!raw || !Number.isFinite(amount) || amount <= 0) return { error: { block: 'amount', message: 'A number above zero, like 45 or 45.50.' } };
  const unit = val(state, 'unit')?.selected_option?.value ?? '';
  return { body: { action: 'variable', amount: Math.round(amount * 100) / 100, category: val(state, 'category')?.selected_option?.value,
    unitId: unit === SHARED_UNIT ? null : unit, shared: unit === SHARED_UNIT, date: val(state, 'date')?.selected_date,
    notes: String(val(state, 'what')?.value ?? '').trim() } };
}

export interface TaskForm {
  id?: string; title?: string; description?: string | null; kind?: 'task' | 'work_order'; unitId?: string | null; status?: string;
  priority?: string; assigneeUserId?: number | null; dueOn?: string | null; scheduledOn?: string | null; costActual?: number | null;
  /** Made from a Slack message (§100): where to say it is now tracked. */
  from?: { channel: string; ts: string };
}
export const PRIORITY_OPTS: Opt[] = [{ value: 'none', label: 'No priority' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' }];
export const STATUS_OPTS: Opt[] = Object.entries(STATUS_WORD).map(([value, label]) => ({ value, label }));

export function taskModal(f: TaskForm, units: Opt[], people: Opt[]): Block {
  const repair = f.kind === 'work_order';
  return {
    type: 'modal', callback_id: 'task_save', private_metadata: JSON.stringify({ id: f.id ?? null, kind: f.kind ?? 'task', ...(f.from ? { from: f.from } : {}) }),
    title: plain(f.id ? (repair ? 'Edit repair' : 'Edit to-do') : (repair ? 'New repair' : 'New to-do')),
    submit: plain('Save'), close: plain('Cancel'),
    blocks: [
      input('title', 'Title', text(f.title), false),
      input('description', 'Details', text(f.description, true)),
      input('unit', 'Listing', select(units, f.unitId)),
      ...(f.id ? [input('status', 'Status', select(STATUS_OPTS, f.status ?? 'pending'))] : []),
      input('priority', 'Priority', select(PRIORITY_OPTS, f.priority ?? 'none')),
      input('owner', 'Owner (Hostaway user)', select(people, f.assigneeUserId != null ? String(f.assigneeUserId) : null)),
      input('start', 'Start from', date(f.scheduledOn)),
      input('due', 'Finish by', date(f.dueOn)),
      ...(repair ? [input('cost', 'Cost ($)', text(f.costActual != null ? String(f.costActual) : null))] : [])
    ]
  };
}

type State = Record<string, Record<string, { value?: string | null; selected_option?: { value: string } | null; selected_date?: string | null }>>;
const val = (s: State, b: string) => s[b]?.v;

/** A submitted task form, as the body /api/todos takes. */
export function readTaskForm(state: State, meta: { id: string | null; kind: string }): Record<string, unknown> {
  const unit = val(state, 'unit')?.selected_option?.value ?? null;
  const owner = val(state, 'owner')?.selected_option?.value ?? null;
  const cost = val(state, 'cost')?.value;
  return {
    ...(meta.id ? { action: 'update', id: meta.id } : { action: 'create', kind: meta.kind }),
    title: val(state, 'title')?.value ?? '', description: val(state, 'description')?.value ?? null,
    unitIds: unit ? [unit] : [], priority: val(state, 'priority')?.selected_option?.value ?? 'none',
    ...(meta.id && val(state, 'status')?.selected_option ? { status: val(state, 'status')!.selected_option!.value } : {}),
    assigneeUserId: owner ? Number(owner) : null,
    scheduledOn: val(state, 'start')?.selected_date ?? null, dueOn: val(state, 'due')?.selected_date ?? null,
    ...(cost !== undefined ? { costActual: cost === null || cost === '' ? null : Number(cost) } : {})
  };
}

export interface ClaimForm {
  id?: string; unitId?: string | null; occurredOn?: string; category?: string | null; severity?: string; status?: string;
  source?: string | null; description?: string | null; refund?: number; repairCost?: number; caseUrl?: string | null;
}
export function claimModal(f: ClaimForm, units: Opt[], categories: string[], sources: string[]): Block {
  const o = (xs: string[]) => xs.map(x => ({ value: x, label: x }));
  return {
    type: 'modal', callback_id: 'claim_save', private_metadata: JSON.stringify({ id: f.id ?? null }),
    title: plain(f.id ? 'Edit claim' : 'New claim'), submit: plain('Save'), close: plain('Cancel'),
    blocks: [
      input('description', 'What happened', text(f.description, true), false),
      input('unit', 'Listing', select(units, f.unitId)),
      input('occurred', 'Raised on', date(f.occurredOn), false),
      input('category', 'Category', select(o(categories), f.category)),
      input('severity', 'Severity', select(o(['Low', 'Medium', 'High', 'Critical']), f.severity ?? 'Medium'), false),
      input('status', 'Status', select(o(CLAIM_STATUSES), f.status ?? 'Open'), false),
      input('source', 'Source', select(o(sources), f.source)),
      input('case', 'Case link (https://…)', text(f.caseUrl)),
      input('refund', 'Refunded ($)', text(f.refund ? String(f.refund) : null))
    ]
  };
}
/** A submitted claim form, as the body /api/claims takes (the fields it does not show are kept by the caller). */
export function readClaimForm(state: State): Record<string, unknown> {
  const refund = val(state, 'refund')?.value;
  return {
    description: val(state, 'description')?.value ?? '', unitId: val(state, 'unit')?.selected_option?.value ?? null,
    occurredOn: val(state, 'occurred')?.selected_date ?? null, category: val(state, 'category')?.selected_option?.value ?? null,
    severity: val(state, 'severity')?.selected_option?.value ?? 'Medium', status: val(state, 'status')?.selected_option?.value ?? 'Open',
    source: val(state, 'source')?.selected_option?.value ?? null, caseUrl: val(state, 'case')?.value ?? '',
    refund: refund ? Number(refund) || 0 : 0
  };
}

/* ── comments from a thread (§107) ─────────────────────────────────── */

/**
 * "@Kaizen the plumber comes at 10" in a task's thread → the comment "the
 * plumber comes at 10". The mention (and a leading "update:") is dropped;
 * what is left is what the person wrote.
 */
export function commentFromMention(text: string): string {
  return (text ?? '').replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, ' ').replace(/^\s*(update|comment|note)\s*[:\-–]\s*/i, '').replace(/\s+\n/g, '\n').trim();
}

/* ── the tasks' check-in and check-out (§107) ──────────────────────── */

// Three messages a day (§109), all in the team's zone: 8 AM (the day and the open tasks, one message), 3 PM (what is missing for
// tomorrow), 11:55 PM (the tasks' check-out). The separate check-in is off: the morning reminder carries the tasks.
export const DEFAULT_TASK_CHECK: { tz: string; checkin: string | null; checkout: string | null } = { tz: 'America/Chicago', checkin: null, checkout: '23:55' };
/** The team's time zone — the reminders' hours and the check-out are read in it. */
export const teamTz = (cfg: SlackConfig) => cfg.taskCheck?.tz ?? DEFAULT_TASK_CHECK.tz;

/** "2026-10-05 08:05" — a moment as a wall clock in a zone. */
export function localNow(tz: string, at = new Date()): { day: string; hm: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

/** A local day as UTC instants [start, end) — for "closed today", "opened today". */
export function dayRange(day: string, tz: string): [string, string] {
  const offset = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - t;
  };
  const at = (d: string) => { const g = Date.parse(`${d}T00:00:00Z`); return new Date(g - offset(g - offset(g))).toISOString(); };
  const next = new Date(Date.parse(`${day}T12:00:00Z`) + 864e5).toISOString().slice(0, 10);
  return [at(day), at(next)];
}

/**
 * Which check is due now, and for which day. The check-in from its time
 * until noon; the check-out from its time until 3 AM — the scheduler can
 * run late, past midnight, and the check-out must still close the day it
 * is about.
 */
export function dueTaskChecks(now: { day: string; hm: string }, cfg: SlackConfig, sent: Set<string>): { kind: 'checkin' | 'checkout'; day: string }[] {
  const c = { ...DEFAULT_TASK_CHECK, ...(cfg.taskCheck ?? {}) };
  const out: { kind: 'checkin' | 'checkout'; day: string }[] = [];
  if (c.checkin && now.hm >= c.checkin && now.hm < '12:00' && !sent.has(`taskcheck:checkin:${now.day}`)) out.push({ kind: 'checkin', day: now.day });
  if (c.checkout) {
    const yesterday = new Date(Date.parse(`${now.day}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
    const day = now.hm >= c.checkout ? now.day : now.hm < '03:00' ? yesterday : null;
    if (day && !sent.has(`taskcheck:checkout:${day}`)) out.push({ kind: 'checkout', day });
  }
  return out;
}

export interface TaskCheckInput {
  day: string;
  open: { id?: string; title: string; owner?: string | null; unit?: string | null; overdue: boolean; dueToday: boolean; inProgress: boolean; kind: string }[];
  closed: { title: string; by?: string | null; cancelled: boolean }[];
  opened: { title: string; by?: string | null }[];
}

const taskLine = (t: { title: string; owner?: string | null; unit?: string | null; kind?: string }, mark: string) =>
  // The owner only when there is one (§108): owners are for specific work — days off and shifts make them no rule.
  `${mark} ${t.kind === 'work_order' ? '🔧 ' : ''}${esc(t.title)}${t.unit ? ` · ${esc(t.unit)}` : ''}${t.owner ? ` · ${esc(t.owner)}` : ''}`;
const listOf = (lines: string[], max = 12) => lines.length > max ? [...lines.slice(0, max), `_…and ${lines.length - max} more_`] : lines;

/**
 * The tasks' check-in (morning): everything open, what is late or due,
 * what is moving. The check-out (night): the day's numbers — closed, opened,
 * still open — and the lists behind them.
 */
export function taskCheckMessage(kind: 'checkin' | 'checkout', d: TaskCheckInput, helpUrl?: string): { text: string; blocks: Block[] } {
  const late = d.open.filter(t => t.overdue), today = d.open.filter(t => t.dueToday), moving = d.open.filter(t => t.inProgress && !t.overdue && !t.dueToday);
  const rest = d.open.filter(t => !t.overdue && !t.dueToday && !(t.inProgress));
  const manage: Block = { type: 'button', text: plain('Manage'), action_id: 'sec_tasks', value: JSON.stringify({ days: [d.day] }), ...(late.length ? { style: 'primary' } : {}) };
  const foot = context(helpUrl ? link(helpUrl, '❓ How to use this') : '', '💬 Pick a task above to comment — or reply in its thread with *@Kaizen …*');
  if (kind === 'checkin') {
    const blocks: Block[] = [
      section(`*☀ Tasks check-in · ${day(d.day)}*\n*${d.open.length}* open · ${late.length ? `▲ *${late.length}* overdue` : '✓ none overdue'} · ● *${today.length}* due today · ◐ *${d.open.filter(t => t.inProgress).length}* in progress`, manage),
      { type: 'divider' }
    ];
    if (late.length) blocks.push(section(`*▲ Overdue*\n${listOf(late.map(t => taskLine(t, '▲'))).join('\n')}`));
    if (today.length) blocks.push(section(`*● Due today*\n${listOf(today.map(t => taskLine(t, '●'))).join('\n')}`));
    if (moving.length) blocks.push(section(`*◐ In progress*\n${listOf(moving.map(t => taskLine(t, '◐'))).join('\n')}`));
    if (rest.length) blocks.push(section(`*○ Also open*\n${listOf(rest.map(t => taskLine(t, '○')), 8).join('\n')}`));
    if (!d.open.length) blocks.push(section('Nothing open. ✓'));
    blocks.push(...pickTask(d.open), foot);
    return { text: `Tasks check-in ${day(d.day)}: ${d.open.length} open, ${late.length} overdue, ${today.length} due today`, blocks };
  }
  const done = d.closed.filter(c => !c.cancelled), cancelled = d.closed.filter(c => c.cancelled);
  const blocks: Block[] = [
    section(`*🌙 Tasks check-out · ${day(d.day)}*\n✓ *${d.closed.length}* closed${cancelled.length ? ` (${done.length} done, ${cancelled.length} cancelled)` : ''} · ＋ *${d.opened.length}* opened · ○ *${d.open.length}* still open${late.length ? ` · ▲ ${late.length} overdue` : ''}`, manage),
    { type: 'divider' }
  ];
  if (d.closed.length) blocks.push(section(`*✓ Closed today*\n${listOf(d.closed.map(c => `${c.cancelled ? '✕' : '✓'} ${esc(c.title)}${c.by ? ` · ${esc(c.by)}` : ''}`)).join('\n')}`));
  if (d.opened.length) blocks.push(section(`*＋ Opened today*\n${listOf(d.opened.map(o => `＋ ${esc(o.title)}${o.by ? ` · ${esc(o.by)}` : ''}`)).join('\n')}`));
  if (d.open.length) blocks.push(section(`*○ Still open*\n${listOf([...late.map(t => taskLine(t, '▲')), ...d.open.filter(t => !t.overdue).map(t => taskLine(t, t.inProgress ? '◐' : '○'))]).join('\n')}`));
  blocks.push(...pickTask(d.open), foot);
  return { text: `Tasks check-out ${day(d.day)}: ${d.closed.length} closed, ${d.opened.length} opened, ${d.open.length} still open`, blocks };
}

/* ── @Kaizen: what a mention asks for (§108) ────────────────────────── */

export type MentionVerb = 'help' | 'new' | 'repair' | 'claim' | 'cost' | 'claims' | 'tasks' | 'today' | 'all' | 'comments' | 'text';

/** "@Kaizen new Fix the AC" → { verb: 'new', arg: 'Fix the AC' }; anything else is plain text. */
export function parseMention(text: string): { verb: MentionVerb; arg: string } {
  const t = commentFromMention(text);
  const [first = '', ...rest] = t.split(/\s+/);
  const map: Record<string, MentionVerb> = { '': 'help', help: 'help', '?': 'help', commands: 'help',
    new: 'new', task: 'new', todo: 'new', 'to-do': 'new', add: 'new', repair: 'repair', claim: 'claim', claims: 'claims', cases: 'claims', cost: 'cost', expense: 'cost', gasto: 'cost', costo: 'cost',
    tasks: 'tasks', list: 'tasks', today: 'today', all: 'all', status: 'all', reminder: 'all', summary: 'all', comments: 'comments', history: 'comments' };
  const v = map[first.toLowerCase()];
  return v ? { verb: v, arg: rest.join(' ') } : { verb: 'text', arg: t };
}

/** Buttons that open the forms — what a mention can offer, since a mention cannot open a pop-up itself. */
export function newButtons(title = '', only?: 'task' | 'work_order' | 'claim' | 'cost', from?: { channel: string; ts: string }): Block {
  const b = (label: string, kind: string, primary: boolean) =>
    ({ type: 'button', text: plain(label), action_id: `mention_new_${kind}`, value: JSON.stringify({ kind, title: title.slice(0, 120), ...(from ? { from } : {}) }), ...(primary ? { style: 'primary' } : {}) });
  const all = [b('+ New to-do', 'task', !only || only === 'task'), b('+ Repair', 'work_order', only === 'work_order'), b('+ Claim', 'claim', only === 'claim'),
               b('+ Cost', 'cost', only === 'cost')];
  return { type: 'actions', elements: only ? all.filter(x => (x.action_id as string).endsWith(only)) : all };
}

export const MENTION_HELP = [
  '*@Kaizen new* _Fix the AC in P2-4308_ — made at once (the listing found in the text); *✎ Add details* in the reply if you want',
  '*@Kaizen repair* … — the same, as a repair · *@Kaizen claim* … — the claim form',
  '*@Kaizen cost* _45 towels P2-4308_ — the cost form, with what it could read filled in; you confirm every field',
  '*@Kaizen tasks* — the open tasks, each with its menu · *@Kaizen claims* — the open claims (status, edit, remove)',
  '*@Kaizen all* — the whole reminder now, in a thread for everyone: check-ins, cleans, tasks, claims, and how the day is going',
  '*@Kaizen today* — the same, only for you',
  'In a task’s thread: *@Kaizen* _your comment_ — saved as a comment · *@Kaizen comments* — the comments so far',
  'Also: */kaizen* (type */kaizen help*) and the ⚡ shortcuts'
].join('\n');

/** Every section's pop-up, one tap away (§112) — the same pop-ups as the 8 AM message's Manage. */
export function sectionButtons(): Block {
  return { type: 'actions', elements: [button('☐ Tasks', 'sec_tasks', '{}'), button('⚑ Claims', 'sec_claims', '{}'),
                                       button('🛬 Check-ins', 'sec_checkins', '{}'), button('🧹 Cleans', 'sec_cleans', '{}')] };
}

export function mentionHelpBlocks(): Block[] {
  return [section('*👋 What I do*'), section(MENTION_HELP), context('*Open:*'), sectionButtons(), context('*New:*'), newButtons()];
}

/** The comments on a task or claim, for its thread (§108). */
export function commentsBlocks(list: { who: string; when: string; body: string }[], title: string): { text: string; blocks: Block[] } {
  if (!list.length) return { text: 'No comments yet', blocks: [section(`💬 No comments yet on *${esc(title)}*.`)] };
  return {
    text: `${list.length} comment${list.length === 1 ? '' : 's'} on ${title}`,
    blocks: [section(`💬 *Comments on ${esc(title)}* · ${list.length}`),
             ...list.slice(-10).map(c => context(`*${esc(c.who)}* · ${esc(c.when)}`, esc(c.body).slice(0, 1500)))]
  };
}

/* ── @Kaizen new: made at once, details after (§110) ─────────────────── */

/** The listing a request names — "AC broken in p2 4308" finds P2-4308; spaces and hyphens are optional, the longest name wins. */
export function guessUnit(text: string, units: Opt[]): string | null {
  const byLength = [...units].sort((a, b) => b.label.length - a.label.length);
  for (const u of byLength) {
    const parts = u.label.toLowerCase().split(/[\s-]+/).filter(Boolean).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (parts.length && new RegExp(`(^|[^a-z0-9])${parts.join('[\\s-]?')}($|[^a-z0-9])`, 'i').test(text)) return u.value;
  }
  return null;
}

/** A request's title (its first line, cut at a word under 120) — and the whole text as the description when there is more. */
export function quickTitle(text: string): { title: string; description: string | null } {
  const t = text.trim();
  const first = t.split('\n')[0]!.trim();
  const title = first.length <= 120 ? first : `${first.slice(0, 117).replace(/\s+\S*$/, '')}…`;
  return { title, description: title === t ? null : t };
}

/** The reply in the request's thread: it is tracked, and the way to add details. */
export function trackedReply(t: { id: string; title: string; kind: string; unit?: string | null }): { text: string; blocks: Block[] } {
  const what = t.kind === 'work_order' ? 'repair' : 'to-do';
  return {
    text: `📋 Tracked in Kaizen as a ${what}: ${t.title}`,
    blocks: [
      section(`📋 *Tracked in Kaizen* as a ${what}: *${esc(t.title)}*${t.unit ? ` · ${esc(t.unit)}` : ''}`),
      { type: 'actions', elements: [
        { type: 'button', text: plain('✎ Add details'), action_id: 'task_edit', value: t.id, style: 'primary' },
        { type: 'button', text: plain('💬 Comment'), action_id: 'task_open', value: t.id }] },
      context('Reply here with *@Kaizen* _your comment_ to add to it.')
    ]
  };
}

