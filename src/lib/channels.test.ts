import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelState } from './channels.ts';

const NOW = Date.parse('2026-09-17T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

test('never published is not a problem and gets no warning', () => {
  const s = channelState({ published: false, liveOk: false, observedAt: null, problem: null, now: NOW });
  assert.equal(s.state, 'unpublished');
  assert.equal(s.mark, '○');
});

test('a recent stored reading counts as current', () => {
  // The live read failing does not matter when yesterday's figure is
  // still the right answer. Warning here would cry wolf daily.
  const s = channelState({ published: true, liveOk: false, observedAt: daysAgo(1),
                           problem: 'blocked', now: NOW });
  assert.equal(s.state, 'ok');
});

test('a rating from before the last scheduled run is stale', () => {
  // The scraper runs daily, so anything older than two days means a run
  // was missed. Under the old three-day window a stale rating read as
  // current, which is how a month-old number went unnoticed.
  const s = channelState({ published: true, liveOk: false, observedAt: daysAgo(3),
                           problem: null, now: NOW });
  assert.equal(s.state, 'stale');
  assert.equal(s.label, '3d old');
});

test('old readings are stale, not broken', () => {
  // Usually the feed pausing. It needs nothing today, so it must not
  // look like the case that does.
  const s = channelState({ published: true, liveOk: false, observedAt: daysAgo(9),
                           problem: 'blocked', now: NOW });
  assert.equal(s.state, 'stale');
  assert.equal(s.label, '9d old');
  assert.notEqual(s.mark, '⚠');
});

test('never read at all is the integration, and says so', () => {
  // This is the one that needs someone to change something, so it is
  // the only one that gets the warning triangle.
  const s = channelState({ published: true, liveOk: false, observedAt: null,
                           problem: 'Airbnb served a bot challenge.', now: NOW });
  assert.equal(s.state, 'blocked');
  assert.equal(s.mark, '⚠');
  assert.match(s.detail, /integration rather than an outage/);
});

test('a working live read beats any stored age', () => {
  const s = channelState({ published: true, liveOk: true, observedAt: daysAgo(40),
                           problem: null, now: NOW });
  assert.equal(s.state, 'ok');
  assert.equal(s.ageDays, 0);
});
