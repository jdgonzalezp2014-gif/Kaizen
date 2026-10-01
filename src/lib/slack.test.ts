import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleansModal, helpBlocks, helpUrlOf, cleanAssignModal, dmTarget, hostawayUserOf, suggestPeople, taskCard, claimMessage, digestMessage, dueDigests, esc, parseCommand, readClaimForm, readTaskForm, taskList, taskMessage, taskModal,
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

test('the morning reminder: today and tomorrow, every missing thing named once', () => {
  const m = digestMessage(D, 'morning', 'https://kaizen.example');
  const all = JSON.stringify(m.blocks);
  // P2-4308: unsigned, ID not in Drive, clean not assigned = 3; Concord unsigned = 1; Quest unassigned = 1.
  assert.equal(m.missing, 5);
  assert.match(all, /agreement not signed, ID not in Drive, clean not assigned/);
  assert.match(all, /Quest\* checkout 10:00 AM — _clean not assigned_/);
  assert.match(all, /1 overdue/);
  assert.match(all, /Missing Fob/);
  assert.equal(m.text, 'Today Oct 1: 5 missing');
});

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

test('the reminder puts the fix beside each missing thing', () => {
  const s = JSON.stringify(digestMessage(D, 'morning').blocks);
  // P2-4308's clean is open: the button assigns it (its checkout reservation).
  assert.match(s, /"action_id":"clean_assign","value":"\{\\"resId\\":\\"O1\\"/);
  // Concord is only unsigned: the button opens the reservation in Hostaway.
  assert.match(s, /dashboard\.hostaway\.com\/reservations\/C1/);
  // Quest's unassigned checkout gets its own button.
  assert.match(s, /\\"resId\\":\\"O2\\"/);
  const m = cleanAssignModal({ resId: 'O2', unit: 'Quest', date: '2026-10-02' }, ['Michelle', 'Veronica']) as { blocks: unknown[] };
  assert.match(JSON.stringify(m.blocks), /No clean needed/);
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

test('/kaizen cleans, and the reminder opens each day’s cleans', () => {
  assert.deepEqual(parseCommand('cleans tomorrow'), { verb: 'cleans', arg: 'tomorrow' });
  const s = JSON.stringify(digestMessage(D, 'morning', 'https://k.example', 'https://k.example/?sop=9').blocks);
  assert.match(s, /"action_id":"cleans_open","value":"2026-10-01"/);
  assert.match(s, /"action_id":"cleans_open","value":"2026-10-02"/);
  assert.match(s, /k\.example\/\?sop=9\|❓ How to use this/);
  assert.equal(helpUrlOf({ appUrl: 'https://k.example', helpSopId: '9' }), 'https://k.example/?sop=9');
  assert.equal(helpUrlOf({ appUrl: 'https://k.example' }), undefined);
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
