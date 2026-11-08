import assert from 'node:assert/strict';
import test from 'node:test';
import { createCategorySuggestionQueue } from '../category-suggestion-queue.mjs';

test('stores an allowed AI category suggestion on a staged import', async () => {
  let time = 1000;
  const row = { id: 'plaid:one', source: 'plaid', merchant: 'Corner Coffee', date: '2026-11-08', amountCents: -450, account: 'Visa', institution: 'Bank', suggestion: { status: 'queued', attempts: 0, nextAt: time, lastError: '' } };
  const inbox = {
    list: () => [row],
    startSuggestion: () => { row.suggestion = { ...row.suggestion, status: 'processing', attempts: row.suggestion.attempts + 1 }; },
    completeSuggestion: (id, suggestion) => { assert.equal(id, row.id); row.suggestion = { ...suggestion, status: 'ready', attempts: row.suggestion.attempts, nextAt: null, lastError: '' }; },
    retrySuggestion: assert.fail,
    failSuggestion: assert.fail,
  };
  const queue = createCategorySuggestionQueue({ inbox, categories: async () => [{ id: 'coffee', name: 'Coffee' }], suggest: async () => ({ category: 'Coffee', confidence: 'high', reason: 'Merchant is a coffee shop.' }), now: () => time, minIntervalMs: 0, autoStart: false });
  await queue.run();
  assert.deepEqual(row.suggestion, { status: 'ready', categoryId: 'coffee', category: 'Coffee', confidence: 'high', reason: 'Merchant is a coffee shop.', attempts: 1, nextAt: null, lastError: '' });
});

test('retries a rate-limited category suggestion without dropping the import', async () => {
  let time = 1000;
  const row = { id: 'plaid:one', source: 'plaid', suggestion: { status: 'queued', attempts: 0, nextAt: time, lastError: '' } };
  const inbox = {
    list: () => [row],
    startSuggestion: () => { row.suggestion = { ...row.suggestion, status: 'processing', attempts: row.suggestion.attempts + 1 }; },
    completeSuggestion: assert.fail,
    failSuggestion: assert.fail,
    retrySuggestion: (id, error, nextAt) => { assert.equal(id, row.id); row.suggestion = { ...row.suggestion, status: 'retrying', lastError: error, nextAt }; },
  };
  const queue = createCategorySuggestionQueue({ inbox, categories: async () => [], suggest: async () => { throw Error('HTTP 429'); }, now: () => time, minIntervalMs: 0, autoStart: false });
  await queue.run();
  assert.equal(row.suggestion.status, 'retrying');
  assert.equal(row.suggestion.attempts, 1);
  assert.equal(row.suggestion.nextAt, 61_000);
});
