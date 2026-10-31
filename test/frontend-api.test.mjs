import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from '../frontend/src/lib/api.js';

test('reports an empty API response without exposing a JSON parse error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 502, statusText: 'Bad Gateway' });
  try {
    await assert.rejects(() => request('/api/transcribe', { method: 'POST' }), /empty response/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
