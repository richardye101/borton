import { createHmac, randomBytes as systemRandomBytes, timingSafeEqual } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const encode = (value) => Buffer.from(value).toString('base64url');
const decode = (value) => Buffer.from(value, 'base64url').toString('utf8');
const cookies = (header = '') => Object.fromEntries(String(header).split(';').map((part) => part.trim().split(/=(.*)/s)).filter(([key]) => key));
const equal = (left, right) => {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};

export function createWebAuth({ password, sessionSecret, now = () => Date.now(), randomBytes = systemRandomBytes, secure = false, ttlMs = 30 * DAY_MS } = {}) {
  if (!password || !sessionSecret) throw new Error('Web password and session secret are required.');
  const sign = (value) => createHmac('sha256', sessionSecret).update(value).digest('base64url');
  const sessionCookie = (token) => `borton_session=${token}; Max-Age=${Math.floor(ttlMs / 1000)}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
  const verifySession = (header) => {
    const token = cookies(header).borton_session;
    if (!token) return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature || !equal(signature, sign(payload))) return null;
    try {
      const session = JSON.parse(decode(payload));
      return session.exp > now() && typeof session.id === 'string' ? session : null;
    } catch { return null; }
  };
  const issueSession = () => {
      const session = { id: randomBytes(16).toString('base64url'), exp: now() + ttlMs };
      const payload = encode(JSON.stringify(session));
      const token = `${payload}.${sign(payload)}`;
      return { cookie: sessionCookie(token), csrf: sign(`csrf:${session.id}`), session };
  };
  return {
    login(candidate) {
      if (!equal(candidate, password)) return null;
      return issueSession();
    },
    trustedLogin() { return issueSession(); },
    verifySession,
    issueCsrf(session) { return session?.id ? sign(`csrf:${session.id}`) : null; },
    verifyCsrf(expected, given) { return !!expected && !!given && equal(expected, given); },
    clearSession() { return `borton_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`; },
  };
}
