import * as actualApi from '@actual-app/api';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createActualWeb } from './actual-web.mjs';
import { createReceiptExtractor } from './receipt-extractor.mjs';
import { createAudioTranscriber, createGroqAudioTranscriber } from './audio-transcriber.mjs';
import { createWebApplication } from './web-app.mjs';
import { createWebAgent } from './web-agent.mjs';
import { createWebMessageQueue } from './web-message-queue.mjs';
import { createGeminiGenerate, createGroqGenerate } from './agent.mjs';
import { createWebAuth } from './web-auth.mjs';
import { createWebServer } from './web-server.mjs';
import { createPlaidSync } from './plaid-sync.mjs';
import { createReviewInbox } from './review-inbox.mjs';
import { createReceiptReviewQueue } from './receipt-review-queue.mjs';
import { createReviewService } from './review-service.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const loadEnv = (file) => {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/); if (!match || line.trim().startsWith('#') || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^("|')|("|')$/g, '');
  }
};
loadEnv(path.join(root, '.env'));
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const web = cfg.web || {};
const password = process.env.ACTUAL_PASSWORD || cfg.actual.password || (fs.existsSync(`${process.env.HOME}/.config/actual/password`) ? fs.readFileSync(`${process.env.HOME}/.config/actual/password`, 'utf8').trim() : '');
if (!process.env.BORTON_WEB_PASSWORD || !process.env.BORTON_WEB_SESSION_SECRET || !process.env.GOOGLE_API_KEY || !password) throw new Error('Missing BORTON_WEB_PASSWORD, BORTON_WEB_SESSION_SECRET, GOOGLE_API_KEY, or Actual password.');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const dataDir = path.resolve(root, web.dataDir || './actual-web-data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
await actualApi.init({ dataDir, serverURL: cfg.actual.serverURL, password });
await actualApi.downloadBudget(cfg.actual.syncId);
const models = [cfg.gemini?.model, ...(cfg.gemini?.fallbackModels || [])].filter(Boolean);
const chatGenerate = process.env.GROQ_API_KEY
  ? createGroqGenerate({ apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL || cfg.groq?.model || 'openai/gpt-oss-20b' })
  : createGeminiGenerate({ apiKey: process.env.GOOGLE_API_KEY, models });
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const generate = async (parts, responseSchema) => {
  let last = new Error('Gemini is unavailable.');
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-goog-api-key': process.env.GOOGLE_API_KEY }, body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', responseSchema } }), signal: AbortSignal.timeout(60_000) });
        if (!response.ok) {
          last = new Error(`Gemini HTTP ${response.status}.`);
          if (response.status === 429 && attempt === 0) { await wait(1_500); continue; }
          break;
        }
        const text = (await response.json())?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error('Gemini returned no extraction.');
        return JSON.parse(text);
      } catch (error) { last = error; break; }
    }
  }
  if (/Gemini HTTP 429/.test(last.message)) throw new Error('Receipt scanning is busy. Please try again in a minute.');
  throw last;
};
const cardmap = fs.existsSync(path.join(root, 'cardmap.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'cardmap.json'), 'utf8')) : {};
const actual = createActualWeb({ api: actualApi, dataDir, lockPath: path.resolve(root, cfg.actual.dataDir, 'actual.lock'), currency: cfg.defaults?.currency || 'CAD', timezone: cfg.agent?.timezone || 'America/Toronto', owedAccountFormat: cfg.defaults?.owedAccountFormat || 'Owed by {name}', cardmap });
const receiptExtractor = createReceiptExtractor({ generate, maxBytes: web.maxUploadBytes || 10 * 1024 * 1024 });
const inbox = createReviewInbox({ filePath: path.join(dataDir, 'reviews.json'), receiptDir: path.join(dataDir, 'review-receipts') });
let reviews;
const receiptQueue = createReceiptReviewQueue({ inbox, extractor: receiptExtractor, matchReceipt: (input) => reviews.matchReceipt(input) });
reviews = createReviewService({ actual, inbox, receiptQueue, cardmap });
const plaid = createPlaidSync({ clientId: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, env: process.env.PLAID_ENV, tokenKey: process.env.PLAID_TOKEN_KEY, statePath: path.join(dataDir, 'plaid-items.json'), actualAccounts: async () => (await actual.bootstrap()).accounts, importTransactions: (rows) => reviews.stagePlaid(rows) });
const assistant = createWebAgent({ api: actualApi, generate: chatGenerate, statePath: path.join(dataDir, 'web-agent-state.json'), currency: cfg.defaults?.currency || 'CAD', timezone: cfg.agent?.timezone || 'America/Toronto', lock: actual.runExclusive });
const assistantQueue = createWebMessageQueue({ assistant, filePath: path.join(dataDir, 'web-message-queue.json') });
const transcriber = process.env.GROQ_API_KEY ? createGroqAudioTranscriber({ apiKey: process.env.GROQ_API_KEY, model: cfg.groq?.transcriptionModel || 'whisper-large-v3-turbo', maxBytes: web.maxAudioBytes || 5 * 1024 * 1024 }) : createAudioTranscriber({ generate, maxBytes: web.maxAudioBytes || 5 * 1024 * 1024 });
const app = createWebApplication({ actual, extractor: receiptExtractor, transcriber, cardmap, fallbackCategory: cfg.defaults?.fallbackCategory || 'General', assistant, assistantQueue, plaid, reviews });
const auth = createWebAuth({ password: process.env.BORTON_WEB_PASSWORD, sessionSecret: process.env.BORTON_WEB_SESSION_SECRET, secure: web.https === true });
const server = createWebServer({ auth, app, staticDir: path.join(root, 'web'), allowedRemote: web.allowedRemote || ['127.0.0.1'], trustedRemotes: web.trustedAutoLoginRemote || [], maxUploadBytes: web.maxUploadBytes || 10 * 1024 * 1024 });
server.listen(web.port || 28456, web.host || '127.0.0.1', () => console.log(`Borton Web listening on http://${web.host || '127.0.0.1'}:${web.port || 28456}`));
const plaidTimer = setInterval(() => { void plaid.syncHealthy(); }, 30 * 60 * 1000);
const receiptCleanupTimer = setInterval(() => { reviews.cleanup(); }, 6 * 60 * 60 * 1000);
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(plaidTimer);
  clearInterval(receiptCleanupTimer);
  receiptQueue.close();
  assistantQueue.close();
  server.shutdown(() => actual.close().finally(() => process.exit(0)));
};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
