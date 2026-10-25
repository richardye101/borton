import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createActualWeb } from '../actual-web.mjs';

function fakeActual() {
  const transactions = [{ id: 'old', account: 'a1', date: '2026-10-23', amount: -1234, payee: 'p1', category: 'c1', notes: '' }, { id: 'transfer', account: 'a1', date: '2026-10-24', amount: -500, payee: 'transfer', transfer_id: 'x' }];
  const payees = [{ id: 'p1', name: 'Corner Store' }, { id: 'transfer', name: 'Transfer', transfer_acct: 'a2' }];
  const writes = [];
  return {
    writes,
    async sync() {},
    async getAccounts() { return [{ id: 'a1', name: 'Visa', closed: false }, { id: 'a2', name: 'Closed', closed: true }]; },
    async getCategories() { return [{ id: 'c1', name: 'Groceries', hidden: false }]; },
    async getPayees() { return payees; },
    async getTransactions(account) { return transactions.filter((row) => row.account === account); },
    async createPayee({ name }) { const payee = { id: `p${payees.length + 1}`, name }; payees.push(payee); return payee.id; },
    async addTransactions(account, rows) { writes.push({ account, rows }); },
  };
}

test('returns newest non-transfer transactions and finds likely duplicates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const web = createActualWeb({ api: fakeActual(), dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const boot = await web.bootstrap();
  assert.deepEqual(boot.transactions.map((row) => row.id), ['old']);
  const duplicates = await web.checkDuplicates({ merchant: 'Corner Store', amountCents: 1234, date: '2026-10-24' });
  assert.equal(duplicates.length, 1);
  const invalid = await web.validateBatch({ rows: [{ clientId: 'x', merchant: '', amountCents: -1, date: 'not-a-date', accountId: 'missing', categoryId: 'missing' }] });
  assert.equal(invalid.rows[0].status, 'invalid');
});

test('writes an acknowledged batch once and reuses one normalized payee', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const api = fakeActual();
  const web = createActualWeb({ api, dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const rows = [
    { clientId: 'one', merchant: 'Fresh Shop', amountCents: 200, date: '2026-10-24', accountId: 'a1', categoryId: 'c1', note: '', duplicateAcknowledged: false },
    { clientId: 'two', merchant: 'fresh shop', amountCents: 300, date: '2026-10-24', accountId: 'a1', categoryId: 'c1', note: '', duplicateAcknowledged: false },
  ];
  const first = await web.submitBatch({ requestId: 'request-0001', rows });
  assert.equal(first.status, 'complete');
  assert.equal(api.writes.length, 2);
  assert.equal((await api.getPayees()).filter((payee) => payee.name.toLowerCase() === 'fresh shop').length, 1);
  assert.deepEqual(await web.submitBatch({ requestId: 'request-0001', rows }), first);
});

test('never replays an uncertain request and flags duplicate rows inside one batch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const api = fakeActual(); const now = () => Date.parse('2026-10-24T12:00:00Z');
  fs.writeFileSync(path.join(dir, 'web-request-journal.json'), JSON.stringify({ 'uncertain-0001': { at: now(), uncertain: true } }));
  const web = createActualWeb({ api, dataDir: dir, now });
  const row = { clientId: 'one', merchant: 'New Store', amountCents: 200, date: '2026-10-24', accountId: 'a1', categoryId: 'c1', note: '', duplicateAcknowledged: false };
  assert.equal((await web.submitBatch({ requestId: 'uncertain-0001', rows: [row] })).status, 'uncertain');
  assert.equal(api.writes.length, 0);
  assert.equal((await web.submitBatch({ requestId: 'request-0002', rows: [row, { ...row, clientId: 'two' }] })).status, 'review_required');
});
