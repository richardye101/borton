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
  rows.push([{ text: '➕ Other (new account)', callback_data: 'card:__new__' }]);
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

// ---------- Split helpers (person -> "Owed by {name}" / "{name}'s spend" accounts) ----------
const OWED_FMT = cfg.defaults.owedAccountFormat || 'Owed by {name}';
const SPEND_FMT = cfg.defaults.spendAccountFormat || "{name}'s spend";
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const owedAccountFor = (person) => OWED_FMT.replace('{name}', cap(String(person).trim()));
const spendAccountFor = (person) => SPEND_FMT.replace('{name}', cap(String(person).trim()));
// "split with Ryan" / "split w ryan" -> "Ryan"; bare "split" -> null (caller uses the default person)
function extractPerson(text) {
  const m = (text || '').match(/\bsplit\s+(?:with|w\/?)\s+([a-z][\w'-]*)/i);
  return m ? m[1] : null;
}
const SPLIT_RE = /\bsplit\b|\bhalf\b|\bhalves\b|\/2\b|#split/i;

// Words that are never a person's name (they're directives/filler) — so "split paid" can't make a
// person literally called "Split", and typing "split" at a name prompt falls back to the default.
const NON_NAMES = new Set(['split', 'splits', 'half', 'halves', 'paid', 'pay', 'pays', 'owe', 'owes', 'with', 'w', 'on', 'the', 'a', 'it', 'this', 'that', 'me', 'my', 'and', 'for', 'by']);
function personName(name) {
  const p = (name == null ? '' : String(name)).trim();
  if (!p || NON_NAMES.has(p.toLowerCase())) return null;
  return cap(p);
}

// Reverse direction: someone ELSE paid a shared expense, so you owe your half.
// Matches "NAME paid", "she/he/they paid", "paid by NAME", "i owe", "owe NAME".
// Returns { person } (person === null means "use the resolved split person", e.g. a pronoun),
// or null when there's no someone-else-paid intent. `strict` anchors to end-of-string for
// command-style replies (so "loan paid off" doesn't match); loose scans mid-sentence free text.
const PRONOUNS = new Set(['she', 'he', 'they', 'her', 'him', 'them']);
function extractPaid(text, strict) {
  const t = text || '';
  const end = strict ? '\\s*$' : '\\b';
  let m;
  if ((m = t.match(new RegExp(`\\bpaid by\\s+([a-z][\\w'-]*)${end}`, 'i')))) return { person: personName(m[1]) };
  if ((m = t.match(new RegExp(`\\b(?:i\\s+)?owe(?:\\s+([a-z][\\w'-]*))?${end}`, 'i')))) return { person: personName(m[1]) };
  if ((m = t.match(new RegExp(`\\b([a-z][\\w'-]*)\\s+paid${end}`, 'i')))) {
    const w = m[1].toLowerCase();
    if (w === 'i') return null;            // "I paid" = you paid, normal expense
    if (PRONOUNS.has(w)) return { person: null };
    if (NON_NAMES.has(w)) return null;     // "split paid" etc. — not a real payer
    return { person: m[1] };
  }
  return null;
}

// Strip machine directives (card routing + split/paid keywords) from free text so a stored note
// keeps only the human description ("neutrogena face cleanser"), not "... on amex split w tia".
function stripControlWords(text, cardTokens = []) {
  let s = ` ${text || ''} `;
  s = s.replace(/\s+split(?:\s+(?:with|w\/?)\s+[a-z][\w'-]*)?(?=\s)/gi, ' '); // "split", "split with X"
  s = s.replace(/\s+(?:go\s+)?halves?(?=\s)|\s+#split(?=\s)|\s+\/2(?=\s)/gi, ' ');
  s = s.replace(/\s+paid by\s+[a-z][\w'-]*(?=\s)/gi, ' ');
  s = s.replace(/\s+(?:i\s+)?owe(?:\s+[a-z][\w'-]*)?(?=\s)/gi, ' ');
  s = s.replace(/\s+[a-z][\w'-]*\s+paid(?=\s)/gi, ' ');                        // "ryan paid", "she paid"
  for (const tok of cardTokens) {                                             // "on amex", "using scotia", bare alias
    if (!tok) continue;
    const t = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`\\s+(?:on|using|used|use|via|with|w\\/?)?\\s*${t}(?=\\s)`, 'gi'), ' ');
  }
  return s.replace(/\s+/g, ' ').trim().replace(/^[,;·\s]+|[,;·\s]+$/g, '').trim();
}

// ---------- Caption parsing (code-side, deterministic) ----------
function parseCaption(caption) {
  const text = (caption || '').trim();
  const lc = text.toLowerCase();
  const paidInfo = extractPaid(text, false);
  const split = SPLIT_RE.test(lc) || !!paidInfo;
  const person = (paidInfo && paidInfo.person) || extractPerson(text);
  let cardAccount = null, matchedAlias = null;
  for (const [alias, acct] of Object.entries(cardmap.aliases).sort((a, b) => b[0].length - a[0].length)) {
    if (lc.includes(alias)) { cardAccount = acct; matchedAlias = alias; break; }
  }
  // notes = the caption with routing/split directives removed, so the transaction note is just
  // what you wrote it was ("neutrogena face cleanser"), not the plumbing.
  const cardTokens = [...(matchedAlias ? matchedAlias.split(/\s+/) : []), ...(cardAccount ? cardAccount.toLowerCase().split(/\s+/) : [])];
  const notes = stripControlWords(text, cardTokens);
  return { notes, split, paid: !!paidInfo, person, cardAccount };
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
  const paidInfo = extractPaid(rest, false);
  const split = SPLIT_RE.test(lc) || !!paidInfo;
  const person = (paidInfo && paidInfo.person) || extractPerson(rest);
  let cardAccount = null, alias = null;
  for (const [a, acct] of Object.entries(cardmap.aliases).sort((x, y) => y[0].length - x[0].length))
    if (lc.includes(a)) { cardAccount = acct; alias = a; break; }
  // clean payee: drop connectors ("at"/"on"/"used"...), card words (alias AND full account name, e.g. "scotiabank" AND "vi"), split/paid words, person
  const drop = new Set(['on', 'at', 'used', 'use', 'using', 'via', 'paid', 'for', 'the', 'split', 'half', 'halves', 'with', 'w', 'w/', '#split', 'owe', 'by', 'she', 'he', 'they', 'her', 'him', 'them', 'i']);
  if (alias) alias.split(/\s+/).forEach((x) => drop.add(x));
  if (cardAccount) cardAccount.toLowerCase().split(/\s+/).forEach((x) => drop.add(x));
  if (person) drop.add(person.toLowerCase());
  const clean = (s) => s.split(/\s+/).filter((w) => w && !drop.has(w.toLowerCase().replace(/^[.,]+|[.,]+$/g, ''))).join(' ').trim();
  // merchant = text before the first comma (the rest is usually items/context -> notes)
  const seg = rest.split(',');
  const merchant = clean(seg[0]) || clean(rest) || 'Manual entry';
  const notes = seg.length > 1 ? clean(seg.slice(1).join(', ')) : '';
  return { amount, split, paid: !!paidInfo, person, cardAccount, merchant, items: [], notes };
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
    note: { type: 'STRING', description: 'free-text context that is not the store or items (e.g. "dinner with Ryan", "birthday gift"); empty string if none' },
    card: { type: 'STRING', description: 'card name/word the user mentioned (e.g. "amex"), empty string if none' },
    split: { type: 'BOOLEAN', description: 'true ONLY if the user explicitly says to split or go halves (e.g. "split", "split with X", "go halves", "my half"), OR says someone else paid (see paid). Merely mentioning a person (e.g. "dinner with Ryan") is NOT a split.' },
    paid: { type: 'BOOLEAN', description: 'true ONLY if SOMEONE ELSE paid and the user owes their half (e.g. "she paid", "Ryan paid", "paid by Ryan", "I owe"). "I paid" is FALSE (the user paid). Empty/unstated is FALSE.' },
    person: { type: 'STRING', description: 'the OTHER person — who to split with, or who paid. Only when split or paid is true; empty string otherwise. Resolve pronouns to a name only if the name is stated, else empty.' },
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
  // Code-side guards: never split/reverse just because a name was mentioned — require the actual words.
  const paid = !!o.paid && !!extractPaid(text, false);
  const split = paid || (!!o.split && SPLIT_RE.test(text));
  const person = split ? (o.person || '').trim() || null : null;
  return { amount, split, paid, person, cardAccount: o.card ? resolveAccount(String(o.card)) : null, merchant, items, notes: (o.note || '').trim() };
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

// Auto-split configured payees (e.g. a recurring shared bill). config.defaults.autoSplit = { "examplepayee": "Partner" }
function maybeAutoSplit(receipt, parsed) {
  if (parsed.split || parsed.splitDecided) return parsed; // already split, or the user explicitly chose at confirm
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
// Match a "{name}'s spend" account (case-insensitive) or create it OFF-budget (their share of a
// reverse split is tracked here without touching your budget envelopes).
async function resolveSpendAccount(person) {
  const want = spendAccountFor(person);
  const existing = Object.keys(ACCT).find((n) => n.toLowerCase() === want.toLowerCase());
  if (existing) return existing;
  const newId = await api.createAccount({ name: want, offbudget: true }, 0);
  await api.sync();
  await refreshActualMaps();
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

// Reverse split: SOMEONE ELSE paid a shared expense. Two transactions, both negative:
//   your half  -> "Owed by {name}" (on-budget, categorized) — your share hits the category, balance goes negative (you owe them)
//   their half -> "{name}'s spend"  (off-budget, uncategorized) — tracks their share without touching your budget
// Returns { id (your-half txn, the one edits act on), spendId (their-half txn) }.
async function logReverseSplit({ owedAccount, spendAccount, total, payee, notes, category, date, personName }) {
  const owedId = ACCT[owedAccount];
  const spendId = ACCT[spendAccount];
  if (!owedId) throw new Error(`No account named "${owedAccount}" in Actual`);
  if (!spendId) throw new Error(`No account named "${spendAccount}" in Actual`);
  const cents = Math.round(Number(total) * 100);
  const half = Math.round(cents / 2);
  const catId = CAT[category] || null;
  const stamp = Date.now();
  const myImported = `bot-${stamp}-${Math.floor(Math.random() * 1e6)}-mine`;
  const theirImported = `bot-${stamp}-${Math.floor(Math.random() * 1e6)}-theirs`;
  await api.addTransactions(owedId, [{ account: owedId, date, amount: -half, payee_name: payee, notes: [notes, `your share — ${personName} paid`].filter(Boolean).join(' · '), category: catId, cleared: false, imported_id: myImported }], { runTransfers: true });
  await api.addTransactions(spendId, [{ account: spendId, date, amount: -(cents - half), payee_name: payee, notes: [notes, `${personName}'s share`].filter(Boolean).join(' · '), cleared: false, imported_id: theirImported }], { runTransfers: true });
  await api.sync();
  const mine = (await api.getTransactions(owedId, date, date)).find((t) => t.imported_id === myImported);
  const theirs = (await api.getTransactions(spendId, date, date)).find((t) => t.imported_id === theirImported);
  return { id: mine ? mine.id : null, spendId: theirs ? theirs.id : null };
}

// ---------- Main flow ----------
const pending = {}; // chatId -> { receipt, parsed, last4, confirm }  (awaiting a card answer)
const confirming = {}; // chatId -> { receipt, parsed, account }  (awaiting yes/no before logging)
const editField = {}; // chatId -> { field, kind: 'pending'|'logged', mid }  (awaiting a typed value after ✏️ Edit → field)
const lastTxn = {}; // chatId -> rec  (most recent logged txn, for follow-up edits within the hour)
const msgTxn = {}; // telegram message_id -> rec  (so a reply to that message edits its txn)
const EDIT_WINDOW_MS = 60 * 60 * 1000; // a reply within an hour edits the last txn
// A txn rec carries enough to rebuild it (needed for split-by-reply): { id, account, date, total, payee, category, notes, split, reverse, spendTxnId, person, ts }

// These maps are persisted to disk so a reply to a logged message still resolves after a bot
// restart (otherwise they reset to empty and the reply is misread as a brand-new expense).
const TXN_STORE = path.resolve(__dir, cfg.actual?.dataDir || './actual-data', 'bot-txnmap.json');
function persistTxns() {
  try {
    const cutoff = Date.now() - 30 * 864e5; // keep ~30 days
    const prune = (m) => Object.fromEntries(Object.entries(m).filter(([, r]) => r && (r.ts || 0) > cutoff));
    fs.writeFileSync(TXN_STORE, JSON.stringify({ lastTxn: prune(lastTxn), msgTxn: prune(msgTxn) }));
  } catch (e) { console.error('persistTxns:', e.message); }
}
function loadTxns() {
  try {
    if (!fs.existsSync(TXN_STORE)) return;
    const d = JSON.parse(fs.readFileSync(TXN_STORE, 'utf8'));
    Object.assign(lastTxn, d.lastTxn || {});
    Object.assign(msgTxn, d.msgTxn || {});
    console.log(`Restored txn map: ${Object.keys(msgTxn).length} message links, ${Object.keys(lastTxn).length} chats.`);
  } catch (e) { console.error('loadTxns:', e.message); }
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

// One-line-per-field "key: value" layout, shared by the confirm preview and the logged receipts.
function fmtExpense({ total, merchant, category, account, split, paid, person, note, date }) {
  const half = (Number(total) / 2).toFixed(2);
  const L = [`Amount: $${Number(total).toFixed(2)}`, `Merchant: ${merchant}`, `Category: ${category}`];
  if (paid) {
    L.push(`Paid by: ${person} (you owe $${half})`);
    L.push(`Account: ${owedAccountFor(person)}`);
  } else {
    if (account) L.push(`Card: ${account}`);
    L.push(`Split: ${split ? `50/50 w/ ${person} — your share $${half}` : 'no'}`);
  }
  if (note) L.push(`Note: ${note}`);
  if (date) L.push(`Date: ${date}`);
  return L.join('\n');
}
const EDIT_HINT = 'Reply to edit or delete — e.g. "category Groceries", "split w/ Ryan", "note: ...", "delete".';

async function finalize(chatId, receipt, parsed, accountName) {
  parsed = maybeAutoSplit(receipt, parsed);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(receipt.date || '') ? receipt.date : todayISO();
  const category = parsed.category || guessCategory(receipt, parsed.notes);
  const items = (receipt.line_items || []).map((s) => String(s).trim()).filter(Boolean).join(', ');
  // Prefer what you wrote (the caption) over the receipt's OCR line-items (often cryptic shortcodes
  // like "NTG HB CLNSR"). Fall back to line-items only when you gave no description.
  const desc = parsed.notes || items;
  let notes = desc;
  if (receipt.card_last4) notes += (notes ? ' ' : '') + `[card ****${receipt.card_last4}]`;
  const person = personName(parsed.person) || cap(cfg.defaults.splitPerson);
  const total = Number(receipt.total);
  const half = (total / 2).toFixed(2);
  let txnId, rec;
  if (parsed.paid) {
    // Reverse: they paid; you owe your half. Your half -> Owed by {name} (categorized);
    // their half -> {name}'s spend (off-budget). The card `accountName` is irrelevant here (they paid).
    rememberSplitPerson(person);
    const owedName = await resolveOwedAccount(person);
    const spendName = await resolveSpendAccount(person);
    const r = await logReverseSplit({ owedAccount: owedName, spendAccount: spendName, total, payee: receipt.merchant, notes, category, date, personName: person });
    txnId = r.id;
    rec = { id: txnId, spendTxnId: r.spendId, account: owedName, spendAccount: spendName, date, total, payee: receipt.merchant, category, notes, split: false, reverse: true, person, ts: Date.now() };
  } else {
    if (parsed.split) rememberSplitPerson(person);
    const splitAccountName = parsed.split ? await resolveOwedAccount(person) : null;
    txnId = await logExpense({ accountName, total, payee: receipt.merchant, notes, category, date, split: parsed.split, splitAccountName, splitPersonName: person });
    rec = { id: txnId, account: accountName, date, total, payee: receipt.merchant, category, notes, split: parsed.split, person, ts: Date.now() };
  }
  if (txnId) lastTxn[chatId] = rec;
  const body = fmtExpense({ total, merchant: receipt.merchant, category, account: accountName, split: parsed.split, paid: parsed.paid, person, note: desc, date });
  const sentId = await send(chatId, `${parsed.paid ? '🔁' : '✅'} Logged\n${body}\n\n${EDIT_HINT}`, txnId ? loggedKb() : undefined);
  if (txnId && sentId) msgTxn[sentId] = rec; // reply to my reply to edit it
  persistTxns();
  return rec;
}

// Re-draw a logged receipt in place from its rec (after a button edit), keeping the ✅/✏️/🗑 row.
async function rerenderLogged(chatId, mid, rec) {
  const body = fmtExpense({ total: rec.total, merchant: rec.payee, category: rec.category, account: rec.account, split: rec.split, paid: rec.reverse, person: rec.person, note: displayNote(rec.notes), date: rec.date });
  await tg('editMessageText', { chat_id: chatId, message_id: mid, text: `${rec.reverse ? '🔁' : '✅'} Logged\n${body}\n\n${EDIT_HINT}`, reply_markup: loggedKb() }).catch(() => {});
}

// A field label shown in prompts / current-value hints.
const FIELD_LABEL = { cat: 'category', card: 'card', note: 'note', split: 'split with (name)', person: 'who paid' };
// After ✏️ Edit → a field button, the user's next message is the new value. Route it to the right place.
async function applyFieldValue(chatId, text) {
  const ef = editField[chatId];
  delete editField[chatId];
  const value = text.trim();
  if (ef.kind === 'pending') {
    const c = confirming[chatId];
    if (!c) return await send(chatId, 'That preview expired — send the expense again.');
    if (ef.field === 'cat') {
      const name = resolveCategory(value);
      if (!name) return await send(chatId, `No category named "${value}". Tap ✏️ Edit → 🏷 Category to retry.`);
      c.parsed.category = name;
    } else if (ef.field === 'note') {
      c.parsed.notes = value;
    } else if (ef.field === 'card') {
      const acct = resolveAccount(value);
      if (!acct) return await send(chatId, `No account matching "${value}". Retry with a card alias or exact name.`);
      c.account = acct;
    } else if (ef.field === 'split') {
      const person = personName(value) || cap(cfg.defaults.splitPerson);
      c.parsed = { ...c.parsed, split: true, splitDecided: true, person };
      rememberSplitPerson(person);
    } else if (ef.field === 'person') { // reverse split: who paid
      c.parsed = { ...c.parsed, paid: true, person: personName(value) || cap(cfg.defaults.splitPerson) };
    }
    return await rerenderConfirm(chatId);
  }
  // logged: translate to an editTxn command, then re-render the receipt in place.
  const rec = msgTxn[ef.mid] || lastTxn[chatId];
  if (!rec) return await send(chatId, "That transaction expired — reply to a newer one.");
  const cmd = ef.field === 'cat' ? `category ${value}`
    : ef.field === 'note' ? `note: ${value}`
    : ef.field === 'card' ? `card ${value}`
    : ef.field === 'person' ? `${value} paid`
    : `split w/ ${value}`;
  await editTxn(chatId, rec, cmd);
  await rerenderLogged(chatId, ef.mid, msgTxn[ef.mid] || rec);
}

async function handlePhoto(chatId, msg) {
  delete pending[chatId]; delete confirming[chatId]; // a fresh receipt supersedes any unanswered card/confirm prompt
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
  const parsed = { notes: ft.notes || '', split: ft.split, paid: ft.paid, person: ft.person };
  // Reverse splits don't need a card of yours (they paid) — skip the card prompt entirely.
  if (!ft.cardAccount && !ft.paid) {
    if (!confirm) throw new Error(`couldn't match a card in "${ft.merchant}"`);
    pending[chatId] = { receipt, parsed, last4: null, confirm: true };
    return await send(chatId, `$${ft.amount.toFixed(2)} · ${ft.merchant}\nWhich card?`, cardKb());
  }
  if (confirm) return await askConfirm(chatId, receipt, parsed, ft.cardAccount);
  return await finalize(chatId, receipt, parsed, ft.cardAccount);
}

// Persisted "most recent split partner" (in cardmap.json) so the confirm step can offer a one-tap suggestion.
function lastSplitPerson() { return cap(cardmap.lastSplitPerson || cfg.defaults.splitPerson || '') || null; }
function rememberSplitPerson(person) {
  const p = cap(String(person || '').trim());
  if (!p || cardmap.lastSplitPerson === p) return;
  cardmap.lastSplitPerson = p; saveCardmap();
}

function confirmText(receipt, parsed, account) {
  const cat = parsed.category || guessCategory(receipt, parsed.notes);
  const person = cap(parsed.person || cfg.defaults.splitPerson);
  const items = (receipt.line_items || []).map((s) => String(s).trim()).filter(Boolean).join(', ');
  const note = parsed.notes || items; // your description wins over receipt line-items
  return `Log this?\n${fmtExpense({ total: receipt.total, merchant: receipt.merchant, category: cat, account, split: parsed.split, paid: parsed.paid, person, note })}`;
}
// Resolve a typed category to its exact Actual name (case-insensitive), or null.
function resolveCategory(want) {
  const w = (want || '').trim().toLowerCase();
  return Object.keys(CAT).find((c) => c.toLowerCase() === w) || null;
}
// A stored note carries machine tags like "[card ****1234] [apple pay]"; strip them for display.
const displayNote = (notes) => (notes || '').replace(/\s*\[[^\]]*\]/g, '').trim();
// Pre-log preview: confirm, edit, or cancel.
function confirmKb() {
  return { inline_keyboard: [[
    { text: '✅ Yes', callback_data: 'c:y' },
    { text: '✏️ Edit', callback_data: 'e:menu' },
    { text: '❌ No', callback_data: 'c:n' },
  ]] };
}
// Logged receipt: dismiss the buttons, edit a field, or delete.
function loggedKb() {
  return { inline_keyboard: [[
    { text: '✅ OK', callback_data: 'e:ok' },
    { text: '✏️ Edit', callback_data: 'e:menu' },
    { text: '🗑 Delete', callback_data: 'e:del' },
  ]] };
}
// Field picker shown after tapping ✏️ Edit (works for both a pending preview and a logged txn).
function fieldMenuKb(reverse) {
  const who = lastSplitPerson() || cap(cfg.defaults.splitPerson);
  const rows = [[{ text: '🏷 Category', callback_data: 'e:set:cat' }, { text: '📝 Note', callback_data: 'e:set:note' }]];
  rows.push(reverse
    ? [{ text: `👤 ${who} paid`, callback_data: 'e:do:person' }, { text: '👤 Someone else', callback_data: 'e:set:person' }]
    : [{ text: '💳 Card', callback_data: 'e:set:card' }, { text: `➗ Split w/ ${who}`, callback_data: 'e:do:split' }, { text: '➗ …', callback_data: 'e:set:split' }]);
  rows.push([{ text: '🔙 Back', callback_data: 'e:back' }]);
  return { inline_keyboard: rows };
}

// Preview the parsed transaction and wait for a yes/no (button or typed) before writing.
async function askConfirm(chatId, receipt, parsed, account) {
  parsed = maybeAutoSplit(receipt, parsed);
  const mid = await send(chatId, confirmText(receipt, parsed, account), confirmKb());
  confirming[chatId] = { receipt, parsed, account, promptMid: mid };
}
// Re-draw the live preview in place after an edit.
async function rerenderConfirm(chatId) {
  const c = confirming[chatId];
  if (!c || !c.promptMid) return;
  await tg('editMessageText', { chat_id: chatId, message_id: c.promptMid, text: confirmText(c.receipt, c.parsed, c.account), reply_markup: confirmKb() }).catch(() => {});
}
// Returns true if it consumed the text (yes/no, or a split-partner name we asked for), false to fall through.
async function handleConfirm(chatId, text) {
  const c = confirming[chatId];
  if (!c) return false;
  const lc = text.trim().toLowerCase();
  if (c.awaitSplitName) { // we asked "who did you split with?" — this reply is the name
    const person = cap(text.trim().replace(/^split\s+(?:with|w\/?)\s+/i, '').trim());
    if (!person) { await send(chatId, "Didn't catch a name — try again, or tap ✅/❌."); return true; }
    c.awaitSplitName = false;
    c.parsed = { ...c.parsed, split: true, splitDecided: true, person };
    rememberSplitPerson(person);
    await rerenderConfirm(chatId);
    return true;
  }
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
// Create an on-budget account by name (or return the existing one if the name already exists).
async function createNamedAccount(name) {
  const clean = name.trim();
  if (!clean) throw new Error('empty account name');
  const existing = Object.keys(ACCT).find((n) => n.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const id = await api.createAccount({ name: clean, offbudget: false }, 0);
  await api.sync();
  await refreshActualMaps();
  ACCT[clean] = ACCT[clean] || id;
  return clean;
}

async function handleCardAnswer(chatId, text) {
  const p = pending[chatId];
  const raw = text.trim();
  // "➕ Other" path: this reply is a brand-new account name.
  if (p.awaitNewAccount) {
    const account = await createNamedAccount(raw);
    if (p.last4) { cardmap.byLast4[p.last4] = account; saveCardmap(); }
    delete pending[chatId];
    return await askConfirm(chatId, p.receipt, p.parsed, account); // confirm screen -> split buttons available
  }
  const account = resolveAccount(raw);
  if (account) {
    if (p.last4) { cardmap.byLast4[p.last4] = account; saveCardmap(); }
    delete pending[chatId];
    return await askConfirm(chatId, p.receipt, p.parsed, account);
  }
  // Not a card name. The user likely moved on — reroute a new expense or an edit of the last txn
  // instead of trapping them on the card question.
  const ft = /\d/.test(raw) ? await parseExpense(raw) : null;
  if (ft) { delete pending[chatId]; return await handleFreeText(chatId, ft); }
  const editish = SPLIT_RE.test(raw) || /^(delete|undo|remove|note\b|category\s|cat\s)/i.test(raw) || /\bpaid\b|\bowe\b/i.test(raw);
  if (editish && lastTxn[chatId]) { delete pending[chatId]; return await editLast(chatId, raw); }
  await send(chatId, `Couldn't match "${raw}" to an account. Tap a card button, or ➕ Other to add a new one.`);
}

const editLast = (chatId, text) => editTxn(chatId, lastTxn[chatId], text);

// Edit a specific transaction (by its rec): note text, "category X", "split", or "delete".
async function editTxn(chatId, rec, text) {
  if (!rec || !rec.id) return send(chatId, "I don't have that transaction on hand anymore.");
  const id = rec.id;
  const raw = text.trim();
  const lc = raw.toLowerCase();
  if (['delete', 'undo', 'remove'].includes(lc)) {
    await api.deleteTransaction(id);
    if (rec.spendTxnId) await api.deleteTransaction(rec.spendTxnId).catch(() => {}); // reverse split: drop their-half leg too
    await api.sync();
    if (lastTxn[chatId]?.id === id) delete lastTxn[chatId];
    persistTxns();
    return send(chatId, '🗑 Deleted that transaction.');
  }
  const m = lc.match(/^(?:category|cat)\s+(.+)$/);
  if (m) {
    const want = m[1].trim();
    const name = Object.keys(CAT).find((c) => c.toLowerCase() === want);
    if (!name) return send(chatId, `No category named "${want}". Try the exact name.`);
    await api.updateTransaction(id, { category: CAT[name] }); await api.sync();
    rec.category = name;
    persistTxns();
    return send(chatId, `✏️ Category → ${name}`);
  }
  // Reverse direction (check BEFORE forward split, since "split with ryan he paid" is both-shaped):
  // someone ELSE paid a shared expense, you owe your half. "NAME paid", "she/he paid", "paid by NAME",
  // "i owe", "owe NAME" (optionally prefixed with "split with NAME"). Your half -> Owed by {name}
  // (categorized, negative = you owe); their half -> {name}'s spend (off-budget).
  const paidInfo = extractPaid(lc, true);
  if (paidInfo) {
    const person = cap((paidInfo.person || extractPerson(raw) || rec.person || cfg.defaults.splitPerson).trim());
    rememberSplitPerson(person);
    if (rec.reverse) return send(chatId, `Already logged as "${person} paid".`);
    const owedName = await resolveOwedAccount(person);
    const spendName = await resolveSpendAccount(person);
    await api.deleteTransaction(id); // drop the original (it was on your card; they actually paid)
    const r = await logReverseSplit({ owedAccount: owedName, spendAccount: spendName, total: rec.total, payee: rec.payee, notes: rec.notes || '', category: rec.category, date: rec.date, personName: person });
    rebindTxn(id, { ...rec, id: r.id, spendTxnId: r.spendId, account: owedName, spendAccount: spendName, split: false, reverse: true, person });
    persistTxns();
    return send(chatId, `🔁 ${person} paid — you owe $${(rec.total / 2).toFixed(2)} → ${rec.category} ("${owedName}").`);
  }
  // Forward split: you paid, they owe you half. "split" or "split with NAME".
  const sp = lc.match(/^(?:split|half|\/2)(?:\s+(?:with|w\/?)\s+(.+))?$/);
  if (sp) {
    if (rec.split) return send(chatId, 'Already split.');
    const person = cap((sp[1] || rec.person || cfg.defaults.splitPerson).trim());
    rememberSplitPerson(person);
    const splitAccountName = await resolveOwedAccount(person);
    // Actual can't add subtransactions in place; rebuild the txn as a 50/50 split.
    await api.deleteTransaction(id);
    const newId = await logExpense({ accountName: rec.account, total: rec.total, payee: rec.payee, notes: rec.notes || '', category: rec.category, date: rec.date, split: true, splitAccountName, splitPersonName: person });
    rebindTxn(id, { ...rec, id: newId, split: true, person });
    persistTxns();
    return send(chatId, `✂️ Split 50/50 w/ ${person} (your share $${(rec.total / 2).toFixed(2)}).`);
  }
  // Change the card/account. "card amex" (or "account …"). Rebuild on the new account, keeping split.
  const cardM = lc.match(/^(?:card|account)\s+(.+)$/);
  if (cardM) {
    if (rec.reverse) return send(chatId, "This one's a reverse split (they paid) — no card to change.");
    const acct = resolveAccount(cardM[1].trim());
    if (!acct) return send(chatId, `No account matching "${cardM[1].trim()}". Try a card alias or exact name.`);
    const splitAccountName = rec.split ? await resolveOwedAccount(rec.person || cfg.defaults.splitPerson) : null;
    await api.deleteTransaction(id);
    const newId = await logExpense({ accountName: acct, total: rec.total, payee: rec.payee, notes: rec.notes || '', category: rec.category, date: rec.date, split: rec.split, splitAccountName, splitPersonName: cap(rec.person || cfg.defaults.splitPerson) });
    rebindTxn(id, { ...rec, id: newId, account: acct });
    persistTxns();
    return send(chatId, `💳 Card → ${acct}`);
  }
  // "note: X" / "notes = X" REPLACES the note (clears it if X is empty); any other free text APPENDS.
  const noteSet = raw.match(/^notes?\s*[:=]\s*([\s\S]*)$/i);
  if (noteSet) {
    const notes = noteSet[1].trim();
    await api.updateTransaction(id, { notes }); await api.sync();
    rec.notes = notes;
    persistTxns();
    return send(chatId, notes ? `📝 Note set: ${notes}` : '📝 Note cleared.');
  }
  const notes = [rec.notes, raw].filter(Boolean).join(' · ');
  await api.updateTransaction(id, { notes }); await api.sync();
  rec.notes = notes;
  persistTxns();
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
    if (editField[id]) { await applyFieldValue(id, text); await react(id, post.message_id, REACT_DONE); return; }
    if (confirming[id] && await handleConfirm(id, text)) { await react(id, post.message_id, REACT_DONE); return; }
    if (pending[id]) { await handleCardAnswer(id, text); await react(id, post.message_id, REACT_DONE); return; }
    // A reply to a previously-logged post edits that transaction (note / category / split / delete).
    // Fall back to the channel's most recent txn if the exact message link didn't survive a restart.
    const repliedTo = post.reply_to_message && (msgTxn[post.reply_to_message.message_id] || lastTxn[id]);
    if (repliedTo) {
      await editTxn(id, repliedTo, text);
    } else if (text.startsWith('{')) {
      // poorton's structured posts log directly — no confirmation. (iOS curls quotes; normalize.)
      let json = null;
      try { json = JSON.parse(text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")); } catch { /* fall through */ }
      if (json) { const rec = await handleIngest(json, id); if (rec?.id) { msgTxn[post.message_id] = rec; persistTxns(); } }
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
      const ans = data.slice(5);
      if (ans === '__new__') { pending[chatId].awaitNewAccount = true; await send(chatId, "Type the new account name (I'll create it in Actual):"); }
      else await handleCardAnswer(chatId, ans);
    } else if (data === 'e:menu') { // ✏️ Edit -> show the field picker on this message
      const c = confirming[chatId];
      const rec = (c && c.promptMid === mid) ? null : msgTxn[mid];
      if (c && c.promptMid === mid) await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: mid, reply_markup: fieldMenuKb(c.parsed.paid) }).catch(() => {});
      else if (rec) await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: mid, reply_markup: fieldMenuKb(rec.reverse) }).catch(() => {});
      else await send(chatId, "That one's too old to edit by button — reply to it instead.");
    } else if (data === 'e:back') { // collapse the field picker back to the normal row
      const c = confirming[chatId];
      const kb = (c && c.promptMid === mid) ? confirmKb() : loggedKb();
      await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: mid, reply_markup: kb }).catch(() => {});
    } else if (data === 'e:do:split' || data === 'e:do:person') { // one-tap: split/reverse with your usual person
      const who = lastSplitPerson() || cap(cfg.defaults.splitPerson);
      const c = confirming[chatId];
      if (c && c.promptMid === mid) { // pending preview
        c.parsed = data === 'e:do:person'
          ? { ...c.parsed, paid: true, split: true, splitDecided: true, person: who }
          : { ...c.parsed, paid: false, split: true, splitDecided: true, person: who };
        await rerenderConfirm(chatId);
      } else if (msgTxn[mid]) { // logged receipt
        await editTxn(chatId, msgTxn[mid], data === 'e:do:person' ? `${who} paid` : `split w/ ${who}`);
        await rerenderLogged(chatId, mid, msgTxn[mid]);
      } else await send(chatId, "That one's too old to edit by button — reply to it instead.");
    } else if (data.startsWith('e:set:')) { // a field was picked -> ask for the new value
      const field = data.slice(6);
      const c = confirming[chatId];
      const kind = (c && c.promptMid === mid) ? 'pending' : 'logged';
      if (kind === 'logged' && !msgTxn[mid]) { await send(chatId, "That one's too old to edit by button."); return; }
      editField[chatId] = { field, kind, mid };
      const rec = kind === 'logged' ? msgTxn[mid] : null;
      const cur = kind === 'pending'
        ? (field === 'cat' ? (c.parsed.category || guessCategory(c.receipt, c.parsed.notes)) : field === 'card' ? (c.account || '') : field === 'note' ? (c.parsed.notes || '') : cap(c.parsed.person || cfg.defaults.splitPerson))
        : (field === 'cat' ? rec.category : field === 'card' ? rec.account : field === 'note' ? displayNote(rec.notes) : cap(rec.person || cfg.defaults.splitPerson));
      const prompts = { cat: 'Type the new category', card: 'Type the card (alias or account name)', note: 'Type the new note (replaces the current one)', split: 'Split with whom? Type a name', person: 'Who paid? Type a name' };
      await send(chatId, `${prompts[field] || 'Type the new value'}${cur ? ` (now: ${cur})` : ''}:`, { force_reply: true, ...(cur ? { input_field_placeholder: String(cur).slice(0, 64) } : {}) });
    } else if (data === 'e:ok') { // dismiss the buttons on a logged receipt
      await dropKb(chatId, mid);
    } else if (data === 'e:del') { // delete a logged txn
      const rec = msgTxn[mid] || lastTxn[chatId];
      await dropKb(chatId, mid);
      if (rec) await editTxn(chatId, rec, 'delete');
      else await send(chatId, 'Nothing to delete.');
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
  // A value typed after ✏️ Edit → field goes to that field (must run before the reply/edit routing).
  if (editField[chatId]) return await applyFieldValue(chatId, msg.text);
  // Reply to a previously-logged message edits that txn. If the exact message link is gone
  // (e.g. logged in an earlier process before this one started), fall back to this chat's most
  // recent txn — an explicit reply almost always means "edit the thing I just logged".
  const repliedTo = msg.reply_to_message && (msgTxn[msg.reply_to_message.message_id] || lastTxn[chatId]);
  if (repliedTo) return await editTxn(chatId, repliedTo, msg.text);
  if (confirming[chatId] && await handleConfirm(chatId, msg.text)) return;
  if (pending[chatId]) return await handleCardAnswer(chatId, msg.text);
  const ft = await parseExpense(msg.text);
  if (ft) return await handleFreeText(chatId, ft);
  if (lastTxn[chatId] && Date.now() - lastTxn[chatId].ts < EDIT_WINDOW_MS) return await editLast(chatId, msg.text);
  await send(chatId, `Send a receipt photo, or text the expense like "12.50 starbucks on amex split with ryan". I'll preview it before logging. Once logged, ${EDIT_HINT}`);
}

// ---------- HTTP ingest (Apple Pay / Shortcuts POST here; NOT via Telegram) ----------
async function handleIngest(d, chat = cfg.telegram.allowedChatId) {
  const amount = Math.abs(Number(d.amount));
  if (!amount || !isFinite(amount)) throw new Error('missing/invalid amount');
  const merchant = (d.merchant || 'Apple Pay').toString().trim() || 'Apple Pay';
  const paid = !!d.paid; // reverse: someone else paid, you owe your half
  const account = (d.card && resolveAccount(String(d.card))) || (d.last4 && cardmap.byLast4[d.last4]) || null;
  if (!account && !paid) throw new Error(`couldn't match card "${d.card || d.last4 || '?'}"`);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') ? d.date : todayISO();
  const split = !!d.split;
  let notes = (d.note || '').toString().trim();
  if (d.last4) notes += (notes ? ' ' : '') + `[card ****${d.last4}]`;
  notes = (notes + ' [apple pay]').trim();
  const category = guessCategory({ merchant, line_items: [] }, notes);
  const person = personName(d.with || d.person) || cap(cfg.defaults.splitPerson);
  const noteText = (d.note || '').toString().trim(); // human note, without the [card]/[apple pay] tags
  let id, rec;
  if (paid) {
    rememberSplitPerson(person);
    const owedName = await resolveOwedAccount(person);
    const spendName = await resolveSpendAccount(person);
    const r = await logReverseSplit({ owedAccount: owedName, spendAccount: spendName, total: amount, payee: merchant, notes, category, date, personName: person });
    id = r.id;
    rec = { id, spendTxnId: r.spendId, account: owedName, spendAccount: spendName, date, total: amount, payee: merchant, category, notes, split: false, reverse: true, person, ts: Date.now() };
  } else {
    if (split) rememberSplitPerson(person);
    const splitAccountName = split ? await resolveOwedAccount(person) : null;
    id = await logExpense({ accountName: account, total: amount, payee: merchant, notes, category, date, split, splitAccountName, splitPersonName: person });
    rec = { id, account, date, total: amount, payee: merchant, category, notes, split, person, ts: Date.now() };
  }
  if (id && chat) lastTxn[chat] = rec;
  const body = fmtExpense({ total: amount, merchant, category, account, split, paid, person, note: noteText, date });
  const sentId = chat ? await send(chat, `${paid ? '🔁' : '⚡'} Logged\n${body}\n\n${EDIT_HINT}`, id ? loggedKb() : undefined) : null;
  if (id && sentId) msgTxn[sentId] = rec; // reply to my reply to edit it
  persistTxns();
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
  loadTxns(); // restore reply->txn links so edits survive restarts
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
  assert(b && b.amount === 7 && b.split === false && b.paid === false, '$amount mid-string, no split/paid');
  // Reverse direction ("someone else paid").
  assert(spendAccountFor('ryan') === "Ryan's spend", 'spend account name: ' + spendAccountFor('ryan'));
  const c = parseFreeText('$50 dinner split with ryan, she paid');
  assert(c && c.amount === 50 && c.paid === true, 'reverse: paid detected');
  assert(c.person === 'ryan', 'reverse: pronoun "she" resolves to named "ryan": ' + c.person);
  assert(c.merchant === 'dinner', 'reverse: merchant cleaned of split/paid/person words: ' + c.merchant);
  const d = parseFreeText('50 dinner ryan paid');
  assert(d && d.paid === true && d.person === 'ryan', 'reverse: "NAME paid" without "split"');
  const e = parseFreeText('$20 lunch i paid on amex');
  assert(e && e.paid === false, '"I paid" is NOT reverse (you paid): ' + JSON.stringify(e));
  assert(extractPaid('she paid', true)?.person === null, 'strict: bare pronoun "she paid"');
  assert(extractPaid('ryan paid', true)?.person === 'ryan', 'strict: "ryan paid"');
  assert(extractPaid('i paid', true) === null, 'strict: "i paid" not reverse');
  assert(extractPaid('loan paid off', true) === null, 'strict: "loan paid off" not reverse (no trailing paid)');
  assert(extractPaid('split with ryan she paid', true)?.person === null, 'strict: combined split + pronoun paid');
  // A directive word can never become a person's name (the "Owed by Split" bug).
  assert(personName('split') === null && personName('half') === null && personName('with') === null, 'personName rejects directive words');
  assert(personName('ryan') === 'Ryan' && personName(' tia ') === 'Tia', 'personName keeps real names');
  assert(extractPaid('walmart split paid', false) === null, 'reverse: "split paid" is NOT a payer named Split');
  assert(extractPaid('tia paid', false)?.person === 'tia', 'reverse: real name still works');
  // Note stripping: the caption's description survives; routing/split directives are removed.
  assert(stripControlWords('neutrogena face cleanser on amex split w ryan', ['amex']) === 'neutrogena face cleanser', 'strip: keeps description, drops card+split: ' + stripControlWords('neutrogena face cleanser on amex split w ryan', ['amex']));
  assert(stripControlWords('dinner with mom, ryan paid', []) === 'dinner with mom', 'strip: keeps "with mom", drops "ryan paid": ' + stripControlWords('dinner with mom, ryan paid', []));
  assert(stripControlWords('split with ryan on amex', ['amex']) === '', 'strip: pure directives -> empty');
  const cap1 = parseCaption('neutrogena face cleanser on amex split w ryan');
  assert(cap1.notes === 'neutrogena face cleanser' && cap1.cardAccount === 'Amex' && cap1.split === true && cap1.person === 'ryan', 'caption: note cleaned + card + split + person: ' + JSON.stringify(cap1));
  console.log('selftest OK');
}
if (process.argv[2] === 'selftest') selftest();
else main().catch((e) => { console.error(e); process.exit(1); });
