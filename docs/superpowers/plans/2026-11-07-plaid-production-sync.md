# Plaid Production Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner connect Canadian Plaid accounts, map them to Actual accounts, and safely import posted transactions.

**Architecture:** A small server-only Plaid module calls Link and Transactions Sync with native `fetch`, encrypting each access token before writing local state. The existing Actual adapter owns idempotent transaction writes behind its lock; the web app, server, and Svelte UI expose a compact Connections screen.

**Tech Stack:** Node.js native `fetch`/`crypto`, Svelte 5, Actual API, Node test runner.

**Spec:** `docs/superpowers/specs/2026-11-07-plaid-production-sync-design.md`

## Global Constraints

- Use production Plaid Link and Transactions Sync for `CA`; no Plaid SDK.
- Keep Plaid secrets and access tokens server-only; encrypt stored tokens with AES-256-GCM.
- Require explicit, unique Actual account mapping before importing.
- Import only posted transactions, using Plaid IDs as Actual `imported_id` values.
- Preserve user notes/categories on Plaid modifications and never delete Actual entries for Plaid removals.

## Review Focus

- Missing credentials must leave Connections usable but clearly unavailable; test in Task 1.
- A failed later Sync page must not advance the stored cursor; test in Task 2.
- Mapping one Actual account twice must fail before any import; test in Task 2.
- API responses must never contain a token or secret; test in Task 4.
- Imported amounts must retain correct sign and cent rounding; test in Task 3.

### Task 1: Server-only Plaid state and Link lifecycle

**Files:**
- Create: `plaid-sync.mjs`
- Test: `test/plaid-sync.test.mjs`

**Interfaces:**
- Produces `createPlaidSync(options)` with `connections`, `linkToken`, `complete`, `setMappings`, `sync`, `reconnectToken`, `disconnect`, and `syncHealthy`.

- [ ] Write tests for unavailable configuration, encrypted persisted access tokens, Link token construction, and server-side public-token exchange.
- [ ] Run `node --test test/plaid-sync.test.mjs` and verify the tests fail because the module is absent.
- [ ] Implement the minimal Plaid client and encrypted JSON state with native `crypto` and `fetch`.
- [ ] Run `node --test test/plaid-sync.test.mjs` and verify it passes.

### Task 2: Mapping validation and cursor-safe Transactions Sync

**Files:**
- Modify: `plaid-sync.mjs`
- Modify: `test/plaid-sync.test.mjs`

**Interfaces:**
- Consumes an `importTransactions(rows)` function supplied by the Actual adapter.
- Produces normalized posted transaction rows and only advances a cursor after every page imports.

- [ ] Write failing tests for mapping validation, paged sync, cursor failure safety, and skipped pending transactions.
- [ ] Run the focused Plaid tests and verify they fail.
- [ ] Implement mapping and Sync pagination, preserving cursor/state semantics from the spec.
- [ ] Run the focused Plaid tests and verify they pass.

### Task 3: Idempotent Actual import

**Files:**
- Modify: `actual-web.mjs`
- Modify: `test/actual-web.test.mjs`

**Interfaces:**
- Produces `actual.importTransactions(rows)` that writes through `runExclusive`.

- [ ] Write failing tests for imported-ID deduplication, sign/cents values, and modification rules.
- [ ] Run `node --test test/actual-web.test.mjs` and verify they fail.
- [ ] Implement the smallest locked import path using existing payee/account/category helpers.
- [ ] Run the focused Actual tests and verify they pass.

### Task 4: Application and authenticated API endpoints

**Files:**
- Modify: `web-app.mjs`
- Modify: `web-server.mjs`
- Modify: `web.mjs`
- Modify: `test/web-app.test.mjs`
- Modify: `test/web-server.test.mjs`

**Interfaces:**
- Adds `/api/plaid/*` authenticated endpoints and a 30-minute healthy-item timer.

- [ ] Write failing app/server tests for all Plaid endpoint delegation, CSRF, dynamic connection IDs, safe responses, and `/connections` routing.
- [ ] Run focused web tests and verify they fail.
- [ ] Wire the module into app/server/startup, including constrained Plaid CSP and interval shutdown.
- [ ] Run focused web tests and verify they pass.

### Task 5: Connections UI and navigation

**Files:**
- Modify: `frontend/src/lib/router.js`
- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/app.css`
- Modify: `test/frontend-api.test.mjs`

**Interfaces:**
- Adds the `/connections` route and a private screen for connection, mapping, sync, reconnect, and removal.

- [ ] Write failing route/client-source tests for Connections and lazy Plaid Link loading.
- [ ] Run focused frontend tests and verify they fail.
- [ ] Implement the compact page and load Plaid’s vendor script only at connection time.
- [ ] Run focused frontend tests and `npm run build`; verify both pass.

### Task 6: Full verification and deploy

**Files:**
- Modify: relevant changed source, test, and documentation files only.

- [ ] Run `npm test`, `npm run build`, and `git diff --check`; resolve failures.
- [ ] Commit the feature without `.superpowers/`.
- [ ] Push, deploy to `actualbot`, rebuild, restart `borton-web`, and confirm it is active.
