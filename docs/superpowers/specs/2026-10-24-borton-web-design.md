# Borton Web design

**Status:** Proposed

## Intent

Borton currently accepts receipts in Telegram and writes the resulting transactions to Actual.
The owner needs a private, mobile-first web application for a faster review workflow: upload
one or more receipt/screenshots, correct many extracted expenses in a row-oriented editor, see
recent activity, and determine whether an expense already exists before creating it. It must also
work well on desktop, where editing a table is the primary interaction.

The app is a custom Borton interface. Actuali and Actual Budget Tweaks are references for useful
mobile ledger/search and transaction-inspector patterns; neither supplies Borton's receipt
extraction or batch-review workflow.

## Goals

- Provide one responsive web application, usable through the owner's existing private WireGuard
  connection, with no public URL and no Telegram requirement.
- Make the newest Actual transactions immediately visible and searchable by merchant, amount,
  date, account, or category.
- Provide an Assistant tab that reuses Borton's existing natural-language Actual agent for
  read queries and reviewed multi-transaction plans, including confirmation and cancellation in
  the web UI.
- Accept an image containing one or more receipts, detect up to eight purchases per image using
  the current Gemini extractor, and never write them automatically.
- Present extracted purchases in a compact editable table. Merchant, amount, date, card/account,
  category, and note are editable inline. Multiple selected rows can receive a shared date,
  account, or category.
- Run Borton's existing same-amount, same-merchant, within-four-days duplicate matcher whenever
  an editable match field changes, and re-check immediately before submission.
- Submit an explicitly reviewed batch to Actual and show a clear success/failure result for every
  row.

## Non-goals for the first release

- A browser-direct Actual client, bank syncing, budgeting screens, reporting, or a replacement
  for the Actual application.
- Telegram notifications or Telegram authentication.
- Automatic logging after OCR, background retries of financial writes, or retaining uploaded
  receipt images on the LXC.
- Batch split/owed-account/other-person payments. The existing bot remains the supported path
  for those specialised receipt workflows; the web app validates a standard one-account expense
  per row.

## Approaches considered

1. Add pages to the existing Telegram polling process. This is low effort but mixes interactive
   web traffic with the long-polling worker and makes bot availability depend on the web server.
2. Run `borton-web` as a separate native Node/systemd service and share purpose-built Borton
   modules. **Selected.** It isolates web failures from the Telegram bot, preserves the LXC's
   native deployment model, and does not expose Actual credentials to the browser.
3. Build a browser application against Actual's API. This would require browser storage and
   cross-origin isolation, would expose the account workflow directly to the client, and would
   bypass Borton's receipt/duplicate behavior.

## Access and security

`borton-web` listens on a configured private address and port. The owner reaches it through the
existing WireGuard connection; no public DNS, tunnel, public reverse proxy, or Docker is part of
this project. The systemd unit runs as the existing root-owned Borton deployment does.

Private networking is not treated as authentication. The service has one password supplied as
`BORTON_WEB_PASSWORD` in the existing root-only `.env`; `BORTON_WEB_SESSION_SECRET` signs an
HTTP-only, `SameSite=Strict` cookie session. The first deployment uses plain HTTP only inside the
encrypted private WireGuard network, so the cookie has no `Secure` attribute. If an existing
private HTTPS reverse proxy is configured later, the same service can set `web.https: true` and
add `Secure`. The login form is the sole unauthenticated route. Every API route rejects
missing/invalid sessions, mutating requests require same-origin requests plus a CSRF token, and
the server sends `Cache-Control: no-store` for financial data. Credentials, Actual configuration,
card-map contents, and Gemini keys never reach browser JavaScript.

The service permits the configured WireGuard/LAN address only. Deployment documentation will
show the exact `web.host` and `web.port` configuration needed for the existing WireGuard network;
the deploy cannot guess its interface/IP. A firewall or reverse proxy can narrow this further.

## Service structure

New `web/` static assets contain plain HTML, CSS, and browser JavaScript; no frontend framework
or build step is introduced. `web.mjs` is the separate Node HTTP service, responsible for
authentication, request validation, static files, image upload limits, and JSON endpoints.

Small extracted modules own shared behavior:

- `receipt-utils.mjs` continues to own date validation, receipt normalization, and duplicate
  matching. Its existing unit tests remain the source of truth.
- A web-agent adapter creates the existing `agent.mjs` with a distinct `web-agent-state.json`
  state file and a fixed owner identity. It reuses the validated Actual tool declarations and
  existing Gemini function-calling loop; browser text never gains shell, raw API, or unrestricted
  database access. Agent turns and confirmations use the same Actual lock as batch commits.
- A new receipt-extraction module receives an image buffer and invokes the existing Gemini schema.
  Both Telegram and Web call it, preventing prompt/schema drift.
- A new Actual session/transaction module initializes `@actual-app/api`, reads accounts, payees,
  categories and recent transactions, and commits standard expense rows. It uses the existing
  application validation and integer-cent conversion rules.
- A process-wide lock file serializes Actual reads/writes that change local sync state across
  `receipt-bot` and `borton-web`. Each service also uses a separate Actual cache directory, so
  their SQLite/Sync caches never share files. Before a commit, the web worker refreshes and runs
  duplicate checks against current Actual data.

The refactor keeps Telegram-specific state and callbacks in `bot.mjs`; its specialized split,
owner-paid, edit, queue, and agent behavior must remain unchanged.

## Web experience

### Recent activity and lookup

The home screen opens on **Recent**: the newest 50 non-transfer transactions, ordered newest
first, showing date, merchant, account, category, and formatted amount. Before a Recent/lookup
response, the service synchronizes Actual at most once every 15 seconds; a user-triggered Refresh
always synchronizes. The UI shows when the data last synchronized. A fixed search control filters
merchant/note text, exact amount, account, category, and date range. Search results are read-only;
selecting a row opens a Borton read-only detail sheet with the account, category, note, status,
date, amount, and Actual transaction ID.

The same lookup panel is reachable from **Check duplicate**. Entering or pasting merchant,
amount, date, and optional account returns likely duplicates with the reason for the match and a
link to the existing record. This supports a quick manual check even with no image upload.

### Assistant

The **Assistant** tab is a private web conversation with the existing Borton agent. It supports
read questions and bulk commands such as “move the ten grocery transactions from last week to
Household” or “find all Uber charges in September and clear them.” The reply renders as text;
when the agent stages a mutation, the UI presents its full deterministic plan and **Confirm** /
**Cancel** controls. Only Confirm executes the frozen plan. Revising the request replaces the
pending plan exactly as it does in Telegram. The page keeps the same short local conversation
state across restarts and makes no Telegram call.

### Capture and batch review

The **Capture** screen accepts camera images, the phone photo library, or desktop drag/drop.
Files are capped at 10 MB each and processed sequentially. JPEG, PNG, WebP, HEIC and HEIF are
accepted; Gemini supports those image MIME types directly. The original image buffer exists only
for the extraction request and is discarded when the response is returned.

The review screen shows one row for every detected receipt. Each row starts as `Needs review` and
contains editable merchant, amount, date, account, category, note, and duplicate cells. Dates
use a date input and preserve receipt dates that are valid; an absent/implausible OCR date starts
as today. The account is preselected from a recognized last four, otherwise it is explicitly
required. A category is suggested but remains editable.

Desktop uses a compact scrollable grid. Phone uses the same rows as cards with a sticky action
bar and a bottom sheet for field selection. Selecting rows enables **Set date**, **Set account**,
and **Set category**; each action changes only the chosen field of selected rows. There is no
hidden fill or automatic commit.

Each row displays one of: `No match found`, `Likely duplicate`, `Check required`, `Ready`, or
`Invalid`. A likely duplicate never blocks the row by itself: the owner can exclude it, correct
it, or mark it as intentionally new. Invalid rows cannot be submitted. The batch action says
`Submit N expenses`; it remains disabled until all included rows are valid and every duplicate
warning has been explicitly acknowledged.

### Submission

`Submit N expenses` first fetches current candidate transactions and performs the duplicate check
again. If a new likely match appeared, the response returns to review with that warning. Otherwise
the server resolves each merchant to an existing Actual payee by normalized name or stages a new
payee creation, writes rows sequentially, and synchronizes Actual once. The response reports each
transaction ID and row outcome. If a write fails, no unattempted row is written, completed rows
remain visible, and the UI tells the owner exactly which rows need review. There is no automatic
replay because the Actual outcome of an interrupted write can be uncertain.

## API contract

Authenticated API responses are JSON and contain only fields needed by the UI.

- `GET /api/bootstrap` returns open expense accounts, visible categories, and recent transactions.
- `GET /api/transactions` accepts bounded lookup filters and returns at most 50 rows.
- `POST /api/duplicates` validates merchant/amount/date/account and returns normalized likely
  matches. It does not write.
- `POST /api/extract` accepts one image multipart body, returns normalized extracted receipt rows
  plus account/category suggestions and duplicate candidates. It does not persist the image.
- `POST /api/batches/validate` validates at most 50 edited rows and returns normalized rows and
  current duplicate candidates.
- `POST /api/batches/submit` re-validates, re-checks duplicates, and commits the selected rows.
  It requires a unique browser-generated request ID; the server persistently records completed
  request IDs and outcomes for 24 hours to make an accidental double-click or a service restart
  idempotent. A request interrupted after a write starts is recorded as uncertain and is never
  automatically replayed; its response directs the user to lookup completed rows before retrying.
- `POST /api/assistant/message` submits one bounded text request and returns the existing agent
  text plus an optional staged plan ID. `POST /api/assistant/confirm` and
  `POST /api/assistant/cancel` act on that plan. All three require the regular authenticated
  session and CSRF token.

Endpoints reject unknown fields, dates outside Borton's existing validation window, non-positive
amounts, non-open accounts, and unknown categories. Money crosses the wire as integer cents to
avoid rounding differences.

## Configuration and deployment

`config.example.json` gains a `web` block for `host`, `port`, upload-size limit, separate data
directory, and the allowed private network/interface. `.env` gains the two web authentication
values. The example contains placeholders only.

New `borton-web.service` starts `/usr/bin/node web.mjs` in `/root/borton`; it is separately
restartable and enabled with the existing native deploy scripts. The deploy health check verifies
the web service is active and the login route responds without exposing data. It never uses
Docker. README deployment instructions cover setting the WireGuard-reachable host/port, creating
the secrets, enabling the service, and opening the private URL on the phone.

## Verification

Tests use Node's built-in test runner and fake Actual/Gemini adapters. They cover authentication,
CSRF and unauthenticated data rejection; request schema limits; date/cents conversion; one and
multi-receipt extraction mapping; bulk-field edits; duplicate status and final recheck; an
intentionally accepted duplicate; idempotent submit; partial commit reporting; no image
persistence; and Assistant message/revision/confirm/cancel behavior. Existing receipt, agent,
routing, retry, and split tests continue to pass.

Before deployment, run syntax checks, the full test suite, a local login/API smoke test with fake
configuration, and the existing read-only Actual smoke test. On the LXC, verify both systemd
services are active, the bot resumes long polling, and a private WireGuard-device login reaches
the recent-transactions page. No test creates a financial transaction in the live budget.

## Rollout and rollback

The web service is deployed in a commit after tests pass. It starts disabled until its private
host/port and `.env` secrets are configured, then is enabled alongside the unchanged bot. Rolling
back means disabling/stopping `borton-web` or deploying the prior known-good commit; the Telegram
bot remains independently available throughout.
