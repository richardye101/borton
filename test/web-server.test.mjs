import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWebAuth } from '../web-auth.mjs';
import { createWebServer } from '../web-server.mjs';

async function request(port, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: options.path || '/', method: options.method || 'GET', headers: options.headers }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject); if (options.body) req.write(options.body); req.end();
  });
}

async function withServer(options, run) {
  const server = createWebServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(server.address().port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('rejects untrusted remotes before login or financial data', async () => {
  const auth = createWebAuth({ password: 'password', sessionSecret: 'secret secret secret secret' });
  await withServer({ auth, app: {}, staticDir: os.tmpdir(), allowedRemote: ['10.0.0.1'] }, async (port) => {
    const response = await request(port, { path: '/login' });
    assert.equal(response.status, 403);
    assert.equal(response.headers['set-cookie'], undefined);
  });
});

test('serves static assets and guards API routes with login, session and CSRF', async () => {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-web-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<main>Borton</main>');
  const auth = createWebAuth({ password: 'password', sessionSecret: 'secret secret secret secret' });
  const app = { bootstrap: async () => ({ transactions: [] }) };
  await withServer({ auth, app, staticDir, allowedRemote: ['127.0.0.1'] }, async (port) => {
    const page = await request(port);
    assert.equal(page.status, 200);
    assert.match(page.body, /Borton/);
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal((await request(port, { path: '/api/bootstrap' })).status, 401);

    const login = await request(port, { method: 'POST', path: '/login', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const csrf = JSON.parse(login.body).csrf;
    const bootstrap = await request(port, { path: '/api/bootstrap', headers: { cookie } });
    assert.equal(bootstrap.status, 200);
    assert.deepEqual(JSON.parse(bootstrap.body), { transactions: [] });
    assert.equal((await request(port, { method: 'POST', path: '/api/duplicates', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal(bootstrap.headers['cache-control'], 'no-store');
  });
});
