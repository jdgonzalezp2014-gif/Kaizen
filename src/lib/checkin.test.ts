import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePin, cleanSteps, cleanHouse, googleDir, appleDir, fillTokens } from './checkin.ts';

test('parsePin: pasted numbers and long map links; short links and junk refused', () => {
  assert.deepEqual(parsePin('33.1507, -96.8236'), { lat: 33.1507, lng: -96.8236 });
  assert.deepEqual(parsePin('(33.1507,-96.8236)'), { lat: 33.1507, lng: -96.8236 });
  // A place link: the place's own point beats the map centre.
  assert.deepEqual(parsePin('https://www.google.com/maps/place/X/@33.10,-96.80,17z/data=!3m1!4b1!4m6!3m5!8m2!3d33.1512!4d-96.8241'), { lat: 33.1512, lng: -96.8241 });
  assert.deepEqual(parsePin('https://www.google.com/maps/@33.1,-96.8,18z'), { lat: 33.1, lng: -96.8 });
  assert.deepEqual(parsePin('https://maps.apple.com/?ll=33.2,-96.7&q=Pin'), { lat: 33.2, lng: -96.7 });
  assert.deepEqual(parsePin('https://www.google.com/maps/search/?api=1&query=33.3%2C-96.6'), { lat: 33.3, lng: -96.6 });
  assert.deepEqual(parsePin('https://www.google.com/maps/search/33.206305,+-96.825887?entry=tts'), { lat: 33.206305, lng: -96.825887 });
  assert.equal(parsePin('https://maps.app.goo.gl/abc123'), null);
  assert.equal(parsePin('123 Main St'), null);
  assert.equal(parsePin('95, 10'), null);
  assert.equal(googleDir({ lat: 1.5, lng: 2 }), 'https://www.google.com/maps/dir/?api=1&destination=1.5,2');
  assert.equal(appleDir({ lat: 1.5, lng: 2 }), 'https://maps.apple.com/?daddr=1.5,2');
});

test('cleanSteps: trims, drops empty steps, needs a title, checks the pin', () => {
  const r = cleanSteps([{ title: ' Key fob ', text: ' Lockbox by the office ', pin: { lat: 33.1, lng: -96.8 } }, { title: '', text: '' }, { title: 'Door', text: '' }]);
  assert.deepEqual(r, { ok: true, steps: [{ title: 'Key fob', text: 'Lockbox by the office', pin: { lat: 33.1, lng: -96.8 }, link: null, photos: [] }, { title: 'Door', text: '', pin: null, link: null, photos: [] }] });
  assert.equal(cleanSteps([{ title: 'a', link: 'http://x' }]).ok, false);
  assert.deepEqual(cleanSteps([{ title: 'a', link: ' https://drive.google.com/file/d/x/view ' }]), { ok: true, steps: [{ title: 'a', text: '', pin: null, link: 'https://drive.google.com/file/d/x/view', photos: [] }] });
  assert.deepEqual(cleanSteps([{ title: 'a', photos: ['1AbCdEfGhIjK', '1AbCdEfGhIjK'] }]).ok && 1, 1);
  assert.equal(cleanSteps([{ title: 'a', photos: ['../x'] }]).ok, false);
  assert.equal(cleanSteps([{ title: 'a', photos: ['1AbCdEfGhIj1', '1AbCdEfGhIj2', '1AbCdEfGhIj3', '1AbCdEfGhIj4'] }]).ok, false);
  assert.equal(cleanSteps([{ title: '', text: 'x' }]).ok, false);
  assert.equal(cleanSteps([{ title: 'a', pin: { lat: 200, lng: 0 } }]).ok, false);
  assert.equal(cleanSteps(Array.from({ length: 9 }, () => ({ title: 'a' }))).ok, false);
  assert.equal(cleanSteps('x').ok, false);
});

test('fillTokens: quotes the record, leaves unknown or empty tokens visible', () => {
  assert.equal(fillTokens('Code {lockbox}.', { lockbox: '1250' }), 'Code 1250.');
  assert.equal(fillTokens('Code {lockbox}.', { lockbox: '' }), 'Code {lockbox}.');
  assert.equal(fillTokens('{cleaner_code}', { cleaner_code: '9' }), '{cleaner_code}');
});

test('cleanHouse: title needed, empties dropped, missing = none', () => {
  assert.deepEqual(cleanHouse([{ title: ' Trash ', text: ' Sun–Thu valet ' }, { title: '', text: '' }]), { ok: true, house: [{ title: 'Trash', text: 'Sun–Thu valet' }] });
  assert.deepEqual(cleanHouse(undefined), { ok: true, house: [] });
  assert.equal(cleanHouse([{ text: 'x' }]).ok, false);
});
