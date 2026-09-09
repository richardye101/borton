// Real Telegram routing, with all network and financial writes replaced in memory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createAgent, createGeminiGenerate, isAgentRequest, isReceiptEdit } from '../agent.mjs';
import { createActualTools } from '../actual-tools.mjs';

const source = fs.readFileSync(new URL('../bot.mjs', import.meta.url), 'utf8');
function declaration(name) {
  const constant = source.match(new RegExp(`^const ${name} = .+;$`, 'm'));
  if (constant) return constant[0];
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `Missing production function: ${name}`);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const planId = 'a'.repeat(32);
function fixture() {
  const writes = [], requests = [], messages = [], calls = [], confirmations = [], references = [];
  const rec = { id: 'receipt-fixture', date: '2026-09-09', notes: 'Eggs and butter on sale', ts: Date.now() };
  const bot = vm.createContext({
    console: { log() {}, error() {} },
    cfg: { telegram: { allowedChatId: 42, relayChannelId: -42 }, agent: { relayEnabled: true }, defaults: {} },
    budgetAgent: {
      pending: () => null,
      remember: (chat, text) => references.push({ chat, text }),
      message: async (chat, text) => { calls.push({ chat, text }); return { text: 'Change date to 2026-09-08?', planId }; },
      confirm: async (chat, id) => { confirmations.push({ chat, id }); return { text: 'Applied' }; },
      cancel: async (chat, id) => { confirmations.push({ chat, id, cancel: true }); return { text: 'Cancelled' }; },
    },
    pending: {}, confirming: {}, ownerPending: {}, editField: {},
    lastTxn: { 42: rec, '-42': rec }, msgTxn: { '42:91': rec, '-42:91': rec, 91: rec },
    REACT_SEEN: 'seen', REACT_DONE: 'done', EDIT_WINDOW_MS: 3600000,
    react: async () => {},
    tg: async (method, params) => { requests.push({ method, params }); return { ok: true }; },
    send: async (chat, text, keyboard) => { messages.push({ chat, text, keyboard }); return 100; },
    dropKb: async () => {}, persistTxns: () => {},
    api: { updateTransaction: async (id, fields) => writes.push({ id, fields: structuredClone(fields) }), sync: async () => {} },
    parseExpense: async () => null, extractPaid: () => null, isAgentRequest, isReceiptEdit,
    transcribeVoiceNote: async () => ({ transcript: 'This should be Sept 8th', ft: null }),
    finalize: async () => writes.push({ receipt: true }),
    handleFreeText: async () => writes.push({ expense: true }),
    handleIngest: async () => { writes.push({ ingest: true }); return { id: 'ingested', ts: Date.now() }; },
    handlePhoto: async () => writes.push({ photo: true }),
    applyFieldValue: async () => {}, handleCardAnswer: async () => {},
  });
  vm.runInContext(['isRelay', 'isAllowedChat', 'isOwner', 'agentFor', 'receiptFor',
    'runAgent', 'sendAgentResult', 'editTxn', 'handleConfirm', 'handleVoice', 'dispatch',
    'onRelayPost', 'onUpdate', 'onCallback'].map(declaration).join('\n'), bot);
  return { bot, rec, writes, requests, messages, calls, confirmations, references };
}
const post = (text, reply = true) => ({ chat: { id: -42, type: 'channel' }, message_id: 92, text,
  ...(reply ? { reply_to_message: { message_id: 91 } } : {}) });

test('screenshot exchange reaches the channel agent without appending notes', async () => {
  const f = fixture();
  await f.bot.onUpdate({ channel_post: post('This should be Sept 8th') });
  await f.bot.onUpdate({ channel_post: post('Not a note', false) });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls.map(c => c.text), ['This should be Sept 8th', 'Not a note']);
  assert.ok(f.calls.every(c => c.chat === -42));
  assert.ok(f.references.some(r => r.text.includes('receipt-fixture')));
  assert.ok(f.messages.every(m => !/Note added|relay error/.test(m.text)));
  assert.equal(f.messages[0].keyboard.inline_keyboard[0][0].callback_data, `ag:y:${planId}`);
});

test('the same natural correction works in private chat and by voice', async () => {
  for (const chat of [42, -42]) {
    const f = fixture();
    await f.bot.dispatch(chat, { text: 'This should be Sept 8th', reply_to_message: { message_id: 91 } });
    await f.bot.dispatch(chat, { voice: { file_id: 'voice' }, reply_to_message: { message_id: 91 } });
    assert.deepEqual(f.writes, []);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(c => c.text === 'This should be Sept 8th'));
  }
});

test('only the owner can press agent or legacy confirmation buttons', async () => {
  const f = fixture();
  for (const from of [undefined, { id: 7 }]) for (const data of [`ag:y:${planId}`, `ag:n:${planId}`, 'c:y', 'e:del']) {
    f.bot.confirming[-42] = { receipt: {}, parsed: {}, account: 'Card' };
    await f.bot.onCallback({ id: 'tap', from, data, message: { chat: { id: -42 }, message_id: 100 } });
  }
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.confirmations, []);
  await f.bot.onCallback({ id: 'tap', from: { id: 42 }, data: `ag:y:${planId}`, message: { chat: { id: -42 }, message_id: 100 } });
  assert.deepEqual(f.confirmations, [{ chat: -42, id: planId }]);
  await f.bot.onCallback({ id: 'tap', from: { id: 42 }, data: `ag:y:${planId}`, message: { chat: { id: -99 }, message_id: 100 } });
  assert.equal(f.confirmations.length, 1);
});

test('typed channel yes cannot bypass owner-only receipt confirmation', async () => {
  const f = fixture();
  f.bot.confirming[-42] = { receipt: {}, parsed: {}, account: 'Card' };
  await f.bot.onRelayPost(post('yes', false));
  assert.deepEqual(f.writes, []);
  assert.ok(f.bot.confirming[-42]);
});

test('channel agent access is opt-in; unknown chats stay denied', async () => {
  const f = fixture();
  f.bot.cfg.agent.relayEnabled = false;
  await f.bot.onRelayPost(post('This should be Sept 8th'));
  await f.bot.onRelayPost({ ...post('hello'), chat: { id: -99 } });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.calls, []);
});

test('receipt uploads remain separate from natural-language commands', async () => {
  const f = fixture();
  await f.bot.onRelayPost(post('{"amount":6.98,"card":"Card"}', false));
  await f.bot.onRelayPost({ ...post('', false), photo: [{ file_id: 'photo' }] });
  assert.deepEqual(f.writes, [{ ingest: true }, { photo: true }]);
  assert.deepEqual(f.calls, []);
});

test('receipt message IDs and legacy fallback cannot cross chats', async () => {
  const f = fixture();
  f.bot.msgTxn['42:91'] = { id: 'private-receipt' };
  f.bot.msgTxn['-42:91'] = { id: 'channel-receipt' };
  await f.bot.dispatch(42, { text: 'This should be Sept 8th', reply_to_message: { message_id: 91 } });
  await f.bot.onRelayPost(post('This should be Sept 8th'));
  assert.match(f.references.find(r => r.chat === 42).text, /private-receipt/);
  assert.match(f.references.find(r => r.chat === -42).text, /channel-receipt/);
  delete f.bot.msgTxn['-42:91'];
  f.bot.msgTxn[91] = { id: 'private-receipt' };
  assert.equal(f.bot.receiptFor(-42, 91), null);
});

test('explicit private note edits survive, and a stale receipt button cannot confirm another receipt', async () => {
  const f = fixture();
  await f.bot.dispatch(42, { text: 'note: corrected note', reply_to_message: { message_id: 91 } });
  assert.deepEqual(f.writes, [{ id: 'receipt-fixture', fields: { notes: 'corrected note' } }]);
  f.bot.confirming[-42] = { promptMid: 101, receipt: {}, parsed: {}, account: 'Card' };
  await f.bot.onCallback({ id: 'tap', from: { id: 42 }, data: 'c:y', message: { chat: { id: -42 }, message_id: 100 } });
  assert.ok(f.bot.confirming[-42]);
  assert.equal(f.writes.length, 1);
});

test('an unlinked reply cannot silently target the latest receipt', async () => {
  const f = fixture();
  await f.bot.onRelayPost({ ...post('This should be Sept 8th'), reply_to_message: { message_id: 999 } });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.references, []);
  assert.match(f.messages.at(-1).text, /cannot safely identify/);
});

test('replying to another receipt while a plan is pending supplies the new reference', async () => {
  const f = fixture();
  f.bot.budgetAgent.pending = () => ({ id: planId });
  f.bot.msgTxn['-42:91'] = { id: 'different-receipt' };
  await f.bot.onRelayPost(post('This should be Sept 8th'));
  assert.match(f.references.at(-1).text, /different-receipt/);
  assert.deepEqual(f.writes, []);
});

test('channel field edits and new accounts stage plans instead of writing anonymously', async () => {
  const f = fixture();
  vm.runInContext(['applyFieldValue', 'handleCardAnswer'].map(declaration).join('\n'), f.bot);
  f.bot.editField[-42] = { kind: 'logged', field: 'note', mid: 91 };
  await f.bot.applyFieldValue(-42, 'corrected note');
  assert.equal(f.calls.at(-1).text, 'note: corrected note');
  f.bot.pending[-42] = { awaitNewAccount: true };
  await f.bot.handleCardAnswer(-42, 'New Card');
  assert.match(f.calls.at(-1).text, /Create an Actual account named "New Card"/);
  f.bot.pending[-42] = { ingest: { amount: 6.98 } };
  f.bot.resolveAccount = () => 'Card'; f.bot.cardKb = () => ({});
  await f.bot.handleCardAnswer(-42, 'Card');
  assert.match(f.messages.at(-1).text, /verify the owner/);
  assert.deepEqual(f.writes, []);
});

test('live Gemini stages the screenshot date correction using synthetic budget data', { skip: process.env.BORTON_LIVE_SMOKE !== '1' }, async () => {
  const f = fixture();
  const transaction = { ...f.rec, account: 'card-fixture', payee: 'shop-fixture', category: 'food-fixture', amount: -698, cleared: false };
  const api = {
    getAccounts: async () => [{ id: 'card-fixture', name: 'Scotiabank VI', offbudget: false, closed: false }],
    getPayees: async () => [{ id: 'shop-fixture', name: 'Shop' }],
    getCategories: async () => [{ id: 'food-fixture', name: 'Groceries' }],
    getCategoryGroups: async () => [],
    getTransactions: async (_account, start, end) => transaction.date >= start && transaction.date <= end ? [{ ...transaction }] : [],
    q: () => ({ filter(where) { this.where = where; return this; }, select() { return this; } }),
    aqlQuery: async q => ({ data: q.where.id === transaction.id ? [{ ...transaction }] : [] }),
  };
  f.bot.budgetAgent = createAgent({ tools: createActualTools(api), allowedChatId: 42, allowedChatIds: [-42],
    planOnly: true, now: () => Date.parse('2026-09-09T12:00:00Z'),
    generate: createGeminiGenerate({ apiKey: process.env.GOOGLE_API_KEY,
      models: JSON.parse(process.env.BORTON_SMOKE_MODELS || '["gemini-flash-latest"]') }) });
  await f.bot.onRelayPost(post('This should be Sept 8th'));
  const pending = f.bot.budgetAgent.pending(-42);
  assert.ok(pending, `A date-change confirmation plan should be staged: ${f.messages.map(m => m.text).join('; ')}`);
  assert.equal(pending.operations.length, 1);
  assert.equal(pending.operations[0].id, 'receipt-fixture');
  assert.deepEqual(pending.operations[0].fields, { date: '2026-09-08' });
  assert.deepEqual(f.writes, []);
});
