# Manual Shared Splits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support named equal, amount, and percentage transaction splits with correct shared balances.

**Architecture:** The Svelte edit panel collects a split mode and named shares. `actual-web.mjs` validates and converts those shares to cents, then rebuilds the original Actual transaction using the existing debt-account model.

**Tech Stack:** Svelte 5, Node.js, Actual Budget API, node:test.

**Spec:** `docs/superpowers/specs/2026-10-25-manual-shared-splits-design.md`

## Global Constraints

- Preserve current 50/50 behaviour as Equal mode.
- Do not add dependencies.
- Reject shares that exceed the source transaction amount.

## Review Focus

- Cent rounding for percentages: test that converted shares never exceed the total.
- Multiple named participants: test that each creates its own debt transfer.
- Owner-card expense: test that the user's selected share is recorded as money owed to the owner.
- Invalid or blank people: reject before deleting the original transaction.
- Existing simple equal split: preserve the one-person 50/50 result.

---

### Task 1: Manual split accounting

**Files:**
- Modify: `actual-web.mjs`
- Test: `test/actual-web.test.mjs`

**Interfaces:**
- Produces: `splitTransaction({ id, accountId, date, mode, shares })` where `shares` contains `{ person, value }`.

- [ ] Write failing tests for exact multi-person and percentage owner-card splits.
- [ ] Run the focused tests and confirm they fail because the endpoint only accepts one 50/50 person.
- [ ] Implement share validation and conversion, then rebuild the parent/debt transactions with the resulting cents.
- [ ] Run focused and complete test suites.
- [ ] Commit the accounting change.

### Task 2: Manual split editor

**Files:**
- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/app.css`

**Interfaces:**
- Consumes: Task 1's `mode` and `shares` endpoint contract.

- [ ] Add Equal, Amount, and % controls, participant rows, remaining amount, and owner-card share input to both inline tables.
- [ ] Preserve the compact copy: “You owe …” or “… owes you.”
- [ ] Build the production app and verify it compiles.
- [ ] Commit the editor change.
