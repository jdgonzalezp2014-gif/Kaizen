import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseHost, caseResult, checkClaim, cleanCaseUrl, closeDate } from './claims.ts';

test('a case link is named by its platform', () => {
  assert.equal(caseHost('https://www.airbnb.com/mediation/hdp_host_entry?referenceId=CLSF-06548225'), 'Airbnb');
  assert.equal(caseHost('https://admin.booking.com/hotel/hoteladmin/extranet_ng/manage/booking.html'), 'Booking.com');
  assert.equal(caseHost('https://www.vrbo.com/traveler/th/claims'), 'Vrbo');
  assert.equal(caseHost('https://support.example.org/case/1'), 'support.example.org');
  assert.equal(caseHost('not a link'), null);
  assert.equal(caseHost(null), null);
});

test('only an https link is kept', () => {
  assert.equal(cleanCaseUrl('  https://www.airbnb.com/x  '), 'https://www.airbnb.com/x');
  assert.equal(cleanCaseUrl('http://airbnb.com'), null);
  assert.equal(cleanCaseUrl(''), null);
});

test('a closed case keeps the day it closed when it is edited (§167)', () => {
  const closed = { status: 'Resolved', resolved_on: '2026-09-30' };
  assert.equal(closeDate('Resolved', undefined, closed, '2026-10-15'), '2026-09-30');
  assert.equal(closeDate('Dismissed', null, closed, '2026-10-15'), '2026-09-30'); // closed → closed: still that day
  assert.equal(closeDate('Resolved', '2026-10-01', closed, '2026-10-15'), '2026-10-01'); // a date sent wins
  assert.equal(closeDate('Resolved', undefined, { status: 'Open', resolved_on: null }, '2026-10-15'), '2026-10-15');
  assert.equal(closeDate('Resolved', undefined, null, '2026-10-15'), '2026-10-15'); // a new case closed at once
  assert.equal(closeDate('Open', '2026-10-01', closed, '2026-10-15'), null); // reopened: no close day
  assert.equal(closeDate('Resolved', 'yesterday', { status: 'Open', resolved_on: null }, '2026-10-15'), '2026-10-15');
});

test('a case nets what Kaizen kept against what Kaizen spent, signed (§167)', () => {
  // paid less than asked, and less than the repair: a loss
  assert.deepEqual(caseResult({ requested: 150, received: 80, repairWork: 120, ownerWork: 0 }),
    { ownerShare: 0, kept: 80, spent: 120, result: -40, overRequested: -70 });
  // paid more than asked: a gain, and over the request
  assert.equal(caseResult({ requested: 100, received: 130, repairWork: 90, ownerWork: 0 }).result, 40);
  assert.equal(caseResult({ requested: 100, received: 130, repairWork: 90, ownerWork: 0 }).overRequested, 30);
  // an upsell: nothing spent, all kept
  assert.equal(caseResult({ requested: 60, received: 60, repairWork: 0, ownerWork: 0 }).result, 60);
  // nothing asked: no "over requested"
  assert.equal(caseResult({ requested: 0, received: 50, repairWork: 0, ownerWork: 0 }).overRequested, 0);
});

test('when the owner paid the repair, the reimbursement is theirs except the difference (owner, §167)', () => {
  // repair $100 charged to the owner, Airbnb pays $120: $100 to the owner, Kaizen keeps $20
  assert.deepEqual(caseResult({ requested: 150, received: 120, repairWork: 100, ownerWork: 100 }),
    { ownerShare: 100, kept: 20, spent: 0, result: 20, overRequested: -30 });
  // pays $80 of the owner's $100: all to the owner, Kaizen neither gains nor loses
  assert.equal(caseResult({ requested: 150, received: 80, repairWork: 100, ownerWork: 100 }).result, 0);
  assert.equal(caseResult({ requested: 150, received: 80, repairWork: 100, ownerWork: 100 }).ownerShare, 80);
  // $60 of $100 charged to the owner, $40 Kaizen's (purchases): $120 in → owner 60, Kaizen keeps 60, spent 40
  assert.equal(caseResult({ requested: 0, received: 120, repairWork: 100, ownerWork: 60 }).result, 20);
});

test('closed with money is Paid; Paid needs money (§167)', () => {
  assert.equal(checkClaim({ status: 'Open', category: 'Damage', received: 50 }), null); // partial, more to come
  assert.equal(checkClaim({ status: 'Paid', category: 'Damage', received: 50 }), null);
  assert.match(checkClaim({ status: 'Paid', category: 'Damage', received: 0 })!, /what was received/);
  assert.match(checkClaim({ status: 'Paid', category: 'Pet fee', received: 0 })!, /price charged/);
  assert.match(checkClaim({ status: 'Dismissed', category: 'Damage', received: 20 })!, /close it as Paid/);
  assert.match(checkClaim({ status: 'Resolved', category: null, received: 20 })!, /\$20\.00/);
  assert.equal(checkClaim({ status: 'Resolved', category: 'Damage', received: 0 }), null);
});
