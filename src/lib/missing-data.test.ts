import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditUnit, worstFirst, countBy } from './missing-data.ts';
import type { RepoRow } from './unit-access.ts';

const full: Record<string, unknown> = {
  name: 'Napa Valley', property_type: 'House', contract: 'Lease', lock_type: 'Schlage Smart Lock', keys_fobs: 'None',
  cleaner_code: '1234', has_closet: true, closet_code: '99', insurance: 'Policy 1', internet_account: '287',
  manager_contact: 'Ann', parking: 'Driveway', house_manual: 'https://x', fob_replacement_fee: 50,
};
const rec = (vals: Record<string, unknown>, table = 'houses'): RepoRow => ({ id: 'HOU-1', table, vals });
const listing = { wifiUsername: 'NapaWifi', wifiPassword: 'x', address: '1 Main', checkInTimeStart: 16, checkInTimeEnd: 22, checkOutTime: 11,
  personCapacity: 6, name: 'Napa', description: 'Nice', houseRules: 'No parties', cleaningFee: 150, contactPhone1: '555',
  listingFeeSetting: [{ feeType: 'insuranceFee', amount: 5, channelId: null }] };
const keys = (u: ReturnType<typeof auditUnit>) => u.gaps.map(g => g.key);

test('a complete unit has only the paperwork its record skips', () => {
  const r = rec(full);
  const u = auditUnit('1', 'Napa Valley', { rec: r, records: [r], stored: new Set(['admin_code', 'backup_code', 'lease']), listing });
  // Every Hostaway field is filled and none is in the record yet: one low "not copied".
  assert.deepEqual(keys(u), ['copy']);
  assert.equal(u.gaps[0]!.severity, 'low');
});

test('no record is critical and Hostaway is still audited', () => {
  const u = auditUnit('1', 'P2-9999', { rec: null, records: [], stored: new Set(), listing: { ...listing, wifiUsername: '' } });
  assert.deepEqual(keys(u).slice(0, 2), ['record', 'hw:wifi']);
  assert.equal(u.gaps[1]!.label, 'Wi-Fi: Network');
  assert.equal(u.gaps[1]!.fix, 'Fill it in Hostaway.');
});

test('access follows the lock type: smart needs a code, fob a lockbox', () => {
  const smart = rec({ ...full, cleaner_code: '' });
  assert.equal(auditUnit('1', 'x', { rec: smart, records: [smart], stored: new Set(), listing: null }).gaps[0]!.label, 'Cleaner code');
  const fob = rec({ ...full, lock_type: 'Access Fob', lockbox: '' }, 'the_links');
  assert.equal(auditUnit('1', 'x', { rec: fob, records: [fob], stored: new Set(), listing: null }).gaps[0]!.label, 'Lockbox');
});

test('insurance counts as a document; AT&T, POC and closet by kind of unit', () => {
  const r = rec({ ...full, insurance: '', internet_account: '', manager_contact: '', closet_code: '' });
  const u = auditUnit('1', 'x', { rec: r, records: [r], stored: new Set(['insurance']), listing: null });
  assert.ok(!keys(u).includes('insurance'));
  assert.ok(keys(u).includes('internet_account'));
  assert.ok(keys(u).includes('poc'));
  assert.ok(keys(u).includes('closet_code'));
  // An apartment's POC is its maintenance line; its closet needs no code.
  const apt = rec({ ...full, property_type: 'Apartment', manager_contact: '', closet_code: '', maintenance_portal: 'https://m' }, 'the_links');
  const a = auditUnit('2', 'y', { rec: apt, records: [apt], stored: new Set(), listing: null });
  assert.ok(!keys(a).includes('poc'));
  assert.ok(!keys(a).includes('closet_code'));
});

test('a Hostaway gap the record can fill says to send it', () => {
  const r = rec({ ...full, cleaning_fee: 150 });
  const u = auditUnit('1', 'x', { rec: r, records: [r], stored: new Set(), listing: { ...listing, cleaningFee: 0 } });
  const g = u.gaps.find(x => x.key === 'hw:cleaning_fee')!;
  assert.equal(g.severity, 'high');
  assert.match(g.fix!, /send it/);
});

test('worst first and counts', () => {
  const a = { unitId: 'a', unit: 'A', table: null, recordId: null, hostaway: true, gaps: [{ key: 'k', label: 'k', severity: 'low' as const, why: '', where: 'repository' as const }] };
  const b = { ...a, unitId: 'b', unit: 'B', gaps: [{ ...a.gaps[0]!, severity: 'critical' as const }] };
  assert.deepEqual(worstFirst([a, b]).map(u => u.unit), ['B', 'A']);
  assert.deepEqual(countBy([a, b]), { critical: 1, high: 0, medium: 0, low: 1 });
});
