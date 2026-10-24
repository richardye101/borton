import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withActualLock } from '../actual-lock.mjs';

test('serializes overlapping work through a shared lock file', async () => {
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'borton-lock-')), 'actual.lock');
  let active = 0; let maximum = 0;
  const work = async () => {
    active += 1; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  };
  await Promise.all([withActualLock(lock, work), withActualLock(lock, work)]);
  assert.equal(maximum, 1);
  assert.equal(fs.existsSync(lock), false);
});
