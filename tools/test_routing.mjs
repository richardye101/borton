// Real Telegram routing, with all network and financial writes replaced in memory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { test } from 'node:test';
import { createAgent, createGeminiGenerate, isAgentRequest, isReceiptEdit } from '../agent.mjs';
import { createActualTools } from '../actual-tools.mjs';
import { createRetryQueue, RetryableError, guardActualWrites } from '../retry-queue.mjs';

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
  const rec = { id: 'receipt-fixture', date: '2026-09-09', account: 'Scotiabank VI', payee: 'Shop', notes: 'Eggs and butter on sale', ts: Date.now() };
  const bot = vm.createContext({
    console: { log() {}, error() {} },
    currentMessage: () => undefined, checkpointMessage: () => {},
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
    'runAgent', 'runReplyAgent', 'sendAgentResult', 'agentConfirmKb', 'agentReceiptButton', 'editTxn', 'handleConfirm', 'handleVoice', 'dispatch',
    'onRelayPost', 'onUpdate', 'onCallback'].map(declaration).join('\n'), bot);
  return { bot, rec, writes, requests, messages, calls, confirmations, references };
}
const post = (text, reply = true) => ({ chat: { id: -42, type: 'channel' }, message_id: 92, text,
  ...(reply ? { reply_to_message: { message_id: 91 } } : {}) });

function queuedFixture(t) {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-queue-routing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = Date.parse('2026-09-10T21:57:00Z');
  const storage = new AsyncLocalStorage();
  Object.assign(f.bot, {
    structuredClone, Buffer, messageContext: storage, currentMessage: () => storage.getStore(),
    checkpointMessage: fields => { const job = storage.getStore(); if (job) f.bot.messageQueue.checkpoint(job, fields); },
    serializeActual: fn => fn(),
  });
  vm.runInContext(['progressMessage', 'messageQueueStatus', 'processMessageJob', 'acceptUpdate'].map(declaration).join('\n'), f.bot);
  f.reload = () => f.bot.messageQueue = createRetryQueue({ filePath: path.join(dir, 'queue.json'), now: () => now, onStatus: f.bot.messageQueueStatus });
  f.advance = ms => now += ms;
  f.run = () => f.bot.messageQueue.runOne(f.bot.processMessageJob);
  f.reload();
  return f;
}

test('voice-to-agent 429 queues once, resumes after restart without retranscribing or retargeting', async t => {
  const f = queuedFixture(t); let transcripts = 0, attempts = 0;
  f.bot.transcribeVoiceNote = async () => { transcripts++; return { transcript: "Remember Sam's card ending 1234", ft: null }; };
  f.bot.budgetAgent.message = async (_chat, text, options) => {
    f.calls.push(text);
    if (++attempts === 1) throw new RetryableError('Gemini HTTP 429.');
    assert.equal(options.retryFailures, true);
    return { text: 'Ready for confirmation', planId };
  };
  await f.bot.acceptUpdate({ update_id: 1, channel_post: { ...post(undefined), voice: { file_id: 'voice' } } });
  await f.run();
  assert.equal(f.bot.messageQueue.jobs[0].status, 'retry');
  assert.equal(f.messages.filter(m => /Queued/.test(m.text)).length, 1);
  assert.ok(f.messages.every(m => !/429|Please try again/.test(m.text)));
  f.bot.lastTxn[-42] = { id: 'newer-unrelated-receipt' };
  f.bot.msgTxn['-42:91'] = f.bot.lastTxn[-42];
  f.reload(); f.advance(60_000); await f.run();
  assert.equal(transcripts, 1); assert.equal(attempts, 2);
  assert.ok(f.references.every(r => !r.text.includes('newer-unrelated')));
  assert.equal(f.bot.messageQueue.jobs.length, 0);
  assert.equal(f.messages.filter(m => m.keyboard).length, 1);
  assert.deepEqual(f.writes, []);
});

test('photo extraction and voice transcription failures reach the durable worker', async t => {
  for (const kind of ['photo', 'voice']) {
    const f = queuedFixture(t); let attempts = 0;
    Object.assign(f.bot, {
      cardmap: { byLast4: { '1234': 'Card' } }, parseCaption: () => ({}), ownerOf: () => null,
      downloadPhoto: async () => ({ buf: Buffer.from('test'), mime: 'image/jpeg' }),
      downloadTelegramFile: async () => ({ buf: Buffer.from('test') }),
      RECEIPT_SCHEMA: {}, VOICE_SCHEMA: {},
      geminiGenerate: async () => {
        if (++attempts === 1) throw new RetryableError('Gemini HTTP 503.');
        return kind === 'photo' ? { merchant: 'Shop', total: 6.98, card_last4: '1234' } : { text: 'Show the budget', isExpense: false };
      },
    });
    vm.runInContext(['handlePhoto', 'extractReceipt', 'transcribeVoiceNote', 'parseVoice'].map(declaration).join('\n'), f.bot);
    const media = kind === 'photo' ? { photo: [{ file_id: 'photo' }] } : { voice: { file_id: 'voice' } };
    await f.bot.acceptUpdate({ update_id: 1, channel_post: { chat: { id: -42 }, message_id: 1, ...media } });
    await f.run();
    assert.equal(f.bot.messageQueue.jobs[0].status, 'retry');
    f.advance(60_000); await f.run();
    assert.equal(attempts, 2); assert.equal(f.bot.messageQueue.jobs.length, 0);
    assert.equal(f.messages.filter(m => /reading receipt|transcribing/.test(m.text)).length, 1);
    assert.ok(f.messages.every(m => !/503|Couldn't|try again/.test(m.text)));
  }
});

test('delivery failure after logging cannot duplicate the receipt', async t => {
  const f = queuedFixture(t);
  const api = guardActualWrites({ addTransactions: async () => f.writes.push('write') }, () => f.bot.checkpointMessage({ unsafe: true }));
  f.bot.handlePhoto = async () => { await api.addTransactions(); throw new RetryableError('Telegram unavailable'); };
  await f.bot.acceptUpdate({ update_id: 1, channel_post: { chat: { id: -42 }, message_id: 1, photo: [{ file_id: 'photo' }] } });
  await f.run(); f.reload(); f.advance(60_000); await f.run();
  assert.deepEqual(f.writes, ['write']);
  assert.equal(f.bot.messageQueue.jobs[0].reason, 'write-outcome-uncertain');
});

test('queued requests retain the received date and cannot execute through buttons or another chat', async t => {
  const f = queuedFixture(t);
  vm.runInContext(declaration('todayISO'), f.bot);
  f.bot.budgetAgent.message = async (_chat, _text, options) => {
    assert.equal(f.bot.todayISO(), '2026-09-10');
    assert.equal(options.receivedAt, Date.parse('2026-09-10T21:57:00Z'));
    throw new RetryableError('429');
  };
  await f.bot.acceptUpdate({ update_id: 1, channel_post: { ...post('Show the budget'), date: Date.parse('2026-09-10T21:57:00Z') / 1000 } });
  await f.run();
  await f.bot.acceptUpdate({ update_id: 2, callback_query: { id: 'tap', from: { id: 42 }, data: `ag:y:${planId}`, message: { chat: { id: -42 } } } });
  assert.deepEqual(f.confirmations, []);
  assert.match(f.requests.at(-1).params.text, /earlier message is queued/);
  await f.bot.acceptUpdate({ update_id: 3, message: { chat: { id: 7 }, text: 'Show the budget' } });
  assert.equal(f.bot.messageQueue.jobs.length, 1);
  f.advance(3_600_000); await f.run();
});

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
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(f.calls[0].text, /receipt-fixture|Shop|Scotiabank/);
  assert.match(f.calls[0].text, /quoted message/i);
});

test('quoted receipt text reaches the agent for text, voice and pending-plan replies', async () => {
  const quoted = '{ “amount”: $7.35,“merchant”:Tinas 4 Ever Flowers,“card”: Tangerine Client Card}';
  for (const mode of ['text', 'voice', 'pending']) {
    const f = fixture();
    if (mode === 'pending') f.bot.budgetAgent.pending = () => ({ id: planId });
    f.bot.transcribeVoiceNote = async () => ({ transcript: 'Can you log this', ft: null });
    const msg = { ...post('Can you log this'), reply_to_message: { message_id: 999, date: 1789244640, text: quoted } };
    if (mode === 'voice') { msg.voice = { file_id: 'voice' }; delete msg.text; }
    await f.bot.onRelayPost(msg);
    assert.equal(f.calls.length, 1);
    for (const value of ['Can you log this', '7.35', 'Tinas 4 Ever Flowers', 'Tangerine Client Card']) assert.ok(f.calls[0].text.includes(value), mode + ': ' + value);
    assert.match(f.calls[0].text, /check.*already.*logged/i);
    assert.deepEqual(f.references, []);
    assert.deepEqual(f.writes, []);
    assert.ok(f.messages.every(m => !/cannot safely identify/i.test(m.text)));
  }
});

test('quoted receipt photo is read once and retained through agent retries', async t => {
  const f = queuedFixture(t); let downloads = 0, attempts = 0;
  f.bot.downloadPhoto = async () => { downloads++; return { buf: Buffer.from('receipt'), mime: 'image/jpeg' }; };
  f.bot.extractReceipt = async () => ({ merchant: 'Flower Shop', total: 7.35, date: '2026-09-12' });
  f.bot.budgetAgent.message = async (_chat, text) => {
    f.calls.push(text);
    assert.match(text, /Flower Shop/);
    assert.match(text, /7\.35/);
    if (++attempts === 1) throw new RetryableError('Gemini HTTP 503.');
    return { text: 'Ready', planId };
  };
  await f.bot.acceptUpdate({ update_id: 1, channel_post: { ...post('Log this on New Debit'),
    reply_to_message: { message_id: 999, date: 1789244640, photo: [{ file_id: 'original-photo' }], caption: 'Birthday flowers' } } });
  await f.run();
  assert.equal(f.bot.messageQueue.jobs[0]?.status, 'retry');
  f.reload(); f.advance(60_000); await f.run();
  assert.equal(downloads, 1);
  assert.equal(attempts, 2);
  assert.equal(new Set(f.calls).size, 1);
  assert.equal(f.bot.messageQueue.jobs.length, 0);
  assert.deepEqual(f.writes, []);
});

test('Telegram quote fragments are included without mistaking a reply for a new account name', async () => {
  const f = fixture();
  f.bot.pending[-42] = { awaitNewAccount: true };
  await f.bot.onRelayPost({ ...post('Log this', false), quote: { text: '$7.35 Flower Shop' },
    reply_to_message: { message_id: 999, text: 'Can you log this', quote: { text: 'New Debit, 2026-09-12' } } });
  assert.match(f.calls[0].text, /7\.35 Flower Shop/);
  assert.match(f.calls[0].text, /New Debit/);
  assert.equal(f.bot.pending[-42].awaitNewAccount, true);
  assert.deepEqual(f.writes, []);
});

test('live Gemini logs a missing quoted receipt but recognizes an already logged one', { skip: process.env.BORTON_LIVE_SMOKE !== '1' }, async () => {
  for (const exists of [false, true]) {
    const f = fixture(); let transactionReads = 0;
    const transaction = { id: 'existing-flower-receipt', account: 'debit', amount: -735, date: '2026-09-12', payee: 'flowers', category: 'gifts' };
    const api = {
      getAccounts: async () => [{ id: 'debit', name: 'New Debit', closed: false, offbudget: false }],
      getPayees: async () => [{ id: 'flowers', name: 'Flower Shop' }],
      getCategories: async () => [{ id: 'gifts', name: 'Gifts' }], getCategoryGroups: async () => [],
      getTransactions: async (_account, start, end) => { transactionReads++; return exists && start <= transaction.date && end >= transaction.date ? [{ ...transaction }] : []; },
    };
    f.bot.budgetAgent = createAgent({ tools: createActualTools(api), allowedChatId: 42, allowedChatIds: [-42],
      planOnly: true, now: () => Date.parse('2026-09-12T12:00:00Z'),
      generate: createGeminiGenerate({ apiKey: process.env.GOOGLE_API_KEY,
        models: JSON.parse(process.env.BORTON_SMOKE_MODELS || '["gemini-flash-latest"]') }) });
    await f.bot.onRelayPost({ ...post('Can you log this'), reply_to_message: { message_id: 999, date: 1789244640,
      text: '{ “amount”: $7.35, “merchant”: Flower Shop, “card”: New Debit, “date”: 2026-09-12 }' } });
    assert.ok(transactionReads > 0, 'Check Actual before logging: ' + f.messages.at(-1)?.text);
    const plan = f.bot.budgetAgent.pending(-42);
    if (exists) {
      assert.equal(plan, null, 'Do not stage a duplicate charge');
      assert.match(f.messages.at(-1).text, /already|exists|recorded/i);
    } else {
      assert.ok(plan, f.messages.at(-1).text);
      assert.equal(plan.operations.length, 1);
      assert.equal(plan.operations[0].domain, 'transaction');
      assert.equal(plan.operations[0].action, 'create');
      assert.equal(plan.operations[0].fields.amount, -735);
      assert.equal(plan.operations[0].fields.account, 'debit');
      assert.equal(plan.operations[0].fields.payee, 'flowers');
      assert.equal(plan.operations[0].fields.date, '2026-09-12');
    }
    assert.deepEqual(f.writes, []);
  }
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
  f.bot.pending[-42] = { awaitNewAccount: true, receipt: { merchant: 'Flower Shop', total: 7.35, date: '2026-09-09' }, parsed: {} };
  Object.assign(f.bot, { safeDate: date => date, maybeAutoSplit: (_r, p) => p, guessCategory: () => 'Gifts' });
  await f.bot.handleCardAnswer(-42, 'New Card');
  assert.match(f.calls.at(-1).text, /"New Card"/);
  assert.match(f.calls.at(-1).text, /same plan/i);
  assert.match(f.calls.at(-1).text, /Flower Shop/);
  assert.match(f.calls.at(-1).text, /7\.35/);
  assert.doesNotMatch(f.calls.at(-1).text, /Do not log the pending receipt yet/);
  assert.equal(f.bot.pending[-42], undefined);
  f.bot.pending[-42] = { ingest: { amount: 6.98 } };
  f.bot.resolveAccount = () => 'Card'; f.bot.cardKb = () => ({});
  await f.bot.handleCardAnswer(-42, 'Card');
  assert.match(f.messages.at(-1).text, /verify the owner/);
  assert.deepEqual(f.writes, []);
});

test('new-account receipt survives retry and restart; one owner confirmation logs it exactly once', async t => {
  const f = queuedFixture(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-account-receipt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accounts = [], transactions = [], prompts = [];
  const api = {
    sync: async () => {}, getAccounts: async () => structuredClone(accounts),
    getCategories: async () => [{ id: 'gifts', name: 'Gifts' }],
    getPayees: async () => [{ id: 'flowers', name: 'Flower Shop' }],
    createAccount: async fields => { f.writes.push('account'); accounts.push({ ...fields, id: 'new-card' }); return 'new-card'; },
    addTransactions: async (_account, rows) => { f.writes.push('transaction'); transactions.push(...rows.map(row => ({ ...row, id: 'new-txn' }))); },
    getTransactions: async () => structuredClone(transactions),
  };
  let turn = 0;
  const generate = async ({ contents }) => {
    const prompt = contents.find(c => c.role === 'user')?.parts[0].text;
    prompts.push(prompt);
    assert.match(prompt, /Flower Shop/);
    assert.match(prompt, /7\.35/);
    assert.match(prompt, /2026-09-09/);
    const call = (name, args) => ({ role: 'model', parts: [{ functionCall: { name, args } }] });
    switch (++turn) {
      case 1: throw new RetryableError('Gemini HTTP 503.');
      case 2: return call('propose_account_change', { action: 'create', fields: { name: 'New Debit' }, ref: 'card' });
      case 3: return { role: 'model', parts: [{ text: 'Account ready.' }] }; // Must not expose this incomplete plan.
      case 4:
        assert.match(contents.at(-1).parts[0].text, /receipt.*transaction/i);
        return call('propose_transaction_changes', { changes: [{ action: 'create', fields: {
          account: '$card', date: '2026-09-09', amount: -735, payee: 'flowers', category: 'gifts', notes: 'Birthday flowers',
        } }] });
      case 5: return { role: 'model', parts: [{ text: 'Both ready.' }] };
      default: throw new Error('Unexpected model call');
    }
  };
  const reloadAgent = () => f.bot.budgetAgent = createAgent({ tools: createActualTools(api), generate,
    allowedChatId: 42, allowedChatIds: [-42], statePath: path.join(dir, 'agent.json') });
  reloadAgent();
  Object.assign(f.bot, { safeDate: date => date, maybeAutoSplit: (_r, p) => p, guessCategory: () => 'Gifts', refreshActualMaps: async () => {} });
  vm.runInContext(declaration('handleCardAnswer'), f.bot);
  f.bot.pending[-42] = { awaitNewAccount: true, receipt: { merchant: 'Flower Shop', total: 7.35, date: '2026-09-09' }, parsed: { notes: 'Birthday flowers' } };
  await f.bot.acceptUpdate({ update_id: 1, channel_post: post('New Debit', false) });
  await f.run();
  assert.equal(f.bot.messageQueue.jobs[0].status, 'retry');
  assert.deepEqual(f.writes, []);
  f.reload(); reloadAgent(); f.advance(60_000); await f.run();
  assert.equal(new Set(prompts).size, 1, 'Retries retain the original receipt, not the new account-name message alone');
  const plan = f.bot.budgetAgent.pending(-42);
  assert.equal(plan?.operations.length, 2);
  assert.equal(f.bot.pending[-42], undefined);
  assert.equal(f.bot.messageQueue.jobs.length, 0);
  assert.equal(f.messages.filter(m => m.keyboard).length, 1);
  assert.deepEqual(f.writes, []);
  reloadAgent(); // Confirmation must survive a separate restart after staging.
  const tap = { id: 'tap', from: { id: 42 }, data: `ag:y:${plan.id}`, message: { chat: { id: -42 }, message_id: 100 } };
  await f.bot.onCallback({ ...tap, from: { id: 7 } });
  assert.deepEqual(f.writes, []);
  await f.bot.onCallback(tap);
  assert.deepEqual(f.writes, ['account', 'transaction']);
  assert.equal(transactions[0].account, 'new-card');
  assert.equal(transactions[0].amount, -735);
  assert.equal(transactions[0].notes, 'Birthday flowers');
  reloadAgent(); await f.bot.onCallback(tap);
  assert.deepEqual(f.writes, ['account', 'transaction']);
});

test('new-account handoff preserves Shortcut data and cannot leave a stale card-button write path', async () => {
  const f = fixture();
  Object.assign(f.bot, { safeDate: date => date, maybeAutoSplit: (_r, p) => p, guessCategory: () => 'Gifts' });
  vm.runInContext(declaration('handleCardAnswer'), f.bot);
  f.bot.pending[-42] = { awaitNewAccount: true, ingest: { amount: 7.35, merchant: 'Flower Shop', date: '2026-09-09',
    note: 'Birthday flowers', last4: '1234', split: true, with: 'Sam' } };
  await f.bot.handleCardAnswer(-42, 'New Card');
  const text = f.calls.at(-1).text;
  for (const value of ['7.35', 'Flower Shop', '2026-09-09', 'Birthday flowers', '1234', 'Sam']) assert.ok(text.includes(value));
  assert.ok(text.includes('"split":true'));
  assert.equal(f.bot.pending[-42], undefined);
  await f.bot.onCallback({ id: 'tap', from: { id: 42 }, data: 'card:New Card', message: { chat: { id: -42 }, message_id: 100 } });
  assert.deepEqual(f.writes, []);
});

test('live Gemini includes the new account and receipt in one plan using synthetic data', { skip: process.env.BORTON_LIVE_SMOKE !== '1' }, async () => {
  const f = fixture();
  Object.assign(f.bot, { safeDate: date => date, maybeAutoSplit: (_r, p) => p, guessCategory: () => 'Gifts' });
  vm.runInContext(declaration('handleCardAnswer'), f.bot);
  const api = {
    getAccounts: async () => [], getTransactions: async () => [],
    getPayees: async () => [{ id: 'flowers', name: 'Flower Shop' }],
    getCategories: async () => [{ id: 'gifts', name: 'Gifts' }], getCategoryGroups: async () => [],
  };
  f.bot.budgetAgent = createAgent({ tools: createActualTools(api), allowedChatId: 42, allowedChatIds: [-42],
    planOnly: true, now: () => Date.parse('2026-09-12T12:00:00Z'),
    generate: createGeminiGenerate({ apiKey: process.env.GOOGLE_API_KEY,
      models: JSON.parse(process.env.BORTON_SMOKE_MODELS || '["gemini-flash-latest"]') }) });
  f.bot.pending[-42] = { awaitNewAccount: true, receipt: { merchant: 'Flower Shop', total: 7.35, date: '2026-09-09' }, parsed: { notes: 'Birthday flowers' } };
  await f.bot.handleCardAnswer(-42, 'New Debit');
  const plan = f.bot.budgetAgent.pending(-42);
  assert.ok(plan, `Expected a complete plan: ${f.messages.map(m => m.text).join('; ')}`);
  const account = plan.operations.find(op => op.domain === 'account' && op.action === 'create');
  const transaction = plan.operations.find(op => op.domain === 'transaction' && op.action === 'create');
  assert.equal(plan.operations.length, 2);
  assert.equal(account?.fields.name, 'New Debit');
  assert.equal(account.initialBalance || 0, 0);
  assert.ok(account.ref);
  assert.equal(transaction?.fields.account, '$' + account.ref);
  assert.equal(transaction.fields.amount, -735);
  assert.equal(transaction.fields.date, '2026-09-09');
  assert.equal(transaction.fields.payee, 'flowers');
  assert.equal(transaction.fields.category, 'gifts');
  assert.equal(transaction.fields.notes, 'Birthday flowers');
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
