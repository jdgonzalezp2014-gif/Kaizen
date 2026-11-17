import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFS, normalizePrefs, inQuiet, decide } from './notify.ts';

const at = (h: number, m = 0) => new Date(2026, 10, 17, h, m);

test('normalize: nothing stored → defaults; junk is replaced', () => {
  assert.deepEqual(normalizePrefs(null), DEFAULT_PREFS);
  const p = normalizePrefs({ volume: 9, messages: { tone: 'kazoo', on: false }, quiet: { from: '25:00' } });
  assert.equal(p.volume, 1);
  assert.equal(p.messages.tone, 'ding');
  assert.equal(p.messages.on, false);
  assert.equal(p.quiet.from, '22:00');
});

test('normalize: the first bell settings carry over (events, volume, sound off)', () => {
  const p = normalizePrefs(null, { on: false, volume: 0.3, events: { new: true, completed: false, cancelled: true } });
  assert.equal(p.volume, 0.3);
  assert.equal(p.tasks.tone, 'none');
  assert.equal(p.tasks.events.completed, false);
});

test('quiet hours across midnight', () => {
  const q = { on: true, from: '22:00', to: '07:00', urgentRings: true };
  assert.equal(inQuiet(q, at(23)), true);
  assert.equal(inQuiet(q, at(6, 59)), true);
  assert.equal(inQuiet(q, at(7)), false);
  assert.equal(inQuiet(q, at(12)), false);
  assert.equal(inQuiet({ ...q, from: '13:00', to: '14:00' }, at(13, 30)), true);
  assert.equal(inQuiet({ ...q, on: false }, at(23)), false);
});

test('decide: filters keep it out of the bell; quiet and pause only silence it', () => {
  const p = normalizePrefs({ tasks: { events: { completed: false } }, messages: { urgentOnly: true }, quiet: { on: true } });
  assert.equal(decide(p, { kind: 'tasks', urgent: false, event: 'completed' }, at(12)).list, false);
  assert.equal(decide(p, { kind: 'messages', urgent: false }, at(12)).list, false);
  const night = decide(p, { kind: 'tasks', urgent: false, event: 'new' }, at(23));
  assert.deepEqual([night.list, night.sound, night.toast], [true, false, false]);
  assert.equal(decide(p, { kind: 'messages', urgent: true }, at(23)).sound, true);
  const paused = { ...p, pausedUntil: at(13).getTime() };
  assert.equal(decide(paused, { kind: 'messages', urgent: true }, at(12)).sound, false);
  assert.equal(decide(paused, { kind: 'messages', urgent: true }, at(14)).sound, true);
});

test('decide: a test ignores the filters but obeys pause; a silent tone plays nothing', () => {
  const p = normalizePrefs({ tasks: { on: false, tone: 'none' } });
  const d = decide(p, { kind: 'tasks', urgent: false, test: true }, at(12));
  assert.deepEqual([d.list, d.sound, d.toast], [true, false, true]);
});
