/**
 * Slack (§99) — what Kaizen says there, and the forms it opens. Pure, so
 * the server and the tests agree; the calls to Slack live in
 * functions/_lib/slack.ts.
 *
 * Messages are Block Kit: a line to read, the facts in small print, and
 * the buttons that act on it — acting from Slack runs as the Kaizen member
 * whose email the Slack user has, with that member's permissions.
 */

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
          t.assignee ? `owner ${t.assignee}` : 'no owner', ['high', 'urgent'].includes(t.priority) ? `▲ ${t.priority}` : '',
          STATUS_WORD[t.status] ?? t.status].filter(Boolean).map(esc).join(' · ');
}
const what = (t: TaskLite) => t.kind === 'work_order' ? '🔧 Repair' : '☐ To-do';

/** "Task created / assigned / completed / changed in Hostaway" — with the buttons to act on it. */
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
        button('📋 Open', 'task_open', t.id),
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
        { text: plain('📋 Open'), value: `open:${t.id}` },
        { text: plain('✓ Complete'), value: `complete:${t.id}` }, { text: plain('▶ Start'), value: `start:${t.id}` },
        { text: plain('✎ Edit'), value: `edit:${t.id}` }, { text: plain('🗑 Remove'), value: `remove:${t.id}` }
      ]
    }));
  }
  if (list.length > 40) blocks.push(context(`…and ${list.length - 40} more${appUrl ? ` — ${link(appUrl, 'open Kaizen')}` : ''}`));
  blocks.push({ type: 'actions', elements: [button('+ To-do', 'task_new', 'task'), button('+ Repair', 'task_new', 'work_order')] });
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
      { type: 'actions', elements: [claimStatusSelect(c), button('✎ Edit', 'claim_edit', c.id)] }
    ]
  };
}
const claimStatusSelect = (c: ClaimLite): Block => ({
  type: 'static_select', action_id: 'claim_status', placeholder: plain('Status'),
  options: CLAIM_STATUSES.map(s => ({ text: plain(s), value: `${s}|${c.id}` })),
  initial_option: { text: plain(c.status), value: `${c.status}|${c.id}` }
});

export function claimList(list: ClaimLite[]): Block[] {
  if (!list.length) return [section('No open claims. ✓')];
  const blocks: Block[] = [section(`*Open claims — ${list.length}*`)];
  for (const c of list.slice(0, 40)) {
    blocks.push(section(`${sevMark(c.severity)} *${esc(claimTitle(c))}*\n${[c.category, c.severity, c.status, c.days != null ? `${c.days}d open` : ''].filter(Boolean).map(esc).join(' · ')}`, {
      type: 'overflow', action_id: 'claim_menu', options: [
        { text: plain('✎ Edit'), value: `edit:${c.id}` },
        ...CLAIM_STATUSES.filter(s => s !== c.status).map(s => ({ text: plain(`→ ${s}`), value: `status:${s}:${c.id}` })),
        { text: plain('🗑 Remove'), value: `remove:${c.id}` }
      ]
    }));
  }
  blocks.push({ type: 'actions', elements: [button('+ Claim', 'claim_new', 'claim')] });
  return blocks;
}

/* ── the reservations reminder ──────────────────────────────────────── */

export interface DigestInput {
  today: string; tomorrow: string;
  arrivals: { resId?: string; date: string; time: string; unit: string; guest: string; agreement: 'signed' | 'not_signed' | null; needsId: boolean; idInDrive: boolean | null }[];
  departures: { resId?: string; date: string; time: string; unit: string; cleaner: string | null; assigned: boolean; notNeeded: boolean; sameDay: boolean }[];
  /** Every open top-level task, flagged when late or due today. */
  tasks: { title: string; unit?: string | null; overdue: boolean; dueToday: boolean; owner?: string | null }[];
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
    blocks.push(section(`*☐ Tasks* · ${d.tasks.length} open\n${[late ? `▲ ${late} overdue` : '', due ? `● ${due} due today` : ''].filter(Boolean).join(' · ') || '✓ nothing overdue'}`,
      manage('sec_tasks', days, late > 0)));
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
    { type: 'actions', elements: [button('+ To-do', 'task_new', 'task'), button('+ Repair', 'task_new', 'work_order')] },
    ...noteBlocks(note),
    ...(undo ? [section(`Removed *${esc(undo.title)}*.`, button('Undo', 'task_restore', undo.id))] : []),
    { type: 'divider' }
  ];
  for (const t of list.slice(0, 40)) {
    blocks.push(section(`${t.overdue ? '▲ ' : t.dueToday ? '● ' : ''}${t.kind === 'work_order' ? '🔧' : '☐'} *${esc(t.title)}*\n${taskFacts(t)}`, {
      type: 'overflow', action_id: 'task_menu', options: [
        { text: plain('📋 Open'), value: `open:${t.id}` }, { text: plain('✓ Complete'), value: `complete:${t.id}` },
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
  for (const c of list.slice(0, 40)) {
    blocks.push(section(`${sevMark(c.severity)} *${esc(claimTitle(c))}*\n${[c.category, c.severity, c.status, c.days != null ? `${c.days}d open` : ''].filter(Boolean).map(esc).join(' · ')}${c.caseUrl ? ` · ${link(c.caseUrl, 'case')}` : ''}`, {
      type: 'overflow', action_id: 'claim_menu', options: [
        { text: plain('✎ Edit'), value: `edit:${c.id}` },
        ...CLAIM_STATUSES.filter(x => x !== c.status).map(x => ({ text: plain(`→ ${x}`), value: `status:${x}:${c.id}` })),
        { text: plain('🗑 Remove'), value: `remove:${c.id}` }
      ]
    }));
  }
  if (!list.length) blocks.push(section('No open claims. ✓'));
  return { type: 'modal', callback_id: 'sec_claims', private_metadata: JSON.stringify({}), title: plain('Claims'), close: plain('Close'), blocks };
}

/** Which reminders are due at this New York hour, not yet sent today. */
export function dueDigests(hourNY: number, todayNY: string, cfg: SlackConfig, sent: Set<string>): ('morning' | 'afternoon')[] {
  const d = { ...DEFAULT_DIGEST, ...(cfg.digest ?? {}) };
  const out: ('morning' | 'afternoon')[] = [];
  for (const k of ['morning', 'afternoon'] as const) {
    const h = d[k];
    if (h != null && hourNY >= h && !sent.has(`digest:${k}:${todayNY}`)) out.push(k);
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
        [r.state === 'assigned' ? esc(r.cleaner ?? '') : r.state === 'open' ? '_not assigned_' : '_no clean needed_',
         r.sameDay ? '⚡ same-day' : '', r.deep ? 'deep clean' : '', r.byHand ? 'set by hand' : ''].filter(Boolean).join(' · '),
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
 * stands, its sub-tasks and latest updates, the buttons that move it, and
 * a box to add an update — refreshed in place after every action.
 */
export function taskCard(t: TaskCard, note?: string, root?: 'tasks'): Block {
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
    title: plain(t.kind === 'work_order' ? 'Repair' : 'To-do'), submit: plain('Add update'), close: plain('Close'),
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
      section(t.updates.length ? `*Latest updates*` : '_No updates yet._'),
      ...t.updates.map(u => context(`*${esc(u.who)}* · ${esc(u.when)}`, esc(u.body).slice(0, 1500))),
      input('update', 'Add an update', text(null, true))
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

export type Verb = 'help' | 'tasks' | 'task' | 'repair' | 'claims' | 'claim' | 'today' | 'cleans';
export function parseCommand(text: string): { verb: Verb; arg: string } {
  const t = (text ?? '').trim();
  const [first = '', ...rest] = t.split(/\s+/);
  const v = first.toLowerCase();
  const map: Record<string, Verb> = { '': 'help', help: 'help', tasks: 'tasks', todos: 'tasks', list: 'tasks', task: 'task', todo: 'task', new: 'task',
    repair: 'repair', claims: 'claims', claim: 'claim', today: 'today', digest: 'today', cleans: 'cleans', cleanings: 'cleans', cleaning: 'cleans' };
  return map[v] ? { verb: map[v]!, arg: rest.join(' ') } : { verb: 'task', arg: t };
}
export const HELP = [
  '*/kaizen tasks* — open to-dos and repairs, each with a menu (complete, start, edit, remove)',
  '*/kaizen task Fix the AC* — a new to-do (a form opens)', '*/kaizen repair Leak under sink* — a new repair',
  '*/kaizen claims* — open claims (status, edit, remove)', '*/kaizen claim Missing fob* — a new claim',
  '*/kaizen today* — check-ins, cleans and what is missing, now',
  '*/kaizen cleans* (or *cleans tomorrow*) — the day’s cleans, and change who cleans',
  '⚡ *Shortcuts* — New task · Report a repair · New claim from anywhere; *Create task from message* in any message’s ⋯ menu'
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
