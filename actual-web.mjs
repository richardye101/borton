import fs from 'node:fs';
import path from 'node:path';
import { findLikelyDuplicates, isValidExpenseDate, withPayeeNames } from './receipt-utils.mjs';
import { withActualLock } from './actual-lock.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const JOURNAL_TTL = DAY_MS;
const unique = (rows) => [...new Map(rows.map((row) => [row.id, row])).values()];
const normalize = (row, payees, accounts, categories, owedAccountPerson) => {
  const splitTransactionIds = (row.subtransactions || []).map((line) => line.id).filter((id) => typeof id === 'string');
  const splitLines = (row.subtransactions || []).map((line) => {
    const categoryId = line.category || null;
    const transferAccount = payees.get(line.payee)?.transfer_acct;
    const account = accounts.get(transferAccount)?.name || '';
    const person = owedAccountPerson(account);
    return { id: line.id, amountCents: Math.abs(line.amount || 0), categoryId, category: categories.get(categoryId)?.name || '', ...(person ? { person, account } : {}) };
  });
  const splitCategoryIds = [...new Set((row.subtransactions || []).map((line) => line.category).filter(Boolean))];
  const categoryId = row.category || (splitCategoryIds.length === 1 ? splitCategoryIds[0] : null);
  const splitDetails = splitLines.filter((line) => line.person).map(({ person, account, amountCents }) => ({ person, account, amountCents, direction: 'they_owe_you' }));
  const debtAccount = accounts.get(row.account)?.name || '';
  const debtPerson = owedAccountPerson(debtAccount);
  return {
    id: row.id, date: String(row.date), amountCents: Math.abs(row.amount), merchant: payees.get(row.payee)?.name || row.payee_name || '',
    accountId: row.account, account: accounts.get(row.account)?.name || '', categoryId,
    category: categories.get(categoryId)?.name || '', note: row.notes || '', cleared: !!row.cleared, isExpense: row.amount < 0,
    ...(splitTransactionIds.length ? { splitTransactionIds, splitLines, splitWith: [...new Set(splitLines.map((line) => line.person).filter(Boolean))], ...(splitDetails.length ? { splitDetails } : {}) } : {}),
    ...(debtPerson ? { debt: { person: debtPerson, account: debtAccount, amountCents: Math.abs(row.amount), direction: row.amount >= 0 ? 'they_owe_you' : 'you_owe_them' } } : {}),
  };
};
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const zonedDate = (time, timezone) => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(time));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value])); return `${value.year}-${value.month}-${value.day}`;
};
const monthEnd = (month) => `${month}-${new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate().toString().padStart(2, '0')}`;

export function createActualWeb({ api, dataDir, lockPath = path.join(dataDir, 'actual.lock'), currency = 'CAD', timezone = 'America/Toronto', owedAccountFormat = 'Owed by {name}', cardmap = {}, now = () => Date.now() } = {}) {
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
  const owedAccountPerson = (name = '') => {
    const [prefix, suffix = ''] = owedAccountFormat.split('{name}');
    if (!owedAccountFormat.includes('{name}') || !name.startsWith(prefix) || !name.endsWith(suffix)) return '';
    return name.slice(prefix.length, suffix ? -suffix.length : undefined).trim();
  };
  const owedAccountName = (person) => owedAccountFormat.replace('{name}', person);
  const accountOwner = (name = '') => {
    const owners = cardmap.owners || {};
    const key = Object.keys(owners).find((candidate) => candidate.toLowerCase() === String(name).toLowerCase());
    if (key) return String(owners[key] || '').trim();
    return String(name).match(/^(.+?)(?:'s|s)\s+\S/i)?.[1].trim() || '';
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
  async function owedAccount(person) {
    const name = owedAccountName(person);
    let current = await maps();
    let account = [...current.accounts.values()].find((row) => row.name.toLowerCase() === name.toLowerCase());
    if (!account) {
      await api.createAccount({ name, offbudget: false }, 0);
      await api.sync(); lastSync = now();
      current = await maps();
      account = [...current.accounts.values()].find((row) => row.name.toLowerCase() === name.toLowerCase());
    }
    if (!account) throw error(`Could not create ${name}.`);
    return { account, maps: current };
  }
  async function transactions({ start = zonedDate(now() - 89 * DAY_MS, timezone), end = zonedDate(now(), timezone), query = '', limit = 50, offset = 0, categoryId, accountId, includeClosed = false, paged = false, force = false } = {}) {
    await sync(force); const { accounts, categories, payees } = await maps(); const rows = [];
    for (const account of accounts.values()) {
      if (account.closed && !includeClosed) continue;
      if (accountId && account.id !== accountId) continue;
      rows.push(...await api.getTransactions(account.id, start, end));
    }
    const filtered = unique(rows).filter((row) => !row.transfer_id && !payees.get(row.payee)?.transfer_acct)
      .map((row) => normalize(row, payees, accounts, categories, owedAccountPerson))
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
    const rows = unique(raw).filter((row) => !row.transfer_id && !payees.get(row.payee)?.transfer_acct).map((row) => normalize(row, payees, accounts, categories, owedAccountPerson));
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
      return { currency, syncedAt: new Date(lastSync).toISOString(), accounts: [...accounts.values()].filter((row) => !row.closed).map((row) => ({ id: row.id, name: row.name, owner: accountOwner(row.name) || null })), categories: [...categories.values()].filter((row) => !row.hidden && !row.is_income).map((row) => ({ id: row.id, name: row.name })), transactions: rows };
    },
    findTransactions: transactions,
    async shared() {
      await sync(); const { accounts, payees } = await maps();
      const people = [];
      for (const account of accounts.values()) {
        const name = owedAccountPerson(account.name);
        if (!name) continue;
        const rows = (await api.getTransactions(account.id, '1900-01-01', '2099-12-31')).sort((left, right) => String(left.date).localeCompare(String(right.date)) || String(left.id).localeCompare(String(right.id)));
        const balanceCents = await api.getAccountBalance(account.id);
        let runningBalanceCents = balanceCents - rows.reduce((total, row) => total + row.amount, 0);
        const entries = rows.map((row) => {
          runningBalanceCents += row.amount;
          return { id: row.id, date: String(row.date), merchant: payees.get(row.payee)?.name || row.payee_name || '', note: row.notes || '', amountCents: Math.abs(row.amount), direction: row.amount >= 0 ? 'they_owe_you' : 'you_owe_them', runningBalanceCents };
        }).reverse();
        people.push({ id: account.id, name, balanceCents, direction: balanceCents >= 0 ? 'they_owe_you' : 'you_owe_them', entries });
      }
      return { people: people.sort((left, right) => Math.abs(right.balanceCents) - Math.abs(left.balanceCents) || left.name.localeCompare(right.name)) };
    },
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
    splitTransaction({ id, accountId, date, person, mode = 'equal', shares } = {}) {
      return runExclusive(async () => {
        if (typeof id !== 'string' || !id || typeof accountId !== 'string' || !accountId || !isValidExpenseDate(date, zonedDate(now(), timezone))) throw error('Choose a valid transaction to split.');
        if (!['equal', 'amount', 'percent'].includes(mode)) throw error('Choose Equal, Amount, or %.');
        await sync();
        const current = await maps();
        const sourceAccount = current.accounts.get(accountId);
        if (!sourceAccount || sourceAccount.closed || owedAccountPerson(sourceAccount.name)) throw error('Choose a regular expense account to split.');
        const owner = accountOwner(sourceAccount.name);
        const raw = (await api.getTransactions(accountId, date, date)).find((row) => row.id === id);
        if (!raw || raw.amount >= 0 || raw.parent_id || (raw.subtransactions || []).length) throw error('Only an ordinary expense can be converted to a split.');
        const amountCents = Math.abs(raw.amount);
        const entries = Array.isArray(shares) && shares.length ? shares : person ? [{ person, value: null }] : [];
        const asShare = (entry) => ({ person: String(entry?.person || '').trim(), value: entry?.value });
        const namedShares = entries.map(asShare).filter((entry) => entry.person);
        const shareCents = (value) => {
          const number = Number(value);
          if (!Number.isFinite(number) || number <= 0) throw error('Enter a positive share for each person.');
          return mode === 'amount' ? Math.round(number * 100) : Math.round(amountCents * number / 100);
        };
        const resolveAmounts = (people, includeYou) => {
          if (!people.length || people.length > 20 || new Set(people.map((entry) => entry.person.toLowerCase())).size !== people.length) throw error('Give each split a unique person.');
          if (mode === 'equal') {
            const each = Math.round(amountCents / (people.length + (includeYou ? 1 : 0)));
            return people.map((entry) => ({ ...entry, amountCents: each }));
          }
          const result = people.map((entry) => {
            if (mode === 'percent' && Number(entry.value) > 100) throw error('A percentage cannot exceed 100%.');
            return { ...entry, amountCents: shareCents(entry.value) };
          });
          return result;
        };
        if (owner) {
          const selected = entries[0] || { value: null };
          const myShareCents = mode === 'equal' ? Math.round(amountCents / 2) : shareCents(selected.value);
          if (myShareCents > amountCents) throw error('Your share cannot exceed the transaction total.');
          const { account: debtAccount } = await owedAccount(owner);
          await api.deleteTransaction(id);
          await api.addTransactions(accountId, [{ account: accountId, date: String(raw.date), amount: -amountCents, payee: raw.payee, notes: [raw.notes, `${owner} paid`].filter(Boolean).join(' · '), cleared: !!raw.cleared, reconciled: false }], { runTransfers: true });
          await api.addTransactions(debtAccount.id, [{ account: debtAccount.id, date: String(raw.date), amount: -myShareCents, payee: raw.payee, notes: [raw.notes, `your share — ${owner} paid`].filter(Boolean).join(' · '), category: raw.category || null, cleared: false, reconciled: false }], { runTransfers: true });
          await api.sync(); lastSync = now();
          return { status: 'complete', direction: 'you_owe_them', shares: [{ person: owner, account: debtAccount.name, amountCents: myShareCents }] };
        }
        const parts = resolveAmounts(namedShares, true);
        const totalSharedCents = parts.reduce((total, entry) => total + entry.amountCents, 0);
        const myShareCents = amountCents - totalSharedCents;
        if (myShareCents <= 0) throw error('Leave an amount for your share.');
        const resolved = [];
        for (const part of parts) {
          const result = await owedAccount(part.person);
          const transferPayee = result.maps.payeeRows.find((row) => row.transfer_acct === result.account.id);
          if (!transferPayee) throw error(`Could not find the transfer payee for ${result.account.name}.`);
          resolved.push({ ...part, account: result.account.name, transferPayee: transferPayee.id });
        }
        await api.deleteTransaction(id);
        await api.addTransactions(accountId, [{ account: accountId, date: String(raw.date), amount: -amountCents, payee: raw.payee, notes: raw.notes || '', cleared: !!raw.cleared, reconciled: false, subtransactions: [
          { amount: -myShareCents, category: raw.category || null, notes: 'your share' },
          ...resolved.map((part) => ({ amount: -part.amountCents, payee: part.transferPayee, notes: `owed by ${part.person}` })),
        ] }], { runTransfers: true });
        await api.sync(); lastSync = now();
        return { status: 'complete', direction: 'they_owe_you', shares: resolved.map(({ person, account, amountCents: value }) => ({ person, account, amountCents: value })) };
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
