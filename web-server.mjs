import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const JSON_LIMIT = 256 * 1024;
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', ...headers });
  res.end(JSON.stringify(body));
};
const readJson = (req) => new Promise((resolve, reject) => {
  let size = 0; let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { size += Buffer.byteLength(chunk); if (size > JSON_LIMIT) reject(new Error('Request is too large.')); else body += chunk; });
  req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON.')); } });
  req.on('error', reject);
});
const readMultipartImage = (req, maxBytes) => new Promise((resolve, reject) => {
  const type = req.headers['content-type'] || ''; const boundary = type.match(/boundary=([^;]+)/i)?.[1];
  if (!boundary) return reject(new Error('Expected an image upload.'));
  const chunks = []; let size = 0;
  req.on('data', (chunk) => { size += chunk.length; if (size > maxBytes + 64 * 1024) reject(new Error('Receipt image exceeds the 10 MB limit.')); else chunks.push(chunk); });
  req.on('end', () => {
    const body = Buffer.concat(chunks); const marker = Buffer.from(`--${boundary}`); const start = body.indexOf(Buffer.from('\r\n\r\n')) + 4;
    const end = body.indexOf(marker, start) - 2; const header = body.subarray(0, start).toString('utf8');
    const mime = header.match(/Content-Type:\s*([^\r\n;]+)/i)?.[1]?.toLowerCase();
    if (start < 4 || end <= start || !mime) return reject(new Error('Upload must include one image.'));
    resolve({ buffer: body.subarray(start, end), mime });
  });
  req.on('error', reject);
});
const allowed = (remote, rule) => {
  if (typeof rule === 'function') return rule(remote);
  const address = remote?.replace(/^::ffff:/, '');
  return (rule || []).some((entry) => {
    if (entry === address) return true;
    const [network, bits] = String(entry).split('/');
    if (!bits || !/^\d+\.\d+\.\d+\.\d+$/.test(address || '') || !/^\d+\.\d+\.\d+\.\d+$/.test(network)) return false;
    const mask = Number(bits); if (mask < 0 || mask > 32) return false;
    const asNumber = (ip) => ip.split('.').reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
    const keep = mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0;
    return (asNumber(address) & keep) === (asNumber(network) & keep);
  });
};
const safeStaticPath = (pathname) => pathname === '/' ? 'index.html' : pathname.startsWith('/') && !pathname.includes('..') ? pathname.slice(1) : null;

export function createWebServer({ auth, app = {}, staticDir, allowedRemote = [], trustedRemotes = [], maxUploadBytes = 10 * 1024 * 1024 } = {}) {
  if (!auth || !staticDir) throw new Error('auth and staticDir are required.');
  const dispatch = {
    'GET /api/bootstrap': 'bootstrap',
    'GET /api/transactions': 'transactions',
    'GET /api/summary': 'summary',
    'POST /api/duplicates': 'duplicates',
    'POST /api/extract': 'extract',
    'POST /api/batches/validate': 'validateBatch',
    'POST /api/batches/submit': 'submitBatch',
    'POST /api/assistant/message': 'assistantMessage',
    'POST /api/assistant/confirm': 'assistantConfirm',
    'POST /api/assistant/cancel': 'assistantCancel',
  };
  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress || '';
    if (!allowed(remote, allowedRemote)) return json(res, 403, { error: 'Private network access required.' });
    const url = new URL(req.url, 'http://borton.local');
    if (req.method === 'GET' && url.pathname === '/api/session') {
      if (!allowed(remote, trustedRemotes)) return json(res, 401, { error: 'Password required.' });
      const login = auth.trustedLogin();
      return json(res, 200, { csrf: login.csrf }, { 'Set-Cookie': login.cookie });
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      try {
        const body = await readJson(req); const login = auth.login(body.password || '');
        return login ? json(res, 200, { csrf: login.csrf }, { 'Set-Cookie': login.cookie }) : json(res, 401, { error: 'Invalid password.' });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (url.pathname.startsWith('/api/')) {
      const session = auth.verifySession(req.headers.cookie);
      if (!session) return json(res, 401, { error: 'Sign in required.' });
      try {
        const payload = req.method === 'POST' && url.pathname === '/api/extract' ? await readMultipartImage(req, maxUploadBytes) : req.method === 'POST' ? await readJson(req) : Object.fromEntries(url.searchParams);
        if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: 'Cross-origin request rejected.' });
        if (req.method === 'POST' && !auth.verifyCsrf(auth.issueCsrf(session), req.headers['x-csrf-token'])) return json(res, 403, { error: 'Invalid CSRF token.' });
        const handler = dispatch[`${req.method} ${url.pathname}`];
        if (!handler || typeof app[handler] !== 'function') return json(res, 404, { error: 'Not found.' });
        return json(res, 200, await app[handler](payload, session));
      } catch (error) { return json(res, error.statusCode || 400, { error: error.message || 'Request failed.' }); }
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
    const relative = safeStaticPath(url.pathname);
    if (!relative || !contentTypes[path.extname(relative)]) return json(res, 404, { error: 'Not found.' });
    try {
      const file = await fs.readFile(path.join(staticDir, relative));
      res.writeHead(200, { 'Content-Type': contentTypes[path.extname(relative)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'" });
      res.end(file);
    } catch { json(res, 404, { error: 'Not found.' }); }
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.shutdown = (callback) => {
    for (const socket of sockets) socket.destroy();
    return server.close(callback);
  };
  return server;
}
