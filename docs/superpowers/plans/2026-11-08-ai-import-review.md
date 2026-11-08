# AI-assisted imported-transaction review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every new Plaid transaction in Reviews until the owner confirms an editable AI-suggested category and note.

**Architecture:** Persist suggestion status and results on each existing review row, and use one small worker to process queued Plaid rows serially. The worker receives an injected category suggestion function; the runtime adapts the existing structured Gemini generator. Review resolution validates the final user-selected category and note, then writes them only for an explicit `import` decision.

**Tech Stack:** Node.js ESM, Actual Budget API, existing Gemini structured JSON generator, Svelte.

**Spec:** `docs/superpowers/specs/2026-11-08-ai-import-review-design.md`

## Global Constraints

- New Plaid transactions must not write to Actual before an explicit review decision.
- Suggestions must be existing, non-income Actual category names only; never create categories.
- Suggestions are private review metadata, never an automatic Actual category write.
- Persist queue state, retries, and results across restarts; serialize requests and back off transient provider failures.
- Preserve merge and ignore behavior; neither changes an existing Actual transaction's category or note.
- Do not alter historical imports already in Actual.

## Approved exception

- The owner approved one migration that clears only the `Tuition` category from existing Actual transactions that have an `imported_id`, then stages them for AI-assisted review. It must not delete transactions or touch manually entered Tuition expenses.

## Review Focus

- Unknown or hallucinated category name: record no suggestion and leave manual selection available (Task 1).
- Restart while a suggestion is processing: recover it as queued without losing the review item (Task 1).
- Transient model 429/5xx: retry later, never lose or import the row (Task 1).
- Tampered category ID or closed account at confirmation: reject server-side before Actual write (Task 2).
- Merge action with category/note fields supplied: do not update the matched Actual transaction (Task 2).

---

### Task 1: Durable category suggestion worker

**Files:**
- Create: `category-suggestion-queue.mjs`
- Modify: `review-inbox.mjs`
- Test: `test/category-suggestion-queue.test.mjs`
- Test: `test/review-inbox.test.mjs`

**Interfaces:**
- Produces `createCategorySuggestionQueue({ inbox, suggest, categories, now, minIntervalMs, autoStart })` with `enqueue(rows)`, `close()`, and restart recovery.
- Produces inbox methods `queueSuggestion(id)`, `completeSuggestion(id, suggestion)`, `retrySuggestion(id, error, nextAt)`, `failSuggestion(id, error)`, and `queuedSuggestions()`.
- Extends staged Plaid review rows with `suggestion: { status: 'queued'|'processing'|'ready'|'retrying'|'failed', categoryId?, category?, confidence?, reason?, attempts?, nextAt?, lastError? }`.

- [ ] **Step 1: Write failing inbox and queue tests**

```js
test('stages a Plaid row with durable queued suggestion metadata', () => {
  const row = inbox.stagePlaid([plaidRow]).rows[0];
  assert.equal(row.suggestion.status, 'queued');
});

test('suggests one valid existing category and recovers interrupted work', async () => {
  const queue = createCategorySuggestionQueue({ inbox, categories: async () => [{ id: 'food', name: 'Food' }], suggest: async () => ({ category: 'Food', confidence: 'high', reason: 'restaurant' }) });
  await queue.enqueue([row]);
  assert.equal(inbox.get(row.id).suggestion.categoryId, 'food');
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --test test/review-inbox.test.mjs test/category-suggestion-queue.test.mjs`

Expected: FAIL because the suggestion state and worker do not exist.

- [ ] **Step 3: Implement the inbox state and `createCategorySuggestionQueue`**

Use the existing inbox file for durable state, one in-process worker, and the receipt queue's serial/retry pattern. Validate the provider's category against the live allowed category list before writing `ready`; unknown names become a non-blocking failed/unavailable suggestion.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test test/review-inbox.test.mjs test/category-suggestion-queue.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add review-inbox.mjs category-suggestion-queue.mjs test/review-inbox.test.mjs test/category-suggestion-queue.test.mjs
git commit -m "feat: queue AI category suggestions for imports"
```

### Task 2: Confirmed import writes the chosen category and note

**Files:**
- Modify: `review-service.mjs`
- Modify: `actual-web.mjs`
- Test: `test/review-service.test.mjs`
- Test: `test/actual-web.test.mjs`

**Interfaces:**
- Consumes Task 1's suggestion queue through `createReviewService({ actual, inbox, categorySuggestions })`.
- `resolve({ id, resolution: { action, categoryId?, note?, transactionId? } })` queues no further write for merge/ignore and sends selected fields to `actual.applyReview` only for import.
- `actual.applyReview(review)` accepts `resolution.categoryId` and `resolution.note` for `action: 'import'`.

- [ ] **Step 1: Write failing service and Actual adapter tests**

```js
test('imports a reviewed Plaid transaction with the owner-selected category and note', async () => {
  await reviews.resolve({ id: row.id, resolution: { action: 'import', categoryId: 'food', note: 'Dinner with Tia' } });
  assert.deepEqual(actual.calls[0].resolution, { action: 'import', categoryId: 'food', note: 'Dinner with Tia' });
});

test('does not modify category or note when resolving a merge', async () => {
  await actual.applyReview({ ...row, resolution: { action: 'merge', transactionId: 'existing', categoryId: 'food', note: 'ignore me' } });
  assert.equal(update.calls[0].category, undefined);
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --test test/review-service.test.mjs test/actual-web.test.mjs`

Expected: FAIL because category/note review fields are not validated or written.

- [ ] **Step 3: Wire staging and explicit import resolution**

Queue only newly staged Plaid rows. For import, validate the current category and account inside `actual.applyReview`, add the category and trimmed note to the Actual transaction, then complete the review. Merge and ignore must discard supplied edit fields.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test test/review-service.test.mjs test/actual-web.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add review-service.mjs actual-web.mjs test/review-service.test.mjs test/actual-web.test.mjs
git commit -m "feat: apply reviewed categories to imported transactions"
```

### Task 3: Runtime classifier and review form

**Files:**
- Modify: `web.mjs`
- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/app.css`
- Test: `test/frontend-api.test.mjs`
- Test: `test/web-app.test.mjs`

**Interfaces:**
- Consumes Task 1's `categorySuggestions` queue and Task 2's review resolution shape.
- The runtime category callback calls the existing structured Gemini generator with merchant, date, amount, account/institution, and the currently permitted category names.
- The Reviews expanded Plaid row sends `{ action: 'import', categoryId, note }` only after the owner submits it.

- [ ] **Step 1: Write failing UI and runtime wiring tests**

```js
test('shows a staged AI suggestion and lets the owner choose category and note before import', async () => {
  assert.match(app, /Suggested category/);
  assert.match(app, /Import with changes/);
  assert.match(app, /resolution: \{ action: 'import', categoryId/);
});

test('wires a category suggestion queue without making a direct Actual import call', () => {
  assert.match(source, /createCategorySuggestionQueue/);
  assert.match(source, /reviews\.stagePlaid/);
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --test test/frontend-api.test.mjs test/web-app.test.mjs`

Expected: FAIL because the review form and runtime queue wiring do not exist.

- [ ] **Step 3: Implement the category prompt, wire the worker, and add the review form**

Use the existing `generate` helper and JSON schema; do not add a new provider or dependency. Give pending/failed suggestion status clear UI copy, prefill the picker only from a valid suggestion, and keep a manual category choice possible in all states.

- [ ] **Step 4: Run focused tests and production build**

Run: `node --test test/frontend-api.test.mjs test/web-app.test.mjs && npm run build`

Expected: PASS and a clean production build.

- [ ] **Step 5: Commit**

```bash
git add web.mjs frontend/src/App.svelte frontend/src/app.css test/frontend-api.test.mjs test/web-app.test.mjs
git commit -m "feat: review AI suggestions before importing"
```

### Task 4: Reset approved legacy imported Tuition records into review

**Files:**
- Modify: `actual-web.mjs`
- Modify: `review-inbox.mjs`
- Modify: `review-service.mjs`
- Modify: `web-app.mjs`
- Modify: `web-server.mjs`
- Test: `test/actual-web.test.mjs`
- Test: `test/review-service.test.mjs`
- Test: `test/web-server.test.mjs`

**Interfaces:**
- `actual.resetImportedTuitionCategory()` finds only transactions with both `imported_id` and the current Tuition category, clears category IDs, and returns normalized transaction metadata.
- `inbox.stageLegacyImports(rows)` creates open review rows linked to existing Actual transaction IDs.
- `reviews.resetImportedTuitionCategory()` clears, stages, and enqueues each affected legacy row.
- `POST /api/reviews/reset-imported-tuition` performs the owner-approved migration.

- [ ] **Step 1: Write failing tests for the approved migration**

```js
test('clears only imported Tuition transactions and preserves all other fields', async () => {
  const migrated = await actual.resetImportedTuitionCategory();
  assert.deepEqual(api.writes, [{ id: 'plaid-tuition', fields: { category: null } }]);
  assert.equal(migrated.rows[0].merchant, 'Metrolinx');
});

test('stages cleared legacy imports for review without deleting them', async () => {
  const result = await reviews.resetImportedTuitionCategory();
  assert.equal(result.staged, 1);
  assert.equal(inbox.list({ status: 'open' })[0].source, 'legacy_import');
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --test test/actual-web.test.mjs test/review-service.test.mjs test/web-server.test.mjs`

Expected: FAIL because the migration and protected endpoint do not exist.

- [ ] **Step 3: Implement the narrow reset and staging endpoint**

Look up the live Tuition category ID from Actual, limit writes to rows with `imported_id`, clear only Tuition category fields (including split children where applicable), and return/stage metadata after sync. Reuse the Task 1 suggestion queue for legacy rows. Do not expose a general category-clearing endpoint.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --test test/actual-web.test.mjs test/review-service.test.mjs test/web-server.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add actual-web.mjs review-inbox.mjs review-service.mjs web-app.mjs web-server.mjs test/actual-web.test.mjs test/review-service.test.mjs test/web-server.test.mjs
git commit -m "feat: reset imported tuition records for review"
```

## Self-review

- Spec coverage: Tasks 1–4 cover durable serial suggestions, no pre-review Actual writes, editable confirmation, UI states, and the explicitly approved legacy Tuition reset.
- Type consistency: Task 1 produces `categorySuggestions`; Task 2 consumes it for staging; Task 3 constructs it and binds the UI to Task 2's `resolution` shape; Task 4 reuses the same queue for legacy imports.
- Review focus: Each listed failure mode has a test in its owning task.
- Proportion: Three independent, testable tasks; no new provider, database, or category-management abstraction.
