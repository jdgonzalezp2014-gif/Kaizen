import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReport, reportVerb, reportMessage, reportOffer, readReportModal, reportTitle } from './reports.ts';
import { parseCommand } from './slack.ts';

test('readReport: kind and words required, urgency defaults to normal', () => {
  assert.deepEqual(readReport({ kind: 'x', body: 'a' }), { error: 'Bug or request?' });
  assert.ok('error' in readReport({ kind: 'bug', body: '  ' }));
  const r = readReport({ kind: 'request', body: ' Export to CSV ', urgency: 'nope', whereFrom: 'Revenue' });
  assert.deepEqual(r, { kind: 'request', body: 'Export to CSV', urgency: 'normal', whereFrom: 'Revenue', device: null });
});

test('reportVerb: English and Spanish words', () => {
  assert.equal(reportVerb('bug'), 'bug');
  assert.equal(reportVerb('Fallo:'), 'bug');
  assert.equal(reportVerb('pedir'), 'request');
  assert.equal(reportVerb('new'), null);
});

test('parseCommand: /kaizen bug and /kaizen request', () => {
  assert.deepEqual(parseCommand('bug the board is blank'), { verb: 'bug', arg: 'the board is blank' });
  assert.deepEqual(parseCommand('pedir export'), { verb: 'request', arg: 'export' });
});

test('reportMessage: open reports offer the next steps; closed ones only reopen', () => {
  const base = { id: '7', kind: 'bug' as const, body: 'Board <blank>', urgency: 'blocking' as const, whereFrom: 'Operations', device: null,
                 source: 'app' as const, reporter: 'ana@x.com', hasPhoto: true };
  const open = reportMessage({ ...base, status: 'new' }, 'https://k.dev');
  const ids = (m: typeof open) => ((m.blocks[2] as { elements: { action_id: string }[] }).elements).map(e => e.action_id);
  assert.deepEqual(ids(open), ['report_status_seen', 'report_status_doing', 'report_status_done', 'report_status_wontfix']);
  assert.match(JSON.stringify(open.blocks[0]), /Board &lt;blank&gt;/);
  assert.match(JSON.stringify(open.blocks[1]), /\?report=7/);
  assert.deepEqual(ids(reportMessage({ ...base, status: 'done' })), ['report_status_seen']);
});

test('reportOffer: words → two buttons; none → the form only', () => {
  assert.equal((reportOffer('bug', 'x', 'Slack').blocks[1] as { elements: unknown[] }).elements.length, 2);
  assert.equal((reportOffer('request', '', 'Slack').blocks[1] as { elements: unknown[] }).elements.length, 1);
});

test('readReportModal and reportTitle', () => {
  const f = readReportModal({ kind: { v: { selected_option: { value: 'request' } } }, body: { v: { value: ' hi ' } },
                              urgency: { v: { selected_option: { value: 'low' } } }, photo: { v: { files: [] } } });
  assert.deepEqual(f, { kind: 'request', body: 'hi', urgency: 'low' });
  assert.equal(reportTitle('a'.repeat(100) + '\nsecond').length, 88);
});
