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

- `bot.mjs` — Telegram long-poll, receipts, voice transcription, expense workflows, and agent routing.
- `agent.mjs` — Gemini tool loop, short conversation memory and confirmed plans.
- `actual-tools.mjs` — validated Actual queries, reports and mutation proposals.
- `retry-queue.mjs` — durable Telegram inbox, delayed retries and dead letters.
- `cardmap.json` — `aliases` (caption words → account) + `byLast4` (self-built).
- Extraction backend is one function (`extractReceipt`) — swap Gemini for Claude or local Gemma without touching the rest.

## Conversational Actual assistant

Ask naturally by text or voice: “How much did I spend on groceries last month?”,
“Find the Costco charge from Friday”, “Change that to Household”, or
“Increase this month's grocery budget by $200.” Receipt photos and explicit expense/edit
commands keep their existing workflows. General questions go to the agent.

The agent can work with transactions/transfers, accounts, categories and groups, payees,
budget amounts/carryover, schedules, rules, tags, notes and bank sync. It reads immediately.
For changes it shows the complete plan with before/after values and one **Confirm / Cancel**
keyboard. Only Confirm executes it. Describe a revision to replace the plan and invalidate
the old buttons. Plans expire after 24 hours. Direct receipt workflows retain their existing
confirmations; the new plan requirement applies to agent operations.

The agent requires `telegram.allowedChatId`, set to the owner's private Telegram chat/user ID.
To enable it in the configured `telegram.relayChannelId`, explicitly set `agent.relayEnabled`
to `true`. Channel subscribers can see its budget replies and plans; only the owner's Telegram
account can use Confirm/Cancel or receipt-edit buttons. Typed channel “yes” cannot confirm.
Private and channel conversation histories and receipt references stay separate.
Ordinary text/voice replies (such as “This should be Sept 8th”) go to the agent, not into notes.
Use an explicit `note: ...` command or the Note field for note edits. Channel text edits produce
confirmed plans; trusted structured receipt uploads retain their existing workflow.
Set `agent.enabled` to `false` to disable it, or `agent.timezone` to your IANA timezone (default
`America/Toronto`). It uses the existing Gemini model/key and adds no runtime dependency.

Actual computes aggregates locally. Gemini receives the requested totals or matching records,
with transaction notes only when needed. It does not receive API credentials, configuration,
or the raw budget database. Short history (12 messages), up to 50 entity references, a pending
plan and the last 100 execution records persist in `actual-data/agent-state.json` (mode 0600).
That file contains financial context; keep it private with the rest of the Actual cache.

Confirmed plans are sequential, not atomic. A failure reports completed, uncertain and
unattempted steps. Interrupted writes are never automatically replayed. Ask the bot to inspect
Actual before requesting a new plan. It checks snapshots again before applying changes.
Destructive account/category/payee changes are presented separately from edits to other object
types. Split-parent structural changes remain in the existing receipt split workflow; the
agent can edit child categories/notes without collapsing the split.

Offline checks: `node tools/test_agent.mjs`, `node --test tools/test_routing.mjs tools/test_split.mjs tools/test_retry.mjs`,
and `node bot.mjs selftest` (use synthetic
config/cardmap files for selftest, which exercises card-map learning).
Read-only deployment check: `node bot.mjs agent-smoke`. This downloads a separate temporary
Actual cache, verifies budget/transaction read schemas, asks Gemini to count open accounts,
and stages a sample plan with execution disabled. It never polls Telegram or executes financial
mutations. The temporary cache is private financial data and is kept under
the OS temporary directory for diagnosis.

The API client is pinned to `26.8.1`, matching the deployed Actual server. A newer budget may
reject an older client with `out-of-sync-migrations`; update the pin to the server's version
and run the smoke check before restarting production.

## Automatic retries

Authorized Telegram text, voice and photo messages are saved before acknowledging delivery.
Temporary Gemini/Telegram failures (429, 5xx, timeouts and interrupted connections) retry after
1, 5 and 15 minutes, then hourly, honoring longer `Retry-After` delays. Model fallback remains,
but there are no immediate repeated calls to the same model. Terse receipt parsing still works
without Gemini; failed AI interpretation is queued rather than converted into a guessed expense.
The bot shows one “Queued — I’ll retry automatically” status, updating it when processing finishes.
Transcripts, receipt references and the original request date/context survive restarts. Messages
stay ordered within each chat, and buttons wait while that chat has queued work. Other chats and
Telegram polling continue. Agent changes still need the owner's existing Confirm button.

The queue is `actual-data/message-queue.json` (under the configured `actual.dataDir`, mode 0600).
It contains private message/financial context and Telegram attachment IDs, not downloaded media
or API keys. Completed payloads are removed. After 24 hours, or on a permanent failure, the
payload remains with `status: "dead"` for inspection, with one notification and no further retries.
Any failure/restart after an Actual mutation started is also held there: its outcome may be
uncertain, so it is never replayed automatically. Inspect Actual before attempting that work again;
do not reset an uncertain job to pending. HTTP `/ingest` and confirmation execution retain their
existing workflows and are not automatically replayed. Preserve the queue file if it is corrupt;
the bot stops rather than silently discarding it. Run only one bot process per queue/token.

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
