import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimMessage, digestMessage, dueDigests, esc, parseCommand, readClaimForm, readTaskForm, taskList, taskMessage, taskModal,
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
    { date: '2026-10-01', time: '4:00 PM', unit: 'P2-4308', guest: 'Alicia', agreement: 'not_signed', needsId: true, idInDrive: false },
    { date: '2026-10-01', time: '4:00 PM', unit: 'CL1250', guest: 'Medardo', agreement: 'signed', needsId: false, idInDrive: null },
    { date: '2026-10-02', time: '4:00 PM', unit: 'Concord', guest: 'Bryan', agreement: 'not_signed', needsId: false, idInDrive: null }
  ],
  departures: [
    { date: '2026-10-01', time: '10:00 AM', unit: 'P2-4308', cleaner: null, assigned: false, notNeeded: false, sameDay: true },
    { date: '2026-10-02', time: '10:00 AM', unit: 'Quest', cleaner: null, assigned: false, notNeeded: false, sameDay: false },
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
