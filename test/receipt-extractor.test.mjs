import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptExtractor } from '../receipt-extractor.mjs';

test('extracts JPEG and HEIC images with the shared multi-receipt request', async () => {
  const calls = [];
  const extractor = createReceiptExtractor({
    generate: async (parts, schema) => {
      calls.push({ parts, schema });
      return { receipts: [{ merchant: 'Corner Store', date: '2026-10-24', total: 12.34, currency: 'CAD', tax: 1.61, card_last4: '1234', line_items: ['Milk'] }] };
    },
  });

  const result = await extractor.extractImage(Buffer.from('receipt'), 'image/heic');

  assert.equal(result.receipts[0].merchant, 'Corner Store');
  assert.equal(calls.length, 1);
  assert.match(calls[0].parts[0].text, /every separate purchase receipt/i);
  assert.equal(calls[0].parts[1].inlineData.mimeType, 'image/heic');
  assert.equal(calls[0].parts[1].inlineData.data, Buffer.from('receipt').toString('base64'));
  assert.equal(calls[0].schema.properties.receipts.type, 'ARRAY');
});

test('rejects unsupported or oversized uploads before calling Gemini', async () => {
  let calls = 0;
  const extractor = createReceiptExtractor({ generate: async () => { calls += 1; return {}; } });

  await assert.rejects(() => extractor.extractImage(Buffer.from('receipt'), 'application/pdf'), /Unsupported image type/);
  await assert.rejects(() => extractor.extractImage(Buffer.alloc(10 * 1024 * 1024 + 1), 'image/jpeg'), /10 MB/);
  assert.equal(calls, 0);
});
