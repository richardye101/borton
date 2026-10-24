import fs from 'node:fs/promises';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withActualLock(lockPath, work, { timeoutMs = 60_000, retryMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try { handle = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for Actual access.');
      await delay(retryMs);
    }
  }
  try { return await work(); }
  finally { await handle.close(); await fs.unlink(lockPath).catch(() => {}); }
}
