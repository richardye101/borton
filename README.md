# Receipt Bot → Actual Budget

Text a receipt photo (optionally captioned) to a Telegram bot; it extracts the receipt with
Gemini vision, parses the caption in code, routes to the right card account via a self-building
last-4 map, writes the transaction to Actual, and replies with a summary.

## Setup (one time)
Secrets live in `.env` (not committed, not in config.json):
```
TELEGRAM_BOT_KEY=...
GOOGLE_API_KEY=...
# optional; otherwise read from ~/.config/actual/password
# ACTUAL_PASSWORD=...
```
Then:
```bash
cd ~/receipt-bot
chmod 600 .env                 # contains secrets
npm install
# 1. open Telegram, message your bot (anything)
npm run chatid                 # prints your chat_id
# 2. put that number in config.json -> telegram.allowedChatId
npm start
```
`config.json` holds only non-secret settings (model, Actual URL/syncId, defaults).

## Use
- Send a **photo** of a receipt. Optional caption, e.g.:
  - `on amex` — force the card
  - `split w tia` — split 50/50 → your half categorized, other half → "Owed by Tia"
  - `dinner with Mike` — free text becomes the transaction note
- First time it sees a new card's last-4 it asks which account; it remembers after that (`cardmap.json`).
- If the receipt has no card number, it asks which card you used.

## Architecture
- `bot.mjs` — everything: Telegram long-poll, Gemini extractor (swappable), caption parser, Actual writes.
- `cardmap.json` — `aliases` (caption words → account) + `byLast4` (self-built).
- Extraction backend is one function (`extractReceipt`) — swap Gemini for Claude or local Gemma without touching the rest.

## Deploy (later)
Move this folder to an always-on host (the Proxmox box) with Node 18+ and network access to the
Actual server. `node bot.mjs` under a process manager (systemd / pm2). Caption parsing + card routing
are code-side, so the only network deps are Telegram + the extraction backend; the bot queues/retries
on transient Gemini rate-limits.

## Notes
- Self-signed Actual cert → `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in code.
- Splits use a transfer subtransaction into the "Owed by Tia" account (set in config `defaults.splitAccount`).
- Category is a light code-side guess; refine in Actual or via rules.
