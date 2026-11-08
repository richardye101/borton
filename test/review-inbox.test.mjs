import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createReviewInbox, rankReviewCandidates } from '../review-inbox.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'borton-reviews-'));

test('ranks foreign imports but skips the same Plaid transaction id', () => {
  const incoming = { importedId: 'plaid-1', accountId: 'a1', date: '2026-10-21', amountCents: -5628, merchant: 'Uniqlo' };
  const candidates = rankReviewCandidates(incoming, [
    { id: 'existing', accountId: 'a1', date: '2026-10-23', amountCents: -5628, merchant: 'Uniqlo, Toronto, ON', importedId: 'older-import' },
    { id: 'already-handled', accountId: 'a1', date: '2026-10-21', amountCents: -5628, merchant: 'Uniqlo', importedId: 'plaid-1' },
  ]);
  assert.deepEqual(candidates.map(({ id, confidence, daysApart }) => ({ id, confidence, daysApart })), [{ id: 'existing', confidence: 'strong', daysApart: 2 }]);
});

test('stages a Plaid row once and survives an inbox reload', () => {
  const directory = temp(); const filePath = path.join(directory, 'reviews.json');
  const row = { importedId: 'plaid-1', accountId: 'a1', account: 'Visa', date: '2026-10-21', amountCents: -5628, merchant: 'Uniqlo', institution: 'Wealthsimple', candidates: [{ id: 'existing', confidence: 'strong', daysApart: 2 }] };
  const inbox = createReviewInbox({ filePath, receiptDir: path.join(directory, 'receipts'), now: () => 1000 });
  assert.deepEqual(inbox.stagePlaid([row]), { staged: 1, existing: 0 });
  assert.deepEqual(inbox.stagePlaid([row]), { staged: 0, existing: 1 });
  const reloaded = createReviewInbox({ filePath, receiptDir: path.join(directory, 'receipts'), now: () => 2000 });
  assert.deepEqual(reloaded.list().map(({ source, status, merchant, importedId, candidates, suggestion }) => ({ source, status, merchant, importedId, candidates, suggestion })), [{ source: 'plaid', status: 'match', merchant: 'Uniqlo', importedId: 'plaid-1', candidates: [{ id: 'existing', confidence: 'strong', daysApart: 2 }], suggestion: { status: 'queued', attempts: 0, nextAt: 1000, lastError: '' } }]);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('recovers an interrupted category suggestion as queued work', () => {
  const directory = temp(); const filePath = path.join(directory, 'reviews.json');
  const inbox = createReviewInbox({ filePath, receiptDir: path.join(directory, 'receipts'), now: () => 1000 });
  inbox.stagePlaid([{ importedId: 'plaid-1', accountId: 'a1', date: '2026-10-21', amountCents: -5628, merchant: 'Uniqlo' }]);
  inbox.startSuggestion('plaid:plaid-1');
  const recovered = createReviewInbox({ filePath, receiptDir: path.join(directory, 'receipts'), now: () => 2000 });
  assert.deepEqual(recovered.list()[0].suggestion, { status: 'queued', attempts: 1, nextAt: 2000, lastError: 'Processing interrupted; retrying.' });
});

test('records verified historical imports as completed without replacing an open review', () => {
  const directory = temp(); const inbox = createReviewInbox({ filePath: path.join(directory, 'reviews.json'), receiptDir: path.join(directory, 'receipts'), now: () => 1000 });
  const row = { importedId: 'plaid-1', accountId: 'a1', account: 'Visa', date: '2026-10-21', amountCents: -5628, merchant: 'Uniqlo', institution: 'Wealthsimple', transactionId: 'actual-1' };
  assert.deepEqual(inbox.stageHistoricalPlaid([row]), { staged: 1, existing: 0 });
  assert.deepEqual(inbox.stageHistoricalPlaid([row]), { staged: 0, existing: 1 });
  assert.deepEqual(inbox.list({ status: 'completed' }).map(({ status, historical, resolution, candidates }) => ({ status, historical, resolution, candidates })), [{ status: 'completed', historical: true, resolution: { action: 'already_imported', transactionId: 'actual-1', status: 'complete' }, candidates: [{ id: 'actual-1', confidence: 'exact', daysApart: 0, evidence: { sameImportId: true } }] }]);
});

test('keeps a review-later reminder linked to its transaction until it is completed', () => {
  const directory = temp(); const filePath = path.join(directory, 'reviews.json');
  const inbox = createReviewInbox({ filePath, receiptDir: path.join(directory, 'receipts'), now: () => 1000 });
  const input = { transactionId: 'actual-1', date: '2026-11-08', merchant: 'Corner Store', account: 'Visa', amountCents: 4250, note: 'Waiting for Tia to pay back her share.' };
  const staged = inbox.stageManual(input);
  assert.equal(staged.staged, 1);
  assert.deepEqual(inbox.stageManual(input), { staged: 0, existing: 1, row: staged.row });
  assert.deepEqual(createReviewInbox({ filePath, receiptDir: path.join(directory, 'receipts'), now: () => 2000 }).list().map(({ source, status, transactionId, note }) => ({ source, status, transactionId, note })), [{ source: 'manual', status: 'later', transactionId: 'actual-1', note: 'Waiting for Tia to pay back her share.' }]);
  inbox.resolve(staged.row.id, { action: 'complete', status: 'complete' });
  assert.equal(inbox.list().length, 0);
  assert.equal(inbox.list({ status: 'completed' })[0].resolution.action, 'complete');
});

test('keeps receipt image bytes private while making them available to the worker', () => {
  const directory = temp(); const filePath = path.join(directory, 'reviews.json');
  const inbox = createReviewInbox({ filePath, receiptDir: path.join(directory, 'receipts'), now: () => 1000 });
  const staged = inbox.stageReceipt({ buffer: Buffer.from('private receipt'), mime: 'image/png' });
  assert.equal('buffer' in staged, false);
  const image = inbox.readReceipt(staged.id);
  assert.deepEqual({ buffer: image.buffer, mime: image.mime }, { buffer: Buffer.from('private receipt'), mime: 'image/png' });
  assert.equal(fs.statSync(image.path).mode & 0o777, 0o600);
  assert.deepEqual(inbox.cleanup(), { removed: 0 });
});

test('retains terminal receipt extraction failures instead of reopening them as new', () => {
  const directory = temp(); const inbox = createReviewInbox({ filePath: path.join(directory, 'reviews.json'), receiptDir: path.join(directory, 'receipts'), now: () => 1000 });
  const staged = inbox.stageReceipt({ buffer: Buffer.from('empty'), mime: 'image/png' });
  const completed = inbox.completeReceipt(staged.id, { status: 'failed', lastError: 'No receipt found.' });
  assert.equal(completed.status, 'failed');
  assert.equal(completed.lastError, 'No receipt found.');
});

test('removes receipt image bytes after thirty days without losing review metadata', () => {
  let time = 1000; const directory = temp(); const inbox = createReviewInbox({ filePath: path.join(directory, 'reviews.json'), receiptDir: path.join(directory, 'receipts'), now: () => time });
  const staged = inbox.stageReceipt({ buffer: Buffer.from('delete later'), mime: 'image/png' });
  const imagePath = inbox.readReceipt(staged.id).path;
  time += 30 * 86_400_000;
  assert.deepEqual(inbox.cleanup(), { removed: 1 });
  assert.equal(fs.existsSync(imagePath), false);
  const retained = inbox.list({ status: 'all' }).find((row) => row.id === staged.id);
  assert.equal(retained.imagePath, undefined);
  assert.equal(retained.imageExpiredAt, time);
  assert.equal(retained.hash, staged.hash);
});
