import { normalizeReceipts } from './receipt-utils.mjs';

const clientId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function createWebApplication({ actual, extractor, transcriber, cardmap = {}, fallbackCategory = 'General', assistant, assistantQueue } = {}) {
  if (!actual || !extractor) throw new Error('actual and extractor are required.');
  return {
    bootstrap: () => actual.bootstrap(),
    transactions: (query) => actual.findTransactions(query),
    editTransaction: (payload) => actual.editTransaction(payload),
    splitTransaction: (payload) => actual.splitTransaction(payload),
    summary: (query) => actual.summary(query),
    shared: () => actual.shared(),
    duplicates: (row) => actual.checkDuplicates(row),
    validateBatch: (payload) => actual.validateBatch(payload),
    submitBatch: (payload) => actual.submitBatch(payload),
    async extract({ buffer, mime }) {
      const [extracted, boot] = await Promise.all([extractor.extractImage(buffer, mime), actual.bootstrap()]);
      const accountsByName = new Map(boot.accounts.map((account) => [account.name, account]));
      const categoriesByName = new Map(boot.categories.map((category) => [category.name, category]));
      const rows = await Promise.all(normalizeReceipts(extracted).map(async (receipt) => {
        const account = accountsByName.get(cardmap.byLast4?.[receipt.card_last4]);
        const category = categoriesByName.get(fallbackCategory) || boot.categories[0];
        const amountCents = Math.round(receipt.total * 100);
        const row = { clientId: clientId(), merchant: receipt.merchant, amountCents, date: receipt.date, accountId: account?.id || null, categoryId: category?.id || null, note: (receipt.line_items || []).join(', '), duplicateAcknowledged: false };
        const duplicates = row.date ? await actual.checkDuplicates(row) : [];
        return { ...row, duplicates, status: !row.accountId || !row.categoryId || !row.date ? 'invalid' : duplicates.length ? 'check_required' : 'ready' };
      }));
      return { rows };
    },
    transcribe: ({ buffer, mime }) => {
      if (!transcriber) throw new Error('Audio transcription is unavailable.');
      return transcriber.transcribe(buffer, mime);
    },
    assistantMessage: (payload) => assistantQueue ? assistantQueue.enqueue({ text: payload.text, context: payload.context }) : assistant?.message({ text: payload.text, context: payload.context }),
    assistantMessages: () => assistantQueue?.list() || [],
    assistantConfirm: (payload) => assistant?.confirm(payload.planId),
    assistantCancel: (payload) => assistant?.cancel(payload.planId),
  };
}
