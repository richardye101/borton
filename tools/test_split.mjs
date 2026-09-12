// Run real bot functions with in-memory Actual/Telegram substitutes: node tools/test_split.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { isReceiptEdit } from '../agent.mjs';

const source = fs.readFileSync(new URL('../bot.mjs', import.meta.url), 'utf8');
// The bot starts polling on import. Load its top-level declarations without startup/config I/O.
function declaration(name) {
  const constant = source.match(new RegExp(`^const ${name} = .+;$`, 'm'));
  if (constant) return constant[0];
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing production declaration: ${name}`);
  const end = source.indexOf('\n}', start);
  assert.ok(end >= 0, `Missing function end: ${name}`);
  return source.slice(start, end + 2);
}
function fixture() {
  const writes = [], messages = [];
  const bot = vm.createContext({
    console,
    currentMessage: () => undefined, checkpointMessage: () => {},
    isReceiptEdit,
    cfg: { defaults: { splitPerson: 'Ryan' }, telegram: { allowedChatId: 42 } },
    ACCT: { Card: 'card', Alice: 'a', Bob: 'b', Carol: 'c', Ryan: 'r' },
    CAT: { Dining: 'dining' },
    TRANSFER_PAYEE: { a: 'pay-a', b: 'pay-b', c: 'pay-c', r: 'pay-r' },
    api: {
      addTransactions: async (_account, txns) => writes.push(...structuredClone(txns)),
      sync: async () => {},
      getTransactions: async () => writes.map((t, i) => ({ ...t, id: `txn-${i}` })),
    },
    confirming: { 42: { promptMid: 77, parsed: { split: true, person: 'Alice', persons: ['Alice', 'Bob'] } } },
    editField: {},
    tg: async () => {},
    send: async (_chat, text) => messages.push(text),
    rerenderConfirm: async () => {},
    lastSplitPerson: () => 'Ryan',
    rememberSplitPerson: () => {},
    resolveOwedAccounts: async people => people,
    owedAccountFor: person => `Owed by ${person}`,
    purgeLegs: async () => {},
    rebindTxn: () => {},
    persistTxns: () => {},
  });
  vm.runInContext(['isRelay', 'isAllowedChat', 'isOwner', 'cap', 'NON_NAMES', 'PRONOUNS', 'personName', 'namesList', 'extractPersons',
    'extractPaid', 'splitAmounts', 'logExpense', 'fmtExpense', 'editTxn', 'onCallback', 'applyFieldValue',
    'handleConfirm'].map(declaration).join('\n'), bot);
  return { bot, writes, messages };
}
const expense = { accountName: 'Card', account: 'Card', total: 10, payee: 'Shop', merchant: 'Shop',
  notes: '', category: 'Dining', date: '2026-09-08', split: true };

test('production name parser handles lists and rejects directive words', () => {
  const { bot } = fixture();
  for (const [text, expected] of [
    ['split with alice, bob and carol', ['Alice', 'Bob', 'Carol']],
    ['split w alice & bob', ['Alice', 'Bob']], ['split with ryan', ['Ryan']], ['just a note', []],
  ]) assert.deepEqual(Array.from(bot.extractPersons(text)), expected);
  assert.deepEqual(Array.from(bot.namesList(['Alice', 'bob'])), ['Alice', 'Bob']);
  assert.deepEqual(Array.from(bot.namesList('alice, bob')), ['Alice', 'Bob']);
  assert.deepEqual(Array.from(bot.namesList('split, paid, me, with')), []);
  assert.deepEqual(Array.from(bot.namesList('')), []);
});

test('split preview matches recorded cents, including rounding remainders', async () => {
  const { bot, writes } = fixture();
  for (const [total, count] of [[30, 2], [30, 1], [10, 2], [99.99, 3], [0.03, 2], [100, 4], [10.01, 1]]) {
    const persons = ['Alice', 'Bob', 'Carol', 'Ryan'].slice(0, count);
    await bot.logExpense({ ...expense, total, splitPersons: persons, splitAccounts: persons });
    const txn = writes.at(-1), [mine, ...others] = txn.subtransactions;
    assert.equal(txn.subtransactions.reduce((sum, t) => sum + t.amount, 0), txn.amount);
    assert.equal(txn.amount, -Math.round(total * 100));
    assert.ok(others.every(t => t.amount === others[0].amount));
    assert.ok(Math.abs(mine.amount - others[0].amount) <= count);
    const preview = bot.fmtExpense({ ...expense, total, persons });
    assert.ok(preview.includes(`your share $${(-mine.amount / 100).toFixed(2)}`), preview);
  }
});

test('legacy one-person inputs still record a 50/50 split', async () => {
  const { bot, writes } = fixture();
  await bot.logExpense({ ...expense, total: 30, splitPersonName: 'Ryan', splitAccountName: 'Ryan' });
  assert.deepEqual(writes[0].subtransactions.map(t => t.amount), [-1500, -1500]);
  assert.equal(writes[0].subtransactions[1].payee, 'pay-r');
});

test('editing a logged split reports the same share it records', async () => {
  const { bot, writes, messages } = fixture();
  await bot.editTxn(42, { ...expense, id: 'original', split: false }, 'split with Alice, Bob');
  assert.equal(writes[0].subtransactions[0].amount, -334);
  assert.match(messages.at(-1), /your share \$3\.34/);
});

test('one-tap split replaces previous partners in both preview and booked transfers', async () => {
  const { bot, writes } = fixture();
  await bot.onCallback({ id: 'tap', from: { id: 42 }, data: 'e:do:split', message: { chat: { id: 42 }, message_id: 77 } });
  const parsed = bot.confirming[42].parsed;
  assert.equal(parsed.person, 'Ryan');
  assert.deepEqual(Array.from(parsed.persons), ['Ryan']);
  await bot.logExpense({ ...expense, splitPersons: parsed.persons, splitAccounts: parsed.persons });
  assert.deepEqual(writes[0].subtransactions.map(t => t.payee).filter(Boolean), ['pay-r']);
  assert.match(bot.fmtExpense({ ...expense, ...parsed }), /50\/50 w\/ Ryan/);
});

test('selecting a payer clears the old forward-split list', async () => {
  const { bot } = fixture();
  await bot.onCallback({ id: 'tap', from: { id: 42 }, data: 'e:do:person', message: { chat: { id: 42 }, message_id: 77 } });
  assert.equal(bot.confirming[42].parsed.paid, true);
  assert.deepEqual(Array.from(bot.confirming[42].parsed.persons), []);
});

test('typed payer and split-name replies also replace previous partners', async () => {
  const { bot } = fixture();
  bot.editField[42] = { kind: 'pending', field: 'person' };
  await bot.applyFieldValue(42, 'Ryan');
  assert.deepEqual(Array.from(bot.confirming[42].parsed.persons), []);
  bot.confirming[42].awaitSplitName = true;
  bot.confirming[42].parsed = { split: true, person: 'Alice', persons: ['Alice', 'Bob'] };
  await bot.handleConfirm(42, 'split with Ryan');
  assert.deepEqual(Array.from(bot.confirming[42].parsed.persons), ['Ryan']);
});
