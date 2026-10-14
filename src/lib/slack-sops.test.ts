import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftFromAi, draftFromThread, linesOf, readSopForm, redact, sopBody, sopModal, sopPrompt, sopsBlocks } from './slack-sops.ts';

const sections = [{ key: 'guest', label: 'Guest lifecycle' }, { key: 'claims', label: 'Claims & disputes' }];

test('SOP from Slack: a thread is the starting point, steps one per line', () => {
  assert.deepEqual(linesOf('1. Offer no refund\n- Negotiate\n\n2) Update Hostaway'), ['Offer no refund', 'Negotiate', 'Update Hostaway']);
  const d = draftFromThread([{ who: 'Boss', text: '*Early checkout*\nOffer to shorten with no refund' }, { who: 'Laura', text: 'ok <@U123>' }]);
  assert.equal(d.title, 'Early checkout');
  assert.deepEqual(d.steps, ['*Early checkout*', 'Offer to shorten with no refund', 'ok @someone']);
});

test('the model gets the conversation without phones or emails, and its answer is checked', () => {
  assert.equal(redact('call 214-555-0199 or a@b.com'), 'call [phone] or [email]');
  const p = sopPrompt(sections, [{ who: 'Boss', text: 'Guest +1 (469) 555 0100 wants out' }]);
  assert.match(p.user, /guest: Guest lifecycle/);
  assert.match(p.user, /Boss: Guest \[phone\] wants out/);
  assert.match(p.system, /Do not invent/);
  const d = draftFromAi({ title: ' Early checkout ', sectionKey: 'nope', steps: ['Offer', 3, ''], rules: 'If Airbnb → no refund', owner: 7 }, sections);
  assert.equal(d.title, 'Early checkout');
  assert.equal(d.sectionKey, '');               // not a section that exists
  assert.deepEqual(d.steps, ['Offer']);
  assert.deepEqual(d.rules, ['If Airbnb → no refund']);
  assert.equal(d.owner, '');
  assert.equal(sopBody(['If A → B']), '## Rules\n- If A → B');
  assert.equal(sopBody([]), null);
});

test('the form: versioned blocks, ✨ only from a thread, publish only for editors; read back or the field to fix', () => {
  const m = sopModal(sections, { title: 'X', sectionKey: 'claims' }, { canPublish: false, source: { channel: 'C1', ts: '1.2' }, v: 2 }) as { blocks: { block_id?: string }[] };
  const s = JSON.stringify(m);
  assert.ok(s.includes('"block_id":"title_2"') && s.includes('sop_suggest') && s.includes('Saved as a *draft*'));
  assert.ok(!s.includes('publish_2'));
  assert.ok(JSON.stringify(sopModal(sections, {}, { canPublish: true })).includes('publish_0'));
  assert.ok(!JSON.stringify(sopModal(sections, {}, { canPublish: true })).includes('sop_suggest'));
  const vals = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`${k}_2`, { v: v as Record<string, unknown> }]));
  assert.deepEqual(readSopForm(vals({ title: { value: 'X' }, section: { selected_option: null }, steps: { value: 'a' } })),
    { error: { block: 'section_2', message: 'Pick a section.' } });
  const ok = readSopForm(vals({ title: { value: 'X' }, section: { selected_option: { value: 'claims' } }, steps: { value: '1. a\n2. b' },
                                rules: { value: '- If x → y' }, publish: { selected_options: [{ value: 'yes' }] } }));
  assert.ok(!('error' in ok) && ok.publish && ok.draft.steps.length === 2 && ok.draft.rules[0] === 'If x → y');
});

test('@Kaizen sops: a button per section that has something, the library link', () => {
  const s = JSON.stringify(sopsBlocks([{ key: 'guest', label: 'Guest lifecycle', n: 2 }, { key: 'x', label: 'Empty', n: 0 },
                                       { key: 'kid', label: 'Child', parentKey: 'guest', n: 1 }], 'https://k'));
  assert.ok(s.includes('Guest lifecycle · 2') && !s.includes('Empty') && !s.includes('Child'));
  assert.ok(s.includes('https://k/?tab=sops') && s.includes('2 to read'));
});
