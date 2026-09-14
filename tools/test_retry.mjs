import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRetryQueue, guardActualWrites, RetryableError, QueueStorageError, retryAfterMs } from '../retry-queue.mjs';
import { createAgent, createGeminiGenerate } from '../agent.mjs';
import { ToolError } from '../actual-tools.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-retry-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'queue.json'), notices = [];
  const logs = [];
  t.mock.method(console, 'error', (...args) => logs.push(args.join(' ')));
  let time = Date.parse('2026-09-10T21:57:00Z');
  const options = { filePath, now: () => time, onStatus: async (job, status) => notices.push([job.id, status]) };
  return { filePath, notices, logs, options, reload: () => createRetryQueue(options), advance: ms => time += ms };
}

test('permanent failure diagnostics persist before notification and redact credentials in logs', async t => {
  const f = fixture(t);
  const secret = 'a private/password';
  f.options.secrets = [secret];
  f.options.onStatus = async () => {
    assert.equal(JSON.parse(fs.readFileSync(f.filePath)).jobs[0].lastErrorDetails.name, 'TypeError');
    throw Error('Telegram offline');
  };
  const q = f.reload();
  q.acknowledge(1, 42, { text: 'private receipt text' });
  const cause = Object.assign(Error('upstream rejected schema'), { code: 'INVALID_ARGUMENT' });
  await q.runOne(async () => { throw new TypeError(`failed ${secret} ${encodeURIComponent(secret)} https://user:pass@example.test/?key=hidden Authorization: Bearer bearer-secret api_key=key-secret`, { cause }); });
  const job = f.reload().jobs[0];
  assert.equal(job.status, 'dead');
  assert.equal(job.lastErrorDetails.cause.message, 'upstream rejected schema');
  assert.equal(job.lastErrorDetails.cause.code, 'INVALID_ARGUMENT');
  assert.match(job.lastErrorDetails.stack, /test_retry\.mjs/);
  assert.equal(job.lastError, job.lastErrorDetails.message);
  const diagnostics = JSON.stringify(job.lastErrorDetails) + f.logs.join('\n');
  for (const value of [secret, encodeURIComponent(secret), 'hidden', 'bearer-secret', 'key-secret', 'private receipt text']) assert.ok(!diagnostics.includes(value), value);
  assert.match(f.logs[0], /"id":1/);
  assert.match(f.logs[0], /non-retryable-failure/);
  await f.reload().runOne(async () => assert.fail('must not replay'));
  assert.equal(f.logs.length, 1);
});

test('each retry records its latest cause, including exhaustion and uncertain writes', async t => {
  const f = fixture(t), q = f.reload();
  q.acknowledge(1, 42, { text: 'retry' });
  await q.runOne(async () => { throw new RetryableError('Gemini HTTP 429.', 180_000); });
  assert.equal(q.jobs[0].nextAt - f.options.now(), 180_000);
  assert.equal(f.reload().jobs[0].lastError, 'Gemini HTTP 429.');
  f.advance(180_000);
  await q.runOne(async () => { throw new RetryableError('Gemini HTTP 503.'); });
  assert.equal(f.reload().jobs[0].lastError, 'Gemini HTTP 503.');
  assert.equal(f.logs.length, 2);
  f.advance(86_400_000);
  await q.runOne(async () => assert.fail('expired'));
  assert.equal(f.reload().jobs[0].lastError, 'Gemini HTTP 503.');
  q.acknowledge(2, 42, { text: 'write' });
  await q.runOne(async job => { q.checkpoint(job, { unsafe: true }); throw new RetryableError('lost write response'); });
  assert.equal(f.reload().jobs[1].lastError, 'lost write response');
  assert.equal(q.jobs[1].reason, 'write-outcome-uncertain');
});

test('diagnostics are bounded and handle non-Error throws and circular causes', async t => {
  const f = fixture(t), q = f.reload();
  const e = new Error('x'.repeat(20_000)); e.cause = e;
  for (const [i, value] of [e, null, 'plain failure', { message: 'object failure', token: 'not-serialized' }].entries()) {
    q.acknowledge(i + 1, 42, { text: 'test' });
    await q.runOne(async () => { throw value; });
    const details = f.reload().jobs[i].lastErrorDetails;
    assert.ok(details.message.length <= 1024);
    assert.ok(JSON.stringify(details).length < 18_000);
    assert.ok(!JSON.stringify(details).includes('not-serialized'));
  }
  assert.equal(q.jobs[2].lastError, 'plain failure');
  assert.equal(q.jobs[3].lastError, 'object failure');
});

test('Gemini failures retain diagnostic causes without changing public errors or retry classification', async t => {
  const f = fixture(t);
  for (const [i, status] of [400, 429, 503].entries()) {
    const q = f.reload();
    q.acknowledge(i + 1, 42 + i, { text: 'ask' });
    const g = createGeminiGenerate({ apiKey: 'test', models: ['fake-model'], fetchImpl: async () => ({
      ok: false, status, headers: new Headers(), json: async () => ({ error: { message: 'schema detail', status: 'INVALID_ARGUMENT' } }),
    }) });
    await q.runOne(async () => g({ contents: [], declarations: [], system: '', signal: AbortSignal.timeout(1000) }));
    const job = f.reload().jobs[i];
    assert.equal(job.lastError, `Gemini HTTP ${status}.`);
    assert.match(job.lastErrorDetails.cause.message, /fake-model.*schema detail/);
    assert.equal(job.status, status === 400 ? 'dead' : 'retry');
  }
  const g = createGeminiGenerate({ apiKey: 'test', models: ['fake-model'], fetchImpl: async () => ({ ok: true,
    json: async () => ({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }),
  }) });
  await assert.rejects(() => g({ contents: [], declarations: [], system: '', signal: AbortSignal.timeout(1000) }),
    e => e.message === 'Gemini could not answer this request.' && /MALFORMED_FUNCTION_CALL/.test(e.cause?.message));
});

test('agent preserves Actual and proposal causes without exposing diagnostics in its public message', async t => {
  const f = fixture(t), q = f.reload();
  const actual = Error('Actual read failed at storage');
  const reader = createAgent({ allowedChatId: 42, tools: { declarations: [], read: async () => { throw actual; } },
    generate: async () => ({ role: 'model', parts: [{ functionCall: { name: 'list_accounts' } }] }),
  });
  q.acknowledge(1, 42, { text: 'read' });
  await q.runOne(job => reader.message(job.chatId, 'read', { retryFailures: true }));
  assert.equal(q.jobs[0].status, 'retry');
  assert.equal(q.jobs[0].lastError, 'Actual is temporarily unavailable.');
  assert.equal(q.jobs[0].lastErrorDetails.cause.message, actual.message);
  let round = 0, proposal = 0;
  const planner = createAgent({ allowedChatId: 43, tools: { declarations: [], prepare: async () => {
    if (proposal++) throw new ToolError('splitPersons must be a list');
    return [{ preview: 'staged only' }];
  } }, generate: async () => ({ role: 'model', parts: round++
    ? [{ text: 'Ready' }]
    : [{ functionCall: { name: 'propose_test' } }, { functionCall: { name: 'propose_test' } }],
  }) });
  q.acknowledge(2, 43, { text: 'plan' });
  await q.runOne(job => planner.message(job.chatId, 'plan', { retryFailures: true }));
  assert.equal(q.jobs[1].status, 'dead');
  assert.equal(q.jobs[1].lastErrorDetails.cause.message, 'splitPersons must be a list');
  assert.equal(planner.pending(43), null);
});

test('durable queue backs off, survives restart, deduplicates and preserves chat order', async t => {
  const f = fixture(t); let q = f.reload();
  q.acknowledge(100, 42, { text: 'original', receiptId: 'receipt-1' });
  q.acknowledge(101, 42, { text: 'next' });
  q.acknowledge(102, -42, { text: 'other chat' });
  await q.runOne(async job => { q.checkpoint(job, { voice: { transcript: 'original' } }); throw new RetryableError('429'); });
  assert.equal(q.jobs[0].nextAt - f.options.now(), 60_000);
  q = f.reload(); assert.equal(q.offset, 103);
  assert.equal(q.acknowledge(100, 42, { text: 'duplicate' }), false);
  const ran = [];
  await q.runOne(async job => ran.push(job.id));
  assert.deepEqual(ran, [102]); // One chat's rate limit does not block another chat.
  assert.equal(await q.runOne(async () => assert.fail('too early')), false);
  for (const [wait, next] of [[60_000, 300_000], [300_000, 900_000], [900_000, 3_600_000]]) {
    f.advance(wait);
    await q.runOne(async job => { assert.equal(job.payload.receiptId, 'receipt-1'); assert.equal(job.voice.transcript, 'original'); throw new RetryableError('503'); });
    assert.equal(q.jobs[0].nextAt - f.options.now(), next);
  }
  assert.deepEqual(f.notices, [[100, 'queued']]);
  f.advance(3_600_000);
  await q.runOne(async job => ran.push(job.id));
  await q.runOne(async job => ran.push(job.id));
  assert.deepEqual(ran, [102, 100, 101]);
  assert.equal(f.reload().jobs.length, 0);
  assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
});

test('Retry-After is a lower bound; exhausted jobs remain in the DLQ without repeated notices', async t => {
  const f = fixture(t), q = f.reload();
  q.acknowledge(1, 42, { text: 'keep me' });
  await q.runOne(async () => { throw new RetryableError('429', 7_200_000); });
  assert.equal(q.jobs[0].nextAt - f.options.now(), 7_200_000);
  f.advance(86_400_000);
  await q.runOne(async () => assert.fail('expired'));
  await f.reload().runOne(async () => assert.fail('dead letter'));
  assert.equal(q.jobs[0].status, 'dead');
  assert.equal(q.jobs[0].payload.text, 'keep me');
  assert.deepEqual(f.notices, [[1, 'queued'], [1, 'dead']]);
  assert.equal(retryAfterMs({ headers: new Headers({ 'retry-after': '120' }) }), 120_000);
  assert.equal(retryAfterMs({ headers: new Headers({ 'retry-after': new Date(f.options.now() + 90_000).toUTCString() }) }, f.options.now()), 90_000);
});

test('write guard persists uncertainty before an Actual call; no replay after failure or restart', async t => {
  const f = fixture(t), q = f.reload();
  q.acknowledge(1, 42, { text: 'log' });
  let writes = 0;
  await q.runOne(async job => {
    const api = guardActualWrites({ addTransactions: async () => {
      assert.equal(JSON.parse(fs.readFileSync(f.filePath)).jobs[0].unsafe, true);
      writes++; throw new RetryableError('lost response');
    } }, () => q.checkpoint(job, { unsafe: true }));
    await api.addTransactions();
  });
  assert.equal(q.jobs[0].reason, 'write-outcome-uncertain');
  await f.reload().runOne(async () => writes++);
  assert.equal(writes, 1);
  const state = JSON.parse(fs.readFileSync(f.filePath));
  state.jobs[0].status = 'running'; delete state.jobs[0].deadNotified;
  fs.writeFileSync(f.filePath, JSON.stringify(state));
  assert.equal(f.reload().jobs[0].status, 'dead');
});

test('safe in-flight jobs recover; permanent failures do not retry; corruption fails closed', async t => {
  const f = fixture(t), q = f.reload();
  q.acknowledge(1, 42, { text: 'pending' });
  const state = JSON.parse(fs.readFileSync(f.filePath)); state.jobs[0].status = 'running';
  fs.writeFileSync(f.filePath, JSON.stringify(state));
  const recovered = f.reload();
  assert.equal(recovered.jobs[0].status, 'retry');
  f.advance(60_000);
  await recovered.runOne(async () => { throw Error('bad input'); });
  assert.equal(recovered.jobs[0].reason, 'non-retryable-failure');
  fs.writeFileSync(f.filePath, JSON.stringify({ version: 99 }));
  assert.throws(f.reload, QueueStorageError);
});

test('429 transport exposes retry metadata and no rapid-fire retries on the same model', async () => {
  let calls = 0;
  const g = createGeminiGenerate({ apiKey: 'test', models: ['fake'], fetchImpl: async () => {
    calls++; return { ok: false, status: 429, headers: new Headers({ 'retry-after': '180' }) };
  } });
  await assert.rejects(() => g({ contents: [], declarations: [], system: '', signal: AbortSignal.timeout(1000) }),
    e => e instanceof RetryableError && e.retryAfterMs === 180_000);
  assert.equal(calls, 1);
});

test('agent retry retains original request context without adding errors or duplicate user turns', async t => {
  const f = fixture(t), q = f.reload();
  const statePath = path.join(path.dirname(f.filePath), 'agent.json');
  const tools = { declarations: [] };
  const a = createAgent({ tools, allowedChatId: 42, statePath, generate: async () => { throw new RetryableError('429'); } });
  q.acknowledge(1, 42, { text: 'remember the card' });
  await q.runOne(async job => {
    q.checkpoint(job, { request: {} });
    await a.message(42, job.payload.text, { request: job.request, retryFailures: true, checkpoint: () => q.checkpoint(job, {}) });
  });
  assert.equal(q.jobs[0].status, 'retry');
  const history = JSON.parse(fs.readFileSync(statePath)).chats[42].history;
  assert.equal(history.length, 1); assert.equal(history[0].role, 'user');
  f.advance(60_000);
  const b = createAgent({ tools, allowedChatId: 42, statePath, generate: async req => {
    assert.equal(req.contents.filter(c => c.role === 'user').length, 1);
    assert.ok(!JSON.stringify(req).includes('429'));
    return { role: 'model', parts: [{ text: 'Here is the answer.' }] };
  } });
  const restored = f.reload();
  await restored.runOne(async job => {
    const result = await b.message(42, job.payload.text, { request: job.request, retryFailures: true });
    assert.equal(result.text, 'Here is the answer.');
  });
  assert.equal(restored.jobs.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(statePath)).chats[42].history.length, 2);
});
