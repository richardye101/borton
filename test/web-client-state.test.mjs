import assert from 'node:assert/strict';
import test from 'node:test';
import { createSummaryCache } from '../web/client-state.mjs';

test('reuses cached summaries until refresh or an expense write clears them', () => {
  const cache = createSummaryCache();
  cache.set('90', { totalCents: 1200 });
  assert.deepEqual(cache.get('90'), { totalCents: 1200 });
  assert.equal(cache.get('all'), undefined);
  cache.clear();
  assert.equal(cache.get('90'), undefined);
});
