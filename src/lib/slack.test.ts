import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costModal, costFromWords, readCostForm, cleanContext, claimCard, claimList, sectionButtons, mentionHelpBlocks, pickTask, guessUnit, quickTitle, trackedReply, parseMention, newButtons, commentsBlocks, commentFromMention, dayRange, dueTaskChecks, localNow, taskCheckMessage, checkinsModal, claimsModal, tasksModal, cleansModal, helpBlocks, helpUrlOf, cleanAssignModal, dmTarget, hostawayUserOf, suggestPeople, taskCard, claimMessage, digestMessage, dueDigests, esc, parseCommand, readClaimForm, readTaskForm, taskList, taskMessage, taskModal,
         type DigestInput } from './slack.ts';

test('/kaizen: verbs, and plain text is a new to-do', () => {
  assert.deepEqual(parseCommand(''), { verb: 'help', arg: '' });
  assert.deepEqual(parseCommand('tasks'), { verb: 'tasks', arg: '' });
  assert.deepEqual(parseCommand('repair Leak under the sink'), { verb: 'repair', arg: 'Leak under the sink' });
  assert.deepEqual(parseCommand('Call the HOA'), { verb: 'task', arg: 'Call the HOA' });
  assert.deepEqual(parseCommand('CLAIM Missing fob'), { verb: 'claim', arg: 'Missing fob' });
});

test('what people typed is escaped for Slack', () => {
  assert.equal(esc('<b> & co'), '&lt;b&gt; &amp; co');
});

const D: DigestInput = {
  today: '2026-10-01', tomorrow: '2026-10-02',
  arrivals: [
    { resId: 'A1', date: '2026-10-01', time: '4:00 PM', unit: 'P2-4308', guest: 'Alicia', agreement: 'not_signed', needsId: true, idInDrive: false },
    { date: '2026-10-01', time: '4:00 PM', unit: 'CL1250', guest: 'Medardo', agreement: 'signed', needsId: false, idInDrive: null },
    { resId: 'C1', date: '2026-10-02', time: '4:00 PM', unit: 'Concord', guest: 'Bryan', agreement: 'not_signed', needsId: false, idInDrive: null }
  ],
  departures: [
    { resId: 'O1', date: '2026-10-01', time: '10:00 AM', unit: 'P2-4308', cleaner: null, assigned: false, notNeeded: false, sameDay: true },
    { resId: 'O2', date: '2026-10-02', time: '10:00 AM', unit: 'Quest', cleaner: null, assigned: false, notNeeded: false, sameDay: false },
    { date: '2026-10-02', time: '10:00 AM', unit: 'Napa', cleaner: 'Veronica', assigned: true, notNeeded: false, sameDay: false }
  ],
  tasks: [{ title: 'Change the code', unit: 'P2-4304', overdue: true, dueToday: false, owner: null }],
  claims: [{ label: 'P2-4308 · Missing Fob', severity: 'Medium', days: 2 }]
};


test('the afternoon reminder: only tomorrow, no tasks or claims', () => {
  const m = digestMessage(D, 'afternoon');
  assert.equal(m.missing, 2);
  assert.doesNotMatch(JSON.stringify(m.blocks), /P2-4308|overdue|Missing Fob/);
});

test('reminders go once a day, at or after their hour', () => {
  const sent = new Set(['digest:morning:2026-10-01']);
  assert.deepEqual(dueDigests(7, '2026-10-01', {}, new Set()), []);
  assert.deepEqual(dueDigests(9, '2026-10-01', {}, new Set()), ['morning']);
  assert.deepEqual(dueDigests(16, '2026-10-01', {}, sent), ['afternoon']);
  assert.deepEqual(dueDigests(16, '2026-10-01', { digest: { afternoon: null } }, sent), []);
  // Nothing sent yet by the afternoon: only the afternoon one, never a late morning.
  assert.deepEqual(dueDigests(16, '2026-10-01', {}, new Set()), ['afternoon']);
  assert.deepEqual(dueDigests(16, '2026-10-01', { digest: { afternoon: null } }, new Set()), ['morning']);
});

test('a task message carries the buttons that act on it', () => {
  const m = taskMessage({ id: '7', title: 'Fix <AC>', kind: 'work_order', status: 'pending', priority: 'high', unit: 'CL1125', assignee: 'Laura' }, 'created', 'juan');
  const s = JSON.stringify(m.blocks);
  assert.match(s, /Fix &lt;AC&gt;/);
  assert.match(s, /task_complete/);
  assert.match(s, /task_start/);
  assert.match(s, /▲ high/);
  const done = JSON.stringify(taskMessage({ id: '7', title: 'x', kind: 'task', status: 'completed', priority: 'none' }, 'completed', '').blocks);
  assert.match(done, /task_reopen/);
  assert.doesNotMatch(done, /task_complete/);
  assert.match(JSON.stringify(taskList([])), /Nothing open/);
});

test('a claim message lets the status be changed in place', () => {
  const s = JSON.stringify(claimMessage({ id: '3', unit: 'P2-4308', category: 'Damage', severity: 'High', status: 'Open', description: 'Missing fob' }, 'opened', 'juan').blocks);
  assert.match(s, /claim_status/);
  assert.match(s, /"value":"Resolved\|3"/);
});

test('forms read back as the API bodies', () => {
  const modal = taskModal({ kind: 'work_order', title: 'Leak' }, [{ value: '1', label: 'CL1125' }], [{ value: '981633', label: 'Laura' }]) as { blocks: { block_id: string }[] };
  assert.deepEqual(modal.blocks.map(b => b.block_id), ['title', 'description', 'unit', 'priority', 'owner', 'start', 'due', 'cost']);
  assert.deepEqual(readTaskForm({
    title: { v: { value: 'Leak' } }, description: { v: { value: null } }, unit: { v: { selected_option: { value: '1' } } },
    priority: { v: { selected_option: { value: 'high' } } }, owner: { v: { selected_option: { value: '981633' } } },
    start: { v: { selected_date: null } }, due: { v: { selected_date: '2026-10-03' } }, cost: { v: { value: '85' } }
  }, { id: null, kind: 'work_order' }), {
    action: 'create', kind: 'work_order', title: 'Leak', description: null, unitIds: ['1'], priority: 'high',
    assigneeUserId: 981633, scheduledOn: null, dueOn: '2026-10-03', costActual: 85
  });
  assert.deepEqual(readClaimForm({ description: { v: { value: 'Fob' } }, severity: { v: { selected_option: { value: 'High' } } },
                                   occurred: { v: { selected_date: '2026-10-01' } } }),
    { description: 'Fob', unitId: null, occurredOn: '2026-10-01', category: null, severity: 'High', status: 'Open', source: null, caseUrl: '', refund: 0 });
});


test('direct messages: off, test (all to the tester, saying for whom), on (only linked people)', () => {
  const people = { '1255725': 'UDEREK', '1074799': 'UJUAN' };
  assert.equal(dmTarget({ people, dm: { mode: 'off' } }, 1255725), null);
  assert.deepEqual(dmTarget({ people, dm: { mode: 'test', testUser: 'UJUAN' } }, 1255725), { to: 'UJUAN', standIn: true });
  assert.deepEqual(dmTarget({ people, dm: { mode: 'test', testUser: 'UJUAN' } }, 1074799), { to: 'UJUAN', standIn: false });
  assert.deepEqual(dmTarget({ people, dm: { mode: 'on' } }, 1255725), { to: 'UDEREK', standIn: false });
  assert.equal(dmTarget({ people, dm: { mode: 'on' } }, 999), null);
  // Default is test with no tester: nobody gets anything until it is set up.
  assert.equal(dmTarget({ people }, 1255725), null);
  assert.equal(hostawayUserOf({ people }, 'UJUAN'), '1074799');
});

test('people are suggested by email, else by full name', () => {
  assert.deepEqual(suggestPeople(
    [{ id: 1, name: 'Derek Cheung', email: 'derek@stayhikaru.com' }, { id: 2, name: 'Juan Gonzalez', email: 'j@x.com' }, { id: 3, name: 'Laura', email: 'l@x.com' }],
    [{ id: 'UD', name: 'Derek Cheung', email: 'derek@kaizen.com' }, { id: 'UJ', name: 'Juan G', email: 'J@x.com' }]),
    { 1: 'UD', 2: 'UJ' });
});

test('the task card: facts, buttons, sub-tasks, latest updates, a box to add one', () => {
  const v = taskCard({ id: '7', title: 'Fix the AC', kind: 'work_order', status: 'pending', priority: 'high', unit: 'CL1125', assignee: 'Laura',
    dueOn: '2026-10-03', costEstimate: 120, children: [{ title: 'Buy filter', status: 'completed' }, { title: 'Install', status: 'pending' }],
    updates: [{ when: 'Oct 1, 9:00 AM', who: 'juan', body: 'Vendor booked' }] }, '✓ Started') as { title: { text: string }; callback_id: string; blocks: unknown[] };
  const s = JSON.stringify(v.blocks);
  assert.equal(v.title.text, 'Repair');
  assert.equal(v.callback_id, 'task_card');
  for (const k of ['card_complete', 'card_start', 'card_take', 'card_edit', 'Sub-tasks', '1/2', 'Vendor booked', '~$120.00 estimated', '✓ Started', '"block_id":"update"']) assert.ok(s.includes(k), k);
});


test('the cleans pop-up: each clean with its state, and Assign / Change when allowed', () => {
  const rows = [
    { resId: 'O1', time: '10:00 AM', unit: 'CL1250', beds: 1, cleaner: 'Michelle', state: 'assigned' as const, sameDay: true, deep: false, byHand: true },
    { resId: 'O2', time: '10:00 AM', unit: 'Quest', beds: 3, cleaner: null, state: 'open' as const, sameDay: false, deep: true, byHand: false },
    { resId: 'O3', time: '11:00 AM', unit: 'Napa', beds: 4, cleaner: null, state: 'not_needed' as const, sameDay: false, deep: false, byHand: false }
  ];
  const v = cleansModal('2026-10-01', 'Today', rows, true, '✓ Quest: Veronica') as { title: { text: string }; blocks: unknown[] };
  const s = JSON.stringify(v.blocks);
  assert.equal(v.title.text, 'Cleans · Today');
  assert.match(s, /2 cleans · ▲ 1 not assigned/);
  assert.match(s, /Michelle · ⚡ same-day · set by hand/);
  assert.match(s, /_not assigned_ · deep clean/);
  assert.match(s, /"text":"Assign"/);
  assert.match(s, /✓ Quest: Veronica/);
  assert.doesNotMatch(JSON.stringify((cleansModal('2026-10-01', 'Today', rows, false) as { blocks: unknown[] }).blocks), /clean_change/);
  assert.match(JSON.stringify((cleanAssignModal({ resId: 'O2', unit: 'Quest', date: '2026-10-01' }, ['V']) as { blocks: unknown[] }).blocks), /Let the rule decide/);
});

test('help is the SOP, step by step, with the way to it', () => {
  const b = JSON.stringify(helpBlocks({ title: 'Kaizen in Slack', purpose: 'Work from Slack', steps: [{ text: 'Read the reminder', detail: '**Morning**: today' }] }, 'https://k/?sop=9'));
  assert.match(b, /📘 Kaizen in Slack/);
  assert.match(b, /1\. Read the reminder/);
  assert.match(b, /\*Morning\*: today/);
  assert.match(b, /Open the SOP in Kaizen/);
  assert.match(JSON.stringify(helpBlocks(null)), /kaizen tasks/);
});

test('the reminder: one short message, a line per section, each with Manage', () => {
  const m = digestMessage(D, 'morning', 'https://k.example', 'https://k.example/?sop=9');
  const s = JSON.stringify(m.blocks);
  // unsigned ×2 (P2-4308, Concord) + ID ×1 (P2-4308) + unassigned cleans ×2 (P2-4308 today, Quest tomorrow)
  assert.equal(m.missing, 5);
  assert.equal(m.text, 'Today Oct 1: 5 missing');
  for (const k of ['sec_checkins', 'sec_cleans', 'sec_tasks', 'sec_claims']) assert.ok(s.includes(`"action_id":"${k}"`), k);
  assert.match(s, /Check-ins\* · 2 today · 1 tomorrow\\n▲ 2 not signed · ▲ 1 ID not in Drive/);
  assert.match(s, /Cleans\* · 1 today · 2 tomorrow · ⚡ 1 same-day\\n▲ 2 not assigned/);
  assert.match(s, /Tasks\* · 1 open\\n▲ 1 overdue/);
  // §109: the morning names the overdue and due-today tasks (it is the tasks' check-in too).
  assert.match(s, /▲ Change the code · P2-4304/);
  assert.match(s, /k\.example\/\?sop=9\|❓ How to use this/);
  // Each button knows the days it covers.
  assert.match(s, /"value":"\{\\"days\\":\[\\"2026-10-01\\",\\"2026-10-02\\"\]\}"/);
  // The afternoon: tomorrow only, and no tasks or claims.
  const a = JSON.stringify(digestMessage(D, 'afternoon').blocks);
  assert.doesNotMatch(a, /sec_tasks|sec_claims/);
  assert.match(a, /"value":"\{\\"days\\":\[\\"2026-10-02\\"\]\}"/);
  assert.deepEqual(parseCommand('cleans tomorrow'), { verb: 'cleans', arg: 'tomorrow' });
});

test('the check-ins pop-up: every arrival, what is missing, and the fix beside it', () => {
  const v = checkinsModal(D, ['2026-10-01', '2026-10-02'], true) as { callback_id: string; blocks: unknown[] };
  const s = JSON.stringify(v.blocks);
  assert.equal(v.callback_id, 'sec_checkins');
  // P2-4308 today: its clean is open — assign it here, and come back to this list.
  assert.match(s, /"action_id":"clean_change","style":"primary","value":"\{\\"resId\\":\\"O1\\".*\\"from\\":\\"checkins\\"/);
  // Concord: only unsigned — the reservation in Hostaway.
  assert.match(s, /dashboard\.hostaway\.com\/reservations\/C1/);
  assert.match(s, /✓ \*CL1250\* 4:00 PM · Medardo\\n✓ signed · no checkout before/);
  assert.match(s, /▲ not signed · ▲ ID not in Drive · ▲ clean not assigned/);
  // Without operations.edit, no Assign — Hostaway only.
  assert.doesNotMatch(JSON.stringify((checkinsModal(D, ['2026-10-01'], false) as { blocks: unknown[] }).blocks), /clean_change/);
});

test('the tasks and claims pop-ups: a menu per item, new from the top, undo in place', () => {
  const t = JSON.stringify((tasksModal([{ id: '7', title: 'Fix AC', kind: 'work_order', status: 'pending', priority: 'none', overdue: true }],
                                       '✓ Started: x', { id: '5', title: 'Old' }) as { blocks: unknown[] }).blocks);
  for (const k of ['1 open', '▲ 1 overdue', 'task_new', 'open:7', 'remove:7', '✓ Started: x', 'Removed *Old*', 'task_restore']) assert.ok(t.includes(k), k);
  const c = JSON.stringify((claimsModal([{ id: '3', unit: 'P2-4308', severity: 'Medium', status: 'Open', description: 'Fob' }]) as { blocks: unknown[] }).blocks);
  for (const k of ['claim_new', '"action_id":"claim_status"', '"value":"Resolved|3"', '"action_id":"claim_edit","value":"3"', '"action_id":"claim_remove","value":"3"']) assert.ok(c.includes(k), k);
  // Slack allows at most five options in an overflow menu — none here goes over.
  for (const m of [...c.matchAll(/"type":"overflow"[^\]]*\]/g)]) assert.ok((m[0].match(/"value"/g) ?? []).length <= 5);
  const cl = JSON.stringify((cleansModal('2026-10-01', 'Today', [], true, undefined, { today: '2026-10-01', tomorrow: '2026-10-02' }) as { blocks: unknown[] }).blocks);
  assert.match(cl, /cleans_day_2026-10-02/);
});

test('no overflow menu goes over Slack’s five options', () => {
  const lists = [JSON.stringify(taskList([{ id: '1', title: 't', kind: 'task', status: 'pending', priority: 'none' }])),
                 JSON.stringify(tasksModal([{ id: '1', title: 't', kind: 'task', status: 'pending', priority: 'none' }])),
                 JSON.stringify(claimsModal([{ id: '3', severity: 'Low', status: 'Open' }]))];
  for (const s of lists) for (const m of s.matchAll(/"type":"overflow","action_id":"[a-z_]+","options":\[(.*?)\]\}/g)) {
    assert.ok((m[1]!.match(/"value"/g) ?? []).length <= 5, m[0].slice(0, 80));
  }
});

test('a mention in a thread becomes the comment, without the mention or an "update:"', () => {
  assert.equal(commentFromMention('<@U0C5NJS538B> the plumber comes at 10'), 'the plumber comes at 10');
  assert.equal(commentFromMention('<@U0C5NJS538B|kaizen> update: keys left with Michelle'), 'keys left with Michelle');
  assert.equal(commentFromMention('<@U1> '), '');
});

test('Central time: the wall clock, and a local day as UTC instants (daylight saving included)', () => {
  assert.deepEqual(localNow('America/Chicago', new Date('2026-10-06T13:05:00Z')), { day: '2026-10-06', hm: '08:05' });   // CDT, UTC-5
  assert.deepEqual(localNow('America/Chicago', new Date('2026-10-07T04:55:00Z')), { day: '2026-10-06', hm: '23:55' });
  assert.deepEqual(dayRange('2026-10-06', 'America/Chicago'), ['2026-10-06T05:00:00.000Z', '2026-10-07T05:00:00.000Z']);
  assert.deepEqual(dayRange('2026-12-01', 'America/Chicago'), ['2026-12-01T06:00:00.000Z', '2026-12-02T06:00:00.000Z']);  // CST, UTC-6
  // The day daylight saving ends is 25 hours long.
  assert.deepEqual(dayRange('2026-11-01', 'America/Chicago'), ['2026-11-01T05:00:00.000Z', '2026-11-02T06:00:00.000Z']);
});

test('check-in (when set) from its time until noon; check-out from 23:55, late runs after midnight still close yesterday', () => {
  const none = new Set<string>();
  // §109: off by default — the morning reminder carries the tasks.
  assert.deepEqual(dueTaskChecks({ day: '2026-10-06', hm: '08:05' }, {}, none), []);
  const on = { taskCheck: { checkin: '08:00' } };
  assert.deepEqual(dueTaskChecks({ day: '2026-10-06', hm: '07:59' }, on, none), []);
  assert.deepEqual(dueTaskChecks({ day: '2026-10-06', hm: '08:05' }, on, none), [{ kind: 'checkin', day: '2026-10-06' }]);
  assert.deepEqual(dueTaskChecks({ day: '2026-10-06', hm: '13:00' }, on, none), []);
  assert.deepEqual(dueTaskChecks({ day: '2026-10-06', hm: '23:55' }, {}, none), [{ kind: 'checkout', day: '2026-10-06' }]);
  assert.deepEqual(dueTaskChecks({ day: '2026-10-07', hm: '00:40' }, {}, none), [{ kind: 'checkout', day: '2026-10-06' }]);
  assert.deepEqual(dueTaskChecks({ day: '2026-10-07', hm: '00:40' }, {}, new Set(['taskcheck:checkout:2026-10-06'])), []);
  assert.deepEqual(dueTaskChecks({ day: '2026-10-06', hm: '08:05' }, { taskCheck: { checkin: null } }, none), []);
});

test('check-in lists everything open; check-out counts the day', () => {
  const d = { day: '2026-10-06',
    open: [{ title: 'Fix AC', owner: 'Laura', unit: 'CL1125', overdue: true, dueToday: false, inProgress: false, kind: 'work_order' },
           { title: 'Call HOA', owner: null, unit: null, overdue: false, dueToday: true, inProgress: false, kind: 'task' },
           { title: 'Giggster', owner: null, unit: null, overdue: false, dueToday: false, inProgress: true, kind: 'task' }],
    closed: [{ title: 'Fob', by: 'laura', cancelled: false }, { title: 'Old', by: 'juan', cancelled: true }],
    opened: [{ title: 'Call HOA', by: 'juan' }] };
  const i = taskCheckMessage('checkin', d);
  assert.equal(i.text, 'Tasks check-in Oct 6: 3 open, 1 overdue, 1 due today');
  const si = JSON.stringify(i.blocks);
  for (const k of ['▲ Overdue', '● Due today', '◐ In progress', '🔧 Fix AC · CL1125 · Laura', '● Call HOA"', '"action_id":"sec_tasks"']) assert.ok(si.includes(k) || si.includes(k.replace('"', '\\n')), k);
  assert.doesNotMatch(si, /no owner/);
  const o = taskCheckMessage('checkout', d);
  assert.equal(o.text, 'Tasks check-out Oct 6: 2 closed, 1 opened, 3 still open');
  const so = JSON.stringify(o.blocks);
  for (const k of ['(1 done, 1 cancelled)', '✓ Fob · laura', '✕ Old · juan', '＋ Call HOA · juan', 'Still open']) assert.ok(so.includes(k), k);
});

test('@Kaizen: what a mention asks for', () => {
  assert.deepEqual(parseMention('<@U1>'), { verb: 'help', arg: '' });
  assert.deepEqual(parseMention('<@U1> new Fix the AC in P2-4308'), { verb: 'new', arg: 'Fix the AC in P2-4308' });
  assert.deepEqual(parseMention('<@U1> repair leak'), { verb: 'repair', arg: 'leak' });
  assert.deepEqual(parseMention('<@U1> comments'), { verb: 'comments', arg: '' });
  assert.deepEqual(parseMention('<@U1> the plumber comes at 10'), { verb: 'text', arg: 'the plumber comes at 10' });
  const b = JSON.stringify(newButtons('Fix the AC'));
  assert.match(b, /mention_new_task/);
  assert.match(b, /\\"title\\":\\"Fix the AC\\"/);
  assert.equal((newButtons('x', 'claim') as { elements: unknown[] }).elements.length, 1);
  assert.match(JSON.stringify(commentsBlocks([{ who: 'juan', when: 'Oct 6', body: 'hi' }], 'Leak').blocks), /Comments on Leak/);
});

test('no message or pop-up has two elements with one action_id — Slack refuses it', () => {
  const t = { id: '1', title: 'A', kind: 'task' as const, status: 'pending', priority: 'none', assignee: null, dueOn: null };
  const each = (blocks: unknown) => {
    const ids: string[] = [];
    JSON.stringify(blocks, (k, v) => { if (k === 'action_id') ids.push(v); return v; });
    assert.equal(new Set(ids).size, ids.length, ids.join(','));
  };
  each(taskList([t]));
  each(tasksModal([{ ...t, overdue: false, dueToday: false }]));
  each(newButtons('x'));
});

test('@Kaizen new: the listing from the text, a short title, the reply with Add details', () => {
  const units = [{ value: '1', label: 'P2-4308' }, { value: '2', label: 'CL 1125' }, { value: '3', label: 'Napa Valley' }, { value: '4', label: 'P2-430' }];
  assert.equal(guessUnit('AC broken in p2 4308', units), '1');
  assert.equal(guessUnit('leak at CL1125 kitchen', units), '2');
  assert.equal(guessUnit('napa-valley needs towels', units), '3');
  assert.equal(guessUnit('P2-43085 is not a unit', units), null);
  assert.equal(guessUnit('buy paper', units), null);
  assert.deepEqual(quickTitle('Fix the AC'), { title: 'Fix the AC', description: null });
  const long = quickTitle(`${'word '.repeat(40)}\nmore`);
  assert.ok(long.title.length <= 120 && long.title.endsWith('…'));
  assert.match(String(long.description), /more$/);
  const r = JSON.stringify(trackedReply({ id: '9', title: 'Fix AC', kind: 'work_order', unit: 'P2-4308' }).blocks);
  assert.match(r, /as a repair: \*Fix AC\* · P2-4308/);
  assert.match(r, /"action_id":"task_edit","value":"9"/);
});

test('💬 Comment on a task: a menu of the listed tasks, late first; the card opens with the box ready', () => {
  const p = pickTask([{ id: '1', title: 'Paint', overdue: false, dueToday: false }, { id: '2', title: 'Fix AC', unit: 'P2-4308', overdue: true, dueToday: false },
                      { id: '3', title: 'x'.repeat(90), dueToday: true }, { title: 'no id' }]);
  const opts = (p[0] as { elements: { action_id: string; options: { text: { text: string }; value: string }[] }[] }).elements[0]!;
  assert.equal(opts.action_id, 'task_pick');
  assert.deepEqual(opts.options.map(o => o.value), ['2', '3', '1']);
  assert.equal(opts.options[0]!.text.text, '▲ Fix AC · P2-4308');
  assert.ok(opts.options[1]!.text.text.length <= 75);
  assert.deepEqual(pickTask([{ title: 'no id' }]), []);
  assert.match(JSON.stringify(digestMessage({ ...D, tasks: [{ id: '7', title: 'Call HOA', overdue: true, dueToday: false }] }, 'morning').blocks), /"action_id":"task_pick"/);
  const card = { id: '1', title: 'A', kind: 'task' as const, status: 'pending', priority: 'none', assignee: null, supervisor: null, dueOn: null, scheduledOn: null,
    reservationLabel: null, description: null, vendor: null, costActual: null, costEstimate: null, resolutionNote: null, unit: null, children: [], updates: [] };
  assert.match(JSON.stringify(taskCard(card, undefined, undefined, true)), /"focus_on_load":true/);
  assert.doesNotMatch(JSON.stringify(taskCard(card)), /focus_on_load/);
});

test('the help opens every section; @Kaizen claims lists them', () => {
  assert.deepEqual(parseMention('<@U1> claims'), { verb: 'claims', arg: '' });
  const ids = JSON.stringify(sectionButtons());
  for (const k of ['sec_tasks', 'sec_claims', 'sec_checkins', 'sec_cleans']) assert.ok(ids.includes(k), k);
  assert.match(JSON.stringify(mentionHelpBlocks()), /sec_claims[\s\S]*mention_new_task/);
});

test('a claim has its card: the case, its comments and the box; every row and message has 💬 Comment', () => {
  const c = { id: '5', unit: 'P2-4308', category: 'Damage', severity: 'High', status: 'Open', description: 'Broken TV', days: 3, refund: 50,
              updates: [{ who: 'juan', when: 'Oct 6', body: 'Asked the guest' }] };
  const v = claimCard(c, undefined, 'claims', true) as { callback_id: string; private_metadata: string };
  const s = JSON.stringify(v);
  assert.equal(v.callback_id, 'claim_card');
  assert.deepEqual(JSON.parse(v.private_metadata), { id: '5', root: 'claims' });
  for (const k of ['P2-4308 · Broken TV', 'Comments* · 1', 'Asked the guest', '$50.00', '"focus_on_load":true']) assert.ok(s.includes(k), k);
  assert.match(JSON.stringify(claimList([c])), /"action_id":"claim_open","value":"5"/);
  assert.match(JSON.stringify(claimMessage(c, 'opened', 'juan').blocks), /claim_open/);
});

test('@Kaizen all asks for the whole reminder', () => {
  assert.deepEqual(parseMention('<@U1> all'), { verb: 'all', arg: '' });
  assert.deepEqual(parseMention('<@U1> status'), { verb: 'all', arg: '' });
});

test('a clean says what leaves and what arrives next', () => {
  const base = { resId: '1', time: '10:00 AM', unit: 'P2-4308', beds: 2, cleaner: 'Michelle', state: 'assigned' as const, sameDay: false, deep: false, byHand: false };
  const a = cleanContext({ ...base, out: { guest: 'Ann Lee', nights: 3, guests: 2, channel: 'Airbnb', total: 540 },
    next: { date: '2026-10-08', time: '4:00 PM', guest: 'Bo Ray', nights: 5, guests: 4, gapDays: 0, total: null } }, '2026-10-08');
  assert.deepEqual(a, ['↗ Out: Ann Lee · 3 nights · 2 guests · Airbnb · $540', '↘ Next in: *same day* 4:00 PM · Bo Ray · 5 nights · 4 guests']);
  assert.match(cleanContext({ ...base, next: { date: '2026-10-11', gapDays: 3 } }, '2026-10-08')[0]!, /Next in: .* \(3 days empty\)/);
  assert.deepEqual(cleanContext({ ...base, next: null }, '2026-10-08'), ['↘ Next in: _nothing booked yet_']);
  assert.deepEqual(cleanContext(base, '2026-10-08'), []);
});

test('a cost: the form asks every field, filled from the words, and refuses a bad amount', () => {
  const units = [{ value: '10', label: 'P2-4308' }, { value: '11', label: 'Quest' }];
  assert.deepEqual(parseMention('<@U1> cost 45 towels P2-4308'), { verb: 'cost', arg: '45 towels P2-4308' });
  assert.equal(parseCommand('cost 45 towels').verb, 'cost');
  const f = costFromWords('45 towels P2-4308', units, '2026-10-07');
  assert.deepEqual(f, { what: '45 towels P2-4308', amount: 45, category: 'Restock', unitId: '10', date: '2026-10-07' });
  const v = JSON.stringify(costModal(f, units));
  for (const k of ['"callback_id":"cost_save"', '"initial_value":"45"', '"initial_date":"2026-10-07"', 'Shared — split across live units']) assert.ok(v.includes(k), k);
  assert.doesNotMatch(v, /"optional":true/);   // every field required
  const st = (amount: string, unit: string) => ({ what: { v: { value: 'towels' } }, amount: { v: { value: amount } }, category: { v: { selected_option: { value: 'Restock' } } },
    unit: { v: { selected_option: { value: unit } } }, date: { v: { selected_date: '2026-10-07' } } });
  assert.deepEqual(readCostForm(st('$1,045.5', '10')), { body: { action: 'variable', amount: 1045.5, category: 'Restock', unitId: '10', shared: false, date: '2026-10-07', notes: 'towels' } });
  assert.equal((readCostForm(st('45', '__shared')) as { body: Record<string, unknown> }).body.shared, true);
  assert.deepEqual(readCostForm(st('abc', '10')), { error: { block: 'amount', message: 'A number above zero, like 45 or 45.50.' } });
  assert.equal((newButtons('x', 'cost') as { elements: { action_id: string }[] }).elements[0]!.action_id, 'mention_new_cost');
});
