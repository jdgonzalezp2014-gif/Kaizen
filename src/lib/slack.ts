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
        button('✎ Edit', 'task_edit', t.id),
        ...(appUrl ? [{ type: 'button', text: plain('Open in Kaizen'), url: `${appUrl}/`, action_id: 'open_kaizen' }] : [])
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
  arrivals: { date: string; time: string; unit: string; guest: string; agreement: 'signed' | 'not_signed' | null; needsId: boolean; idInDrive: boolean | null }[];
  departures: { date: string; time: string; unit: string; cleaner: string | null; assigned: boolean; notNeeded: boolean; sameDay: boolean }[];
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

/**
 * Morning: the whole day, and tomorrow's gaps. Afternoon: what is still
 * missing for tomorrow, so it gets fixed before the end of the day.
 */
export function digestMessage(d: DigestInput, kind: 'morning' | 'afternoon', appUrl?: string): { text: string; blocks: Block[]; missing: number } {
  const days = kind === 'morning' ? [d.today, d.tomorrow] : [d.tomorrow];
  const blocks: Block[] = [section(kind === 'morning' ? `*☀ Today, ${day(d.today)}*` : `*🕒 Before tomorrow, ${day(d.tomorrow)}*`)];
  let missing = 0;
  for (const date of days) {
    const ins = d.arrivals.filter(a => a.date === date);
    const outs = d.departures.filter(o => o.date === date && !o.notNeeded);
    const label = date === d.today ? 'Today' : 'Tomorrow';
    const lines: string[] = [];
    for (const a of ins) {
      const cleanOpen = outs.some(o => o.unit === a.unit && !o.assigned);
      const miss = missingFor(a, cleanOpen);
      missing += miss.length;
      lines.push(`${miss.length ? '▲' : '✓'} *${esc(a.unit)}* ${esc(a.time)} · ${esc(a.guest)}${miss.length ? ` — _${miss.join(', ')}_` : ''}`);
    }
    for (const o of outs.filter(o => !o.assigned)) {
      if (ins.some(a => a.unit === o.unit)) continue; // already said on the arrival
      missing++;
      lines.push(`▲ *${esc(o.unit)}* checkout ${esc(o.time)} — _clean not assigned_`);
    }
    const cleans = outs.length ? `${outs.length} clean${outs.length === 1 ? '' : 's'}${outs.some(o => o.sameDay) ? ` · ${outs.filter(o => o.sameDay).length} same-day` : ''}` : 'no cleans';
    blocks.push(section(`*${label}* · ${ins.length} check-in${ins.length === 1 ? '' : 's'} · ${cleans}${lines.length ? '\n' + lines.join('\n') : ''}`));
  }
  if (kind === 'morning') {
    const late = d.tasks.filter(t => t.overdue), todayT = d.tasks.filter(t => t.dueToday);
    if (late.length || todayT.length) {
      blocks.push(section(`*Tasks* · ${late.length} overdue · ${todayT.length} due today\n` +
        [...late.map(t => `▲ ${esc(t.title)}${t.unit ? ` · ${esc(t.unit)}` : ''}${t.owner ? ` · ${esc(t.owner)}` : ''}`),
         ...todayT.map(t => `● ${esc(t.title)}${t.unit ? ` · ${esc(t.unit)}` : ''}${t.owner ? ` · ${esc(t.owner)}` : ''}`)].slice(0, 12).join('\n')));
    }
    if (d.claims.length) {
      blocks.push(section(`*Open claims* · ${d.claims.length}\n` + d.claims.slice(0, 8).map(c => `${sevMark(c.severity)} ${esc(c.label)} · ${c.days}d`).join('\n')));
    }
  }
  blocks.push(context(missing ? `▲ ${missing} thing${missing === 1 ? '' : 's'} missing` : '✓ Nothing missing', appUrl ? link(appUrl, 'Open Kaizen') : ''));
  const head = kind === 'morning' ? `Today ${day(d.today)}` : `Before tomorrow ${day(d.tomorrow)}`;
  return { text: `${head}: ${missing ? `${missing} missing` : 'nothing missing'}`, blocks, missing };
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

export type Verb = 'help' | 'tasks' | 'task' | 'repair' | 'claims' | 'claim' | 'today';
export function parseCommand(text: string): { verb: Verb; arg: string } {
  const t = (text ?? '').trim();
  const [first = '', ...rest] = t.split(/\s+/);
  const v = first.toLowerCase();
  const map: Record<string, Verb> = { '': 'help', help: 'help', tasks: 'tasks', todos: 'tasks', list: 'tasks', task: 'task', todo: 'task', new: 'task',
    repair: 'repair', claims: 'claims', claim: 'claim', today: 'today', digest: 'today' };
  return map[v] ? { verb: map[v]!, arg: rest.join(' ') } : { verb: 'task', arg: t };
}
export const HELP = [
  '*/kaizen tasks* — open to-dos and repairs, each with a menu (complete, start, edit, remove)',
  '*/kaizen task Fix the AC* — a new to-do (a form opens)', '*/kaizen repair Leak under sink* — a new repair',
  '*/kaizen claims* — open claims (status, edit, remove)', '*/kaizen claim Missing fob* — a new claim',
  '*/kaizen today* — check-ins, cleans and what is missing, now'
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
}
export const PRIORITY_OPTS: Opt[] = [{ value: 'none', label: 'No priority' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' }];
export const STATUS_OPTS: Opt[] = Object.entries(STATUS_WORD).map(([value, label]) => ({ value, label }));

export function taskModal(f: TaskForm, units: Opt[], people: Opt[]): Block {
  const repair = f.kind === 'work_order';
  return {
    type: 'modal', callback_id: 'task_save', private_metadata: JSON.stringify({ id: f.id ?? null, kind: f.kind ?? 'task' }),
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
