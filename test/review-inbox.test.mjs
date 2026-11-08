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
  assert.deepEqual(reloaded.list().map(({ source, status, merchant, importedId, candidates }) => ({ source, status, merchant, importedId, candidates })), [{ source: 'plaid', status: 'match', merchant: 'Uniqlo', importedId: 'plaid-1', candidates: [{ id: 'existing', confidence: 'strong', daysApart: 2 }] }]);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});
