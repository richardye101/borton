import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RetryableError } from './retry-queue.mjs';

const DAY = 86_400_000;
const RETRY_DELAYS = [60_000, 300_000, 900_000, 3_600_000];
const HISTORY_LIMIT = 200;

const clone = (value) => structuredClone(value);
const publicJob = ({ payload, ...job }) => ({ ...clone(job), text: payload.text });

export function createWebMessageQueue({ assistant, filePath, now = Date.now } = {}) {
  if (!assistant?.message || !filePath) throw new Error('assistant and filePath are required.');
  let state = { version: 1, jobs: [] };
  let draining = null;
  let timer = null;

  if (fs.existsSync(filePath)) {
    try { state = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { throw new Error('Unreadable web message queue; preserve the file before recovery.'); }
  }
  if (state.version !== 1 || !Array.isArray(state.jobs) || state.jobs.some((job) => !job?.id || !job.payload?.text || !Number.isFinite(job.createdAt) || !Number.isSafeInteger(job.attempts) || !['queued', 'processing', 'retry', 'complete', 'failed'].includes(job.status) || (['queued', 'retry'].includes(job.status) && !Number.isFinite(job.nextAt)))) {
    throw new Error('Invalid web message queue; preserve the file before recovery.');
  }
  for (const job of state.jobs) if (job.status === 'processing') { job.status = 'retry'; job.nextAt = Number.isFinite(job.nextAt) ? Math.max(job.nextAt, now()) : now(); }

  function save() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filePath);
  }

  function trimHistory() {
    const settled = state.jobs.filter((job) => job.status === 'complete' || job.status === 'failed').sort((a, b) => (a.finishedAt || 0) - (b.finishedAt || 0));
    while (settled.length > HISTORY_LIMIT) {
      const old = settled.shift(); state.jobs = state.jobs.filter((job) => job !== old);
    }
  }

  function schedule() {
    if (timer) { clearTimeout(timer); timer = null; }
    const next = state.jobs.find((job) => job.status === 'queued' || job.status === 'retry');
    if (!next) return;
    const delay = Math.max(0, next.nextAt - now());
    timer = setTimeout(() => { timer = null; void run(); }, delay);
    timer.unref?.();
  }

  async function process(job) {
    job.status = 'processing'; job.attempts += 1; delete job.lastError; delete job.nextAt; save();
    try {
      const result = await assistant.message(clone(job.payload));
      job.status = 'complete'; job.response = String(result?.text || 'Completed.'); job.planId = result?.planId || null; job.finishedAt = now();
    } catch (error) {
      job.lastError = String(error?.message || 'Message processing failed.').slice(0, 512);
      if (error instanceof RetryableError && now() - job.createdAt < DAY) {
        job.status = 'retry';
        job.nextAt = now() + Math.max(RETRY_DELAYS[Math.min(job.attempts - 1, RETRY_DELAYS.length - 1)], error.retryAfterMs || 0);
      } else {
        job.status = 'failed'; job.finishedAt = now();
      }
    }
    trimHistory(); save();
  }

  async function run() {
    if (draining) return draining;
    draining = (async () => {
      while (true) {
        const job = state.jobs.find((entry) => entry.status === 'queued' || entry.status === 'retry');
        if (!job || job.nextAt > now()) break;
        await process(job);
      }
    })().finally(() => { draining = null; schedule(); });
    return draining;
  }

  save();
  queueMicrotask(() => { void run(); });
  return {
    enqueue(payload) {
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (!text) throw new Error('A message is required.');
      const job = { id: randomUUID(), payload: { text, ...(payload.context && typeof payload.context === 'object' ? { context: clone(payload.context) } : {}) }, createdAt: now(), nextAt: now(), attempts: 0, status: 'queued' };
      state.jobs.push(job); save(); void run();
      return publicJob(job);
    },
    list: () => state.jobs.slice().reverse().map(publicJob),
    run,
    close() { if (timer) clearTimeout(timer); timer = null; },
  };
}
