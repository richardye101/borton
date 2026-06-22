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
cp config.example.json config.json     # then edit with your chat id, Actual server, syncId
cp cardmap.example.json cardmap.json   # your card aliases (self-builds over time)
npm install
# 1. open Telegram, message your bot (anything)
npm run chatid                 # prints your chat_id
# 2. put that number in config.json -> telegram.allowedChatId
npm start
```
`config.json` and `cardmap.json` are gitignored (they hold your chat ids, server, and account
names); commit only the `*.example.json` templates.

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

## Deploy
On an always-on host with network access to the Actual server (e.g. a Proxmox LXC). The repo is
public but `.env`, `config.json`, and `cardmap.json` are gitignored — copy those three in by hand
(`scp` them beside the cloned repo). Run **one** instance per bot token — two pollers fight over
`getUpdates` (Telegram 409). The Telegram relay is fully outbound; port `28455` only matters if
something POSTs to `/ingest` directly.

### Native on a Debian 12 LXC (recommended)
**Node 21+ is required** — `@actual-app/api` uses the global `navigator`, absent in Node ≤20, so
install Node 22 from NodeSource, *not* Debian's old `nodejs`.

On the LXC (`pct enter <CTID>` or the console):
```bash
apt update && apt install -y git
git clone https://github.com/richardye101/borton.git /root/borton && cd /root/borton
```

Copy the three gitignored private files in (clone doesn't include them) — from your workstation:
```bash
scp .env config.json cardmap.json root@<LXC-IP>:/root/borton/
```

Then run the deploy script (installs Node 22 + build tools, `npm ci`, installs & enables the
systemd service):
```bash
./deploy.sh
journalctl -u receipt-bot -f          # -> "Bot running. Long-polling Telegram…"
```

Update after code changes:
```bash
git -C /root/borton pull && cd /root/borton && npm ci && systemctl restart receipt-bot
```
Re-run `npm ci` after any Node version change too (rebuilds the native module).

### Docker (alternative)
```bash
docker compose up -d --build      # code-only image; secrets/config bind-mounted, cache in a volume
docker compose logs -f
```

## Notes
- Self-signed Actual cert → `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in code.
- Splits transfer half into an `Owed by {name}` account (format in config `defaults.owedAccountFormat`,
  default person `defaults.splitPerson`); the account is matched or auto-created on first use.
- Category is a light code-side guess; refine in Actual or via rules.
