const retryable = (error) => /429|busy|timeout|503|5\d\d/i.test(String(error?.message || error || ''));

export function createCategorySuggestionQueue({ inbox, categories, suggest, now = Date.now, minIntervalMs = 20_000, autoStart = true } = {}) {
  if (!inbox || !categories || !suggest) throw new Error('inbox, categories, and suggest are required.');
  let running = null; let lastStart = -Infinity; let timer = null; let closed = false;
  const queued = () => inbox.list({ status: 'all' }).filter((row) => ['plaid', 'legacy_import'].includes(row.source) && ['queued', 'retrying'].includes(row.suggestion?.status));
  const nextDelay = () => {
    const rows = queued(); if (!rows.length) return null;
    const retryAt = Math.min(...rows.map((row) => row.suggestion?.nextAt || 0));
    return Math.max(0, retryAt - now(), lastStart + minIntervalMs - now());
  };
  const schedule = () => {
    if (!autoStart || closed || running || timer) return;
    const delay = nextDelay(); if (delay == null || !Number.isFinite(delay)) return;
    timer = setTimeout(() => { timer = null; run(); }, delay);
    timer.unref?.();
  };
  const run = async () => {
    if (running) return running;
    running = (async () => {
      for (const row of queued()) {
        if ((row.suggestion?.nextAt || 0) > now()) continue;
        if (now() - lastStart < minIntervalMs) break;
        lastStart = now();
        try {
          inbox.startSuggestion(row.id);
          const allowed = await categories();
          const result = await suggest({ merchant: row.merchant, date: row.date, amountCents: row.amountCents, account: row.account, institution: row.institution, categories: allowed.map((category) => category.name) });
          const category = allowed.find((entry) => entry.name.toLowerCase() === String(result?.category || '').trim().toLowerCase());
          if (!category) throw Object.assign(Error('No usable category suggestion.'), { permanent: true });
          inbox.completeSuggestion(row.id, { categoryId: category.id, category: category.name, confidence: result.confidence, reason: result.reason });
        } catch (error) {
          if (retryable(error) && !error.permanent) inbox.retrySuggestion(row.id, error.message, now() + Math.max(60_000, error.retryAfterMs || 0));
          else inbox.failSuggestion(row.id, error.message);
        }
      }
    })().finally(() => { running = null; schedule(); });
    return running;
  };
  schedule();
  return { enqueue() { schedule(); }, list: queued, run, close() { closed = true; if (timer) clearTimeout(timer); timer = null; } };
}
