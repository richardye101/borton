import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewService } from '../review-service.mjs';

test('stages Plaid imports with candidate evidence and applies explicit decisions', async () => {
  const staged = []; const resolved = []; const writes = [];
  const actual = {
    async reviewCandidates() { return [{ id: 'actual-1', accountId: 'a1', date: '2026-10-21', amountCents: -5628, merchant: 'Uniqlo, Toronto', importedId: 'older-import' }]; },
    async applyReview(row) { writes.push(row); return { status: 'complete', transactionId: 'actual-1' }; },
  };
  const inbox = {
    stagePlaid(rows) { staged.push(...rows); return { staged: rows.length, existing: 0 }; },
    list() { return [{ id: 'plaid:new', source: 'plaid', importedId: 'new', accountId: 'a1', date: '2026-10-23', amountCents: -5628, merchant: 'Uniqlo' }]; },
    resolve(id, resolution) { resolved.push({ id, resolution }); return { id, status: 'completed', resolution }; },
  };
  const reviews = createReviewService({ actual, inbox });
  assert.deepEqual(await reviews.stagePlaid([{ importedId: 'new', accountId: 'a1', date: '2026-10-23', amountCents: -5628, merchant: 'Uniqlo' }]), { staged: 1, existing: 0 });
  assert.deepEqual(staged[0].candidates, [{ id: 'actual-1', confidence: 'strong', daysApart: 2, evidence: { sameAmount: true, merchant: 'contains' } }]);
  assert.deepEqual(await reviews.resolve({ id: 'plaid:new', resolution: { action: 'merge', transactionId: 'actual-1' } }), { id: 'plaid:new', status: 'completed', resolution: { action: 'merge', transactionId: 'actual-1', status: 'complete' } });
  assert.deepEqual(writes, [{ id: 'plaid:new', source: 'plaid', importedId: 'new', accountId: 'a1', date: '2026-10-23', amountCents: -5628, merchant: 'Uniqlo', resolution: { action: 'merge', transactionId: 'actual-1' } }]);
  assert.deepEqual(resolved, [{ id: 'plaid:new', resolution: { action: 'merge', transactionId: 'actual-1', status: 'complete' } }]);
});

test('sends the owner-selected category and note only with an import decision', async () => {
  const writes = [];
  const actual = { async applyReview(row) { writes.push(row); return { status: 'complete', transactionId: 'actual-1' }; } };
  const inbox = {
    list: () => [{ id: 'plaid:new', source: 'plaid', importedId: 'new', accountId: 'a1', date: '2026-10-23', amountCents: -5628, merchant: 'Uniqlo' }],
    resolve: (id, resolution) => ({ id, resolution }),
  };
  const reviews = createReviewService({ actual, inbox });
  await reviews.resolve({ id: 'plaid:new', resolution: { action: 'import', categoryId: 'food', note: 'Dinner with Tia' } });
  assert.deepEqual(writes[0].resolution, { action: 'import', categoryId: 'food', note: 'Dinner with Tia' });
});

test('stages cleared legacy imports for review without deleting them', async () => {
  const staged = []; const queued = [];
  const calls = []; const rows = [{ transactionId: 'actual-1', importedId: 'plaid-1', accountId: 'a1', date: '2026-11-02', amountCents: -2000, merchant: 'Metrolinx' }];
  const actual = { async resetImportedTuitionCategory(options) { calls.push(options); return { rows }; } };
  const inbox = { stageLegacyImports(rows) { staged.push(...rows); return { staged: rows.length, existing: 0 }; } };
  const reviews = createReviewService({ actual, inbox, categorySuggestions: { enqueue: (rows) => queued.push(...rows) } });
  assert.deepEqual(await reviews.resetImportedTuitionCategory(), { staged: 1, existing: 0 });
  assert.deepEqual(staged, [{ transactionId: 'actual-1', importedId: 'plaid-1', accountId: 'a1', date: '2026-11-02', amountCents: -2000, merchant: 'Metrolinx' }]);
  assert.deepEqual(queued, staged);
  assert.deepEqual(calls, [{ dryRun: true }, { transactionIds: ['actual-1'] }]);
});

test('only counts the Tuition correction on a dry run', async () => {
  const actual = { async resetImportedTuitionCategory({ dryRun }) { assert.equal(dryRun, true); return { rows: [{ transactionId: 'actual-1' }] }; } };
  const reviews = createReviewService({ actual, inbox: {} });
  assert.deepEqual(await reviews.resetImportedTuitionCategory({ dryRun: true }), { count: 1 });
});

test('matches a receipt to the mapped account without searching unrelated accounts', async () => {
  const actual = {
    async bootstrap() { return { accounts: [{ id: 'a1', name: 'Visa' }, { id: 'a2', name: 'Other card' }] }; },
    async reviewCandidates(row) { assert.equal(row.accountId, 'a1'); return [{ id: 'actual-1', accountId: 'a1', date: '2026-11-06', amountCents: -450, merchant: 'Coffee shop' }]; },
  };
  const inbox = { list: () => [{ id: 'plaid:other', source: 'plaid', accountId: 'a2', date: '2026-11-07', amountCents: -450, merchant: 'Coffee' }] };
  const reviews = createReviewService({ actual, inbox, cardmap: { byLast4: { 1234: 'Visa' } } });
  assert.deepEqual(await reviews.matchReceipt({ receipt: { merchant: 'Coffee', date: '2026-11-07', total: 4.5, card_last4: '1234' } }), { accountId: 'a1', account: 'Visa', candidates: [{ id: 'actual-1', confidence: 'strong', daysApart: 1, evidence: { sameAmount: true, merchant: 'contains' } }] });
});

test('keeps only verified same-account historical imports for audit staging', async () => {
  const staged = []; const inbox = { list: () => [], stageHistoricalPlaid: (rows) => { staged.push(...rows); return { staged: rows.length, existing: 0 }; } };
  const actual = {
    importedMatches: async (rows) => rows.filter((row) => row.importedId === 'kept').map((row) => ({ ...row, transactionId: 'actual-1' })),
  };
  const reviews = createReviewService({ actual, inbox });

  assert.deepEqual(await reviews.auditHistoricalImports([{ importedId: 'kept', accountId: 'a1' }, { importedId: 'other', accountId: 'a2' }]), { scanned: 2, matched: 1, staged: 1, existing: 0 });
  assert.deepEqual(staged, [{ importedId: 'kept', accountId: 'a1', transactionId: 'actual-1' }]);
});

test('audits historical imports in Actual-safe pages', async () => {
  const calls = [];
  const inbox = { list: () => [], stageHistoricalPlaid: (rows) => ({ staged: rows.length, existing: 0 }) };
  const actual = {
    importedMatches: async (rows) => { calls.push(rows.length); return rows.map((row) => ({ ...row, transactionId: `actual-${row.importedId}` })); },
  };
  const reviews = createReviewService({ actual, inbox });
  const rows = Array.from({ length: 501 }, (_, index) => ({ importedId: String(index), accountId: 'a1' }));

  assert.deepEqual(await reviews.auditHistoricalImports(rows), { scanned: 501, matched: 501, staged: 501, existing: 0 });
  assert.deepEqual(calls, [500, 1]);
});

test('never applies a completed historical audit record to Actual again', async () => {
  let actualWrites = 0;
  const inbox = { list: () => [{ id: 'plaid:old', source: 'plaid', status: 'completed', historical: true }] };
  const actual = { applyReview: async () => { actualWrites += 1; } };
  const reviews = createReviewService({ actual, inbox });

  await assert.rejects(() => reviews.resolve({ id: 'plaid:old', resolution: { action: 'import' } }), /Completed reviews cannot be changed/);
  assert.equal(actualWrites, 0);
});

test('attaches a receipt to an approved Actual candidate without changing the transaction', async () => {
  const resolved = [];
  const inbox = { list: () => [{ id: 'receipt:one', source: 'receipt', candidates: [{ id: 'actual-1', confidence: 'strong' }] }], resolve: (id, resolution) => { resolved.push({ id, resolution }); return { id, status: 'completed', resolution }; } };
  const reviews = createReviewService({ actual: {}, inbox });
  assert.deepEqual(await reviews.resolve({ id: 'receipt:one', resolution: { action: 'attach', transactionId: 'actual-1' } }), { id: 'receipt:one', status: 'completed', resolution: { action: 'attach', transactionId: 'actual-1', status: 'complete' } });
  assert.deepEqual(resolved, [{ id: 'receipt:one', resolution: { action: 'attach', transactionId: 'actual-1', status: 'complete' } }]);
});

test('stages a review-later reminder from the real transaction without editing Actual', async () => {
  const staged = []; const actual = {
    async findTransactions({ transactionId }) { assert.equal(transactionId, 'actual-1'); return [{ id: 'actual-1', date: '2026-11-08', merchant: 'Corner Store', account: 'Visa', amountCents: 4250 }]; },
  };
  const inbox = { stageManual: (row) => { staged.push(row); return { staged: 1, existing: 0, row }; }, list: () => [] };
  const reviews = createReviewService({ actual, inbox });
  assert.deepEqual(await reviews.stageManual({ transactionId: 'actual-1', note: 'Waiting for a repayment.' }), { staged: 1, existing: 0, row: { transactionId: 'actual-1', date: '2026-11-08', merchant: 'Corner Store', account: 'Visa', amountCents: 4250, note: 'Waiting for a repayment.' } });
  assert.deepEqual(staged, [{ transactionId: 'actual-1', date: '2026-11-08', merchant: 'Corner Store', account: 'Visa', amountCents: 4250, note: 'Waiting for a repayment.' }]);
});
