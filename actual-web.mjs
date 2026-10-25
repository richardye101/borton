import fs from 'node:fs';
import path from 'node:path';
import { findLikelyDuplicates, isValidExpenseDate, withPayeeNames } from './receipt-utils.mjs';
import { withActualLock } from './actual-lock.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const JOURNAL_TTL = DAY_MS;
const unique = (rows) => [...new Map(rows.map((row) => [row.id, row])).values()];
const normalize = (row, payees, accounts, categories) => {
  const splitTransactionIds = (row.subtransactions || []).map((line) => line.id).filter((id) => typeof id === 'string');
  const splitLines = (row.subtransactions || []).map((line) => {
    const categoryId = line.category || null;
    return { id: line.id, amountCents: Math.abs(line.amount || 0), categoryId, category: categories.get(categoryId)?.name || '' };
  });
  const splitCategoryIds = [...new Set((row.subtransactions || []).map((line) => line.category).filter(Boolean))];
  const categoryId = row.category || (splitCategoryIds.length === 1 ? splitCategoryIds[0] : null);
  return {
    id: row.id, date: String(row.date), amountCents: Math.abs(row.amount), merchant: payees.get(row.payee)?.name || row.payee_name || '',
    accountId: row.account, account: accounts.get(row.account)?.name || '', categoryId,
    category: categories.get(categoryId)?.name || '', note: row.notes || '', cleared: !!row.cleared, isExpense: row.amount < 0,
    ...(splitTransactionIds.length ? { splitTransactionIds, splitLines } : {}),
  };
};
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const zonedDate = (time, timezone) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(time));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value])); return `${value.year}-${value.month}-${value.day}`;
};
const monthEnd = (month) => `${month}-${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate().toString().padStart(2, '0')}`;

export function createActualWeb({ api, dataDir, lockPath = path.join(dataDir, 'actual.lock'), currency = 'CAD', timezone = 'America/Toronto', now = () => Date.now() } = {}) {
  if (!api || !dataDir) throw new Error('api and dataDir are required.');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const journalPath = path.join(dataDir, 'web-request-journal.json');
  let lastSync = 0;
  let queue = Promise.resolve();
  const readJournal = () => { try { return JSON.parse(fs.readFileSync(journalPath, 'utf8')); } catch { return {}; } };
  const writeJournal = (journal) => { const tmp = `${journalPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(journal), { mode: 0o600 }); fs.renameSync(tmp, journalPath); };
  const runExclusive = (work) => {
    const guarded = () => withActualLock(lockPath, work);
    const next = queue.then(guarded, guarded); queue = next.catch(() => {}); return next;
  };
  async function sync(force = false) {
    if (force || now() - lastSync > 15_000) { await api.sync(); lastSync = now(); }
  }
  async function maps() {
    const [allAccounts, visible, hidden, payeeRows] = await Promise.all([api.getAccounts(), api.getCategories(), api.getCategories({ hidden: true }), api.getPayees()]);
    const accounts = new Map(allAccounts.map((row) => [row.id, row]));
    const categories = new Map(unique([...visible, ...hidden]).map((row) => [row.id, row]));
    const payees = new Map(payeeRows.map((row) => [row.id, row]));
    return { accounts, categories, payees, payeeRows };
  }
  async function transactions({ start = zonedDate(now() - 89 * DAY_MS, timezone), end = zonedDate(now(), timezone), query = '', limit = 50, offset = 0, categoryId, accountId, includeClosed = false, paged = false, force = false } = {}) {
    await sync(force); const { accounts, categories, payees } = await maps(); const rows = [];
    for (const account of accounts.values()) {
      if (account.closed && !includeClosed) continue;
      if (accountId && account.id !== accountId) continue;
      rows.push(...await api.getTransactions(account.id, start, end));
    }
    const filtered = unique(rows).filter((row) => !row.transfer_id && !payees.get(row.payee)?.transfer_acct)
      .map((row) => normalize(row, payees, accounts, categories))
      .filter((row) => !categoryId || (categoryId === '__uncategorized__' ? !row.categoryId : row.categoryId === categoryId))
      .filter((row) => !query || `${row.merchant} ${row.note}`.toLowerCase().includes(String(query).toLowerCase()))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    const startAt = Math.max(Number(offset) || 0, 0);
    const requestedLimit = Number(limit);
    const page = requestedLimit === 0 ? filtered.slice(startAt) : filtered.slice(startAt, startAt + Math.min(requestedLimit || 50, 5000));
    return paged ? { rows: page, total: filtered.length } : page;
  }
  const breakdown = (rows, field, filters) => [...rows.reduce((groups, row) => {
    const id = field === 'category' ? row.categoryId || 'uncategorized' : field === 'account' ? row.accountId : row.date.slice(0, 7);
    const name = field === 'month' ? id : row[field] || 'Uncategorized'; const current = groups.get(id) || { id, name, amountCents: 0, count: 0, filters: field === 'month' ? { start: `${id}-01`, end: monthEnd(id) } : { ...filters, [field === 'category' ? 'categoryId' : 'accountId']: field === 'category' && !row.categoryId ? '__uncategorized__' : row[`${field}Id`] || null } };
    current.amountCents += row.amountCents; current.count += 1; groups.set(id, current); return groups;
  }, new Map()).values()].sort((a, b) => b.amountCents - a.amountCents || a.name.localeCompare(b.name));
  async function duplicateRows({ merchant, amountCents, date, accountId }) {
    await sync(); const { accounts, categories, payees } = await maps();
    const start = new Date(Date.parse(`${date}T12:00:00Z`) - 5 * DAY_MS).toISOString().slice(0, 10);
    const end = new Date(Date.parse(`${date}T12:00:00Z`) + 5 * DAY_MS).toISOString().slice(0, 10);
    const raw = [];
    for (const account of accounts.values()) if (!account.closed && (!accountId || account.id === accountId)) raw.push(...await api.getTransactions(account.id, start, end));
    const rows = unique(raw).filter((row) => !row.transfer_id && !payees.get(row.payee)?.transfer_acct).map((row) => normalize(row, payees, accounts, categories));
    const candidates = rows.map((row) => ({ id: row.id, date: row.date, amount: -row.amountCents, payee_name: row.merchant }));
    return findLikelyDuplicates(candidates, { merchant, total: amountCents / 100, date }).map((match) => rows.find((row) => row.id === match.id));
  }
  async function validateRows(rows = []) {
    if (!Array.isArray(rows) || rows.length > 50) throw error('Submit between 1 and 50 rows.');
    const { accounts, categories } = await maps();
    return Promise.all(rows.map(async (row) => {
      const valid = row && typeof row.clientId === 'string' && String(row.merchant || '').trim() && Number.isSafeInteger(row.amountCents) && row.amountCents > 0 && isValidExpenseDate(row.date) && accounts.get(row.accountId) && !accounts.get(row.accountId).closed && categories.has(row.categoryId);
      if (!valid) return { ...row, status: 'invalid', duplicates: [] };
      const duplicates = await duplicateRows(row);
      return { ...row, merchant: String(row.merchant).trim(), note: String(row.note || '').trim(), status: duplicates.length && !row.duplicateAcknowledged ? 'check_required' : 'ready', duplicates };
    }));
  }
  return {
    runExclusive,
    async bootstrap() {
      const [{ accounts, categories }, rows] = await Promise.all([maps(), transactions({})]);
      return { currency, syncedAt: new Date(lastSync).toISOString(), accounts: [...accounts.values()].filter((row) => !row.closed && !row.offbudget).map((row) => ({ id: row.id, name: row.name })), categories: [...categories.values()].filter((row) => !row.hidden && !row.is_income).map((row) => ({ id: row.id, name: row.name })), transactions: rows };
    },
    findTransactions: transactions,
    async summary({ period, days = 90, force = false } = {}) {
      const range = period === 'all' ? null : Math.min(Math.max(Number(period || days) || 90, 1), 365);
      const end = zonedDate(now(), timezone); const start = range ? zonedDate(now() - (range - 1) * DAY_MS, timezone) : '1900-01-01';
      const rows = (await transactions({ start, end, limit: 0, includeClosed: !range, force })).filter((row) => row.isExpense);
      const filters = { start, end };
      const byMonth = breakdown(rows, 'month', filters);
      const monthCategories = byMonth.map((month) => ({
        ...month,
        categories: breakdown(rows.filter((row) => row.date.startsWith(month.name)), 'category', month.filters),
      }));
      return { period: range ? String(range) : 'all', start, end, totalCents: rows.reduce((total, row) => total + row.amountCents, 0), count: rows.length, byCategory: breakdown(rows, 'category', filters), byAccount: breakdown(rows, 'account', filters), byMonth, monthCategories };
    },
    checkDuplicates: duplicateRows,
    async validateBatch({ rows }) { return { rows: await validateRows(rows) }; },
    editTransaction({ id, merchant, amountCents, date, accountId, categoryId, note = '', splitTransactionIds = [] } = {}) {
      return runExclusive(async () => {
        if (typeof id !== 'string' || !id || !String(merchant || '').trim() || !Number.isSafeInteger(amountCents) || amountCents <= 0 || !isValidExpenseDate(date, zonedDate(now(), timezone))) throw error('Enter valid expense details.');
        if (!Array.isArray(splitTransactionIds) || splitTransactionIds.length > 100 || splitTransactionIds.some((lineId) => typeof lineId !== 'string' || !lineId || lineId === id)) throw error('Invalid split transaction details.');
        await sync();
        const { accounts, categories, payeeRows } = await maps();
        if (!accounts.get(accountId) || accounts.get(accountId).closed || !categories.has(categoryId)) throw error('Choose a valid account and category.');
        const name = String(merchant).trim();
        let payee = payeeRows.find((row) => row.name.toLowerCase() === name.toLowerCase());
        if (!payee) payee = { id: await api.createPayee({ name }), name };
        const updated = await api.updateTransaction(id, { date, amount: -amountCents, payee: payee.id, notes: String(note || '').trim(), account: accountId, category: categoryId });
        if (Array.isArray(updated) && !updated.length) throw error('Actual could not update this transaction.');
        for (const lineId of splitTransactionIds) await api.updateTransaction(lineId, { category: categoryId });
        await api.sync(); lastSync = now();
        return { status: 'complete', id };
      });
    },
    submitBatch({ requestId, rows }) {
      return runExclusive(async () => {
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId || '')) throw error('Invalid request ID.');
        const journal = readJournal();
        for (const [key, value] of Object.entries(journal)) if (value.at < now() - JOURNAL_TTL) delete journal[key];
        if (journal[requestId]?.result) return journal[requestId].result;
        if (journal[requestId]?.uncertain) return { status: 'uncertain', rows: [], error: 'This request may have started writing. Check Actual before submitting again.' };
        journal[requestId] = { at: now(), uncertain: true }; writeJournal(journal);
        const checked = await validateRows(rows);
        for (let i = 0; i < checked.length; i += 1) {
          const row = checked[i]; if (row.status !== 'ready') continue;
          const earlier = checked.slice(0, i).filter((candidate) => candidate.status === 'ready').map((candidate, index) => ({ id: `batch-${index}`, date: candidate.date, amount: -candidate.amountCents, payee_name: candidate.merchant }));
          if (findLikelyDuplicates(earlier, { merchant: row.merchant, total: row.amountCents / 100, date: row.date }).length && !row.duplicateAcknowledged) { row.status = 'check_required'; row.duplicates = [{ id: 'batch', merchant: row.merchant, amountCents: row.amountCents }]; }
        }
        if (checked.some((row) => row.status === 'invalid')) return { status: 'invalid', rows: checked };
        if (checked.some((row) => row.status === 'check_required')) return { status: 'review_required', rows: checked };
        const { payeeRows } = await maps(); const byName = new Map(payeeRows.map((row) => [row.name.toLowerCase(), row]));
        const outcome = [];
        try {
          for (const row of checked) {
            const key = row.merchant.toLowerCase(); let payee = byName.get(key);
            if (!payee) { const id = await api.createPayee({ name: row.merchant }); payee = { id, name: row.merchant }; byName.set(key, payee); }
            const importedId = `borton-web-${requestId}-${row.clientId}`;
            await api.addTransactions(row.accountId, [{ date: row.date, amount: -row.amountCents, payee: payee.id, notes: row.note, category: row.categoryId, imported_id: importedId }], { runTransfers: true });
            const created = (await api.getTransactions(row.accountId, row.date, row.date)).find((transaction) => transaction.imported_id === importedId);
            outcome.push({ clientId: row.clientId, status: 'complete', transactionId: created?.id || null, importedId });
          }
          await api.sync(); lastSync = now();
          const result = { status: 'complete', rows: outcome }; journal[requestId] = { at: now(), result }; writeJournal(journal); return result;
        } catch (cause) {
          const result = { status: outcome.length ? 'partial' : 'uncertain', rows: outcome, error: cause.message }; journal[requestId] = { at: now(), result }; writeJournal(journal); return result;
        }
      });
    },
    async close() { await api.shutdown?.(); },
  };
}
