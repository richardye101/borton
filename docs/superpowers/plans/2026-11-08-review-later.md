# Review Later Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flag an existing transaction for follow-up and manage it from Reviews without altering the Actual transaction.

**Architecture:** Persist `manual` review rows in the existing inbox, linked by transaction ID and carrying an optional note. Expose one small API endpoint and reuse Reviews' transaction detail and completion mechanics.

**Tech Stack:** Node.js, existing review inbox/service/web server, Svelte.

**Spec:** `docs/superpowers/specs/2026-11-08-review-later-design.md`

## Global Constraints

- Use the existing persisted review inbox; add no dependencies.
- Flagging and clearing a review must not edit the Actual transaction.

## Review Focus

- A transaction cannot accumulate duplicate open Review later entries.
- A review-later entry survives reloading the persisted inbox.
- Completing an open review removes it from the open Reviews list but preserves its history.
- The optional reminder is visible in the Reviews detail.
- Existing Plaid and receipt review behavior remains unchanged.

### Task 1: Persist linked review-later records

**Files:**
- Modify: `review-inbox.mjs`, `review-service.mjs`
- Test: `test/review-inbox.test.mjs`, `test/review-service.test.mjs`

**Interfaces:**
- Produces: `inbox.stageManual({ transactionId, date, merchant, account, amountCents, note })` and `reviews.stageManual(payload)`.

- [ ] **Step 1: Write failing tests** for persistence, duplicate-open suppression, and completed resolution.
- [ ] **Step 2: Run the focused tests** and confirm they fail because `stageManual` is missing.
- [ ] **Step 3: Implement** the minimal `manual` inbox/service path.
- [ ] **Step 4: Run focused tests** and confirm they pass.
- [ ] **Step 5: Commit** the backend review-later support.

### Task 2: Expose and render review-later

**Files:**
- Modify: `web-app.mjs`, `web-server.mjs`, `frontend/src/App.svelte`, `frontend/src/app.css`
- Test: `test/web-app.test.mjs`, `test/web-server.test.mjs`, `test/frontend-api.test.mjs`

**Interfaces:**
- Consumes: `reviews.stageManual(payload)`.
- Produces: `POST /api/reviews/later` and an accessible Home/Summary action that stages it.

- [ ] **Step 1: Write failing tests** for the web endpoint and the UI action/detail reminder.
- [ ] **Step 2: Run focused tests** and confirm they fail because the endpoint/action is missing.
- [ ] **Step 3: Implement** the endpoint and minimal inline prompt/action.
- [ ] **Step 4: Run focused tests** and confirm they pass.
- [ ] **Step 5: Commit** the user-facing flow.

### Task 3: Verify and deploy

**Files:**
- Modify: none

- [ ] **Step 1: Run** `npm test` and `npm run build`.
- [ ] **Step 2: Deploy** the merged main branch to the LXC and verify the live service.
