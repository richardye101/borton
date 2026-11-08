import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebApplication } from '../web-app.mjs';

test('turns extracted receipts into editable rows with duplicate candidates', async () => {
  const actual = {
    async bootstrap() { return { accounts: [{ id: 'a1', name: 'Visa' }], categories: [{ id: 'c1', name: 'General' }], transactions: [] }; },
    async checkDuplicates() { return [{ id: 'existing', merchant: 'Coffee', amountCents: 500 }]; },
  };
  const extractor = { async extractImage() { return { receipts: [{ merchant: 'Coffee', date: '2026-10-24', total: 5, card_last4: '1234', line_items: ['Coffee'] }] }; } };
  const app = createWebApplication({ actual, extractor, cardmap: { byLast4: { 1234: 'Visa' } }, fallbackCategory: 'General' });
  const result = await app.extract({ buffer: Buffer.from('image'), mime: 'image/jpeg' });
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], { clientId: result.rows[0].clientId, merchant: 'Coffee', amountCents: 500, date: '2026-10-24', accountId: 'a1', categoryId: 'c1', note: 'Coffee', duplicateAcknowledged: false, duplicates: [{ id: 'existing', merchant: 'Coffee', amountCents: 500 }], status: 'check_required' });
});

test('passes recorded audio to its configured transcriber', async () => {
  const app = createWebApplication({ actual: {}, extractor: {}, transcriber: { transcribe: async (buffer, mime) => ({ text: `${mime}:${buffer.toString()}` }) } });
  assert.deepEqual(await app.transcribe({ buffer: Buffer.from('note'), mime: 'audio/webm' }), { text: 'audio/webm:note' });
});

test('passes the visible screen context to Borton', async () => {
  const received = [];
  const app = createWebApplication({ actual: {}, extractor: {}, assistant: { async message(payload) { received.push(payload); return { text: 'Ready' }; } } });
  assert.deepEqual(await app.assistantMessage({ text: 'Classify these', context: { page: 'home', visibleTransactions: [{ id: 'txn-1' }] } }), { text: 'Ready' });
  assert.deepEqual(received, [{ text: 'Classify these', context: { page: 'home', visibleTransactions: [{ id: 'txn-1' }] } }]);
});

test('queues web assistant messages and exposes safe message history', async () => {
  const received = [];
  const app = createWebApplication({ actual: {}, extractor: {}, assistantQueue: {
    enqueue(payload) { received.push(payload); return { id: 'job-1', text: payload.text, status: 'queued' }; },
    list() { return [{ id: 'job-1', text: 'Classify these', status: 'complete', response: 'Plan ready' }]; },
  } });
  assert.deepEqual(await app.assistantMessage({ text: 'Classify these', context: { page: 'home' } }), { id: 'job-1', text: 'Classify these', status: 'queued' });
  assert.deepEqual(await app.assistantMessages(), [{ id: 'job-1', text: 'Classify these', status: 'complete', response: 'Plan ready' }]);
  assert.deepEqual(received, [{ text: 'Classify these', context: { page: 'home' } }]);
});

test('delegates Plaid connection actions without exposing credentials', async () => {
  const calls = [];
  const plaid = { connections: async () => ({ configured: true, connections: [] }), linkToken: async () => ({ linkToken: 'short-lived' }), complete: async (payload) => { calls.push(payload); return { id: 'item' }; }, setMappings: async (payload) => payload, sync: async (id) => ({ id, added: 1 }), reconnectToken: async (id) => ({ linkToken: id }), disconnect: async (id) => ({ id, status: 'complete' }) };
  const app = createWebApplication({ actual: {}, extractor: {}, plaid });
  assert.deepEqual(await app.plaidConnections(), { configured: true, connections: [] });
  assert.deepEqual(await app.plaidLinkToken({}), { linkToken: 'short-lived' });
  assert.deepEqual(await app.plaidComplete({ publicToken: 'public' }), { id: 'item' });
  assert.deepEqual(calls, [{ publicToken: 'public' }]);
  assert.deepEqual(await app.plaidMapping({ id: 'item', mappings: [] }), { id: 'item', mappings: [] });
  assert.deepEqual(await app.plaidSync({ id: 'item' }), { id: 'item', added: 1 });
  assert.deepEqual(await app.plaidReconnectToken({ id: 'item' }), { linkToken: 'item' });
  assert.deepEqual(await app.plaidDisconnect({ id: 'item' }), { id: 'item', status: 'complete' });
});

test('exposes staged reviews and receipt uploads without bypassing the review queue', async () => {
  const calls = [];
  const plaid = { history: async () => ({ scanned: 2, rows: [{ importedId: 'one' }, { importedId: 'two' }] }) };
  const reviews = {
    list: (query) => [{ id: 'plaid:one', query }],
    resolve: async (payload) => { calls.push(['resolve', payload]); return { id: payload.id, status: 'completed' }; },
    stageReceipts: (files) => { calls.push(['receipts', files]); return [{ id: 'receipt:one' }]; },
    auditHistoricalImports: async (rows) => { calls.push(['audit', rows]); return { matched: 1, staged: 1, existing: 0 }; },
  };
  const app = createWebApplication({ actual: {}, extractor: {}, reviews, plaid });
  assert.deepEqual(await app.reviews({ status: 'open' }), [{ id: 'plaid:one', query: { status: 'open' } }]);
  assert.deepEqual(await app.resolveReview({ id: 'plaid:one', resolution: { action: 'ignore' } }), { id: 'plaid:one', status: 'completed' });
  assert.deepEqual(await app.uploadReceipts({ files: [{ buffer: Buffer.from('image'), mime: 'image/png' }] }), { rows: [{ id: 'receipt:one' }] });
  assert.deepEqual(await app.auditReviewHistory(), { scanned: 2, matched: 1, staged: 1, existing: 0 });
  assert.deepEqual(calls, [['resolve', { id: 'plaid:one', resolution: { action: 'ignore' } }], ['receipts', [{ buffer: Buffer.from('image'), mime: 'image/png' }]], ['audit', [{ importedId: 'one' }, { importedId: 'two' }]]]);
});
