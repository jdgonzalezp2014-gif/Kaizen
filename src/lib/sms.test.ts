import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, segments, isGsm, gsmLength, toE164 } from './sms.ts';

test('one curly quote would triple the bill, so it is folded', () => {
  // "the unit's price" with U+2019 is not GSM-7, which drops the segment
  // size from 160 to 70 for the WHOLE message.
  const raw = 'the unit’s price';
  assert.equal(isGsm(raw), false);
  assert.equal(isGsm(sanitize(raw)), true);
  assert.equal(sanitize(raw), "the unit's price");
});

test('characters are folded, never silently deleted', () => {
  // Stripping an em dash runs two sentences together and changes what
  // the message says.
  assert.equal(sanitize('CL1339 — 0% booked … act'), 'CL1339 - 0% booked ... act');
  assert.equal(sanitize('rate → 165'), 'rate -> 165');
  assert.equal(sanitize('4.87★'), '4.87*');
});

test('emoji are matched as surrogate pairs, not as a broken range', () => {
  // A range like [ἰ0-ᾯF] parses as ἰ then "0-ᾯ" and
  // eats ordinary letters. This project shipped that bug once.
  assert.equal(sanitize('\u{1F6A8} CL1339 red'), 'CL1339 red');
  assert.equal(sanitize('Price 0 to 9 and A to Z'), 'Price 0 to 9 and A to Z');
});

test('GSM extension characters cost two places', () => {
  assert.equal(gsmLength('abc'), 3);
  assert.equal(gsmLength('a{b}'), 6);
});

test('a multi-part message loses room to its own header', () => {
  // 153 per part, not 160 — a count that ignores the header is right
  // until the message is one character over, which is when it matters.
  assert.equal(segments('a'.repeat(160)).count, 1);
  assert.equal(segments('a'.repeat(161)).count, 2);
  assert.equal(segments('a'.repeat(306)).count, 2);
  assert.equal(segments('a'.repeat(307)).count, 3);
});

test('a single non-GSM character switches the whole message to UCS-2', () => {
  // The cliff: 70 characters cost one segment either way, but at 71 the
  // UCS-2 message needs two while the GSM-7 one still has 89 spare.
  const ucs = segments('你' + 'a'.repeat(69));
  assert.equal(ucs.encoding, 'UCS-2');
  assert.equal(ucs.count, 1);

  assert.equal(segments('你' + 'a'.repeat(70)).count, 2);
  assert.equal(segments('a'.repeat(71)).count, 1);
});

test('an unparseable number is refused, not mangled', () => {
  // A mangled number produces a message that is never delivered and
  // never reported as undelivered.
  assert.equal(toE164('(214) 555-0147'), '+12145550147');
  assert.equal(toE164('+44 20 7946 0958'), '+442079460958');
  assert.equal(toE164('12145550147'), '+12145550147');
  assert.equal(toE164('123'), null);
  assert.equal(toE164(''), null);
});
