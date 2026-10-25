import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebAuth } from '../web-auth.mjs';

const secret = 'a test secret that is long enough';

test('issues and verifies a signed session only for the configured password', () => {
  let now = 1_000;
  const auth = createWebAuth({ password: 'open-sesame', sessionSecret: secret, now: () => now, randomBytes: () => Buffer.alloc(16, 7) });

  assert.equal(auth.login('wrong'), null);
  const session = auth.login('open-sesame');
  assert.match(session.cookie, /Max-Age=2592000/);
  assert.match(session.cookie, /HttpOnly/);
  assert.match(session.cookie, /SameSite=Strict/);
  assert.doesNotMatch(session.cookie, /Secure/);
  assert.ok(auth.verifySession(session.cookie));
  assert.ok(auth.verifyCsrf(session.csrf, session.csrf));
  assert.equal(auth.verifyCsrf(session.csrf, 'wrong'), false);
  assert.equal(auth.verifySession(session.cookie.replace('borton_session=', 'borton_session=x')), null);

  now += 30 * 24 * 60 * 60 * 1000 + 1;
  assert.equal(auth.verifySession(session.cookie), null);
});

test('adds Secure only when configured', () => {
  const auth = createWebAuth({ password: 'open-sesame', sessionSecret: secret, secure: true });
  assert.match(auth.login('open-sesame').cookie, /; Secure/);
});

test('issues a trusted session without accepting a password', () => {
  const auth = createWebAuth({ password: 'open-sesame', sessionSecret: secret, randomBytes: () => Buffer.alloc(16, 9) });
  const session = auth.trustedLogin();
  assert.match(session.cookie, /Max-Age=2592000/);
  assert.ok(auth.verifySession(session.cookie));
});
