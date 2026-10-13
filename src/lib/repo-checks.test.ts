import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, runCheck, writePlan, norm } from './repo-checks.ts';

const wifi = CHECKS.find(c => c.key === 'wifi')!;
const fee = CHECKS.find(c => c.key === 'cleaning_fee')!;

test('wifi: match, capitals only, real difference, missing sides', () => {
  assert.equal(runCheck(wifi, { wifi_network: '1304WiFi', password_2: '5starstay' }, { wifiName: '1304WiFi', wifiPassword: '5starstay' }).status, 'match');
  assert.equal(runCheck(wifi, { wifi_network: '4212WiFi', password_2: '5starstay' }, { wifiName: '4212wifi', wifiPassword: '5starstay' }).status, 'case');
  assert.equal(runCheck(wifi, { wifi_network: 'NapaWifi', password_2: 'x' }, { wifiName: 'InternetConnection', wifiPassword: 'x' }).status, 'differ');
  assert.equal(runCheck(wifi, {}, { wifiName: 'A', wifiPassword: 'b' }).status, 'no-repository');
  assert.equal(runCheck(wifi, {}, {}).status, 'empty');
});

test('a real difference outranks a missing side', () => {
  const r = runCheck(wifi, { wifi_network: 'A', password_2: '' }, { wifiName: 'B', wifiPassword: 'p' });
  assert.equal(r.status, 'differ');
});

test('money compares as amounts; 0 is unset', () => {
  assert.equal(norm('money', '$150'), '150.00');
  assert.equal(norm('money', 0), '');
  assert.equal(runCheck(fee, { cleaning_fee: 150 }, { cleaningFee: 150.0 }).status, 'match');
  assert.equal(runCheck(fee, { cleaning_fee: '' }, { cleaningFee: 95 }).status, 'no-repository');
});

test('writePlan maps each side to the other, refuses an empty source', () => {
  const r = runCheck(wifi, { wifi_network: '4315WiFi', password_2: '5starstay' }, { wifiName: '4212wifi', wifiPassword: '5starstay' });
  assert.deepEqual(writePlan(wifi, r, 'hostaway'), { wifiUsername: '4315WiFi', wifiPassword: '5starstay' });
  assert.deepEqual(writePlan(wifi, r, 'repository'), { wifi_network: '4212wifi', password_2: '5starstay' });
  const f = runCheck(fee, {}, { cleaningFee: 95 });
  assert.deepEqual(writePlan(fee, f, 'repository'), { cleaning_fee: 95 });
  assert.equal(typeof writePlan(fee, f, 'hostaway'), 'string');
});
