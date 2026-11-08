# Reviews Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stage Plaid and receipt imports in one persistent Reviews inbox where the owner can search, filter, match, resolve, and audit records before they affect Actual.

**Architecture:** A focused private review-state module will persist incoming bank rows, receipt jobs, candidate evidence, and resolutions. Plaid sync will stage before advancing its cursor; a separate one-at-a-time receipt worker will persist source images, retry OCR safely, and clean images up after 30 days. The existing Actual facade applies explicit Import/Merge/Ignore decisions under its lock, while the Svelte page uses the existing router and table patterns.

**Tech Stack:** Node ESM, built-in `fs`/`crypto`/`node:test`, `@actual-app/api`, Svelte, existing private JSON data files and `withActualLock`.

**Spec:** `docs/superpowers/specs/2026-11-07-reviews-inbox-design.md`

## Global Constraints

- No automatic merge or category assignment; only an explicit review resolution writes to Actual.
- Keep receipt images in Borton-only `0600` storage; never insert base64 or image data into Actual notes.
- Delete receipt image bytes 30 days after upload, retaining extracted fields and audit history.
- Stage Plaid changes durably before advancing a Plaid cursor.
- Use integer cents, signed bank/Actual amounts, and existing private network/auth/CSRF boundaries.
- Add no dependency or database.

## Review Focus

- An Actual row with a different importer ID is still a candidate; only the identical Plaid ID is already handled — Task 1.
- Restart during OCR returns a processing receipt to retry without losing the image or producing duplicate jobs — Task 3.
- A 429 retry honors a delay and never processes two receipt scans concurrently — Task 3.
- A merge must preserve all user-maintained Actual transaction fields — Task 2.
- A 30-day cleanup never removes still-needed structured audit data — Task 3.

---

## File Structure

- Create `review-inbox.mjs` — private durable review records, candidate ranking, and receipt job lifecycle.
- Create `receipt-review-queue.mjs` — one-lane OCR worker, retry/restart handling, and image retention cleanup.
- Modify `actual-web.mjs` — explicit review resolution operations against Actual.
- Modify `plaid-sync.mjs` — stage posted rows before cursor advancement; record removed/modified events.
- Modify `web.mjs` — wire persistent review state and receipt worker lifecycle.
- Modify `web-app.mjs` — expose review list, receipt upload, and resolution calls.
- Modify `web-server.mjs` — authenticated review APIs, multi-file receipt upload, authenticated image preview, and `/reviews` history fallback.
- Modify `frontend/src/lib/router.js`, `frontend/src/App.svelte`, and `frontend/src/app.css` — routable Reviews page, filters, bulk/row actions, receipt upload and preview.
- Create/modify `test/review-inbox.test.mjs`, `test/receipt-review-queue.test.mjs`, `test/actual-web.test.mjs`, `test/plaid-sync.test.mjs`, `test/web-app.test.mjs`, `test/web-server.test.mjs`, and router/frontend tests — behavior coverage.

### Task 1: Durable review records and candidate matcher

**Files:**
- Create: `review-inbox.mjs`
- Test: `test/review-inbox.test.mjs`

**Interfaces:**
- Produces `createReviewInbox({ filePath, receiptDir, now })` with `stagePlaid(rows)`, `list(filters)`, `stageReceipt(file)`, `completeReceipt(id, extraction)`, `retryReceipt(id, error, nextAt)`, `resolve(id, decision)`, and `cleanup()`.
- Produces review rows with stable IDs, source/status, normalized candidates/evidence, and immutable decision audit entries.

- [ ] **Step 1: Write failing matcher and persistence tests**

Assert that same signed cents plus nearby date and normalized merchant ranks a candidate even when the Actual candidate has a different `imported_id`; assert identical Plaid IDs are skipped; assert staging the same bank row is idempotent after an inbox reload.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review-inbox.test.mjs`
Expected: FAIL because `review-inbox.mjs` does not exist.

- [ ] **Step 3: Implement the minimal private JSON inbox**

Use atomic mode-`0600` JSON writes, a content-hash receipt identity, and pure candidate ranking. Keep `list` filtering/sorting in the server-side module so the page does not need all history.

- [ ] **Step 4: Run focused test to verify it passes**

Run: `node --test test/review-inbox.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add review-inbox.mjs test/review-inbox.test.mjs
git commit -m "feat: persist import reviews"
```

### Task 2: Apply explicit review decisions to Actual

**Files:**
- Modify: `actual-web.mjs`
- Modify: `test/actual-web.test.mjs`

**Interfaces:**
- Consumes review rows with `{ id, importedId, accountId, date, amountCents, merchant, resolution }`.
- Produces `actual.applyReview(review)` returning `{ status, transactionId }` for `merge`, `import`, and `ignore`.

- [ ] **Step 1: Write failing Actual-resolution tests**

Assert Merge writes only `imported_id` and `cleared: true` to the chosen existing transaction; Import creates an uncategorized transaction with its Plaid ID; Ignore produces no Actual write.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/actual-web.test.mjs`
Expected: FAIL because `applyReview` is unavailable.

- [ ] **Step 3: Implement `applyReview(review)` under `runExclusive`**

Validate the staged row and target. Preserve transaction merchant, date, amount, category, notes, and splits on merge. Do not retain the old default-category import path for staged Plaid rows.

- [ ] **Step 4: Run focused test to verify it passes**

Run: `node --test test/actual-web.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add actual-web.mjs test/actual-web.test.mjs
git commit -m "feat: apply reviewed imports explicitly"
```

### Task 3: Durable receipt OCR worker and 30-day retention

**Files:**
- Create: `receipt-review-queue.mjs`
- Create: `test/receipt-review-queue.test.mjs`
- Modify: `review-inbox.mjs`
- Modify: `test/review-inbox.test.mjs`

**Interfaces:**
- Consumes `{ inbox, extractor, now, minIntervalMs: 20000 }`.
- Produces `createReceiptReviewQueue(...).enqueue(files)`, `list()`, `run()`, `retry(id)`, `getImage(id)`, `cleanup()`, and `close()`.

- [ ] **Step 1: Write failing receipt worker tests**

Assert queued files survive a new queue instance, one worker processes in upload order, a temporary/429 error records retry state and delay, processing state becomes retry on restart, duplicate content is not queued twice, and 30-day cleanup removes bytes but preserves review/audit metadata.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/receipt-review-queue.test.mjs test/review-inbox.test.mjs`
Expected: FAIL because the receipt worker is unavailable.

- [ ] **Step 3: Implement the one-lane worker**

Persist raw image files in the inbox receipt directory at `0600`; interpret existing temporary OCR failures and `Retry-After` as retryable; wait at least 20 seconds between starts; persist every transition before/after extraction. On a successful extraction, call the inbox matcher with unsigned receipt values and attach candidate evidence.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test test/receipt-review-queue.test.mjs test/review-inbox.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add review-inbox.mjs receipt-review-queue.mjs test/review-inbox.test.mjs test/receipt-review-queue.test.mjs
git commit -m "feat: queue receipt reviews"
```

### Task 4: Stage Plaid syncs and expose review APIs

**Files:**
- Modify: `plaid-sync.mjs`
- Modify: `web.mjs`
- Modify: `web-app.mjs`
- Modify: `web-server.mjs`
- Modify: `test/plaid-sync.test.mjs`
- Modify: `test/web-app.test.mjs`
- Modify: `test/web-server.test.mjs`

**Interfaces:**
- `createPlaidSync` consumes `stageReviews(rows)` instead of direct `importTransactions(rows)`.
- `createWebApplication` exposes `reviews`, `reviewResolve`, `reviewUpload`, `reviewRetry`, and `reviewImage`.
- Authenticated API paths: `GET /api/reviews`, `POST /api/reviews/resolve`, `POST /api/reviews/receipts`, `POST /api/reviews/:id/retry`, `GET /api/reviews/:id/image`.

- [ ] **Step 1: Write failing transport and Plaid staging tests**

Assert a Plaid sync invokes durable staging before the cursor is persisted; assert a staging failure leaves the cursor unchanged; assert review endpoints require the existing session/CSRF protection; assert image fetch is authenticated and not static.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/plaid-sync.test.mjs test/web-app.test.mjs test/web-server.test.mjs`
Expected: FAIL because staging APIs and handlers are unavailable.

- [ ] **Step 3: Implement minimal wiring and multi-file parsing**

Replace immediate Plaid import wiring with staging. Add bounded multi-file multipart parsing (per-file 10 MB, batch 50 files/50 MB), strict image MIME validation, review resolution through the Actual lock, private-image response headers, and worker startup/cleanup from `web.mjs`.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test test/plaid-sync.test.mjs test/web-app.test.mjs test/web-server.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plaid-sync.mjs web.mjs web-app.mjs web-server.mjs test/plaid-sync.test.mjs test/web-app.test.mjs test/web-server.test.mjs
git commit -m "feat: stage Plaid and receipt reviews"
```

### Task 5: Routable Reviews inbox page

**Files:**
- Modify: `frontend/src/lib/router.js`
- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/app.css`
- Modify: frontend/router tests

**Interfaces:**
- Route/view: `reviews` at `/reviews`.
- Consumes the review API list and mutation responses from Task 4.

- [ ] **Step 1: Write failing route and UI behavior tests**

Assert `/reviews` survives direct load/back-forward routing, navigation exposes Reviews, the default list is Open, each requested column has a sort/filter control, and row actions cannot be applied without explicit confirmation.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="review|router"`
Expected: FAIL because `reviews` is not a route/view.

- [ ] **Step 3: Implement the table using existing UI patterns**

Add multi-image upload, queue counts/status, source/status filters, column filtering/sorting, expandable match evidence, authenticated receipt preview, row actions, selection, and one explicit Apply confirmation. Keep Completed available as a filter and preserve the responsive table behavior.

- [ ] **Step 4: Run focused UI tests and build**

Run: `npm test -- --test-name-pattern="review|router" && npm run build`
Expected: PASS and successful Vite build.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/router.js frontend/src/App.svelte frontend/src/app.css frontend/src/**/*.test.*
git commit -m "feat: add reviews inbox"
```

### Task 6: Full regression verification and deployment review

**Files:**
- Modify: any files required by verified fixes only.

- [ ] **Step 1: Run full test suite and production build**

Run: `npm test && npm run build`
Expected: all tests pass and build succeeds.

- [ ] **Step 2: Review the final diff against the spec**

Confirm staged-before-cursor behavior, explicit-only Actual writes, review audit retention, 30-day source-image removal, authenticated image serving, and mobile/route coverage.

- [ ] **Step 3: Commit verified fixes, if any**

```bash
git add <verified-files>
git commit -m "fix: complete reviews inbox"
```
