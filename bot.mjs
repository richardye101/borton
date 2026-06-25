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
async function send(chatId, text, reply_markup) {
  const r = await tg('sendMessage', { chat_id: chatId, text, ...(reply_markup ? { reply_markup } : {}) });
  return r?.result?.message_id;
}
// Inline-keyboard widgets (tappable buttons -> callback_query).
const YESNO_KB = { inline_keyboard: [[{ text: '✅ Yes', callback_data: 'c:y' }, { text: '❌ No', callback_data: 'c:n' }]] };
function cardKb() {
  const accounts = [...new Set(Object.values(cardmap.aliases))].filter((a) => `card:${a}`.length <= 64);
  const rows = [];
  for (let i = 0; i < accounts.length; i += 2) rows.push(accounts.slice(i, i + 2).map((a) => ({ text: a, callback_data: `card:${a}` })));
  return { inline_keyboard: rows };
}
const dropKb = (chatId, mid) => tg('editMessageReplyMarkup', { chat_id: chatId, message_id: mid }).catch(() => {});
// Reaction feedback: 👀 on receipt, 👍 when done. (Telegram's allowed reaction set
// excludes ✅, so 👍 stands in for the "done" check.) Pass '' to clear.
const REACT_SEEN = '👀', REACT_DONE = '👍';
async function react(chatId, messageId, emoji) {
  if (!messageId) return;
  const r = await tg('setMessageReaction', { chat_id: chatId, message_id: messageId, reaction: emoji ? [{ type: 'emoji', emoji }] : [] }).catch((e) => ({ ok: false, description: e.message }));
  if (r && r.ok === false) console.error('react failed:', r.description);
}
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
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// Try the primary model, then fall back to other flash models on transient 429/5xx (e.g. 503 overload).
// Fall back to lighter, less-contended models (lite variants rarely 503) rather than other popular flash models.
const GEMINI_MODELS = [cfg.gemini.model, ...(cfg.gemini.fallbackModels || ['gemini-2.0-flash-lite', 'gemini-flash-lite-latest', 'gemini-2.0-flash'])]
  .filter((m, i, a) => m && a.indexOf(m) === i);
async function geminiGenerate(parts, schema) {
  const body = { contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema } };
  let lastErr = 'unknown';
  for (const model of GEMINI_MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-goog-api-key': GEMINI_KEY }, body: JSON.stringify(body) });
        if (r.status === 429 || r.status >= 500) { lastErr = `${model} HTTP ${r.status}`; await sleep(700 * (attempt + 1)); continue; }
        const d = await r.json();
        const t = d?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!t) { lastErr = `${model}: ${JSON.stringify(d).slice(0, 150)}`; break; } // bad response -> try next model
        return JSON.parse(t);
      } catch (e) { lastErr = `${model}: ${e.message}`; await sleep(700); }
    }
  }
  throw new Error('Gemini unavailable (' + lastErr + ')');
}
async function extractReceipt(buf, mime) {
  return geminiGenerate(
    [{ text: 'Extract the receipt into the schema. Use the printed grand total for "total". List each purchased item in line_items using short names (condense long descriptions, drop prices/quantities). If the card last-4 is not printed, return an empty string for card_last4.' },
     { inlineData: { mimeType: mime, data: buf.toString('base64') } }],
    RECEIPT_SCHEMA);
}

// ---------- Split helpers (person -> "Owed by {name}" account) ----------
const OWED_FMT = cfg.defaults.owedAccountFormat || 'Owed by {name}';
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const owedAccountFor = (person) => OWED_FMT.replace('{name}', cap(String(person).trim()));
// "split with Ryan" / "split w ryan" -> "Ryan"; bare "split" -> null (caller uses the default person)
function extractPerson(text) {
  const m = (text || '').match(/\bsplit\s+(?:with|w\/?)\s+([a-z][\w'-]*)/i);
  return m ? m[1] : null;
}
const SPLIT_RE = /\bsplit\b|\bhalf\b|\bhalves\b|\/2\b|#split/i;

// ---------- Caption parsing (code-side, deterministic) ----------
function parseCaption(caption) {
  const text = (caption || '').trim();
  const lc = text.toLowerCase();
  const split = SPLIT_RE.test(lc);
  const person = extractPerson(text);
  let cardAccount = null;
  for (const [alias, acct] of Object.entries(cardmap.aliases).sort((a, b) => b[0].length - a[0].length)) {
    if (lc.includes(alias)) { cardAccount = acct; break; }
  }
  return { notes: text, split, person, cardAccount };
}

// Free-text expense, e.g. "12.50 starbucks on amex split w ryan" — needs a leading
// number or a $amount. Returns null if no amount, so non-expense text falls through.
function parseFreeText(text) {
  const t = (text || '').trim();
  const m = t.match(/^\s*\$?\s*(\d+(?:\.\d{1,2})?)\b/) || t.match(/\$\s*(\d+(?:\.\d{1,2})?)\b/);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!amount || !isFinite(amount)) return null;
  const rest = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).trim();
  const lc = rest.toLowerCase();
  const split = SPLIT_RE.test(lc);
  const person = extractPerson(rest);
  let cardAccount = null, alias = null;
  for (const [a, acct] of Object.entries(cardmap.aliases).sort((x, y) => y[0].length - x[0].length))
    if (lc.includes(a)) { cardAccount = acct; alias = a; break; }
  // clean payee: drop connectors ("at"/"on"/"used"...), card words (alias AND full account name, e.g. "scotiabank" AND "vi"), split words, person
  const drop = new Set(['on', 'at', 'used', 'use', 'using', 'via', 'paid', 'for', 'the', 'split', 'half', 'halves', 'with', 'w', 'w/', '#split']);
  if (alias) alias.split(/\s+/).forEach((x) => drop.add(x));
  if (cardAccount) cardAccount.toLowerCase().split(/\s+/).forEach((x) => drop.add(x));
  if (person) drop.add(person.toLowerCase());
  const clean = (s) => s.split(/\s+/).filter((w) => w && !drop.has(w.toLowerCase().replace(/^[.,]+|[.,]+$/g, ''))).join(' ').trim();
  // merchant = text before the first comma (the rest is usually items/context -> notes)
  const seg = rest.split(',');
  const merchant = clean(seg[0]) || clean(rest) || 'Manual entry';
  const notes = seg.length > 1 ? clean(seg.slice(1).join(', ')) : '';
  return { amount, split, person, cardAccount, merchant, items: [], notes };
}

// Regex handles the terse form ("12.50 starbucks on amex"); anything descriptive
// (items, prose) escalates to Gemini so the store and items get separated.
async function parseExpense(text) {
  const ft = parseFreeText(text);
  const descriptive = /[,]|\b(bought|and|for|with)\b/i.test(text) || text.trim().split(/\s+/).length > 5;
  if (ft && !descriptive) return ft;
  if (/\d/.test(text)) { const g = await geminiFreeText(text); if (g) return g; }
  return ft; // Gemini unavailable -> fall back to the regex result
}

// Hybrid fallback: only when the regex can't structure the text (but a digit is present,
// so it's plausibly an expense). Costs 1 Gemini call; clean inputs never reach here.
const FREETEXT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    total: { type: 'NUMBER', description: 'amount spent' },
    merchant: { type: 'STRING', description: 'the store / payee name ONLY (e.g. "No Frills"), not the items; empty string if not stated' },
    items: { type: 'ARRAY', items: { type: 'STRING' }, description: 'distinct purchased products as short names (e.g. groceries ["eggs","cheese"]). Leave EMPTY for a restaurant meal or single service — that context goes in note, not items.' },
    note: { type: 'STRING', description: 'free-text context that is not the store or items (e.g. "dinner with Tia", "birthday gift"); empty string if none' },
    card: { type: 'STRING', description: 'card name/word the user mentioned (e.g. "amex"), empty string if none' },
    split: { type: 'BOOLEAN', description: 'true ONLY if the user explicitly says to split or go halves (e.g. "split", "split with X", "go halves", "my half"). Merely mentioning a person (e.g. "dinner with Tia") is NOT a split.' },
    person: { type: 'STRING', description: 'who to split WITH — only when split is true; empty string otherwise' },
  },
  required: ['total'],
};
async function geminiFreeText(text) {
  let o;
  try {
    o = await geminiGenerate([{ text: `Extract a single expense from this message into the schema. Put only the store/payee name in "merchant" and the purchased items in "items". Message: ${JSON.stringify(text)}` }], FREETEXT_SCHEMA);
  } catch { return null; } // Gemini down across all models -> caller falls back to the regex parse
  const amount = Math.abs(Number(o.total));
  if (!amount || !isFinite(amount)) return null;
  const merchant = (o.merchant || '').trim() || 'Manual entry';
  const items = (o.items || []).map((x) => String(x).trim()).filter(Boolean);
  const split = !!o.split && SPLIT_RE.test(text); // guard: never split just because a name was mentioned
  return { amount, split, person: split ? (o.person || '').trim() || null : null, cardAccount: o.card ? resolveAccount(String(o.card)) : null, merchant, items, notes: (o.note || '').trim() };
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

// Auto-split configured payees (e.g. a recurring shared bill). config.defaults.autoSplit = { "beanfield": "Tia" }
function maybeAutoSplit(receipt, parsed) {
  if (parsed.split) return parsed;
  const ms = (receipt.merchant || '').toLowerCase();
  for (const [kw, who] of Object.entries(cfg.defaults.autoSplit || {}))
    if (kw && ms.includes(kw.toLowerCase())) return { ...parsed, split: true, person: parsed.person || who };
  return parsed;
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
// Match an "Owed by {name}" account (case-insensitive) or create it on-budget.
async function resolveOwedAccount(person) {
  const want = owedAccountFor(person);
  const existing = Object.keys(ACCT).find((n) => n.toLowerCase() === want.toLowerCase());
  if (existing) return existing;
  const newId = await api.createAccount({ name: want, offbudget: false }, 0);
  await api.sync();
  await refreshActualMaps(); // pick up the account + its transfer payee
  ACCT[want] = ACCT[want] || newId;
  return want;
}
async function logExpense({ accountName, total, payee, notes, category, date, split, splitAccountName, splitPersonName }) {
  const acctId = ACCT[accountName];
  if (!acctId) throw new Error(`No account named "${accountName}" in Actual`);
  const cents = Math.round(Number(total) * 100);
  const catId = CAT[category] || null;
  const txn = { account: acctId, date, amount: -cents, payee_name: payee, notes, cleared: false };
  if (split) {
    const half = Math.round(cents / 2);
    const owedAcct = ACCT[splitAccountName];
    const transferPayee = owedAcct ? TRANSFER_PAYEE[owedAcct] : null;
    if (transferPayee) {
      txn.subtransactions = [
        { amount: -half, category: catId, notes: 'your share' },
        { amount: -(cents - half), payee: transferPayee, notes: `owed by ${splitPersonName}` },
      ];
    } else {
      txn.category = catId; // fallback: no transfer payee found, log whole + tag
      txn.notes = `${notes} [SPLIT w/ ${splitPersonName} — settle manually]`;
    }
  } else {
    txn.category = catId;
  }
  const importedId = 'bot-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  txn.imported_id = importedId;
  await api.addTransactions(acctId, [txn], { runTransfers: true });
  await api.sync();
  const created = (await api.getTransactions(acctId, txn.date, txn.date)).find((t) => t.imported_id === importedId);
  return created ? created.id : null;
}

// ---------- Main flow ----------
const pending = {}; // chatId -> { receipt, parsed, last4, confirm }  (awaiting a card answer)
const confirming = {}; // chatId -> { receipt, parsed, account }  (awaiting yes/no before logging)
const lastTxn = {}; // chatId -> rec  (most recent logged txn, for follow-up edits within the hour)
const msgTxn = {}; // telegram message_id -> rec  (so a reply to that message edits its txn)
const EDIT_WINDOW_MS = 60 * 60 * 1000; // a reply within an hour edits the last txn
// A txn rec carries enough to rebuild it (needed for split-by-reply): { id, account, date, total, payee, category, notes, split, ts }

function todayISO() { return new Date().toISOString().slice(0, 10); }

async function finalize(chatId, receipt, parsed, accountName) {
  parsed = maybeAutoSplit(receipt, parsed);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(receipt.date || '') ? receipt.date : todayISO();
  const category = guessCategory(receipt, parsed.notes);
  const items = (receipt.line_items || []).map((s) => String(s).trim()).filter(Boolean).join(', ');
  let notes = [parsed.notes, items].filter(Boolean).join(' · ');
  if (receipt.card_last4) notes += (notes ? ' ' : '') + `[card ****${receipt.card_last4}]`;
  const person = cap(parsed.person || cfg.defaults.splitPerson);
  const splitAccountName = parsed.split ? await resolveOwedAccount(person) : null;
  const txnId = await logExpense({ accountName, total: receipt.total, payee: receipt.merchant, notes, category, date, split: parsed.split, splitAccountName, splitPersonName: person });
  const rec = { id: txnId, account: accountName, date, total: Number(receipt.total), payee: receipt.merchant, category, notes, split: parsed.split, person, ts: Date.now() };
  if (txnId) lastTxn[chatId] = rec;
  const splitLine = parsed.split ? `  ·  split w/ ${person} (your share $${(receipt.total / 2).toFixed(2)})` : '  ·  not split';
  const sentId = await send(chatId, `✅ $${Number(receipt.total).toFixed(2)} · ${receipt.merchant}\n→ ${category} · ${accountName}${splitLine}\n${date}${items ? '\n🧾 ' + items : ''}\n(reply to edit: note · "category X" · "split w/ NAME" · "NAME paid" · "delete")`);
  if (txnId && sentId) msgTxn[sentId] = rec; // reply to my reply to edit it
  return rec;
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
      await send(chatId, `New card ****${receipt.card_last4} ($${Number(receipt.total).toFixed(2)} at ${receipt.merchant}).\nWhich account is it?`, cardKb());
    } else {
      pending[chatId] = { receipt, parsed, last4: null };
      await send(chatId, `No card number on the receipt ($${Number(receipt.total).toFixed(2)} at ${receipt.merchant}).\nWhich card did you use?`, cardKb());
    }
    return;
  }
  await finalize(chatId, receipt, parsed, account);
}

// confirm=true (manual DM): preview + wait for yes. confirm=false (relay/poorton): log directly.
async function handleFreeText(chatId, ft, confirm = true) {
  const receipt = { merchant: ft.merchant, total: ft.amount, card_last4: '', date: '', line_items: ft.items || [] };
  const parsed = { notes: ft.notes || '', split: ft.split };
  if (!ft.cardAccount) {
    if (!confirm) throw new Error(`couldn't match a card in "${ft.merchant}"`);
    pending[chatId] = { receipt, parsed, last4: null, confirm: true };
    return await send(chatId, `$${ft.amount.toFixed(2)} · ${ft.merchant}\nWhich card?`, cardKb());
  }
  if (confirm) return await askConfirm(chatId, receipt, parsed, ft.cardAccount);
  return await finalize(chatId, receipt, parsed, ft.cardAccount);
}

// Preview the parsed transaction and wait for a yes/no (button or typed) before writing.
async function askConfirm(chatId, receipt, parsed, account) {
  parsed = maybeAutoSplit(receipt, parsed);
  const cat = guessCategory(receipt, parsed.notes);
  const splitLine = parsed.split ? `  ·  split w/ ${cap(parsed.person || cfg.defaults.splitPerson)}` : '  ·  not split';
  const items = (receipt.line_items || []).map((s) => String(s).trim()).filter(Boolean).join(', ');
  const mid = await send(chatId, `Log this?\n$${Number(receipt.total).toFixed(2)} · ${receipt.merchant}\n→ ${cat} · ${account}${splitLine}${items ? '\n🧾 ' + items : ''}`, YESNO_KB);
  confirming[chatId] = { receipt, parsed, account, promptMid: mid };
}
// Returns true if it consumed the text (a yes/no answer), false to fall through to normal handling.
async function handleConfirm(chatId, text) {
  const lc = text.trim().toLowerCase();
  const c = confirming[chatId];
  if (/^(y|yes|ok|okay|confirm|👍|yep|yeah)$/.test(lc)) { delete confirming[chatId]; await finalize(chatId, c.receipt, c.parsed, c.account); return true; }
  if (/^(n|no|nope|cancel|nvm)$/.test(lc)) { delete confirming[chatId]; await send(chatId, '❌ Cancelled — nothing logged.'); return true; }
  delete confirming[chatId]; // anything else: drop the stale prompt, reinterpret the new message
  return false;
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
  if (p.confirm) return await askConfirm(chatId, p.receipt, p.parsed, account);
  await finalize(chatId, p.receipt, p.parsed, account);
}

const editLast = (chatId, text) => editTxn(chatId, lastTxn[chatId], text);

// Edit a specific transaction (by its rec): note text, "category X", "split", or "delete".
async function editTxn(chatId, rec, text) {
  if (!rec || !rec.id) return send(chatId, "I don't have that transaction on hand anymore.");
  const id = rec.id;
  const raw = text.trim();
  const lc = raw.toLowerCase();
  if (['delete', 'undo', 'remove'].includes(lc)) {
    await api.deleteTransaction(id); await api.sync();
    if (lastTxn[chatId]?.id === id) delete lastTxn[chatId];
    return send(chatId, '🗑 Deleted that transaction.');
  }
  const m = lc.match(/^(?:category|cat)\s+(.+)$/);
  if (m) {
    const want = m[1].trim();
    const name = Object.keys(CAT).find((c) => c.toLowerCase() === want);
    if (!name) return send(chatId, `No category named "${want}". Try the exact name.`);
    await api.updateTransaction(id, { category: CAT[name] }); await api.sync();
    rec.category = name;
    return send(chatId, `✏️ Category → ${name}`);
  }
  // Forward split: you paid, they owe you half. "split" or "split with NAME".
  const sp = lc.match(/^(?:split|half|\/2)(?:\s+(?:with|w\/?)\s+(.+))?$/);
  if (sp) {
    if (rec.split) return send(chatId, 'Already split.');
    const person = cap((sp[1] || rec.person || cfg.defaults.splitPerson).trim());
    const splitAccountName = await resolveOwedAccount(person);
    // Actual can't add subtransactions in place; rebuild the txn as a 50/50 split.
    await api.deleteTransaction(id);
    const newId = await logExpense({ accountName: rec.account, total: rec.total, payee: rec.payee, notes: rec.notes || '', category: rec.category, date: rec.date, split: true, splitAccountName, splitPersonName: person });
    rebindTxn(id, { ...rec, id: newId, split: true, person });
    return send(chatId, `✂️ Split 50/50 w/ ${person} (your share $${(rec.total / 2).toFixed(2)}).`);
  }
  // Reverse direction: they paid a shared expense, you owe your half. "NAME paid",
  // "paid by NAME", "owe NAME", or bare "owe". One categorized txn for your half in
  // their (on-budget) Owed-by account: category shows your share, balance goes negative.
  const rev = lc.match(/^(?:([\w'-]+)\s+paid|paid by\s+([\w'-]+)|i\s+owe(?:\s+([\w'-]+))?|owe(?:\s+([\w'-]+))?)$/);
  if (rev) {
    const person = cap((rev[1] || rev[2] || rev[3] || rev[4] || rec.person || cfg.defaults.splitPerson).trim());
    const owedName = await resolveOwedAccount(person);
    const half = rec.total / 2;
    await api.deleteTransaction(id);
    const newId = await logExpense({ accountName: owedName, total: half, payee: rec.payee, notes: rec.notes || '', category: rec.category, date: rec.date, split: false });
    rebindTxn(id, { ...rec, id: newId, account: owedName, total: half, split: false, person });
    return send(chatId, `🔁 ${person} paid — your half $${half.toFixed(2)} → ${rec.category}, logged to "${owedName}" (you owe it).`);
  }
  const add = raw.replace(/^note:?\s*/i, '').trim();
  const notes = [rec.notes, add].filter(Boolean).join(' · ');
  await api.updateTransaction(id, { notes }); await api.sync();
  rec.notes = notes;
  return send(chatId, '📝 Note added.');
}
// After a rebuild (split), point every reference to the old txn id at the new rec.
function rebindTxn(oldId, newRec) {
  for (const map of [lastTxn, msgTxn])
    for (const k of Object.keys(map)) if (map[k].id === oldId) map[k] = newRec;
}

// Relay: a second "sender" bot posts JSON into a private channel; this bot (admin) reads it.
async function onRelayPost(post) {
  if (!cfg.telegram.relayChannelId) {
    console.log('Relay channel_post seen from chat id:', post.chat.id, '— put this in config.json telegram.relayChannelId');
    return;
  }
  if (post.chat.id !== cfg.telegram.relayChannelId) return;
  const id = post.chat.id; // reply in the channel the post came from
  const text = (post.text || '').trim();
  await react(id, post.message_id, REACT_SEEN);
  try {
    if (post.photo) { await handlePhoto(id, post); await react(id, post.message_id, REACT_DONE); return; } // receipt posted in the channel
    // Button taps come via callback_query, but accept typed yes/no & card answers too.
    if (confirming[id] && await handleConfirm(id, text)) { await react(id, post.message_id, REACT_DONE); return; }
    if (pending[id]) { await handleCardAnswer(id, text); await react(id, post.message_id, REACT_DONE); return; }
    // A reply to a previously-logged post edits that transaction (note / category / split / delete).
    const repliedTo = post.reply_to_message && msgTxn[post.reply_to_message.message_id];
    if (repliedTo) {
      await editTxn(id, repliedTo, text);
    } else if (text.startsWith('{')) {
      // poorton's structured posts log directly — no confirmation. (iOS curls quotes; normalize.)
      let json = null;
      try { json = JSON.parse(text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")); } catch { /* fall through */ }
      if (json) { const rec = await handleIngest(json, id); if (rec?.id) msgTxn[post.message_id] = rec; }
      else { const ft = await parseExpense(text); if (!ft) throw new Error('bad JSON and no amount found'); await handleFreeText(id, ft); }
    } else {
      // free text = a human typing -> confirm with Yes/No buttons (also asks card via buttons)
      const ft = await parseExpense(text);
      if (!ft) throw new Error('no amount found — try "12.50 merchant on amex"');
      await handleFreeText(id, ft);
    }
    await react(id, post.message_id, REACT_DONE);
  } catch (e) {
    await react(id, post.message_id, '');
    await send(id, '⚠️ relay error: ' + e.message).catch(() => {});
    console.error('relay', e);
  }
}

// Inline-button taps arrive as callback_query (works in DMs and channels).
async function onCallback(cq) {
  const chatId = cq.message?.chat?.id;
  const mid = cq.message?.message_id;
  const data = cq.data || '';
  await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
  if (!chatId) return;
  try {
    if (data === 'c:y') {
      const c = confirming[chatId];
      await dropKb(chatId, mid);
      if (!c) return;
      delete confirming[chatId];
      await finalize(chatId, c.receipt, c.parsed, c.account);
    } else if (data === 'c:n') {
      delete confirming[chatId];
      await dropKb(chatId, mid);
      await send(chatId, '❌ Cancelled — nothing logged.');
    } else if (data.startsWith('card:') && pending[chatId]) {
      await dropKb(chatId, mid);
      await handleCardAnswer(chatId, data.slice(5));
    }
  } catch (e) {
    await send(chatId, '⚠️ ' + (e.message || String(e)));
    console.error('callback', e);
  }
}

async function onUpdate(u) {
  if (u.callback_query) return await onCallback(u.callback_query);
  if (u.channel_post) return await onRelayPost(u.channel_post);
  const msg = u.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  if (cfg.telegram.allowedChatId && chatId !== cfg.telegram.allowedChatId) return; // ignore strangers
  await react(chatId, msg.message_id, REACT_SEEN);
  try {
    await dispatch(chatId, msg);
    await react(chatId, msg.message_id, REACT_DONE);
  } catch (e) {
    await react(chatId, msg.message_id, '');
    await send(chatId, '⚠️ ' + (e.message || String(e)));
    console.error(e);
  }
}

async function dispatch(chatId, msg) {
  if (msg.photo) return await handlePhoto(chatId, msg);
  if (!msg.text) return;
  // Reply to a previously-logged message edits that txn (channel uses this; DM falls back to the edit window).
  const repliedTo = msg.reply_to_message && msgTxn[msg.reply_to_message.message_id];
  if (repliedTo) return await editTxn(chatId, repliedTo, msg.text);
  if (confirming[chatId] && await handleConfirm(chatId, msg.text)) return;
  if (pending[chatId]) return await handleCardAnswer(chatId, msg.text);
  const ft = await parseExpense(msg.text);
  if (ft) return await handleFreeText(chatId, ft);
  if (lastTxn[chatId] && Date.now() - lastTxn[chatId].ts < EDIT_WINDOW_MS) return await editLast(chatId, msg.text);
  await send(chatId, 'Send a receipt photo, or just text the expense like "12.50 starbucks on amex split with ryan". I\'ll show a preview to confirm before logging. After one\'s logged, reply within the hour to edit it — free text = note, "category X", "split w/ NAME", "NAME paid", or "delete".');
}

// ---------- HTTP ingest (Apple Pay / Shortcuts POST here; NOT via Telegram) ----------
async function handleIngest(d, chat = cfg.telegram.allowedChatId) {
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
  const person = cap((d.with || d.person || cfg.defaults.splitPerson));
  const splitAccountName = split ? await resolveOwedAccount(person) : null;
  const id = await logExpense({ accountName: account, total: amount, payee: merchant, notes, category, date, split, splitAccountName, splitPersonName: person });
  const rec = { id, account, date, total: amount, payee: merchant, category, notes, split, person, ts: Date.now() };
  if (id && chat) lastTxn[chat] = rec;
  const sentId = chat ? await send(chat, `⚡ $${amount.toFixed(2)} · ${merchant}\n→ ${category} · ${account}${split ? `  ·  split w/ ${person}` : '  ·  not split'}\n(reply to edit: note · "category X" · "split w/ NAME" · "NAME paid" · "delete")`) : null;
  if (id && sentId) msgTxn[sentId] = rec; // reply to my reply to edit it
  return rec;
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
  const a = parseFreeText('12.50 starbucks on amex split with ryan');
  assert(a && a.amount === 12.5 && a.split === true, 'amount+split parsed');
  assert(a.person === 'ryan', 'person extracted: ' + a.person);
  assert(a.merchant === 'starbucks', 'merchant cleaned of card/split/person words: ' + a.merchant);
  assert(owedAccountFor('ryan') === 'Owed by Ryan', 'owed account name: ' + owedAccountFor('ryan'));
  const b = parseFreeText('paid $7 for coffee');
  assert(b && b.amount === 7 && b.split === false, '$amount mid-string, no split');
  console.log('selftest OK');
}
if (process.argv[2] === 'selftest') selftest();
else main().catch((e) => { console.error(e); process.exit(1); });
