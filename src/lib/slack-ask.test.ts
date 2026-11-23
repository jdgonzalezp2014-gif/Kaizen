import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askKind, looksLikeQuestion, recordBlocks } from './slack-ask.ts';

test('a question by its shape, English and Spanish', () => {
  for (const q of ['what is the wifi at amber valley', '¿cuál es el código de P2?', 'donde estan las toallas', 'is the pool heated?', "what's the address"])
    assert.ok(looksLikeQuestion(q), q);
  for (const q of ['fix the AC in P2-4308', 'wifi amber valley', 'buy 2 paper towels']) assert.ok(!looksLikeQuestion(q), q);
});

test('script decides before anything is read: question, short lookup, or a to-do', () => {
  assert.equal(askKind('wifi amber valley'), 'lookup');
  assert.equal(askKind('fix the door lock at Amber Valley tomorrow'), 'todo');
  assert.equal(askKind('how do we restock the coffee'), 'question');
  assert.equal(askKind('restock coffee', true), 'question');
});

test('record blocks: fields shown, secrets as a reveal button only for who may reveal', () => {
  const hit = { table: 'units', tableTitle: 'Units', id: '7', name: 'Amber Valley', matched: true,
    fields: [{ label: 'Wifi network', value: 'Amber<5G>' }], secrets: [{ column: 'wifi_password', label: 'Wifi password' }] };
  const yes = JSON.stringify(recordBlocks([hit], { canReveal: true, appUrl: 'https://k' }));
  assert.ok(yes.includes('Amber&lt;5G&gt;') && yes.includes('ask_reveal_wifi_password') && yes.includes('no AI used') && yes.includes('https://k/?tab=repository'));
  assert.ok(!yes.includes('"value":"Amber'));
  const no = JSON.stringify(recordBlocks([hit], { canReveal: false, answer: 'Yes', by: 'gemini-3.5-flash-lite' }));
  assert.ok(!no.includes('ask_reveal') && no.includes('cannot reveal') && no.includes('answered by gemini'));
});
