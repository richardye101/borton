import fs from 'node:fs';
import path from 'node:path';

export class RetryableError extends Error {
  constructor(message, retryAfterMs = 0) {
    super(message);
    this.retryAfterMs = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0;
  }
}
export class QueueStorageError extends Error {}

export function retryAfterMs(response, now = Date.now()) {
  const value = response.headers?.get('retry-after');
  if (!value) return 0;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

// All current Actual mutation families pass here, including dynamically selected tools.
export function guardActualWrites(api, beforeWrite) {
  return Object.fromEntries(Object.entries(api).map(([name, value]) => [name,
    typeof value === 'function' && /^(?:add|import|create|update|delete|set|reset|hold|close|reopen|merge|runBankSync|runImport|batchBudgetUpdates)/.test(name)
      ? (...args) => { beforeWrite(); return value(...args); } : value]));
}

const DAY = 86_400_000;
const DELAYS = [60_000, 300_000, 900_000, 3_600_000];
const open = job => job.status === 'pending' || job.status === 'retry' || job.status === 'running';

export function createRetryQueue({ filePath, now = Date.now, onStatus = async () => {} }) {
  // ponytail: one process and a small JSON queue; use SQLite if backlog size makes rewrites costly.
  let state = { version: 1, offset: 0, jobs: [] };
  let busy = false;
  try { if (fs.existsSync(filePath)) state = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { throw new QueueStorageError('Unreadable message queue; preserve the file before recovery.'); }
  if (state.version !== 1 || !Number.isSafeInteger(state.offset) || !Array.isArray(state.jobs) ||
      state.jobs.some(j => !j || !Number.isSafeInteger(j.id) || !j.payload || !j.chatId ||
        !Number.isFinite(j.createdAt) || !Number.isFinite(j.nextAt) || !Number.isSafeInteger(j.attempts) ||
        !['pending', 'running', 'retry', 'dead'].includes(j.status))) {
    throw new QueueStorageError('Invalid message queue; preserve the file before recovery.');
  }
  function save() {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const fd = fs.openSync(filePath + '.tmp', 'w', 0o600);
      try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(filePath + '.tmp', filePath);
      const dir = fs.openSync(path.dirname(filePath), 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } catch { throw new QueueStorageError('Could not persist message queue; stopping before acknowledging more updates.'); }
  }
  function dead(job, reason) { job.status = 'dead'; job.reason = reason; job.finishedAt = now(); }
  for (const job of state.jobs) if (job.status === 'running') {
    if (job.unsafe) dead(job, 'write-outcome-uncertain');
    else { job.status = 'retry'; job.nextAt = Math.max(job.nextAt, now() + DELAYS[0]); }
  }
  save();
  return {
    get offset() { return state.offset; },
    get jobs() { return structuredClone(state.jobs); },
    hasPending(chatId) { return state.jobs.some(j => String(j.chatId) === String(chatId) && open(j)); },
    acknowledge(id, chatId, payload) {
      if (!Number.isSafeInteger(id) || id < state.offset) return false;
      if (payload) state.jobs.push({ id, chatId, payload: structuredClone(payload), createdAt: now(), attempts: 0, status: 'pending', nextAt: now() });
      state.offset = id + 1;
      save(); // Payload and Telegram offset commit together, before the next getUpdates.
      return true;
    },
    checkpoint(job, fields) { Object.assign(job, structuredClone(fields)); save(); },
    async runOne(process) {
      if (busy) return false;
      busy = true;
      try {
        const notify = async (job, status) => {
          const key = status + 'Notified';
          if (job[key]) return;
          job[key] = true; save(); // At most one notification attempt, including across crashes.
          try { await onStatus(job, status); } catch (e) { if (e instanceof QueueStorageError) throw e; }
        };
        let expired = false;
        for (const j of state.jobs) if (open(j) && now() - j.createdAt >= DAY) { dead(j, 'retries-exhausted'); expired = true; }
        if (expired) save();
        for (const j of state.jobs) if (j.status === 'dead') await notify(j, 'dead');
        const seen = new Set();
        const job = state.jobs.find(j => {
          if (!open(j) || seen.has(String(j.chatId))) return false;
          seen.add(String(j.chatId));
          return j.nextAt <= now();
        });
        if (!job) return false;
        job.status = 'running'; job.attempts++; save();
        try {
          await process(job);
        } catch (e) {
          if (e instanceof QueueStorageError) throw e;
          if (!job.unsafe && e instanceof RetryableError && now() - job.createdAt < DAY) {
            job.status = 'retry';
            job.nextAt = now() + Math.max(DELAYS[Math.min(job.attempts - 1, DELAYS.length - 1)], e.retryAfterMs);
            job.reason = 'temporary-service-failure'; job.lastError = e.message;
            save(); await notify(job, 'queued');
          } else {
            dead(job, job.unsafe ? 'write-outcome-uncertain' : 'non-retryable-failure');
            save(); await notify(job, 'dead');
          }
          return true;
        }
        // Persist completion before notifying; a delivery failure must not replay a budget write.
        state.jobs = state.jobs.filter(j => j !== job); save();
        if (job.queuedNotified) await onStatus(job, 'done').catch(() => {});
        return true;
      } finally { busy = false; }
    },
  };
}
