import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createActualWeb } from '../actual-web.mjs';

function fakeActual(extraTransactions = []) {
  const transactions = [{ id: 'old', account: 'a1', date: '2026-10-23', amount: -1234, payee: 'p1', category: 'c1', notes: '' }, { id: 'old-2', account: 'a1', date: '2026-10-22', amount: -200, payee: 'p1', category: 'c1', notes: '' }, { id: 'closed-expense', account: 'a2', date: '2024-01-02', amount: -500, payee: 'p1', category: 'c1', notes: '' }, { id: 'transfer', account: 'a1', date: '2026-10-24', amount: -500, payee: 'transfer', transfer_id: 'x' }, ...extraTransactions];
  const payees = [{ id: 'p1', name: 'Corner Store' }, { id: 'transfer', name: 'Transfer', transfer_acct: 'a2' }];
  const writes = [];
  return {
    writes,
    async sync() {},
    async getAccounts() { return [{ id: 'a1', name: 'Visa', closed: false }, { id: 'a2', name: 'Closed', closed: true }]; },
    async getCategories() { return [{ id: 'c1', name: 'Groceries', hidden: false }, { id: 'income', name: 'Salary', hidden: false, is_income: true }]; },
    async getPayees() { return payees; },
    async getTransactions(account) { return transactions.filter((row) => row.account === account); },
    async createPayee({ name }) { const payee = { id: `p${payees.length + 1}`, name }; payees.push(payee); return payee.id; },
    async addTransactions(account, rows) { writes.push({ account, rows }); },
    async updateTransaction(id, fields) { writes.push({ id, fields }); return [{ id, ...fields }]; },
  };
}

test('returns newest non-transfer transactions and finds likely duplicates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const web = createActualWeb({ api: fakeActual(), dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const boot = await web.bootstrap();
  assert.deepEqual(boot.transactions.map((row) => row.id), ['old', 'old-2']);
  assert.deepEqual(boot.categories.map((row) => row.name), ['Groceries']);
  const duplicates = await web.checkDuplicates({ merchant: 'Corner Store', amountCents: 1234, date: '2026-10-24' });
  assert.equal(duplicates.length, 1);
  const invalid = await web.validateBatch({ rows: [{ clientId: 'x', merchant: '', amountCents: -1, date: 'not-a-date', accountId: 'missing', categoryId: 'missing' }] });
  assert.equal(invalid.rows[0].status, 'invalid');
});

test('summarizes expense spending by category, account, and month', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const web = createActualWeb({ api: fakeActual(), dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  assert.equal(typeof web.summary, 'function');
  const summary = await web.summary({ days: 30 });
  assert.equal(summary.totalCents, 1434);
  assert.deepEqual(summary.byCategory.map(({ name, amountCents, count }) => ({ name, amountCents, count })), [{ name: 'Groceries', amountCents: 1434, count: 2 }]);
  assert.deepEqual(summary.byAccount.map(({ name, amountCents, count }) => ({ name, amountCents, count })), [{ name: 'Visa', amountCents: 1434, count: 2 }]);
  assert.deepEqual(summary.byMonth.map(({ name, amountCents, count }) => ({ name, amountCents, count })), [{ name: '2026-10', amountCents: 1434, count: 2 }]);
  assert.deepEqual(summary.monthCategories.map(({ name, categories }) => ({ name, categories: categories.map(({ name: category, amountCents }) => ({ name: category, amountCents })) })), [{ name: '2026-10', categories: [{ name: 'Groceries', amountCents: 1434 }] }]);
});

test('includes closed-account history in all-time summaries and returns stable drill-down filters', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const web = createActualWeb({ api: fakeActual(), dataDir: dir, now: () => Date.parse('2026-10-24T01:00:00Z') });
  const summary = await web.summary({ period: 'all' });
  assert.equal(summary.period, 'all');
  assert.equal(summary.totalCents, 1934);
  assert.deepEqual(summary.byAccount.find((row) => row.id === 'a2').filters, { start: '1900-01-01', end: '2026-10-23', accountId: 'a2' });
  assert.deepEqual(summary.byMonth.find((row) => row.name === '2026-10').filters, { start: '2026-10-01', end: '2026-10-31' });
});

test('returns a paged filtered transaction detail response', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const web = createActualWeb({ api: fakeActual(), dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const detail = await web.findTransactions({ start: '2026-10-01', end: '2026-10-31', categoryId: 'c1', offset: 1, limit: 1, paged: true });
  assert.equal(detail.total, 2);
  assert.deepEqual(detail.rows.map((row) => row.id), ['old-2']);
  const unbounded = await web.findTransactions({ start: '2026-10-01', end: '2026-10-31', categoryId: 'c1', limit: 0, paged: true });
  assert.deepEqual(unbounded.rows.map((row) => row.id), ['old', 'old-2']);
});

test('uses a dedicated filter for uncategorized transaction drill-downs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const api = fakeActual([{ id: 'uncategorized', account: 'a1', date: '2026-10-21', amount: -300, payee: 'p1', category: null, notes: '' }]);
  const web = createActualWeb({ api, dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const summary = await web.summary({ days: 30 });
  assert.deepEqual(summary.byCategory.find((row) => row.name === 'Uncategorized').filters, { start: '2026-09-25', end: '2026-10-24', categoryId: '__uncategorized__' });
  const detail = await web.findTransactions({ start: '2026-09-25', end: '2026-10-24', categoryId: '__uncategorized__' });
  assert.deepEqual(detail.map((row) => row.id), ['uncategorized']);
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

test('edits an expense with validated fields and a normalized payee', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const api = fakeActual();
  const web = createActualWeb({ api, dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const result = await web.editTransaction({ id: 'old', merchant: 'Fresh Shop', amountCents: 1500, date: '2026-10-24', accountId: 'a1', categoryId: 'c1', note: 'Weekly groceries' });
  assert.deepEqual(result, { status: 'complete', id: 'old' });
  assert.deepEqual(api.writes.at(-1), { id: 'old', fields: { date: '2026-10-24', amount: -1500, payee: 'p3', notes: 'Weekly groceries', account: 'a1', category: 'c1' } });
  await assert.rejects(web.editTransaction({ id: 'old', merchant: '', amountCents: 0, date: 'invalid', accountId: 'missing', categoryId: 'missing' }), /valid expense/);
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
