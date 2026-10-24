# Borton Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a private, responsive Borton web application for reviewing batches of receipt expenses, checking duplicates, and viewing recent Actual transactions.

**Architecture:** A native `borton-web` Node HTTP service serves static browser assets and authenticated JSON endpoints. It uses a separate Actual cache directory and a shared file lock, while extracting receipt parsing and standard-transaction helpers from `bot.mjs` so web and Telegram behavior stay aligned. The browser holds only the current review batch; it never receives secrets or uploads images to disk.

**Tech Stack:** Node ESM, built-in `node:http`, `node:test`, `@actual-app/api`, Gemini REST API, plain HTML/CSS/browser JavaScript, systemd.

**Spec:** `docs/superpowers/specs/2026-10-24-borton-web-design.md`

## Global Constraints

- Run as a separate native systemd service beside `receipt-bot`; do not use Docker.
- Bind only to the configured private WireGuard/LAN address and use no public URL.
- Protect every financial endpoint with password login, signed HttpOnly SameSite=Strict sessions, CSRF validation, and no-store responses.
- Keep Actual, Gemini, and card-map credentials/configuration server-side; discard image buffers after extraction.
- Accept JPEG, PNG, WebP, HEIC, and HEIF up to 10 MB; process uploads sequentially.
- Never automatically submit a receipt, retry an uncertain Actual write, or replay an interrupted batch.
- Re-run duplicate matching directly before submission; same amount, merchant, and ±4 days remains a warning requiring acknowledgement, not a blocker.
- Batch mode creates only standard single-account expenses. Existing Telegram flows retain all split and owner-paid behavior.
- Money is integer cents over the web API. Dates use Borton's existing validator.
- Use a separate Actual data directory for the web service and a lock file shared by bot/web mutation paths.

## Review Focus

- A plain-HTTP request from outside the configured private address must never receive a session or financial response; cover this in Task 2's auth/server test.
- A receipt with a duplicate discovered after the initial review must return to review without any writes; cover this in Task 4's submit recheck test.
- A double-click or service restart using the same request ID must return the stored result without another Actual write; cover this in Task 4's durable idempotency test.
- HEIC with a browser-supplied empty/incorrect MIME type must be rejected safely rather than sent as an arbitrary blob; cover this in Task 3's upload validation test.
- A new merchant name must result in one payee creation reused by every matching row in the batch; cover this in Task 4's batch-commit test.

---

## File structure

- `receipt-extractor.mjs` — shared Gemini receipt schema, MIME validation, and `extractReceiptImage`.
- `actual-web.mjs` — Actual initialization, bounded reads, normalized duplicate lookup, payee resolution, batch commit, file locking, and idempotency journal.
- `web-auth.mjs` — password/session/CSRF primitives with injectable clock/random source for tests.
- `web-server.mjs` — static-file and JSON/multipart HTTP routing, access restrictions, security headers, request limits, and dependency injection.
- `web.mjs` — production configuration loading and service composition/startup.
- `web/index.html`, `web/app.css`, `web/app.js` — mobile/desktop UI, current batch state, and API client.
- `test/receipt-extractor.test.mjs`, `test/web-auth.test.mjs`, `test/actual-web.test.mjs`, `test/web-server.test.mjs` — dependency-free behavior tests.
- `borton-web.service`, `deploy/install.sh`, `deploy/borton-deploy.sh`, `config.example.json`, `README.md`, `deploy/README.md` — configuration and native deployment.

### Task 1: Shared receipt extraction

**Files:**
- Create: `receipt-extractor.mjs`
- Create: `test/receipt-extractor.test.mjs`
- Modify: `bot.mjs:14,502-540`

**Interfaces:**
- Produces `RECEIPT_IMAGE_TYPES: ReadonlySet<string>` and `createReceiptExtractor({ generate, now }): { extractImage(buffer: Buffer, mime: string): Promise<Receipt[]> }`.
- `Receipt` is `{ merchant, date, total, currency, tax, card_last4, line_items }`; callers pass its result through `normalizeReceipts`.

- [ ] **Step 1: Write failing tests for valid JPEG/HEIC extraction and unsupported/oversized image rejection**

  Assert that a fake Gemini generator receives the shared multi-receipt prompt/schema and that an invalid MIME or buffer above the configured 10 MB limit rejects before the generator is called.

- [ ] **Step 2: Run the extractor test to verify it fails**

  Run: `node --test test/receipt-extractor.test.mjs`

  Expected: FAIL because `receipt-extractor.mjs` does not exist.

- [ ] **Step 3: Implement `createReceiptExtractor` and move the schema/prompt out of `bot.mjs`**

  Keep Gemini transport injected. Permit only `image/jpeg`, `image/png`, `image/webp`, `image/heic`, and `image/heif`; enforce the byte limit before base64 encoding.

- [ ] **Step 4: Refactor the Telegram `extractReceipt` wrapper to call the shared extractor**

  Preserve its retry/error behavior and existing multi-receipt response shape.

- [ ] **Step 5: Run focused and regression tests**

  Run: `node --test test/receipt-extractor.test.mjs test/receipt-utils.test.mjs && node bot.mjs selftest`

  Expected: PASS.

- [ ] **Step 6: Commit**

  ```bash
  git add receipt-extractor.mjs test/receipt-extractor.test.mjs bot.mjs
  git commit -m "refactor: share receipt extraction"
  ```

### Task 2: Authentication and HTTP boundaries

**Files:**
- Create: `web-auth.mjs`
- Create: `test/web-auth.test.mjs`
- Create: `web-server.mjs`
- Create: `test/web-server.test.mjs`

**Interfaces:**
- Produces `createWebAuth({ password, sessionSecret, now, randomBytes }): { login, verifySession, issueCsrf, verifyCsrf, clearSession }`.
- Produces `createWebServer({ auth, app, staticDir, allowedRemote, maxUploadBytes }): http.Server` where `app` contains endpoint handlers supplied by Task 4.

- [ ] **Step 1: Write failing auth tests for wrong password, tampered/expired session, CSRF mismatch, and secure-cookie configuration**

  Assert password comparison occurs server-side and only a signed, unexpired cookie plus matching CSRF token is accepted.

- [ ] **Step 2: Run auth tests to verify they fail**

  Run: `node --test test/web-auth.test.mjs`

  Expected: FAIL because `web-auth.mjs` does not exist.

- [ ] **Step 3: Implement `createWebAuth` using HMAC-SHA256 and timing-safe password comparison**

  Store only expiry and a random session ID in the signed cookie. Use `HttpOnly; SameSite=Strict; Path=/`; append `Secure` only when the production config says HTTPS.

- [ ] **Step 4: Write failing server tests for private-address rejection, unauthenticated API rejection, login, no-store, and static application serving**

  Use a real ephemeral HTTP server and injected no-op app handlers; assert untrusted remotes never get login or API content.

- [ ] **Step 5: Run server tests to verify they fail**

  Run: `node --test test/web-server.test.mjs`

  Expected: FAIL because `web-server.mjs` does not exist.

- [ ] **Step 6: Implement `createWebServer` routing and request guards**

  Restrict `/api/*` to valid sessions, require CSRF for POST, parse bounded JSON, render only known static files, set security headers, and keep multipart parsing as a Task 5 handler concern.

- [ ] **Step 7: Run Task 2 tests and commit**

  Run: `node --test test/web-auth.test.mjs test/web-server.test.mjs`

  Expected: PASS.

  ```bash
  git add web-auth.mjs web-server.mjs test/web-auth.test.mjs test/web-server.test.mjs
  git commit -m "feat: add private web authentication"
  ```

### Task 3: Actual-backed web data service

**Files:**
- Create: `actual-web.mjs`
- Create: `test/actual-web.test.mjs`
- Modify: `receipt-utils.mjs` only if a testable export is needed

**Interfaces:**
- Produces `createActualWeb({ api, dataDir, lockPath, currency, now }): { bootstrap, findTransactions, checkDuplicates, validateBatch, submitBatch, close }`.
- A `WebExpense` is `{ clientId, merchant, amountCents, date, accountId, categoryId, note, duplicateAcknowledged }`.
- `submitBatch({ requestId, rows })` returns `{ status: 'complete'|'review_required'|'partial'|'uncertain', rows }`.

- [ ] **Step 1: Write failing Actual service tests for normalized recent/search rows, duplicate matching, and validation errors**

  Use an in-memory fake Actual adapter. Assert transactions are non-transfer, newest-first, capped at 50, and duplicate candidates use the existing ±4-day matcher.

- [ ] **Step 2: Run the test to verify it fails**

  Run: `node --test test/actual-web.test.mjs`

  Expected: FAIL because `actual-web.mjs` does not exist.

- [ ] **Step 3: Implement read/bootstrap/duplicate/validation methods**

  Use integer cents, open accounts, visible categories, a 15-second sync freshness window, and the existing `findLikelyDuplicates` matcher. Return only fields required by the UI.

- [ ] **Step 4: Extend tests with cross-process lock acquisition/release and a newly-created payee reused in one batch**

  Assert a second operation waits for the lock and that two row merchants differing only by case create one payee.

- [ ] **Step 5: Implement lock, payee resolution, and sequential standard-expense writer**

  Maintain a separate web data directory. Persist the request journal atomically with mode 0600; completed request IDs return their original result for 24 hours, while in-progress/interrupted writes become `uncertain`.

- [ ] **Step 6: Run Task 3 tests and commit**

  Run: `node --test test/actual-web.test.mjs test/receipt-utils.test.mjs`

  Expected: PASS.

  ```bash
  git add actual-web.mjs receipt-utils.mjs test/actual-web.test.mjs
  git commit -m "feat: add Actual web batch service"
  ```

### Task 4: API composition and safe submit semantics

**Files:**
- Modify: `web-server.mjs`
- Modify: `test/web-server.test.mjs`
- Create: `web.mjs`

**Interfaces:**
- `createWebApplication({ actual, extractor }): { bootstrap, transactions, duplicates, extract, validateBatch, submitBatch }` is composed by `web.mjs` and consumed by `createWebServer`.

- [ ] **Step 1: Write failing API tests for `/api/bootstrap`, `/api/transactions`, `/api/duplicates`, `/api/extract`, validate, and submit**

  Cover multi-receipt upload mapping, image buffer disposal after extraction, at-most-50 rows, a duplicate appearing between validation and submit, acknowledgement requirements, double-click idempotency, and partial-result rendering data.

- [ ] **Step 2: Run API tests to verify they fail**

  Run: `node --test test/web-server.test.mjs`

  Expected: FAIL on the missing route behavior.

- [ ] **Step 3: Implement the API application and production `web.mjs` composition**

  Load the existing root-only configuration and `.env`, initialize `@actual-app/api` with `web.dataDir`, wrap the current Gemini generator in the shared extractor, and cleanly shut down Actual on process signals.

- [ ] **Step 4: Implement multipart image parsing with one-file/10-MB bounds and immediate buffer release**

  Preserve only MIME and bytes long enough to invoke `extractImage`; normalize output, infer account/category suggestions, and return duplicate candidates without persisting the source.

- [ ] **Step 5: Run API and full Node suite, then commit**

  Run: `node --test && node --check web.mjs && node --check web-server.mjs`

  Expected: PASS.

  ```bash
  git add web.mjs web-server.mjs test/web-server.test.mjs
  git commit -m "feat: expose Borton web APIs"
  ```

### Task 5: Responsive capture/review interface

**Files:**
- Create: `web/index.html`
- Create: `web/app.css`
- Create: `web/app.js`
- Modify: `test/web-server.test.mjs`

**Interfaces:**
- Browser state is `{ activeView, transactions, batch, selectedIds, csrfToken }`.
- Browser requests the endpoints from Task 4; it never sees Actual/Gemini credentials or raw configuration.

- [ ] **Step 1: Add a failing server/static test for the app shell and declared mobile viewport**

  Assert the served entry page includes viewport configuration, navigation for Recent/Capture/Check duplicate, and no inline secrets.

- [ ] **Step 2: Run the static test to verify it fails**

  Run: `node --test test/web-server.test.mjs`

  Expected: FAIL because the app shell/assets do not exist.

- [ ] **Step 3: Build the login and Recent/lookup views**

  Render 50 newest non-transfer entries, filters, current freshness time, explicit Refresh, and a read-only transaction detail sheet.

- [ ] **Step 4: Build Capture and review controls**

  Support camera/library/drop uploads, render editable rows/cards, account/category controls, multi-select field actions, duplicate badges, exclude/acknowledge handling, and Submit N expenses with per-row result state.

- [ ] **Step 5: Apply responsive CSS and keyboard/touch behavior**

  Use a grid on wide displays and stacked cards with a sticky bottom action bar on phones. Ensure essential controls have labels and error messages are announced.

- [ ] **Step 6: Run the full suite and commit**

  Run: `node --test && node --check web/app.js && git diff --check`

  Expected: PASS.

  ```bash
  git add web/index.html web/app.css web/app.js test/web-server.test.mjs
  git commit -m "feat: add Borton web review interface"
  ```

### Task 6: Native deployment and documentation

**Files:**
- Create: `borton-web.service`
- Modify: `config.example.json`
- Modify: `deploy/install.sh`
- Modify: `deploy/borton-deploy.sh`
- Modify: `README.md`
- Modify: `deploy/README.md`

**Interfaces:**
- `web` config has `host`, `port`, `dataDir`, `lockPath`, `maxUploadBytes`, `allowedRemote`, and `https`.
- `.env` requires `BORTON_WEB_PASSWORD` and `BORTON_WEB_SESSION_SECRET` only when `borton-web` is enabled.

- [ ] **Step 1: Add failing deployment-script assertions for installing/enabling the web service and checking its health**

  Verify the existing deploy does not treat a healthy bot alone as a complete deployment when web is configured/enabled.

- [ ] **Step 2: Run the deployment assertions to verify they fail**

  Run: `node --test test/deploy-web.test.mjs`

  Expected: FAIL because the web unit/deploy behavior is absent.

- [ ] **Step 3: Implement unit, config examples, install/deploy health check, and private WireGuard instructions**

  Start `borton-web` independently, confirm a login route response without credentials, and preserve the bot's existing rollback behavior. Document secrets/configuration but never add actual values.

- [ ] **Step 4: Run verification and commit**

  Run: `node --test && node bot.mjs selftest && node tools/test_agent.mjs && git diff --check`

  Expected: PASS.

  ```bash
  git add borton-web.service config.example.json deploy README.md test/deploy-web.test.mjs
  git commit -m "feat: deploy Borton web service"
  ```

### Task 7: Publish and verify on the LXC

**Files:**
- No source changes expected.

- [ ] **Step 1: Inspect final branch and run all checks**

  Run: `git status --short && npm test && node tools/test_agent.mjs && git diff --check`

  Expected: clean tracked tree and passing tests.

- [ ] **Step 2: Push the branch and verify the deployed revision**

  Push the committed branch as configured for the production auto-deployer. On `actualbot`, verify the new commit, `receipt-bot` active/long-polling, `borton-web` active, and the private login route responding.

- [ ] **Step 3: Exercise only read-only production smoke checks**

  Log in from the WireGuard-reachable phone and confirm Recent and duplicate lookup load. Do not submit a live expense as a test.

## Self-review

- **Spec coverage:** Tasks 1–5 cover extraction, batch editing APIs, duplicate warnings/rechecks, recent/search, image disposal, private authentication, and responsive UI. Task 6 covers configuration/native service/health checks; Task 7 covers LXC rollout. Split and owner-paid batch transactions remain an explicit non-goal.
- **Type consistency:** `WebExpense` is produced by browser rows and consumed by `actual-web` and submit routes. `createWebApplication` is the only API layer passed into `createWebServer`.
- **Review focus:** Each of the five high-risk cases is assigned to Tasks 2–4 as stated above.
- **Proportion:** The plan fixes module boundaries, endpoint names, exact limits, and test/commit steps without prescribing implementation bodies.
