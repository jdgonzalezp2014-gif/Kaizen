import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessHost, identify } from './auth.ts';

const req = (url: string, email?: string) => new Request(url, { headers: email ? { 'Cf-Access-Authenticated-User-Email': email } : {} });

test('identity is read only on hosts Access guards', () => {
  assert.equal(identify(req('https://kaizen-01v.pages.dev/api/roles', 'a@b.co'), {})?.email, 'a@b.co');
  assert.equal(identify(req('https://abc123.kaizen-01v.pages.dev/api/roles', 'a@b.co'), {})?.email, 'a@b.co');
  // The guest portal's own domain has no Access in front: a typed header is not an identity.
  assert.equal(identify(req('https://stay.kaizenguestproperties.com/api/roles', 'a@b.co'), {}), null);
  assert.equal(identify(req('https://pages.dev.evil.com/api/roles', 'a@b.co'), {}), null);
  assert.equal(identify(req('https://kaizen-01v.pages.dev/api/roles'), {}), null);
});

test('a public host never gets the local-dev identity either', () => {
  assert.equal(identify(req('https://stay.kaizenguestproperties.com/api/roles'), { ALLOW_UNAUTHENTICATED: 'true' }), null);
  assert.equal(identify(req('http://localhost:8799/api/roles'), { ALLOW_UNAUTHENTICATED: 'true' })?.local, true);
});

test('ACCESS_HOSTS names the custom domains that are behind Access', () => {
  assert.equal(accessHost('app.example.com', {}), false);
  assert.equal(accessHost('App.Example.com', { ACCESS_HOSTS: 'x.com, app.example.com' }), true);
  assert.equal(identify(req('https://app.example.com/api/roles', 'a@b.co'), { ACCESS_HOSTS: 'app.example.com' })?.email, 'a@b.co');
});
