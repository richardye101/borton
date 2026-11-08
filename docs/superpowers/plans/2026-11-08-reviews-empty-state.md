# Reviews Empty State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty Reviews spreadsheet with an action-oriented inbox dashboard.

**Architecture:** Keep the existing `/reviews` route and APIs. The Svelte view will conditionally render a compact empty-state dashboard only when the current filtered review set is empty; the receipt uploader and Connections navigation are reused.

**Tech Stack:** Svelte, existing Borton CSS, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-08-reviews-empty-state-design.md`

## Global Constraints

- Reuse the existing route, receipt upload endpoint and Connections route; no new backend state or dependencies.
- Keep the empty state responsive and accessible.
- Do not imply a Plaid sync happened or write to Actual.

## Review Focus

- Open, Completed and All filters with no matching rows must show the dashboard rather than a blank table; covered by source-level UI test.
- Selecting a receipt from the empty state must use the existing batch uploader; covered by the established upload handler reference.
- The dashboard must disappear once a review row exists; covered by its `{#if filteredReviews().length}` branch.

---

### Task 1: Reviews empty-state dashboard

**Files:**
- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/app.css`
- Test: `test/frontend-api.test.mjs`

**Interfaces:**
- Consumes: `filteredReviews()`, `uploadReviewReceipts(event)`, and `show('connections')`.
- Produces: a dashboard when `filteredReviews()` is empty and the existing table otherwise.

- [ ] **Step 1: Write the failing source-level UI test**

Assert that `App.svelte` contains the `filteredReviews().length` empty branch, “All caught up,” a Connections navigation call, and the existing receipt upload handler.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/frontend-api.test.mjs`

- [ ] **Step 3: Render the empty-state dashboard and hide table controls until rows exist**

Keep the receipt input accessible and visually styled as a primary action; preserve the table unchanged for nonempty rows.

- [ ] **Step 4: Run build and tests**

Run: `npm run build && npm test`
Expected: build succeeds and all tests pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/App.svelte frontend/src/app.css test/frontend-api.test.mjs
git commit -m "feat: improve reviews empty state"
```
