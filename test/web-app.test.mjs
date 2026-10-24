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
