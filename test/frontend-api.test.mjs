import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from '../frontend/src/lib/api.js';
import { pathForRoute, routeFromPath } from '../frontend/src/lib/router.js';

test('reports an empty API response without exposing a JSON parse error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 502, statusText: 'Bad Gateway' });
  try {
    await assert.rejects(() => request('/api/transcribe', { method: 'POST' }), /empty response/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('routes Connections as a first-class page', () => {
  assert.deepEqual(routeFromPath('/connections'), { view: 'connections', transactionId: '' });
  assert.equal(pathForRoute('connections'), '/connections');
});

test('routes Reviews as a first-class page', () => {
  assert.deepEqual(routeFromPath('/reviews'), { view: 'reviews', transactionId: '' });
  assert.equal(pathForRoute('reviews'), '/reviews');
});
