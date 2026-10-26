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
    async getAccounts() { return [{ id: 'a1', name: 'Visa', closed: false }, { id: 'a2', name: 'Closed', closed: true }, { id: 'a3', name: 'Tias Mastercard', closed: false, offbudget: true }]; },
    async getCategories() { return [{ id: 'c1', name: 'Groceries', hidden: false }, { id: 'income', name: 'Salary', hidden: false, is_income: true }]; },
    async getPayees() { return payees; },
    async getTransactions(account) { return transactions.filter((row) => row.account === account); },
    async getAccountBalance(account) { return transactions.filter((row) => row.account === account).reduce((total, row) => total + row.amount, 0); },
    async createPayee({ name }) { const payee = { id: `p${payees.length + 1}`, name }; payees.push(payee); return payee.id; },
    async addTransactions(account, rows) { writes.push({ account, rows }); },
    async updateTransaction(id, fields) { writes.push({ id, fields }); return [{ id, ...fields }]; },
    async deleteTransaction(id) { writes.push({ delete: id }); },
  };
}

test('returns newest non-transfer transactions and finds likely duplicates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const web = createActualWeb({ api: fakeActual(), dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const boot = await web.bootstrap();
  assert.deepEqual(boot.transactions.map((row) => row.id), ['old', 'old-2']);
  assert.deepEqual(boot.accounts.map((row) => row.name), ['Visa', 'Tias Mastercard']);
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

test('finds one transaction by id for a direct transaction link', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const web = createActualWeb({ api: fakeActual(), dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const detail = await web.findTransactions({ transactionId: 'old-2' });
  assert.deepEqual(detail.map((row) => row.id), ['old-2']);
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

test('shows a shared split category and applies a row category edit to every split line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const api = fakeActual([{ id: 'split', account: 'a1', date: '2026-10-21', amount: -3442, payee: 'p1', category: null, notes: 'Groceries split', subtransactions: [
    { id: 'split-one', category: 'c1', amount: -1721, payee: 'p1' },
    { id: 'split-two', category: null, amount: -1721, payee: 'owed-tia' },
  ] }]);
  api.getAccounts = async () => [{ id: 'a1', name: 'Visa', closed: false }, { id: 'owed-tia', name: 'Owed by Tia', closed: false }];
  api.getPayees = async () => [{ id: 'p1', name: 'Corner Store' }, { id: 'owed-tia', name: 'Owed by Tia', transfer_acct: 'owed-tia' }];
  const web = createActualWeb({ api, dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const row = (await web.findTransactions({ start: '2026-10-01', end: '2026-10-31' })).find((transaction) => transaction.id === 'split');
  assert.equal(row.category, 'Groceries');
  assert.deepEqual(row.splitTransactionIds, ['split-one', 'split-two']);
  assert.deepEqual(row.splitLines, [
    { id: 'split-one', amountCents: 1721, categoryId: 'c1', category: 'Groceries' },
    { id: 'split-two', amountCents: 1721, categoryId: null, category: '', person: 'Tia', account: 'Owed by Tia' },
  ]);
  assert.deepEqual(row.splitDetails, [{ person: 'Tia', account: 'Owed by Tia', amountCents: 1721, direction: 'they_owe_you' }]);
  await web.editTransaction({ id: 'split', merchant: 'Corner Store', amountCents: 3442, date: '2026-10-21', accountId: 'a1', categoryId: 'c1', note: 'Groceries split', splitTransactionIds: row.splitTransactionIds });
  assert.deepEqual(api.writes.slice(-3), [
    { id: 'split', fields: { date: '2026-10-21', amount: -3442, payee: 'p1', notes: 'Groceries split', account: 'a1', category: 'c1' } },
    { id: 'split-one', fields: { category: 'c1' } },
    { id: 'split-two', fields: { category: 'c1' } },
  ]);
});

test('shows a person ledger and running balance from an owed account', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const api = fakeActual([
    { id: 'tia-split', account: 'owed-tia', date: '2026-10-20', amount: 2361, payee: 'p1', notes: 'No frills split' },
    { id: 'tia-paid', account: 'owed-tia', date: '2026-10-22', amount: -500, payee: 'p1', notes: 'Tia paid back' },
  ]);
  api.getAccounts = async () => [{ id: 'a1', name: 'Visa', closed: false }, { id: 'owed-tia', name: 'Owed by Tia', closed: false }];
  const web = createActualWeb({ api, dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  assert.deepEqual(await web.shared(), {
    people: [{
      id: 'owed-tia', name: 'Tia', balanceCents: 1861, direction: 'they_owe_you',
      entries: [
        { id: 'tia-paid', date: '2026-10-22', merchant: 'Corner Store', note: 'Tia paid back', amountCents: 500, direction: 'you_owe_them', runningBalanceCents: 1861 },
        { id: 'tia-split', date: '2026-10-20', merchant: 'Corner Store', note: 'No frills split', amountCents: 2361, direction: 'they_owe_you', runningBalanceCents: 2361 },
      ],
    }],
  });
});

test('attaches an owner-paid shared debt to its expense row', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const api = fakeActual([
    { id: 'tia-paid', account: 'tia-card', date: '2026-10-21', amount: -1000, payee: 'p1', category: 'c1', notes: 'Dinner · Tia paid' },
    { id: 'owed-tia', account: 'owed-tia', date: '2026-10-21', amount: -500, payee: 'p1', category: 'c1', notes: 'Dinner · your share — Tia paid' },
  ]);
  api.getAccounts = async () => [{ id: 'tia-card', name: 'Tias Wealthsimple VIP', closed: false }, { id: 'owed-tia', name: 'Owed by Tia', closed: false }];
  const web = createActualWeb({ api, dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const rows = await web.findTransactions({ start: '2026-10-21', end: '2026-10-21' });
  assert.deepEqual(rows.map((row) => row.id), ['tia-paid']);
  assert.deepEqual(rows[0].sharedDebt, { person: 'Tia', account: 'Owed by Tia', amountCents: 500, direction: 'you_owe_them' });
});

test('rebuilds an owner-paid transaction as a debt entry when splitting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const api = fakeActual([{ id: 'their-card', account: 'tia-card', date: '2026-10-21', amount: -1001, payee: 'p1', category: 'c1', notes: 'Dinner' }]);
  api.getAccounts = async () => [{ id: 'tia-card', name: 'Tias Mastercard', closed: false }, { id: 'owed-tia', name: 'Owed by Tia', closed: false }];
  api.getPayees = async () => [{ id: 'p1', name: 'Corner Store' }, { id: 'owed-tia', name: 'Owed by Tia', transfer_acct: 'owed-tia' }];
  const web = createActualWeb({ api, dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const result = await web.splitTransaction({ id: 'their-card', accountId: 'tia-card', date: '2026-10-21', person: 'Ignored' });
  assert.deepEqual(result, { status: 'complete', direction: 'you_owe_them', person: 'Tia', shares: [{ person: 'Tia', account: 'Owed by Tia', amountCents: 501 }] });
  assert.equal(api.writes[0].delete, 'their-card');
  assert.deepEqual(api.writes.slice(1).map(({ account, rows }) => ({ account, rows: rows.map((row) => ({ amount: row.amount, payee: row.payee, category: row.category, notes: row.notes })) })), [
    { account: 'tia-card', rows: [{ amount: -1001, payee: 'p1', category: 'c1', notes: 'Dinner · Tia paid' }] },
    { account: 'owed-tia', rows: [{ amount: -501, payee: 'p1', category: 'c1', notes: 'Dinner · your share — Tia paid' }] },
  ]);
});

test('converts named exact shares into debt transfers and keeps the remainder as your spending', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const api = fakeActual([{ id: 'manual-split', account: 'a1', date: '2026-10-21', amount: -10000, payee: 'p1', category: 'c1', notes: 'Dinner' }]);
  api.getAccounts = async () => [{ id: 'a1', name: 'Visa', closed: false }, { id: 'owed-alex', name: 'Owed by Alex', closed: false }, { id: 'owed-tia', name: 'Owed by Tia', closed: false }];
  api.getPayees = async () => [{ id: 'p1', name: 'Corner Store' }, { id: 'owed-alex', name: 'Owed by Alex', transfer_acct: 'owed-alex' }, { id: 'owed-tia', name: 'Owed by Tia', transfer_acct: 'owed-tia' }];
  const web = createActualWeb({ api, dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const result = await web.splitTransaction({ id: 'manual-split', accountId: 'a1', date: '2026-10-21', mode: 'amount', shares: [{ person: 'Alex', value: 25 }, { person: 'Tia', value: 15 }] });
  assert.deepEqual(result, { status: 'complete', direction: 'they_owe_you', person: 'Alex', shares: [{ person: 'Alex', account: 'Owed by Alex', amountCents: 2500 }, { person: 'Tia', account: 'Owed by Tia', amountCents: 1500 }] });
  assert.equal(api.writes[0].delete, 'manual-split');
  assert.deepEqual(api.writes[1].rows[0].subtransactions.map((row) => ({ amount: row.amount, category: row.category, payee: row.payee })), [
    { amount: -6000, category: 'c1', payee: undefined },
    { amount: -2500, category: undefined, payee: 'owed-alex' },
    { amount: -1500, category: undefined, payee: 'owed-tia' },
  ]);
});

test('converts a one-category Actual split into a shared expense', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const api = fakeActual([{ id: 'category-split', account: 'a1', date: '2026-10-21', amount: -1000, payee: 'p1', category: null, notes: 'Dinner', subtransactions: [
    { id: 'part-one', amount: 0, category: 'c1' }, { id: 'part-two', amount: 0, category: 'c1' },
  ] }]);
  api.getAccounts = async () => [{ id: 'a1', name: 'Visa', closed: false }, { id: 'owed-alex', name: 'Owed by Alex', closed: false }];
  api.getPayees = async () => [{ id: 'p1', name: 'Corner Store' }, { id: 'owed-alex', name: 'Owed by Alex', transfer_acct: 'owed-alex' }];
  const web = createActualWeb({ api, dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  assert.equal((await web.splitTransaction({ id: 'category-split', accountId: 'a1', date: '2026-10-21', mode: 'equal', shares: [{ person: 'Alex' }] })).direction, 'they_owe_you');
  assert.equal(api.writes[0].delete, 'category-split');
});

test('uses a percentage as your share when the named account owner paid', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-actual-web-'));
  const api = fakeActual([{ id: 'owner-percent', account: 'tia-card', date: '2026-10-21', amount: -1001, payee: 'p1', category: 'c1', notes: 'Dinner' }]);
  api.getAccounts = async () => [{ id: 'tia-card', name: 'Tias Mastercard', closed: false }, { id: 'owed-tia', name: 'Owed by Tia', closed: false }];
  api.getPayees = async () => [{ id: 'p1', name: 'Corner Store' }, { id: 'owed-tia', name: 'Owed by Tia', transfer_acct: 'owed-tia' }];
  const web = createActualWeb({ api, dataDir: dir, now: () => Date.parse('2026-10-24T12:00:00Z') });
  const result = await web.splitTransaction({ id: 'owner-percent', accountId: 'tia-card', date: '2026-10-21', mode: 'percent', shares: [{ person: 'ignored', value: 30 }] });
  assert.deepEqual(result, { status: 'complete', direction: 'you_owe_them', person: 'Tia', shares: [{ person: 'Tia', account: 'Owed by Tia', amountCents: 300 }] });
  assert.equal(api.writes[2].rows[0].amount, -300);
});
