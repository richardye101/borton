import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const asKey = (value) => { try { const key = Buffer.from(value || '', 'base64'); return key.length === 32 ? key : null; } catch { return null; } };
const publicItem = (item) => ({ id: item.id, institution: item.institution || 'Connected bank', status: item.status || 'needs_mapping', lastSyncedAt: item.lastSyncedAt || null, lastError: item.lastError || '', removedCount: item.removedCount || 0, accounts: (item.accounts || []).map(({ id, name, mask, type, actualAccountId }) => ({ id, name, mask: mask || '', type, actualAccountId: actualAccountId || '' })) });
const postedRows = (item, changes) => [...changes.added, ...changes.modified].filter((row) => !row.pending && item.accounts.some((account) => account.id === row.account_id && account.actualAccountId)).map((row) => {
  const account = item.accounts.find((candidate) => candidate.id === row.account_id);
  return { importedId: row.transaction_id, accountId: account.actualAccountId, date: row.date, amountCents: -Math.round(Number(row.amount || 0) * 100), merchant: String(row.merchant_name || row.name || 'Plaid transaction').trim(), cleared: true, modified: changes.modified.some((candidate) => candidate.transaction_id === row.transaction_id) };
});
const historicalRows = (item, rows) => rows.filter((row) => !row.pending && item.accounts.some((account) => account.id === row.account_id && account.actualAccountId)).map((row) => {
  const account = item.accounts.find((candidate) => candidate.id === row.account_id);
  return { importedId: row.transaction_id, accountId: account.actualAccountId, date: row.date, amountCents: -Math.round(Number(row.amount || 0) * 100), merchant: String(row.merchant_name || row.name || 'Plaid transaction').trim(), cleared: true, modified: false, institution: item.institution || 'Connected bank', account: account.name || 'Account' };
});

export function createPlaidSync({ clientId = '', secret = '', env = '', tokenKey = '', statePath, actualAccounts = async () => [], importTransactions = async () => {}, fetch: fetcher = globalThis.fetch, now = Date.now } = {}) {
  const key = asKey(tokenKey);
  const configured = Boolean(clientId && secret && env === 'production' && key && statePath && fetcher);
  const base = 'https://production.plaid.com';
  const decrypt = (value) => {
    const iv = Buffer.from(value.iv, 'base64'); const tag = Buffer.from(value.tag, 'base64'); const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  };
  const encrypt = (value) => {
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  };
  const load = () => { if (!configured || !fs.existsSync(statePath)) return { items: [] }; try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { items: [] }; } };
  const save = (state) => { fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 }); const temporary = `${statePath}.tmp`; fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temporary, statePath); fs.chmodSync(statePath, 0o600); };
  const requireConfigured = () => { if (!configured) throw error('Plaid is not configured on this server.', 503); };
  const call = async (route, body) => {
    requireConfigured(); const response = await fetcher(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: clientId, secret, ...body }) });
    const result = await response.json().catch(() => ({})); if (!response.ok) throw error(result.error_message || `Plaid HTTP ${response.status}.`, response.status >= 500 ? 502 : 400); return result;
  };
  const find = (id) => { const state = load(); const item = state.items.find((candidate) => candidate.id === id); if (!item) throw error('Plaid connection not found.', 404); return { state, item }; };
  return {
    configured,
    async connections() { return { configured, connections: configured ? load().items.map(publicItem) : [], actualAccounts: configured ? await actualAccounts() : [] }; },
    async linkToken({ connectionId = '' } = {}) {
      const access = connectionId ? decrypt(find(connectionId).item.accessToken) : '';
      const result = await call('/link/token/create', { client_name: 'Borton', language: 'en', country_codes: ['CA'], products: ['transactions'], user: { client_user_id: 'borton-owner' }, ...(access ? { access_token: access, update: { account_selection_enabled: true } } : {}) });
      return { linkToken: result.link_token };
    },
    async complete({ publicToken, metadata = {}, connectionId = '' } = {}) {
      requireConfigured(); if (!connectionId && (!publicToken || typeof publicToken !== 'string')) throw error('Plaid did not return a Link token.');
      if (connectionId) {
        const { state, item } = find(connectionId); const mappings = new Map(item.accounts.map((account) => [account.id, account.actualAccountId]));
        item.accounts = (metadata.accounts || []).map((account) => ({ id: account.id, name: account.name || account.official_name || 'Account', mask: account.mask || '', type: account.type || '', actualAccountId: mappings.get(account.id) || '' }));
        item.status = item.accounts.some((account) => account.actualAccountId) ? 'ready' : 'needs_mapping'; item.lastError = ''; save(state); return publicItem(item);
      }
      const result = await call('/item/public_token/exchange', { public_token: publicToken }); const state = load();
      const item = { id: result.item_id, accessToken: encrypt(result.access_token), institution: metadata.institution?.name || 'Connected bank', status: 'needs_mapping', lastSyncedAt: null, lastError: '', removedCount: 0, cursor: '', accounts: (metadata.accounts || []).map((account) => ({ id: account.id, name: account.name || account.official_name || 'Account', mask: account.mask || '', type: account.type || '', actualAccountId: '' })) };
      if (!item.accounts.length) throw error('Choose at least one account in Plaid Link.');
      state.items.push(item); save(state); return publicItem(item);
    },
    async setMappings({ id, mappings = [] } = {}) {
      const { state, item } = find(id); const actual = new Set((await actualAccounts()).map((account) => account.id)); const used = new Set();
      for (const mapping of mappings) { if (!item.accounts.some((account) => account.id === mapping.plaidAccountId)) throw error('Unknown Plaid account.'); if (mapping.actualAccountId && !actual.has(mapping.actualAccountId)) throw error('Choose a valid Actual account.'); if (mapping.actualAccountId && used.has(mapping.actualAccountId)) throw error('An Actual account cannot be mapped more than once.'); if (mapping.actualAccountId) used.add(mapping.actualAccountId); }
      for (const account of item.accounts) account.actualAccountId = mappings.find((mapping) => mapping.plaidAccountId === account.id)?.actualAccountId || '';
      if (!used.size) throw error('Map at least one account before syncing.'); item.status = 'ready'; item.lastError = ''; save(state); return publicItem(item);
    },
    async sync(id) {
      const { state, item } = find(id); if (!item.accounts.some((account) => account.actualAccountId)) throw error('Map an Actual account before syncing.');
      let cursor = item.cursor || ''; let added = 0; let modified = 0; let removed = 0;
      try {
        while (true) {
          const changes = await call('/transactions/sync', { access_token: decrypt(item.accessToken), ...(cursor ? { cursor } : {}) }); const rows = postedRows(item, changes);
          await importTransactions(rows); added += changes.added.filter((row) => !row.pending).length; modified += changes.modified.filter((row) => !row.pending).length; removed += changes.removed.length; cursor = changes.next_cursor;
          if (!changes.has_more) break;
        }
        item.cursor = cursor; item.lastSyncedAt = new Date().toISOString(); item.lastError = ''; item.status = 'ready'; item.removedCount = (item.removedCount || 0) + removed; save(state); return { id: item.id, added, modified, removed };
      } catch (cause) { item.lastError = cause.message; if (/ITEM_LOGIN_REQUIRED|reconnect/i.test(cause.message)) item.status = 'reconnect_needed'; save(state); throw cause; }
    },
    async history({ days = 180, pageSize = 500 } = {}) {
      requireConfigured(); const windowDays = Math.min(Math.max(Number(days) || 180, 1), 730); const count = Math.min(Math.max(Number(pageSize) || 500, 1), 500);
      const endDate = new Date(now()).toISOString().slice(0, 10); const startDate = new Date(Number(now()) - (windowDays - 1) * 86_400_000).toISOString().slice(0, 10); const rows = [];
      for (const item of load().items.filter((candidate) => candidate.status === 'ready' && candidate.accounts.some((account) => account.actualAccountId))) {
        let offset = 0; let total = Infinity;
        while (offset < total) {
          const result = await call('/transactions/get', { access_token: decrypt(item.accessToken), start_date: startDate, end_date: endDate, options: { count, offset } });
          rows.push(...historicalRows(item, result.transactions || [])); total = Number(result.total_transactions || 0); offset += count;
          if (!(result.transactions || []).length) break;
        }
      }
      return { scanned: rows.length, rows };
    },
    async reconnectToken(id) { return this.linkToken({ connectionId: id }); },
    async disconnect(id) { const { state, item } = find(id); await call('/item/remove', { access_token: decrypt(item.accessToken) }); state.items = state.items.filter((candidate) => candidate !== item); save(state); return { id, status: 'complete' }; },
    async syncHealthy() { if (!configured) return []; const items = load().items.filter((item) => item.status === 'ready' && item.accounts.some((account) => account.actualAccountId)); return Promise.allSettled(items.map((item) => this.sync(item.id))); },
    async debugState() { return JSON.stringify(load()); },
  };
}
