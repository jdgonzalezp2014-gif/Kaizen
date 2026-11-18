import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiPrompt, appliesTo, awaitingReply, scopeWords, threadTabs, tabOf, waits, dueAt, fill, guestAiFrom, guideFacts, hostawayIso, isPortalUrl, maskPhone, matchesFilter, mergeThread, planFor,
  portalLink, stageOf, stayWindow, suggestionFromAi, varsFor, whenWords, zonedInstant, type InboxRow, type Stay, type Template, type ThreadMsg, bookingLinks, condWords, condsOf, paidOf, signedOf } from './inbox.ts';

const stay: Stay = { reservationId: '71', listingId: '9', listing: 'P2-1406', guest: 'Ana Ruiz', arrival: '2026-11-20', departure: '2026-11-23', status: 'new', bookedAt: '2026-11-10T15:00:00Z' };
const tpl = (o: Partial<Template>): Template => ({ id: 't1', name: 'Welcome', body: 'Hi {{first_name}}', channel: 'hostaway', trigger: 'before_checkin', offsetHours: 24, active: true, listingIds: null, conditions: [], holdHours: null, ...o });
const msg = (o: Partial<ThreadMsg>): ThreadMsg => ({ id: 'm', at: '2026-11-16T10:00:00Z', incoming: true, body: 'hi', channel: 'hostaway', status: 'received', ...o });

test('a stay moves through its stages by the day', () => {
  assert.equal(stageOf(stay, '2026-11-18'), 'upcoming');
  assert.equal(stageOf(stay, '2026-11-20'), 'arriving');
  assert.equal(stageOf(stay, '2026-11-21'), 'staying');
  assert.equal(stageOf(stay, '2026-11-23'), 'leaving');
  assert.equal(stageOf(stay, '2026-11-24'), 'past');
  assert.equal(stageOf({ ...stay, status: 'cancelled' }, '2026-11-21'), 'cancelled');
  assert.equal(stageOf({ ...stay, status: 'inquiryPreapproved' }, '2026-11-21'), 'inquiry');
});

test('the list filters by what the stay is today', () => {
  const row = { ...stay, conversationId: 'c', photo: null, channel: 'airbnb', guests: 2, unread: true, lastAt: null, lastIncoming: true, preview: '', tasks: 0, scheduled: 0 } as InboxRow;
  assert.ok(matchesFilter(row, 'now', '2026-11-21'));
  assert.ok(!matchesFilter(row, 'now', '2026-11-18'));
  assert.ok(matchesFilter(row, 'upcoming', '2026-11-18'));
  assert.ok(matchesFilter(row, 'unread', '2026-11-18'));
  assert.ok(matchesFilter(row, 'past', '2026-12-01'));
});

test('Hostaway dates are UTC; a phone shows only its last four', () => {
  assert.equal(hostawayIso('2026-11-16 23:14:52'), '2026-11-16T23:14:52Z');
  assert.equal(hostawayIso('soon'), null);
  assert.equal(maskPhone('+1 (469) 555-0142'), '••• 0142');
  assert.equal(maskPhone('12'), null);
});

test('a template is filled, and a variable with no value is named — never sent blank', () => {
  const v = varsFor(stay, null);
  assert.deepEqual(fill('Hi {{first_name}}, see you {{checkin}} at {{ checkin_time }} for {{nights}} nights.', v),
    { text: 'Hi Ana, see you Friday, November 20 at 4 PM for 3 nights.', missing: [] });
  assert.deepEqual(fill('Check in here: {{portal_link}}', v).missing, ['portal_link']);
  assert.equal(fill('{{portal_link}}', varsFor(stay, 'https://stay.example.com/guest/71.abc')).text, 'https://stay.example.com/guest/71.abc');
});

test('a wall-clock hour in the listing\'s zone becomes the right instant, across daylight saving', () => {
  assert.equal(zonedInstant('2026-11-20', 16, 'America/Chicago').toISOString(), '2026-11-20T22:00:00.000Z'); // CST, UTC-6
  assert.equal(zonedInstant('2026-07-04', 16, 'America/Chicago').toISOString(), '2026-07-04T21:00:00.000Z'); // CDT, UTC-5
});

test('when a template goes: offsets around check-in, check-out and the booking', () => {
  const tz = 'America/Chicago';
  assert.equal(dueAt(tpl({}), stay, tz)!.toISOString(), '2026-11-19T22:00:00.000Z');
  assert.equal(dueAt(tpl({ trigger: 'after_checkin', offsetHours: 2 }), stay, tz)!.toISOString(), '2026-11-21T00:00:00.000Z');
  assert.equal(dueAt(tpl({ trigger: 'before_checkout', offsetHours: 0 }), stay, tz)!.toISOString(), '2026-11-23T17:00:00.000Z');
  assert.equal(dueAt(tpl({ trigger: 'booked', offsetHours: 1 }), stay, tz)!.toISOString(), '2026-11-10T16:00:00.000Z');
  assert.equal(dueAt(tpl({ trigger: 'manual' }), stay, tz), null);
  assert.equal(whenWords(tpl({})), '1 day before check-in');
  assert.equal(whenWords(tpl({ trigger: 'after_checkout', offsetHours: 3 })), '3 hours after check-out');
  assert.equal(whenWords(tpl({ trigger: 'booked', offsetHours: 0 })), 'At booking');
});

test('the plan of a stay: planned, due inside the grace, missed after it, and never twice', () => {
  const tz = 'America/Chicago', t = [tpl({}), tpl({ id: 't2', name: 'Off', active: false }), tpl({ id: 't3', trigger: 'manual' })];
  const at = (iso: string) => planFor(stay, t, [], new Date(iso), tz).map(p => p.state);
  assert.deepEqual(at('2026-11-19T10:00:00Z'), ['planned']);
  assert.deepEqual(at('2026-11-19T23:00:00Z'), ['due']);
  assert.deepEqual(at('2026-11-20T09:00:00Z'), ['missed']);
  assert.deepEqual(planFor(stay, t, [{ templateId: 't1', status: 'staged' }], new Date('2026-11-19T23:00:00Z'), tz).map(p => p.state), ['staged']);
  assert.deepEqual(planFor({ ...stay, status: 'cancelled' }, t, [], new Date('2026-11-19T23:00:00Z'), tz), []);
  assert.deepEqual(stayWindow([tpl({ offsetHours: 72 })], '2026-11-16'), { from: '2026-11-12', to: '2026-11-20' });
});

test('one timeline: the channel\'s copy of a sent message wins, staged and scheduled rows stay', () => {
  const channel = [msg({ id: 'a' }), msg({ id: 'b', incoming: false, body: 'Hello  Ana', status: 'sent', at: '2026-11-16T10:05:00Z' })];
  const ours = [msg({ id: 'o1', incoming: false, body: 'Hello Ana', status: 'sent', ours: true, at: '2026-11-16T10:05:01Z' }),
    msg({ id: 'o2', incoming: false, body: 'Later', status: 'scheduled', ours: true, at: '2026-11-17T10:00:00Z' }),
    msg({ id: 'o3', incoming: false, body: 'Gone', status: 'cancelled', ours: true, at: '2026-11-16T11:00:00Z' })];
  assert.deepEqual(mergeThread(channel, ours).map(m => m.id), ['a', 'b', 'o2']);
  assert.ok(awaitingReply([msg({})]));
  assert.ok(!awaitingReply(channel));
});

test('the AI settings are made whole; "auto" does not exist yet', () => {
  assert.deepEqual(guestAiFrom(null), { mode: 'off', provider: 'claude', model: 'claude-opus-5-5', instructions: '' });
  assert.deepEqual(guestAiFrom({ mode: 'auto', provider: 'gemini', model: 'bad model!', instructions: ' be kind ' }),
    { mode: 'suggest', provider: 'gemini', model: 'gemini-3.6-flash', instructions: 'be kind' });
});

test('the prompt carries the facts, the SOPs and the conversation — and no code is asked for', () => {
  const facts = guideFacts({ address: '1 Main St', wifi: { network: 'Kaizen', password: 'pw' }, checkIn: '4 PM', checkOut: '11 AM', parking: null, access: null, manual: null, rules: 'No parties', phone: null },
    { unitName: 'P2-1406', notOffered: ['pet'] });
  assert.match(facts, /Wi-Fi: network "Kaizen", password "pw"/);
  assert.match(facts, /Not offered here: pet/);
  const p = aiPrompt({ stay, today: '2026-11-21', facts, sops: [{ id: '1', title: 'Late check-out', steps: [{ text: 'Check the board' }] }],
    thread: [msg({ body: 'Can I leave at 1pm?' }), msg({ status: 'staged', incoming: false, body: 'not sent' })], instructions: 'Sign as Kaizen', company: 'Kaizen' });
  assert.match(p.system, /Never write a door code/);
  assert.match(p.system, /Sign as Kaizen/);
  assert.match(p.user, /\[Late check-out\]/);
  assert.match(p.user, /GUEST: Can I leave at 1pm\?/);
  assert.doesNotMatch(p.user, /not sent/);
});

test('a suggestion keeps its shape: empty is nothing, low confidence hands off', () => {
  assert.equal(suggestionFromAi({ reply: ' ' }), null);
  assert.deepEqual(suggestionFromAi({ reply: 'Sure', confidence: 'high', handoff: false, reason: '', sources: ['Wi-Fi', 3] }),
    { reply: 'Sure', confidence: 'high', handoff: false, reason: '', sources: ['Wi-Fi', '3'] });
  assert.equal(suggestionFromAi({ reply: 'Hm', confidence: 'what' })!.handoff, true);
});

test('the portal link is built from the account\'s address only', () => {
  assert.equal(portalLink('https://stay.example.com/', '71', 'abc'), 'https://stay.example.com/guest/71.abc');
  assert.equal(portalLink(null, '71', 'abc'), null);
  assert.equal(portalLink('http://x.com', '71', 'abc'), null);
  assert.ok(isPortalUrl('') && isPortalUrl('https://stay.example.com'));
  assert.ok(!isPortalUrl('javascript:alert(1)'));
});

test('an automation is for all listings or the chosen ones', () => {
  assert.ok(appliesTo(tpl({}), '9'));
  assert.ok(appliesTo(tpl({ listingIds: [] }), null));
  assert.ok(appliesTo(tpl({ listingIds: ['9', '4'] }), '9'));
  assert.ok(!appliesTo(tpl({ listingIds: ['4'] }), '9'));
  assert.ok(!appliesTo(tpl({ listingIds: ['4'] }), null));
  assert.equal(scopeWords(tpl({})), 'All listings');
  assert.equal(scopeWords(tpl({ listingIds: ['4'] })), '1 listing');
  const tz = 'America/Chicago', now = new Date('2026-11-19T23:00:00Z');
  assert.deepEqual(planFor(stay, [tpl({ listingIds: ['4'] })], [], now, tz), []);
  assert.deepEqual(planFor(stay, [tpl({ listingIds: ['9'] })], [], now, tz).map(p => p.state), ['due']);
});

test('after online check-in: waits for the guest, goes when done, and can be held until close to arrival', () => {
  const tz = 'America/Chicago', code = tpl({ id: 'c', trigger: 'checkin_done', offsetHours: 0 });
  // Check-in is 2026-11-20 16:00 CST = 22:00Z.
  assert.deepEqual(planFor(stay, [code], [], new Date('2026-11-12T10:00:00Z'), tz).map(p => [p.state, p.at]), [['waiting', null]]);
  const done = { ...stay, checkinDoneAt: '2026-11-12T10:00:00Z' };
  assert.equal(dueAt(code, done, tz)!.toISOString(), '2026-11-12T10:00:00.000Z');
  assert.deepEqual(planFor(done, [code], [], new Date('2026-11-12T10:01:00Z'), tz).map(p => p.state), ['due']);
  const held = { ...code, holdHours: 48 };
  assert.equal(dueAt(held, done, tz)!.toISOString(), '2026-11-18T22:00:00.000Z');
  assert.deepEqual(planFor(done, [held], [], new Date('2026-11-12T10:01:00Z'), tz).map(p => p.state), ['planned']);
  assert.deepEqual(planFor(done, [held], [], new Date('2026-11-18T22:05:00Z'), tz).map(p => p.state), ['due']);
  // Done inside the hold: it goes at once.
  assert.equal(dueAt(held, { ...stay, checkinDoneAt: '2026-11-20T15:00:00Z' }, tz)!.toISOString(), '2026-11-20T15:00:00.000Z');
  assert.equal(whenWords(code), 'When online check-in is done');
  assert.equal(whenWords(held), 'When online check-in is done, not before 2 days ahead of check-in');
  assert.equal(whenWords(tpl({ trigger: 'checkin_done', offsetHours: 2 })), '2 hours after online check-in');
  assert.deepEqual(stayWindow([held], '2026-11-16'), { from: '2026-11-13', to: '2026-11-19' });
});

test('a condition: a reminder is not needed once the check-in is done; "only if done" is judged at its moment', () => {
  const tz = 'America/Chicago', before = new Date('2026-11-19T10:00:00Z'), at = new Date('2026-11-19T23:00:00Z');
  const remind = tpl({ conditions: ['checkin_pending'] }), thanks = tpl({ conditions: ['checkin_done'] });
  assert.deepEqual(planFor(stay, [remind], [], at, tz).map(p => p.state), ['due']);
  assert.deepEqual(planFor({ ...stay, checkinDoneAt: '2026-11-18T10:00:00Z' }, [remind], [], before, tz).map(p => p.state), ['skipped']);
  assert.deepEqual(planFor(stay, [thanks], [], before, tz).map(p => p.state), ['planned']);
  assert.deepEqual(planFor(stay, [thanks], [], at, tz).map(p => p.state), ['skipped']);
  assert.deepEqual(planFor({ ...stay, checkinDoneAt: '2026-11-18T10:00:00Z' }, [thanks], [], at, tz).map(p => p.state), ['due']);
});

test('conditions: payment / agreement / ID, all must hold; unknown payment and no agreement count as done', () => {
  const tz = 'America/Chicago', before = new Date('2026-11-19T10:00:00Z'), at = new Date('2026-11-19T23:00:00Z');
  const payRemind = tpl({ conditions: ['payment_pending'] }), code = tpl({ conditions: ['checkin_done', 'payment_done'] });
  assert.deepEqual(planFor({ ...stay, paid: false }, [payRemind], [], at, tz).map(p => p.state), ['due']);
  assert.deepEqual(planFor({ ...stay, paid: true }, [payRemind], [], before, tz).map(p => p.state), ['skipped']);
  assert.deepEqual(planFor({ ...stay, paid: null }, [payRemind], [], at, tz).map(p => p.state), ['skipped']);
  assert.deepEqual(planFor({ ...stay, paid: false, checkinDoneAt: '2026-11-18T10:00:00Z' }, [code], [], at, tz).map(p => p.state), ['skipped']);
  assert.deepEqual(planFor({ ...stay, paid: true, checkinDoneAt: '2026-11-18T10:00:00Z' }, [code], [], at, tz).map(p => p.state), ['due']);
  assert.deepEqual(condsOf('payment_done,always,checkin_pending,checkin_done,x'), ['checkin_pending', 'payment_done']);
  assert.deepEqual(condsOf('always'), []);
  assert.equal(signedOf('not_signed'), false); assert.equal(signedOf(null), null); assert.equal(paidOf('Unknown'), null);
  assert.equal(condWords(['checkin_pending', 'payment_done']), 'Check-in not done · Paid');
});

test('booking links: Hostaway always, Airbnb by its HM code only', () => {
  assert.deepEqual(bookingLinks({ reservationId: '71', channel: 'airbnbOfficial', channelCode: 'HMYAFSWFWH' }),
    { hostaway: 'https://dashboard.hostaway.com/reservations/71', channel: { label: 'Airbnb', url: 'https://www.airbnb.com/hosting/reservations/details/HMYAFSWFWH' } });
  assert.equal(bookingLinks({ reservationId: '71', channel: 'bookingcom', channelCode: '123' }).channel, null);
  assert.equal(bookingLinks({ reservationId: '', channel: 'airbnb', channelCode: null }).hostaway, null);
});

test('house blanks are filled on the server; without a value the message is refused', () => {
  const v = varsFor(stay, null, undefined, { door_code: ' 4821 ', wifi_network: 'Kaizen' });
  assert.equal(fill('Code {{door_code}} · {{wifi_network}}', v).text, 'Code 4821 · Kaizen');
  assert.deepEqual(fill('{{door_code}} {{wifi_password}}', varsFor(stay, null)).missing, ['door_code', 'wifi_password']);
});

test('each way in and out of a conversation is a tab, only the ones that exist', () => {
  const m = (via: string | null, channel: 'hostaway' | 'sms' = 'hostaway') => ({ via, channel });
  assert.equal(tabOf(m('channel')), 'chat');
  assert.equal(tabOf(m('emailFormatted')), 'email');
  assert.equal(tabOf(m('sms')), 'sms');
  assert.equal(tabOf(m(null, 'sms')), 'sms');
  assert.deepEqual(threadTabs({ channel: 'airbnbOfficial', hasEmail: false }, []), ['all', 'chat', 'sms']);
  assert.deepEqual(threadTabs({ channel: 'direct', hasEmail: true }, []), ['all', 'email', 'sms']);
  assert.deepEqual(threadTabs({ channel: 'partner', hasEmail: false }, [m('channel'), m('email')]), ['all', 'chat', 'email', 'sms']);
});

test('"thanks" is not waiting for an answer', () => {
  assert.ok(waits({ lastIncoming: true }));
  assert.ok(!waits({ lastIncoming: true, noReply: true }));
  assert.ok(!waits({ lastIncoming: false }));
});
