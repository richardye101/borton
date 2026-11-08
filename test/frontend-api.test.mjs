import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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

test('shows an action-oriented empty state for Reviews instead of an empty table', async () => {
  const app = await fs.readFile(new URL('../frontend/src/App.svelte', import.meta.url), 'utf8');
  const css = await fs.readFile(new URL('../frontend/src/app.css', import.meta.url), 'utf8');
  assert.match(app, /filteredReviews\(\)\.length/);
  assert.match(app, /All caught up/);
  assert.match(app, /show\('connections'\)/);
  assert.match(app, /on:change=\{uploadReviewReceipts\}/);
  assert.match(css, /\.reviews-empty-state\{[^}]*grid-column:2/);
});

test('lets the completed Reviews view audit and display verified historical imports', async () => {
  const app = await fs.readFile(new URL('../frontend/src/App.svelte', import.meta.url), 'utf8');
  assert.match(app, /auditHistoricalReviews/);
  assert.match(app, /\/api\/reviews\/audit-history/);
  assert.match(app, /Review past imports/);
  assert.match(app, /Already imported/);
});
