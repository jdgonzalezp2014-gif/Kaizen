import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrations } from './integrations.ts';

test('integrations: state from the account, identity waits for its provider', () => {
  const l = integrations({ hasHostawayKey: true, hasStripeKey: false, hasGeminiKey: true, hasClaudeKey: false, hasQuoKey: false, slack: true, drive: null });
  const by = Object.fromEntries(l.map(i => [i.key, i.state]));
  assert.deepEqual(by, { hostaway: 'on', stripe: 'off', slack: 'on', drive: 'off', ai: 'on', quo: 'off', guestai: 'off', identity: 'later' });
  assert.deepEqual(l.filter(i => i.required).map(i => i.key), ['hostaway']);
});
