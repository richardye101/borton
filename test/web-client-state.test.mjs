import assert from 'node:assert/strict';
import test from 'node:test';
import { createSummaryCache } from '../frontend/src/lib/client-state.js';
import { pathForRoute, routeFromPath } from '../frontend/src/lib/router.js';

test('reuses cached summaries until refresh or an expense write clears them', () => {
  const cache = createSummaryCache();
  cache.set('90', { totalCents: 1200 });
  assert.deepEqual(cache.get('90'), { totalCents: 1200 });
  assert.equal(cache.get('all'), undefined);
  cache.clear();
  assert.equal(cache.get('90'), undefined);
});

test('maps page and transaction URLs to stable client routes', () => {
  assert.deepEqual(routeFromPath('/summary'), { view: 'summary', transactionId: '' });
  assert.deepEqual(routeFromPath('/home/transactions/txn-42'), { view: 'home', transactionId: 'txn-42' });
  assert.equal(pathForRoute('home', 'txn-42'), '/home/transactions/txn-42');
  assert.equal(pathForRoute('shared'), '/shared');
  assert.equal(pathForRoute('unknown'), '/home');
});
