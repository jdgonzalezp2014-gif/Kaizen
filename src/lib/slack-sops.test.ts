import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftFromAi, draftFromThread, linesOf, partialSopForm, readSopForm, redact, reviewFromAi, reviewNote, sopBody, sopModal, sopPrompt, sopsBlocks } from './slack-sops.ts';

const sections = [{ key: 'guest', label: 'Guest lifecycle' }, { key: 'claims', label: 'Claims & disputes' }];

test('SOP from Slack: a thread is the starting point, steps one per line', () => {
  assert.deepEqual(linesOf('1. Offer no refund\n- Negotiate\n\n2) Update Hostaway'), ['Offer no refund', 'Negotiate', 'Update Hostaway']);
  const d = draftFromThread([{ who: 'Boss', text: '*Early checkout*\nOffer to shorten with no refund' }, { who: 'Laura', text: 'ok <@U123>' }]);
  assert.equal(d.title, 'Early checkout');
  // A message that opens with a mention: the title is its words, not "@someone" (2026-10-14).
  assert.equal(draftFromThread([{ who: 'Laura', text: '<@U9>\nWe have a guest at Quest' }]).title, 'We have a guest at Quest');
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

test('✨ grades how complete it is and asks politely for what is missing; a second ✨ builds on what was typed', () => {
  const p = sopPrompt(sections, [{ who: 'Derek', text: 'shorten, no change in payout' }], { steps: ['Shorten in Hostaway'], rules: [] });
  assert.match(p.system, /be strict/);
  assert.match(p.system, /Never question a decision/);
  // Who decides, and the shorthand spelled out (2026-10-14: "no change in payout" read as the rule's words, not its meaning).
  assert.match(p.system, /DECIDES/); assert.match(p.system, /not refunded for the nights they no longer use/);
  assert.match(p.user, /Current draft \(written by the person — keep it\):\n\{"steps":\["Shorten in Hostaway"\]/);
  assert.doesNotMatch(sopPrompt(sections, [{ who: 'a', text: 'b' }], { title: '', steps: [] }).user, /Current draft/);
  assert.deepEqual(reviewFromAi({ score: 7, gaps: ['What do we tell the guest?', 3] }), { score: null, gaps: ['What do we tell the guest?'] });
  const n = reviewNote('gemini', { score: 2, gaps: ['What do we tell the guest?'] });
  assert.match(n, /Completeness: 2\/5/); assert.match(n, /• What do we tell the guest\?/); assert.match(n, /tap ✨ again/);
  assert.match(reviewNote('gemini', { score: 5, gaps: [] }), /anyone could follow this/);
  const vals = { title_1: { v: { value: 'X' } }, steps_1: { v: { value: '1. a\n2. b' } } };
  assert.deepEqual(partialSopForm(vals as never).steps, ['a', 'b']);
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

test('@Kaizen help <question>: a few SOPs by words, the model answers only from them; partial or none asks the thread', async () => {
  const { rankSops, helpPrompt, helpFromAi, helpAnswerBlocks, helpMissingBlocks } = await import('./slack-sops.ts');
  const lib = [{ id: '1', title: 'Your clean step by step: photos, done, supplies', steps: [{ text: 'Photos before' }] },
               { id: '2', title: 'Log and follow a guest claim', purpose: 'A guest asks for a refund', steps: [] },
               { id: '3', title: 'Record a cost', steps: [] }];
  assert.deepEqual(rankSops('what about the photos?', lib).map(s => s.id), ['1']);
  assert.deepEqual(rankSops('good morning', lib), []);
  const p = helpPrompt('refund?', lib.slice(1, 2));
  assert.match(p.user, /\[2\] Log and follow a guest claim/); assert.match(p.system, /Be strict/);
  assert.deepEqual(helpFromAi({ ids: ['2', '9'], answer: 'Log it.', covers: 'partial', missing: 'whether we refund' }, lib),
    { sops: [lib[1]], answer: 'Log it.', covers: 'partial', missing: 'whether we refund' });
  assert.equal(helpFromAi({ ids: ['2'], covers: 'none' }, lib).sops.length, 0);
  const from = { channel: 'C1', root: '1.2' };
  assert.match(JSON.stringify(helpAnswerBlocks('Log it.', [lib[1]!], 'https://k', { missing: 'whether we refund', from })), /The SOPs don't say \*whether we refund\*.*mention_new_sop/);
  assert.match(JSON.stringify(helpMissingBlocks('refund?', from)), /No SOP covers this yet.*please explain it here/);
});

test('the grade is the team’s own standard, general; the questions can go to the thread; search words count', async () => {
  const { standardFrom, DEFAULT_STANDARD, sopPrompt, gapsInThread, sopModal, rankSops } = await import('./slack-sops.ts');
  const body = '## One SOP, one process\nx\n## What a complete SOP covers\nOne point each.\n- **Scope** — a\n- **Outcomes** — b\n\n## Where it shows\ny';
  assert.equal(standardFrom(body), 'One point each.\n- **Scope** — a\n- **Outcomes** — b');
  assert.equal(standardFrom('no such header'), null);
  assert.match(sopPrompt([], [{ who: 'a', text: 'b' }], null, 'MY STANDARD').system, /The standard \(what a complete SOP covers\):\nMY STANDARD/);
  assert.match(sopPrompt([], [{ who: 'a', text: 'b' }]).system, /\*\*Outcomes\*\*/);
  assert.ok(DEFAULT_STANDARD.includes('counts as covered'));   // not every SOP talks to a guest
  const t = gapsInThread(['What if it fails?'], 'Record a charge');
  assert.match(JSON.stringify(t.blocks), /Writing an SOP from this thread: \*Record a charge\*.*• What if it fails\?/);
  const m = sopModal([], {}, { canPublish: false, source: { channel: 'C', ts: '1' }, gaps: ['q'] }) as { private_metadata: string };
  assert.ok(JSON.stringify(m).includes('sop_ask_thread'));
  assert.deepEqual(JSON.parse(m.private_metadata).gaps, ['q']);
  assert.ok(!JSON.stringify(sopModal([], {}, { canPublish: false, source: { channel: 'C', ts: '1' } })).includes('sop_ask_thread'));
  const lib = [{ id: '2', title: 'Early departure or mid-stay clean', steps: [], keywords: ['guest left early', 'salida temprana'] },
               { id: '3', title: 'Record a cost', steps: [] }];
  assert.deepEqual(rankSops('la salida temprana del huésped', lib).map(s => s.id), ['2']);
});
