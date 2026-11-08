import { rankReviewCandidates } from './review-inbox.mjs';

export function createReviewService({ actual, inbox, receiptQueue, categorySuggestions, cardmap = {} } = {}) {
  if (!actual || !inbox) throw new Error('actual and inbox are required.');
  const find = (id) => inbox.list({ status: 'all' }).find((row) => row.id === id);
  return {
    list: (query) => inbox.list(query),
    async stagePlaid(rows = []) {
      const prepared = [];
      for (const row of rows) prepared.push({ ...row, candidates: rankReviewCandidates(row, await actual.reviewCandidates(row)) });
      const result = inbox.stagePlaid(prepared);
      if (result.staged) categorySuggestions?.enqueue(prepared);
      return result;
    },
    async auditHistoricalImports(rows = []) {
      const matches = [];
      for (let index = 0; index < rows.length; index += 500) matches.push(...await actual.importedMatches(rows.slice(index, index + 500)));
      return { scanned: rows.length, matched: matches.length, ...inbox.stageHistoricalPlaid(matches) };
    },
    async resetImportedTuitionCategory({ dryRun = false } = {}) {
      const preview = await actual.resetImportedTuitionCategory({ dryRun: true });
      if (dryRun) return { count: preview.rows.length };
      const staged = inbox.stageLegacyImports(preview.rows);
      if (staged.staged) categorySuggestions?.enqueue(preview.rows);
      await actual.resetImportedTuitionCategory({ transactionIds: preview.rows.map((row) => row.transactionId) });
      return staged;
    },
    async stageManual({ transactionId, note = '' } = {}) {
      if (!transactionId) throw new Error('Choose a transaction to review later.');
      const row = (await actual.findTransactions({ transactionId }))[0];
      if (!row) throw new Error('That transaction is no longer available.');
      return inbox.stageManual({ transactionId: row.id, date: row.date, merchant: row.merchant, account: row.account, amountCents: row.amountCents, note });
    },
    async matchReceipt({ row, receipt } = {}) {
      const accountName = cardmap.byLast4?.[receipt?.card_last4];
      if (!accountName || !receipt?.date || !Number.isFinite(Number(receipt.total))) return { candidates: [] };
      const account = (await actual.bootstrap()).accounts.find((candidate) => candidate.name.toLowerCase() === String(accountName).toLowerCase());
      if (!account) return { candidates: [] };
      const incoming = { importedId: row?.id || `receipt:${receipt.card_last4}`, accountId: account.id, date: receipt.date, amountCents: -Math.round(receipt.total * 100), merchant: receipt.merchant };
      const stagedPlaid = inbox.list({ status: 'open' }).filter((candidate) => candidate.source === 'plaid');
      return { accountId: account.id, account: account.name, candidates: rankReviewCandidates(incoming, [...await actual.reviewCandidates(incoming), ...stagedPlaid]) };
    },
    async resolve({ id, resolution } = {}) {
      const row = find(id); if (!row) throw new Error('Review not found.');
      if (row.status === 'completed' || row.historical) throw new Error('Completed reviews cannot be changed.');
      if (row.source === 'receipt') {
        if (resolution?.action !== 'attach' || !row.candidates?.some((candidate) => candidate.id === resolution.transactionId) || String(resolution.transactionId).startsWith('plaid:')) throw new Error('Choose an approved Actual transaction for this receipt.');
        return inbox.resolve(id, { ...resolution, status: 'complete' });
      }
      if (row.source === 'manual') {
        if (resolution?.action !== 'complete') throw new Error('Review-later items can only be marked complete.');
        return inbox.resolve(id, { action: 'complete', status: 'complete' });
      }
      if (row.source === 'legacy_import') {
        if (resolution?.action === 'ignore') return inbox.resolve(id, { action: 'ignore', status: 'complete' });
        const result = await actual.applyLegacyReview({ ...row, resolution });
        return inbox.resolve(id, { ...resolution, ...result });
      }
      if (row.source !== 'plaid') throw new Error('Review source is not supported.');
      const result = await actual.applyReview({ ...row, resolution });
      return inbox.resolve(id, { ...resolution, ...result });
    },
    stageReceipts(files = []) {
      if (!receiptQueue) throw new Error('Receipt uploads are unavailable.');
      return receiptQueue.enqueue(files);
    },
    cleanup: () => receiptQueue?.cleanup() || inbox.cleanup(),
  };
}
