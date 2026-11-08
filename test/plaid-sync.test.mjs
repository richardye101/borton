import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPlaidSync } from '../plaid-sync.mjs';

const key = Buffer.alloc(32, 7).toString('base64');
const config = { clientId: 'client', secret: 'secret', env: 'production', tokenKey: key };
const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'borton-plaid-'));

test('keeps Plaid tokens encrypted and absent from connection results', async () => {
  const statePath = path.join(temp(), 'plaid-items.json');
  const plaid = createPlaidSync({ ...config, statePath, actualAccounts: async () => [{ id: 'a1', name: 'Visa' }], fetch: async (_url, init) => {
    const body = JSON.parse(init.body);
    return body.public_token ? response({ access_token: 'access-secret', item_id: 'item-1' }) : response({ link_token: 'link-token' });
  } });
  await plaid.complete({ publicToken: 'public-token', metadata: { institution: { name: 'Bank' }, accounts: [{ id: 'plaid-a', name: 'Visa', type: 'credit' }] } });
  assert.match(fs.readFileSync(statePath, 'utf8'), /ciphertext/);
  assert.doesNotMatch(fs.readFileSync(statePath, 'utf8'), /access-secret/);
  assert.deepEqual((await plaid.connections()).connections[0], { id: 'item-1', institution: 'Bank', status: 'needs_mapping', lastSyncedAt: null, lastError: '', removedCount: 0, accounts: [{ id: 'plaid-a', name: 'Visa', mask: '', type: 'credit', actualAccountId: '' }] });
});

test('creates a Canadian transactions Link token and advances cursor only after every page imports', async () => {
  const calls = []; const imported = []; const statePath = path.join(temp(), 'plaid-items.json');
  const plaid = createPlaidSync({ ...config, statePath, actualAccounts: async () => [{ id: 'a1', name: 'Visa' }], importTransactions: async (rows) => imported.push(...rows), fetch: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body });
    if (url.endsWith('/link/token/create')) return response({ link_token: 'link-token' });
    if (url.endsWith('/item/public_token/exchange')) return response({ access_token: 'access', item_id: 'item-1' });
    if (url.endsWith('/transactions/sync')) return body.cursor ? response({ added: [{ transaction_id: 't2', account_id: 'p1', date: '2026-11-07', amount: -1.235, merchant_name: 'Refund', pending: false }], modified: [], removed: [], next_cursor: 'cursor-2', has_more: false }) : response({ added: [{ transaction_id: 't1', account_id: 'p1', date: '2026-11-06', amount: 12.34, merchant_name: 'Shop', pending: false }], modified: [], removed: [], next_cursor: 'cursor-1', has_more: true });
    throw new Error('Unexpected request');
  } });
  assert.deepEqual(await plaid.linkToken(), { linkToken: 'link-token' });
  assert.deepEqual(calls[0].body, { client_id: 'client', secret: 'secret', client_name: 'Borton', language: 'en', country_codes: ['CA'], products: ['transactions'], user: { client_user_id: 'borton-owner' } });
  await plaid.complete({ publicToken: 'public', metadata: { institution: { name: 'Bank' }, accounts: [{ id: 'p1', name: 'Visa', type: 'credit' }] } });
  await plaid.setMappings({ id: 'item-1', mappings: [{ plaidAccountId: 'p1', actualAccountId: 'a1' }] });
  assert.deepEqual(await plaid.sync('item-1'), { id: 'item-1', added: 2, modified: 0, removed: 0 });
  assert.deepEqual(imported.map(({ importedId, amountCents }) => ({ importedId, amountCents })), [{ importedId: 't1', amountCents: -1234 }, { importedId: 't2', amountCents: 124 }]);
  assert.equal(JSON.parse(await plaid.debugState()).items[0].cursor, 'cursor-2');
});

test('rejects duplicate Actual mappings before syncing', async () => {
  const plaid = createPlaidSync({ ...config, statePath: path.join(temp(), 'plaid-items.json'), actualAccounts: async () => [{ id: 'a1', name: 'Visa' }], fetch: async (_url, init) => JSON.parse(init.body).public_token ? response({ access_token: 'access', item_id: 'item-1' }) : response({ link_token: 'link' }) });
  await plaid.complete({ publicToken: 'public', metadata: { accounts: [{ id: 'p1', name: 'One', type: 'credit' }, { id: 'p2', name: 'Two', type: 'credit' }] } });
  await assert.rejects(() => plaid.setMappings({ id: 'item-1', mappings: [{ plaidAccountId: 'p1', actualAccountId: 'a1' }, { plaidAccountId: 'p2', actualAccountId: 'a1' }] }), /more than once/i);
});

test('keeps every account selected in Link for mapping', async () => {
  const plaid = createPlaidSync({ ...config, statePath: path.join(temp(), 'plaid-items.json'), actualAccounts: async () => [], fetch: async (_url, init) => JSON.parse(init.body).public_token ? response({ access_token: 'access', item_id: 'item-1' }) : response({ link_token: 'link' }) });
  const connection = await plaid.complete({ publicToken: 'public', metadata: { accounts: [{ id: 'checking', name: 'Chequing', type: 'depository', subtype: 'checking' }, { id: 'loc', name: 'Line of credit', type: 'loan', subtype: 'line of credit' }, { id: 'card', name: 'Card', type: 'credit', subtype: 'credit card' }] } });
  assert.deepEqual(connection.accounts.map((account) => account.id), ['checking', 'loc', 'card']);
});

test('reconnect Link lets the owner revise selected accounts', async () => {
  const calls = []; const plaid = createPlaidSync({ ...config, statePath: path.join(temp(), 'plaid-items.json'), actualAccounts: async () => [], fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return init && JSON.parse(init.body).public_token ? response({ access_token: 'access', item_id: 'item-1' }) : response({ link_token: 'link' }); } });
  await plaid.complete({ publicToken: 'public', metadata: { accounts: [{ id: 'old', name: 'Card', type: 'credit' }] } });
  await plaid.reconnectToken('item-1');
  assert.deepEqual(calls.at(-1).body.update, { account_selection_enabled: true });
  const updated = await plaid.complete({ connectionId: 'item-1', metadata: { accounts: [{ id: 'deposit', name: 'Chequing', type: 'depository' }] } });
  assert.deepEqual(updated.accounts.map((account) => account.id), ['deposit']);
});
