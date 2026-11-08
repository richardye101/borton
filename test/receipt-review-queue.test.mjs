import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptReviewQueue } from '../receipt-review-queue.mjs';

test('processes receipt jobs serially and retries temporary OCR failures', async () => {
  let time = 1_000; const calls = []; const rows = new Map();
  const inbox = {
    stageReceipt: ({ name, buffer, mime }) => { const id = `receipt:${name}`; const row = { id, name, mime, status: 'queued', nextAt: time }; rows.set(id, { ...row, buffer }); return row; },
    list: () => [...rows.values()],
    readReceipt: (id) => ({ buffer: rows.get(id).buffer, mime: rows.get(id).mime }),
    startReceipt: (id) => Object.assign(rows.get(id), { status: 'processing' }),
    completeReceipt: (id, extraction) => { Object.assign(rows.get(id), extraction, { status: 'match' }); },
    retryReceipt: (id, error, nextAt) => { Object.assign(rows.get(id), { status: 'retrying', lastError: error, nextAt }); },
    cleanup: () => ({ removed: 0 }),
  };
  let attempts = 0;
  const queue = createReceiptReviewQueue({ inbox, now: () => time, minIntervalMs: 0, autoStart: false, extractor: { async extractImage(buffer) { calls.push(buffer.toString()); if (buffer.toString() === 'first' && attempts++ === 0) throw Object.assign(Error('Gemini HTTP 429.'), { retryAfterMs: 500 }); return { receipts: [{ merchant: buffer.toString(), total: 1 }] }; } } });
  queue.enqueue([{ name: 'first', buffer: Buffer.from('first'), mime: 'image/jpeg' }, { name: 'second', buffer: Buffer.from('second'), mime: 'image/jpeg' }]);
  await queue.run();
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(rows.get('receipt:first').status, 'retrying');
  assert.equal(rows.get('receipt:second').status, 'match');
  time = 61_000; await queue.run();
  assert.equal(rows.get('receipt:first').status, 'match');
  assert.deepEqual(calls, ['first', 'second', 'first']);
});

test('reads staged receipt bytes through the inbox and records a permanent OCR failure', async () => {
  const rows = new Map([['receipt:one', { id: 'receipt:one', status: 'queued', mime: 'image/png', nextAt: 0 }]]);
  const inbox = {
    list: () => [...rows.values()],
    readReceipt: () => ({ buffer: Buffer.from('private'), mime: 'image/png' }),
    completeReceipt: () => assert.fail('permanent failures must not complete'),
    retryReceipt: () => assert.fail('permanent failures must not retry'),
    failReceipt: (id, error) => Object.assign(rows.get(id), { status: 'failed', lastError: error }),
    cleanup: () => ({ removed: 0 }),
  };
  const queue = createReceiptReviewQueue({ inbox, minIntervalMs: 0, autoStart: false, extractor: { async extractImage(buffer) { assert.equal(buffer.toString(), 'private'); throw Error('Unsupported image type.'); } } });
  await queue.run();
  assert.deepEqual(rows.get('receipt:one'), { id: 'receipt:one', status: 'failed', mime: 'image/png', nextAt: 0, lastError: 'Unsupported image type.' });
});

test('marks an image with no extractable receipt as failed', async () => {
  const row = { id: 'receipt:empty', status: 'queued', mime: 'image/png', nextAt: 0 };
  const inbox = {
    list: () => [row],
    readReceipt: () => ({ buffer: Buffer.from('empty'), mime: 'image/png' }),
    startReceipt: () => Object.assign(row, { status: 'processing' }),
    completeReceipt: (id, extraction) => Object.assign(row, extraction),
    retryReceipt: () => assert.fail('empty scans should not retry'),
    failReceipt: () => assert.fail('the extraction completed normally'),
    cleanup: () => ({ removed: 0 }),
  };
  await createReceiptReviewQueue({ inbox, minIntervalMs: 0, autoStart: false, extractor: { async extractImage() { return { receipts: [] }; } } }).run();
  assert.equal(row.status, 'failed');
  assert.equal(row.lastError, 'No receipt found.');
});
