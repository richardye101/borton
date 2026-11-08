# Historical Review Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface previously direct-imported Plaid transactions as verified historical records in Completed Reviews.

**Architecture:** Plaid fetches mapped historical rows without changing its sync cursor. Actual resolves only same-account `imported_id` matches. The review inbox persists verified matches as completed audit records, exposed by a protected API and a Completed-view action.

**Tech Stack:** Node.js, Actual API adapter, Plaid Transactions API, Svelte, node:test.

**Spec:** `docs/superpowers/specs/2026-11-08-historical-review-audit-design.md`

## Global Constraints

- Never write to Actual while auditing history.
- Include only mapped Plaid accounts and existing Actual `imported_id` matches.
- Preserve existing review rows.

## Review Focus

- A historical Plaid row with no Actual import ID is ignored.
- A matching row from a different Actual account is ignored.
- Re-running the audit is idempotent.
- Plaid pagination does not drop mapped transactions.
- Open reviews remain Open after an audit.

### Task 1: Read historical Plaid rows and verify Actual matches

**Files:**
- Modify: `plaid-sync.mjs`, `actual-web.mjs`, `review-service.mjs`
- Test: `test/plaid-sync.test.mjs`, `test/review-service.test.mjs`

- [x] Write failing tests for mapped, paginated Plaid history and same-account imported-ID matching.
- [x] Run the targeted tests and verify they fail because the audit APIs do not exist.
- [x] Implement `plaid.history()`, `actual.importedMatches(rows)`, and `reviews.auditHistoricalImports()`.
- [x] Run targeted tests and verify they pass.

### Task 2: Persist and expose completed audit records

**Files:**
- Modify: `review-inbox.mjs`, `web-app.mjs`, `web-server.mjs`
- Test: `test/review-inbox.test.mjs`, `test/web-app.test.mjs`, `test/web-server.test.mjs`

- [x] Write failing tests for idempotent completed audit rows and the protected audit endpoint.
- [x] Run targeted tests and verify they fail.
- [x] Implement inbox persistence and `POST /api/reviews/audit-history`.
- [x] Run targeted tests and verify they pass.

### Task 3: Make historical records discoverable in Reviews

**Files:**
- Modify: `frontend/src/App.svelte`, `test/frontend-api.test.mjs`

- [ ] Write a failing source-level test for the Completed review control and audit action.
- [ ] Run the test and verify it fails.
- [ ] Add a completed-view audit button with a concise result message.
- [ ] Run `npm run build` and `npm test` and verify they pass.
