import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseHost, cleanCaseUrl } from './claims.ts';

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
