import assert from 'node:assert/strict';
import test from 'node:test';
import { findLikelyDuplicates, isValidExpenseDate, normalizeReceipts, withPayeeNames } from '../receipt-utils.mjs';

test('findLikelyDuplicates matches amount, merchant, and nearby posting date', () => {
  const matches = findLikelyDuplicates([
    { id: 'same', amount: -1299, date: '2026-10-18', payee_name: 'Starbucks Coffee' },
    { id: 'wrong-merchant', amount: -1299, date: '2026-10-18', payee_name: 'Metro' },
    { id: 'too-old', amount: -1299, date: '2026-10-10', payee_name: 'Starbucks' },
    { id: 'wrong-amount', amount: -1399, date: '2026-10-18', payee_name: 'Starbucks' },
  ], { total: 12.99, merchant: 'Starbucks', date: '2026-10-20' });

  assert.deepEqual(matches.map((t) => t.id), ['same']);
});

test('findLikelyDuplicates recognizes normalized merchant names', () => {
  const matches = findLikelyDuplicates([
    { id: 'same', amount: -4599, date: '2026-10-20', payee_name: 'THE HOME DEPOT #1234' },
  ], { total: 45.99, merchant: 'Home Depot', date: '2026-10-20' });

  assert.equal(matches.length, 1);
});

test('withPayeeNames resolves Actual payee IDs before duplicate matching', () => {
  const rows = withPayeeNames([{ id: 'txn', amount: -1299, payee: 'payee-1' }], [{ id: 'payee-1', name: 'Starbucks Coffee' }]);
  assert.equal(rows[0].payee_name, 'Starbucks Coffee');
});

test('normalizeReceipts accepts old single-receipt results and filters invalid batch entries', () => {
  assert.deepEqual(normalizeReceipts({ merchant: 'Coffee', total: 4.5 }), [{ merchant: 'Coffee', total: 4.5 }]);
  assert.deepEqual(normalizeReceipts({ receipts: [
    { merchant: 'Coffee', total: 4.5 },
    { merchant: '', total: 8 },
    { merchant: 'Refund?', total: 0 },
  ] }), [{ merchant: 'Coffee', total: 4.5 }]);
});

test('isValidExpenseDate rejects impossible and far-future dates', () => {
  assert.equal(isValidExpenseDate('2026-10-18', '2026-10-21'), true);
  assert.equal(isValidExpenseDate('2026-02-30', '2026-10-21'), false);
  assert.equal(isValidExpenseDate('2026-10-25', '2026-10-21'), false);
});
