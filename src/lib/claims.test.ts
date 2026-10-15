import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseHost, cleanCaseUrl, closeDate } from './claims.ts';

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
