import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byChannel, byCategory, channelLabel } from './breakdown.ts';

const P = { from: '2026-09-01', to: '2026-09-30' };

test('channel spellings are grouped, not listed four times', () => {
  // Hostaway returns airbnbOfficial, Airbnb and homeaway for what a host
  // thinks of as two channels. Four spellings in a report is a
  // data-cleaning bug on display, not a finding.
  assert.equal(channelLabel('airbnbOfficial'), 'Airbnb');
  assert.equal(channelLabel('Airbnb'), 'Airbnb');
  assert.equal(channelLabel('bookingcom'), 'Booking.com');
  assert.equal(channelLabel('homeaway'), 'Vrbo / Expedia');
  // An iCal import is not a sales channel: those nights are owner holds
  // that earn nothing, and showing a $0 ADR beside Airbnb reads as a
  // pricing failure rather than a blocked calendar.
  assert.equal(channelLabel('customIcal'), 'Blocked (iCal)');
  assert.equal(channelLabel('bookingengine'), 'Direct');
  assert.equal(channelLabel('partner'), 'Partner');
  assert.equal(channelLabel(''), 'Unknown');
  assert.equal(channelLabel(undefined), 'Unknown');
});

test('channel revenue uses the same window arithmetic as the headline', () => {
  // A ten-night stay half inside the window contributes half its room
  // revenue, exactly as the portfolio total counts it. A breakdown whose
  // parts do not add to the number above it is worse than none.
  const res = [
    { listingId: 'a', arrival: '2026-08-28', departure: '2026-09-07',
      totalPaid: 1100, cleaningFee: 100, channel: 'airbnbOfficial' },
    { listingId: 'a', arrival: '2026-09-10', departure: '2026-09-15',
      totalPaid: 600, cleaningFee: 100, channel: 'direct' }
  ];
  const rows = byChannel(res, P);
  const airbnb = rows.find(r => r.channel === 'Airbnb')!;
  assert.equal(airbnb.nights, 6);              // Sep 1–6 inclusive
  assert.equal(Math.round(airbnb.revenue), 700); // 6 × $100 + $100 cleaning on the 7th
  assert.equal(rows.length, 2);
  assert.equal(Math.round(rows.reduce((a, r) => a + r.share * 100, 0)), 100);
});

test('shares sum to one hundred per cent', () => {
  const res = [
    { listingId: 'a', arrival: '2026-09-01', departure: '2026-09-03', totalPaid: 300, cleaningFee: 0, channel: 'Airbnb' },
    { listingId: 'a', arrival: '2026-09-05', departure: '2026-09-06', totalPaid: 100, cleaningFee: 0, channel: 'Direct' }
  ];
  const total = byChannel(res, P).reduce((a, r) => a + r.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('a shared cost is divided across units, not counted once per unit', () => {
  const costs = [{ listingId: '', shared: true, start: '2026-09-01', end: '',
                   category: 'Internet', frequency: 'Monthly', amount: 300, source: 'fixed' as const }];
  const lines = byCategory(costs, ['a', 'b', 'c'], P);
  const internet = lines.find(l => l.category === 'Internet')!;
  // One $300/month line, three units, September — the whole line, once.
  assert.ok(Math.abs(internet.total - 300 * 12 / 365 * 30) < 1);
  assert.equal(internet.variable, 0);
});
