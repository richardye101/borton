import { normalizeReceipts } from './receipt-utils.mjs';

const retryable = (error) => /429|busy|timeout|503/i.test(String(error?.message || ''));

export function createReceiptReviewQueue({ inbox, extractor, matchReceipt = async () => ({}), now = Date.now, minIntervalMs = 20_000, autoStart = true } = {}) {
  if (!inbox || !extractor?.extractImage) throw new Error('inbox and extractor are required.');
  let running = null; let lastStart = -Infinity; let timer = null; let closed = false;
  const nextDelay = () => {
    const queued = inbox.list().filter((row) => ['queued', 'retrying'].includes(row.status));
    if (!queued.length) return null;
    const retryAt = Math.min(...queued.map((row) => row.nextAt || 0));
    return Math.max(0, retryAt - now(), lastStart + minIntervalMs - now());
  };
  const schedule = () => {
    if (!autoStart || closed || running || timer) return;
    const delay = nextDelay(); if (delay == null || !Number.isFinite(delay)) return;
    timer = setTimeout(() => { timer = null; run(); }, delay);
    timer.unref?.();
  };
  const enqueue = (files = []) => {
    const staged = files.map((file) => inbox.stageReceipt(file));
    schedule(); return staged;
  };
  const run = async () => {
    if (running) return running;
    running = (async () => {
      for (const row of inbox.list()) {
        if (!['queued', 'retrying'].includes(row.status) || (row.nextAt || 0) > now()) continue;
        if (now() - lastStart < minIntervalMs) break;
        lastStart = now();
        try {
          inbox.startReceipt?.(row.id);
          const image = inbox.readReceipt(row.id);
          const result = await extractor.extractImage(image.buffer, image.mime);
          const receipt = normalizeReceipts(result)[0];
          inbox.completeReceipt(row.id, receipt ? { ...receipt, amountCents: Math.round(receipt.total * 100), candidates: [], ...await matchReceipt({ row, receipt }) } : { status: 'failed', lastError: 'No receipt found.' });
        } catch (error) {
          if (retryable(error)) inbox.retryReceipt(row.id, error.message, now() + Math.max(60_000, error.retryAfterMs || 0));
          else inbox.failReceipt(row.id, error.message);
        }
      }
    })().finally(() => { running = null; schedule(); });
    return running;
  };
  schedule();
  return { enqueue, list: () => inbox.list(), run, retry(id) { const row = inbox.retryReceipt(id, '', now()); schedule(); return row; }, getImage(id) { return inbox.list({ status: 'all' }).find((row) => row.id === id) || null; }, cleanup: () => inbox.cleanup(), close() { closed = true; if (timer) clearTimeout(timer); timer = null; } };
}
