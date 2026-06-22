// Telegram receipt logger -> Actual Budget
// Flow: photo+caption -> Gemini vision extracts receipt JSON -> caption parsed in code
//       -> route to card account (explicit alias > receipt last-4 > ask) -> write to Actual -> reply.
import * as api from '@actual-app/api';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dir, 'config.json'), 'utf8'));
const CARDMAP_PATH = path.join(__dir, 'cardmap.json');
let cardmap = JSON.parse(fs.readFileSync(CARDMAP_PATH, 'utf8'));
const saveCardmap = () => fs.writeFileSync(CARDMAP_PATH, JSON.stringify(cardmap, null, 2));

// Secrets come from .env (TELEGRAM_BOT_KEY, GOOGLE_API_KEY, optional ACTUAL_PASSWORD).
function loadEnv(p) {
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
loadEnv(path.join(__dir, '.env'));

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_KEY || cfg.telegram?.token;
const GEMINI_KEY = process.env.GOOGLE_API_KEY || cfg.gemini?.apiKey;
const ACTUAL_PASSWORD = process.env.ACTUAL_PASSWORD || cfg.actual?.password
  || (fs.existsSync(`${process.env.HOME}/.config/actual/password`)
      ? fs.readFileSync(`${process.env.HOME}/.config/actual/password`, 'utf8').trim() : '');
for (const [k, v] of [['TELEGRAM_BOT_KEY', TELEGRAM_TOKEN], ['GOOGLE_API_KEY', GEMINI_KEY]])
  if (!v) { console.error(`Missing ${k} (set it in ~/receipt-bot/.env)`); process.exit(1); }

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Actual self-signed cert
const TG = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ---------- Telegram helpers ----------
async function tg(method, params) {
  const r = await fetch(`${TG}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  return r.json();
}
async function send(chatId, text) { await tg('sendMessage', { chat_id: chatId, text }); }
async function downloadPhoto(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const filePath = f.result.file_path;
  const r = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const mime = filePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  return { buf, mime };
}

// ---------- Gemini extractor (pluggable: swap this fn for Claude/local later) ----------
const RECEIPT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    merchant: { type: 'STRING', description: 'Store / merchant name' },
    date: { type: 'STRING', description: 'Purchase date as YYYY-MM-DD if visible, else empty string' },
    total: { type: 'NUMBER', description: 'Grand total paid' },
    currency: { type: 'STRING' },
    tax: { type: 'NUMBER' },
    card_last4: { type: 'STRING', description: 'Last 4 digits of the card if printed (e.g. from "VISA ****1234"), else empty string' },
    line_items: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Short list of items purchased' },
  },
  required: ['merchant', 'total'],
};
async function extractReceipt(buf, mime) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.gemini.model}:generateContent`;
  const body = {
    contents: [{
      parts: [
        { text: 'Extract the receipt into the schema. Use the printed grand total for "total". List each purchased item in line_items using short names (condense long descriptions, drop prices/quantities). If the card last-4 is not printed, return an empty string for card_last4.' },
        { inlineData: { mimeType: mime, data: buf.toString('base64') } },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: RECEIPT_SCHEMA },
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': GEMINI_KEY },
      body: JSON.stringify(body),
    });
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini: no content — ' + JSON.stringify(d).slice(0, 300));
    return JSON.parse(text);
  }
  throw new Error('Gemini: rate-limited/unavailable after retries');
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------- Caption parsing (code-side, deterministic) ----------
function parseCaption(caption) {
  const text = (caption || '').trim();
  const lc = text.toLowerCase();
  const split = /\bsplit\b|\bhalf\b|\/2\b|#split/.test(lc) || /\bw\/?\s*tia\b/.test(lc);
  let cardAccount = null;
  for (const [alias, acct] of Object.entries(cardmap.aliases).sort((a, b) => b[0].length - a[0].length)) {
    if (lc.includes(alias)) { cardAccount = acct; break; }
  }
  return { notes: text, split, cardAccount };
}

// Free-text expense, e.g. "12.50 starbucks on amex split w tia" — needs a leading
// number or a $amount. Returns null if no amount, so non-expense text falls through.
function parseFreeText(text) {
  const t = (text || '').trim();
  const m = t.match(/^\s*\$?\s*(\d+(?:\.\d{1,2})?)\b/) || t.match(/\$\s*(\d+(?:\.\d{1,2})?)\b/);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!amount || !isFinite(amount)) return null;
  const rest = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim();
  const lc = rest.toLowerCase();
  const split = /\bsplit\b|\bhalf\b|\/2\b|#split/.test(lc) || /\bw\/?\s*tia\b/.test(lc);
  let cardAccount = null, alias = null;
  for (const [a, acct] of Object.entries(cardmap.aliases).sort((x, y) => y[0].length - x[0].length))
    if (lc.includes(a)) { cardAccount = acct; alias = a; break; }
  // clean payee: tokens minus the card alias, a leading "on", and split words
  const drop = new Set(['on', 'split', 'half', 'w', 'w/', 'tia', '#split']);
  if (alias) alias.split(/\s+/).forEach((x) => drop.add(x));
  const merchant = rest.split(/\s+/).filter((w) => !drop.has(w.toLowerCase())).join(' ').trim();
  return { amount, split, cardAccount, merchant: merchant || 'Manual entry', notes: merchant };
}

// ---------- Category guess (light; user/Actual rules can refine) ----------
const CAT_RULES = [
  [/sobey|loblaw|no frills|metro|kai wei|grocer|supermarket|shopper/, 'Groceries'],
  [/mcdonald|tacos|restaurant|dinner|lunch|cafe|locals only|pizza|sushi/, 'Eating Out'],
  [/tim hortons|starbucks|coffee|espresso/, 'Coffee'],
  [/uber|lyft|presto|metrolinx|go transit|ttc|transit/, 'Transportation'],
  [/lcbo|beer|wine|liquor/, 'Alcohol'],
  [/ikea|home depot|homesense|canadian tire/, 'Home'],
];
function guessCategory(receipt, caption) {
  const hay = `${receipt.merchant} ${(receipt.line_items || []).join(' ')} ${caption}`.toLowerCase();
  for (const [re, cat] of CAT_RULES) if (re.test(hay)) return cat;
  return cfg.defaults.fallbackCategory;
}

// ---------- Actual ----------
let ACCT = {}, CAT = {}, TRANSFER_PAYEE = {};
async function initActual() {
  if (!fs.existsSync(cfg.actual.dataDir)) fs.mkdirSync(cfg.actual.dataDir, { recursive: true });
  await api.init({ dataDir: path.resolve(__dir, cfg.actual.dataDir), serverURL: cfg.actual.serverURL, password: ACTUAL_PASSWORD });
  await api.downloadBudget(cfg.actual.syncId);
  await refreshActualMaps();
}
async function refreshActualMaps() {
  ACCT = Object.fromEntries((await api.getAccounts()).map((a) => [a.name, a.id]));
  CAT = Object.fromEntries((await api.getCategories()).map((c) => [c.name, c.id]));
  for (const p of await api.getPayees()) if (p.transfer_acct) TRANSFER_PAYEE[p.transfer_acct] = p.id;
}
async function logExpense({ accountName, total, payee, notes, category, date, split }) {
  const acctId = ACCT[accountName];
  if (!acctId) throw new Error(`No account named "${accountName}" in Actual`);
  const cents = Math.round(Number(total) * 100);
  const catId = CAT[category] || null;
  const txn = { account: acctId, date, amount: -cents, payee_name: payee, notes, cleared: false };
  if (split) {
    const half = Math.round(cents / 2);
    const owedAcct = ACCT[cfg.defaults.splitAccount];
    const transferPayee = owedAcct ? TRANSFER_PAYEE[owedAcct] : null;
    if (transferPayee) {
      txn.subtransactions = [
        { amount: -half, category: catId, notes: 'your share' },
        { amount: -(cents - half), payee: transferPayee, notes: `owed by ${cfg.defaults.splitPerson}` },
      ];
    } else {
      txn.category = catId; // fallback: no transfer payee found, log whole + tag
      txn.notes = `${notes} [SPLIT w/ ${cfg.defaults.splitPerson} — settle manually]`;
    }
  } else {
    txn.category = catId;
  }
  const importedId = 'bot-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  txn.imported_id = importedId;
  await api.addTransactions(acctId, [txn]);
  await api.sync();
  const created = (await api.getTransactions(acctId, txn.date, txn.date)).find((t) => t.imported_id === importedId);
  return created ? created.id : null;
}

// ---------- Main flow ----------
const pending = {}; // chatId -> { receipt, parsed, last4 }  (awaiting a card answer)
const lastTxn = {}; // chatId -> { id, ts }  (most recent logged txn, for follow-up edits)
const EDIT_WINDOW_MS = 60 * 60 * 1000; // a reply within an hour edits the last txn

function todayISO() { return new Date().toISOString().slice(0, 10); }

async function finalize(chatId, receipt, parsed, accountName) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(receipt.date || '') ? receipt.date : todayISO();
  const category = guessCategory(receipt, parsed.notes);
  const items = (receipt.line_items || []).map((s) => String(s).trim()).filter(Boolean).join(', ');
  let notes = [parsed.notes, items].filter(Boolean).join(' · ');
  if (receipt.card_last4) notes += (notes ? ' ' : '') + `[card ****${receipt.card_last4}]`;
  const txnId = await logExpense({ accountName, total: receipt.total, payee: receipt.merchant, notes, category, date, split: parsed.split });
  if (txnId) lastTxn[chatId] = { id: txnId, ts: Date.now() };
  const splitLine = parsed.split ? `  ·  split w/ ${cfg.defaults.splitPerson} (your share $${(receipt.total / 2).toFixed(2)})` : '';
  await send(chatId, `✅ $${Number(receipt.total).toFixed(2)} · ${receipt.merchant}\n→ ${category} · ${accountName}${splitLine}\n${date}${items ? '\n🧾 ' + items : ''}\n(reply to edit: note text · "category X" · "delete")`);
}

async function handlePhoto(chatId, msg) {
  const fileId = msg.photo[msg.photo.length - 1].file_id; // largest
  await send(chatId, '📸 reading receipt…');
  const { buf, mime } = await downloadPhoto(fileId);
  const receipt = await extractReceipt(buf, mime);
  const parsed = parseCaption(msg.caption);
  let account = parsed.cardAccount || (receipt.card_last4 && cardmap.byLast4[receipt.card_last4]) || null;
  if (!account) {
    if (receipt.card_last4) {
      pending[chatId] = { receipt, parsed, last4: receipt.card_last4 };
      await send(chatId, `New card ****${receipt.card_last4} ($${Number(receipt.total).toFixed(2)} at ${receipt.merchant}).\nWhich account is it? (reply with the card name)`);
    } else {
      pending[chatId] = { receipt, parsed, last4: null };
      await send(chatId, `No card number on the receipt ($${Number(receipt.total).toFixed(2)} at ${receipt.merchant}).\nWhich card did you use?`);
    }
    return;
  }
  await finalize(chatId, receipt, parsed, account);
}

async function handleFreeText(chatId, ft) {
  const receipt = { merchant: ft.merchant, total: ft.amount, card_last4: '', date: '', line_items: [] };
  const parsed = { notes: ft.notes, split: ft.split };
  const account = ft.cardAccount || null;
  if (!account) {
    pending[chatId] = { receipt, parsed, last4: null };
    return await send(chatId, `$${ft.amount.toFixed(2)} · ${ft.merchant}\nWhich card did you use?`);
  }
  await finalize(chatId, receipt, parsed, account);
}

function resolveAccount(answer) {
  const lc = answer.trim().toLowerCase();
  if (cardmap.aliases[lc]) return cardmap.aliases[lc];
  const exact = Object.keys(ACCT).find((n) => n.toLowerCase() === lc);
  if (exact) return exact;
  const partial = Object.keys(ACCT).find((n) => n.toLowerCase().includes(lc));
  return partial || null;
}

async function handleCardAnswer(chatId, text) {
  const p = pending[chatId];
  const account = resolveAccount(text);
  if (!account) { await send(chatId, `Couldn't match "${text}" to an account. Try the exact card name.`); return; }
  if (p.last4) { cardmap.byLast4[p.last4] = account; saveCardmap(); }
  delete pending[chatId];
  await finalize(chatId, p.receipt, p.parsed, account);
}

async function editLast(chatId, text) {
  const id = lastTxn[chatId].id;
  const raw = text.trim();
  const lc = raw.toLowerCase();
  if (['delete', 'undo', 'remove'].includes(lc)) {
    await api.deleteTransaction(id); await api.sync();
    delete lastTxn[chatId];
    return send(chatId, '🗑 Deleted that transaction.');
  }
  const m = lc.match(/^(?:category|cat)\s+(.+)$/);
  if (m) {
    const want = m[1].trim();
    const name = Object.keys(CAT).find((c) => c.toLowerCase() === want);
    if (!name) return send(chatId, `No category named "${want}". Try the exact name.`);
    await api.updateTransaction(id, { category: CAT[name] }); await api.sync();
    return send(chatId, `✏️ Category → ${name}`);
  }
  const note = raw.replace(/^note:?\s*/i, '').trim();
  await api.updateTransaction(id, { notes: note }); await api.sync();
  return send(chatId, '📝 Note updated.');
}

// Relay: a second "sender" bot posts JSON into a private channel; this bot (admin) reads it.
async function onRelayPost(post) {
  if (!cfg.telegram.relayChannelId) {
    console.log('Relay channel_post seen from chat id:', post.chat.id, '— put this in config.json telegram.relayChannelId');
    return;
  }
  if (post.chat.id !== cfg.telegram.relayChannelId) return;
  const chat = cfg.telegram.allowedChatId;
  const text = (post.text || '').trim();
  try {
    if (text.startsWith('{')) {
      await handleIngest(JSON.parse(text));
    } else {
      const ft = parseFreeText(text);
      if (!ft) throw new Error('not JSON and no amount found — try "12.50 merchant on amex"');
      await handleFreeText(chat, ft);
    }
  } catch (e) {
    if (chat) await send(chat, '⚠️ relay error: ' + e.message).catch(() => {});
    console.error('relay', e);
  }
}

async function onUpdate(u) {
  if (u.channel_post) return await onRelayPost(u.channel_post);
  const msg = u.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  if (cfg.telegram.allowedChatId && chatId !== cfg.telegram.allowedChatId) return; // ignore strangers
  try {
    if (msg.photo) return await handlePhoto(chatId, msg);
    if (msg.text && pending[chatId]) return await handleCardAnswer(chatId, msg.text);
    if (msg.text) {
      const ft = parseFreeText(msg.text);
      if (ft) return await handleFreeText(chatId, ft);
    }
    if (msg.text && lastTxn[chatId] && Date.now() - lastTxn[chatId].ts < EDIT_WINDOW_MS) return await editLast(chatId, msg.text);
    if (msg.text) await send(chatId, 'Send a receipt photo, or just text the expense like "12.50 starbucks on amex split w tia". After I log one, reply within the hour to edit it — free text = note, "category X", or "delete".');
  } catch (e) {
    await send(chatId, '⚠️ ' + (e.message || String(e)));
    console.error(e);
  }
}

// ---------- HTTP ingest (Apple Pay / Shortcuts POST here; NOT via Telegram) ----------
async function handleIngest(d) {
  const chat = cfg.telegram.allowedChatId;
  const amount = Math.abs(Number(d.amount));
  if (!amount || !isFinite(amount)) throw new Error('missing/invalid amount');
  const merchant = (d.merchant || 'Apple Pay').toString().trim() || 'Apple Pay';
  const account = (d.card && resolveAccount(String(d.card))) || (d.last4 && cardmap.byLast4[d.last4]) || null;
  if (!account) throw new Error(`couldn't match card "${d.card || d.last4 || '?'}"`);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') ? d.date : todayISO();
  const split = !!d.split;
  let notes = (d.note || '').toString().trim();
  if (d.last4) notes += (notes ? ' ' : '') + `[card ****${d.last4}]`;
  notes = (notes + ' [apple pay]').trim();
  const category = guessCategory({ merchant, line_items: [] }, notes);
  const id = await logExpense({ accountName: account, total: amount, payee: merchant, notes, category, date, split });
  if (id && chat) lastTxn[chat] = { id, ts: Date.now() };
  if (chat) await send(chat, `⚡ $${amount.toFixed(2)} · ${merchant}\n→ ${category} · ${account}${split ? '  · split' : ''}\n(reply to edit: note · "category X" · "delete")`);
  return { account, category, amount };
}
function startIngest() {
  const port = cfg.ingest?.port || 8088;
  const secret = process.env.INGEST_SECRET;
  if (!secret) { console.log('WARNING: INGEST_SECRET not set in .env — /ingest disabled.'); return; }
  http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.startsWith('/ingest')) { res.writeHead(404); return res.end('not found'); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const u = new URL(req.url, 'http://x');
        const given = u.searchParams.get('secret') || req.headers['x-secret'];
        if (given !== secret) { res.writeHead(401); return res.end('unauthorized'); }
        const out = await handleIngest(JSON.parse(body || '{}'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...out }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
        const chat = cfg.telegram.allowedChatId;
        if (chat) await send(chat, '⚠️ ingest error: ' + e.message).catch(() => {});
      }
    });
  }).listen(port, () => console.log(`Ingest endpoint listening on :${port}/ingest`));
}

async function main() {
  console.log('Connecting to Actual…');
  await initActual();
  console.log('Accounts:', Object.keys(ACCT).join(', '));
  startIngest();
  if (!cfg.telegram.allowedChatId) console.log('WARNING: allowedChatId not set — bot will respond to anyone who messages it. Run `npm run chatid` and set it in config.json.');
  console.log('Bot running. Long-polling Telegram…');
  let offset = 0;
  for (;;) {
    try {
      const res = await tg('getUpdates', { offset, timeout: 50 });
      for (const u of res.result || []) { offset = u.update_id + 1; await onUpdate(u); }
    } catch (e) { console.error('poll error', e.message); await sleep(3000); }
  }
}
// `node bot.mjs selftest` — checks the free-text parser without touching Telegram/Actual.
function selftest() {
  const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
  assert(parseFreeText('hello there') === null, 'no amount -> null');
  assert(parseFreeText('category Dining') === null, 'no amount -> null (edit-like)');
  const a = parseFreeText('12.50 starbucks on amex split w tia');
  assert(a && a.amount === 12.5 && a.split === true, 'amount+split parsed');
  assert(a.merchant === 'starbucks', 'merchant cleaned of card/split words: ' + a.merchant);
  const b = parseFreeText('paid $7 for coffee');
  assert(b && b.amount === 7, '$amount mid-string parsed');
  console.log('selftest OK');
}
if (process.argv[2] === 'selftest') selftest();
else main().catch((e) => { console.error(e); process.exit(1); });
