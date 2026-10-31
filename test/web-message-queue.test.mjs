import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RetryableError } from '../retry-queue.mjs';
import { createWebMessageQueue } from '../web-message-queue.mjs';

const waitFor = async (check) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = check(); if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for queue work.');
};

test('queues web messages, completes them in order, and retains safe delivery history', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-web-queue-'));
  const seen = [];
  const queue = createWebMessageQueue({
    filePath: path.join(directory, 'messages.json'),
    assistant: { async message(payload) { seen.push(payload.text); return { text: `Done: ${payload.text}` }; } },
  });
  const first = queue.enqueue({ text: 'First', context: { page: 'home' } });
  const second = queue.enqueue({ text: 'Second', context: { page: 'summary' } });
  assert.ok(['queued', 'processing'].includes(first.status));
  assert.equal(second.status, 'queued');
  await waitFor(() => queue.list().every((job) => job.status === 'complete'));
  assert.deepEqual(seen, ['First', 'Second']);
  assert.deepEqual(queue.list().map(({ text, status, response }) => ({ text, status, response })), [
    { text: 'Second', status: 'complete', response: 'Done: Second' },
    { text: 'First', status: 'complete', response: 'Done: First' },
  ]);
  assert.equal(Object.hasOwn(queue.list()[0], 'context'), false);
});

test('retains a transient Gemini failure as a retrying queue item', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-web-queue-'));
  let now = 1_000;
  const queue = createWebMessageQueue({
    filePath: path.join(directory, 'messages.json'), now: () => now,
    assistant: { async message() { throw new RetryableError('Gemini HTTP 503.', 60_000); } },
  });
  queue.enqueue({ text: 'Classify this' });
  const retrying = await waitFor(() => queue.list()[0]?.status === 'retry' && queue.list()[0]);
  assert.equal(retrying.lastError, 'Gemini HTTP 503.');
  assert.equal(retrying.nextAt, 61_000);
  assert.equal(retrying.attempts, 1);
  now = 61_000;
  await queue.run();
  assert.equal(queue.list()[0].attempts, 2);
  queue.close();
});

test('reopens persisted failed jobs that no longer have a next retry time', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'borton-web-queue-'));
  const filePath = path.join(directory, 'messages.json');
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    jobs: [{
      id: 'failed-job', payload: { text: 'Classify this' }, createdAt: 1, attempts: 1,
      status: 'failed', finishedAt: 2, lastError: 'Request failed.',
    }],
  }));

  const queue = createWebMessageQueue({ filePath, assistant: { async message() { throw new Error('Should not run'); } } });
  assert.equal(queue.list()[0].status, 'failed');
  assert.equal(queue.list()[0].text, 'Classify this');
  queue.close();
});
