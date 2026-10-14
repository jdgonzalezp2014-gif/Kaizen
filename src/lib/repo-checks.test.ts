import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, SECTIONS, SYNCED_COLUMNS, runCheck, writePlan, norm, composeRules, splitRules, draftAdds, hostawayValue, firstDiffLine } from './repo-checks.ts';

const wifi = CHECKS.find(c => c.key === 'wifi')!;
const fee = CHECKS.find(c => c.key === 'cleaning_fee')!;
const check = (k: string) => CHECKS.find(c => c.key === k)!;

test('wifi: match, capitals only, real difference, missing sides', () => {
  assert.equal(runCheck(wifi, { wifi_network: '1304WiFi', password_2: '5starstay' }, { wifiUsername: '1304WiFi', wifiPassword: '5starstay' }).status, 'match');
  assert.equal(runCheck(wifi, { wifi_network: '4212WiFi', password_2: '5starstay' }, { wifiUsername: '4212wifi', wifiPassword: '5starstay' }).status, 'case');
  assert.equal(runCheck(wifi, { wifi_network: 'NapaWifi', password_2: 'x' }, { wifiUsername: 'InternetConnection', wifiPassword: 'x' }).status, 'differ');
  assert.equal(runCheck(wifi, {}, { wifiUsername: 'A', wifiPassword: 'b' }).status, 'no-repository');
  assert.equal(runCheck(wifi, {}, {}).status, 'empty');
});

test('a real difference outranks a missing side', () => {
  const r = runCheck(wifi, { wifi_network: 'A', password_2: '' }, { wifiUsername: 'B', wifiPassword: 'p' });
  assert.equal(r.status, 'differ');
});

test('money compares as amounts; 0 is unset', () => {
  assert.equal(norm('money', '$150'), '150.00');
  assert.equal(norm('money', 0), '');
  assert.equal(runCheck(fee, { cleaning_fee: 150 }, { cleaningFee: 150.0 }).status, 'match');
  assert.equal(runCheck(fee, { cleaning_fee: '' }, { cleaningFee: 95 }).status, 'no-repository');
});

test('writePlan maps each side to the other, refuses an empty source', () => {
  const r = runCheck(wifi, { wifi_network: '4315WiFi', password_2: '5starstay' }, { wifiUsername: '4212wifi', wifiPassword: '5starstay' });
  assert.deepEqual(writePlan(wifi, r, 'hostaway'), { wifiUsername: '4315WiFi', wifiPassword: '5starstay' });
  assert.deepEqual(writePlan(wifi, r, 'repository'), { wifi_network: '4212wifi', password_2: '5starstay' });
  const f = runCheck(fee, {}, { cleaningFee: 95 });
  assert.deepEqual(writePlan(fee, f, 'repository'), { cleaning_fee: 95 });
  assert.equal(typeof writePlan(fee, f, 'hostaway'), 'string');
});

test('every check has a section, a unique key and unique columns', () => {
  const keys = new Set(SECTIONS.map(s => s.key));
  assert.ok(CHECKS.every(c => keys.has(c.section)));
  assert.equal(new Set(CHECKS.map(c => c.key)).size, CHECKS.length);
  const cols = CHECKS.flatMap(c => c.fields.map(f => f.repo));
  assert.equal(new Set(cols).size, cols.length);
  assert.ok(SYNCED_COLUMNS.has('wifi_network') && SYNCED_COLUMNS.has('rule_add_pet_fee'));
  assert.ok(CHECKS.filter(c => c.section === 'hostaway').every(c => !c.send));
});

test('hours: Hostaway 16 is "4 PM"; written back as 16', () => {
  assert.equal(norm('hour', '16'), '4 PM');
  assert.equal(norm('hour', '4:00 pm'), '4 PM');
  assert.equal(norm('hour', 0), '12 AM');
  assert.equal(norm('hour', '12 PM'), '12 PM');
  const d = check('checkin_from');
  const r = runCheck(d, { checkin_from: '3 PM' }, { checkInTimeStart: '16' });
  assert.equal(r.status, 'differ');
  assert.deepEqual(writePlan(d, r, 'repository'), { checkin_from: '4 PM' });
  assert.deepEqual(writePlan(d, r, 'hostaway'), { checkInTimeStart: 15 });
});

test('bool: "0" is a value (No), not empty; checkbox ↔ 1/0', () => {
  const d = check('hw_instant_book');
  const r = runCheck(d, {}, { instantBookable: '0' });
  assert.equal(r.status, 'no-repository');
  assert.deepEqual(writePlan(d, r, 'repository'), { hw_instant_book: false });
  assert.equal(runCheck(d, { hw_instant_book: false }, { instantBookable: 0 }).status, 'match');
  assert.equal(typeof writePlan(d, r, 'hostaway'), 'string', 'Hostaway settings are never sent');
});

test('long texts ignore line endings and trailing spaces; say where they part', () => {
  assert.equal(norm('longtext', 'a  \r\nb\r\n'), 'a\nb');
  assert.equal(firstDiffLine('a\nb\nc', 'a\nb\nd'), 3);
  assert.equal(firstDiffLine('a', 'a'), 0);
});

test('custom fees read from listingFeeSetting, the all-channels row', () => {
  const l = { listingFeeSetting: [{ feeType: 'insuranceFee', channelId: 2002, amount: 9 }, { feeType: 'insuranceFee', channelId: 0, amount: 12 }] };
  assert.equal(hostawayValue(l, 'fee:insuranceFee'), 12);
  assert.equal(hostawayValue({}, 'fee:insuranceFee'), '');
});

const RULES = 'House Rules:\n\n1. Sign the agreement.\n\n2. No parties.';

test('house rules = the original + the Adds, numbered on', () => {
  const vals = { house_rules: RULES, rule_add_pet_fee: 'Pet fee: $150 per pet.', rule_add_other: 'Quiet hours 10pm.' };
  assert.equal(composeRules(vals), `${RULES}\n\n3. Pet fee: $150 per pet.\n\n4. Quiet hours 10pm.`);
  assert.equal(composeRules({ house_rules: 'Be nice.', rule_add_pet_fee: 'Pets $50.' }), 'Be nice.\n\nPets $50.');
  assert.equal(composeRules({ rule_add_pet_fee: 'Pets $50.' }), 'Pets $50.');
});

test('copying Hostaway\'s rules back keeps the Adds out of the original', () => {
  const vals = { house_rules: 'old', rule_add_pet_fee: 'Pet fee: $150 per pet.', rule_add_other: 'Quiet hours 10pm.' };
  const hostaway = `${RULES}\n\n3. Pet fee: $150 per pet.\n\n4. Quiet hours 10pm.`;
  assert.equal(splitRules(hostaway, vals), RULES);
  assert.equal(splitRules(RULES, vals), RULES, 'Adds not in Hostaway yet: the whole text is the original');
  const d = check('house_rules');
  const r = runCheck(d, vals, { houseRules: hostaway });
  assert.deepEqual(writePlan(d, r, 'repository', vals), { house_rules: RULES });
  const sent = writePlan(d, runCheck(d, { ...vals, house_rules: RULES }, { houseRules: RULES }), 'hostaway');
  assert.deepEqual(sent, { houseRules: hostaway });
});

test('draftAdds words the empty Adds from the record\'s own fees', () => {
  const d = draftAdds({ pet_fee: 150, fob_replacement_fee: '75', extra_guest_fee: 25, guests_included: 8, max_guests: 10, rule_add_lost_fob: 'Kept.' });
  assert.match(d.rule_add_pet_fee!, /\$150 per pet/);
  assert.equal(d.rule_add_lost_fob, undefined, 'never overwrites');
  assert.match(d.rule_add_extra_guest!, /includes 8 guests; each additional guest is \$25 per night \(maximum 10 guests\)/);
  assert.deepEqual(draftAdds({}), {});
  assert.equal(draftAdds({ pet_fee: 150, house_rules: '4. Pets must be disclosed.' }).rule_add_pet_fee, undefined, 'the original already covers pets');
});
