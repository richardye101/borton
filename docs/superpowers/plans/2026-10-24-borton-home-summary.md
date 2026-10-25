# Borton Home and Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Borton a private, responsive expense workspace with trusted WireGuard entry, a Home quick-add workflow, a cached drill-down Summary, and an always-available Chat.

**Architecture:** Preserve the Node HTTP server and Actual service. Add an exact-source trusted-session path, richer read-only summary/transaction queries, and compose the new layout in the existing vanilla JavaScript client. Financial writes continue through existing batch validation and submission.

**Tech Stack:** Node.js ESM, `node:test`, `@actual-app/api`, vanilla HTML/CSS/JavaScript, systemd.

**Spec:** `docs/superpowers/specs/2026-10-24-borton-home-summary-design.md`

## Global Constraints

- The app remains private; only `web.allowedRemote` reaches the server.
- Automatic entry is limited to `10.88.111.5`, `10.88.111.7`, `10.0.0.3`, and `10.0.0.4` through `web.trustedAutoLoginRemote`.
- Trusted and password sessions are sliding 30-day HttpOnly, SameSite=Strict cookies.
- Use `America/Toronto` for default and period dates.
- Keep all expense writes on `validateBatch` and `submitBatch`.
- All-time summaries include open and closed on-budget accounts and must not silently cap aggregation.

## Review Focus

- A trusted-session request from `10.88.111.44` must still require a password; test exact-source matching in Task 1.
- A stale summary cache must be cleared after quick-add or receipt submission; test cache invalidation in Task 3.
- All-time totals must include closed-account expense history; test it in Task 2.
- Drill-down totals must use IDs and date boundaries, not ambiguous display names; test category/account/month filters in Task 2.
- A quick add that matches an existing expense must stop for acknowledgement before any write; test it in Task 3.

---

### Task 1: Trusted WireGuard sessions

**Files:**
- Modify: `web-auth.mjs`
- Modify: `web-server.mjs`
- Modify: `web.mjs`, `config.example.json`
- Test: `test/web-auth.test.mjs`, `test/web-server.test.mjs`

**Interfaces:**
- Produces `auth.trustedLogin()` with a 30-day sliding session.
- Produces unauthenticated `GET /api/session` that succeeds only for `trustedAutoLoginRemote`.

- [ ] **Step 1: Write failing trusted-session tests**

Add tests asserting a configured trusted address receives a session/CSRF response, an allowed but untrusted address receives 401, and password sessions carry a 30-day max age.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/web-auth.test.mjs test/web-server.test.mjs`

- [ ] **Step 3: Add exact-source trusted login and server dispatch**

Add `trustedRemotes` to `createWebServer`, handle `GET /api/session` before the existing `/api` session guard, and wire `web.trustedAutoLoginRemote` from configuration.

- [ ] **Step 4: Run trusted-session tests to verify they pass**

Run: `node --test test/web-auth.test.mjs test/web-server.test.mjs`

- [ ] **Step 5: Commit**

`git commit -m "feat: add trusted WireGuard sessions"`

### Task 2: Summary ranges and drill-down queries

**Files:**
- Modify: `actual-web.mjs`, `web-app.mjs`, `web-server.mjs`
- Test: `test/actual-web.test.mjs`, `test/web-server.test.mjs`

**Interfaces:**
- `summary({ period, force })` returns period metadata and group rows containing stable filters.
- `findTransactions({ start, end, categoryId, accountId, offset, limit, query })` returns a page and total count.

- [ ] **Step 1: Write failing summary/query tests**

Cover all-time closed-account inclusion, Toronto-derived period boundaries, category/account/month stable filters, and a paginated detail response.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/actual-web.test.mjs test/web-server.test.mjs`

- [ ] **Step 3: Implement range, aggregation, and filtered paging**

Use IDs for category/account groups, explicit start/end for month groups, and avoid the display limit for aggregation. Keep regular Recent queries capped and paged.

- [ ] **Step 4: Run summary/query tests to verify they pass**

Run: `node --test test/actual-web.test.mjs test/web-server.test.mjs`

- [ ] **Step 5: Commit**

`git commit -m "feat: add Summary drill-down queries"`

### Task 3: Responsive Home, Summary cache, quick add, and Chat

**Files:**
- Modify: `web/index.html`, `web/app.js`, `web/app.css`
- Test: `test/web-app.test.mjs` or focused browser-client coverage if added

**Interfaces:**
- Client cache keyed by `30`, `90`, `365`, and `all`; successful writes clear it.
- Quick add produces a one-row existing batch submission flow.
- Chat is a header bubble/overlay and Check an expense can prefill it with a duplicate-check request.

- [ ] **Step 1: Add a failing client-level test or minimal testable helper coverage**

Cover cache reuse versus forced refresh, cache invalidation after a complete submit response, and a duplicate-blocked quick add.

- [ ] **Step 2: Implement desktop/mobile navigation and amount masking**

Render desktop View/Actions rail, mobile View tabs plus Actions section, header Chat bubble, and a persisted display-only amount masking control.

- [ ] **Step 3: Implement Home and Summary behavior**

Make Home default, add the two-row quick-add form, cache Summary period responses, render clickable groups and detail pages, and add explicit Refresh.

- [ ] **Step 4: Implement Check an expense and Chat handoff**

Prioritize upload/extraction and editable duplicate review; keep manual fields collapsible and route incomplete text into the Chat overlay.

- [ ] **Step 5: Run client and full service tests**

Run: `npm test && node tools/test_agent.mjs && node --check web/app.js`

- [ ] **Step 6: Commit**

`git commit -m "feat: redesign Borton home workspace"`

### Task 4: Deploy configuration and production verification

**Files:**
- Modify: `README.md`, `config.example.json`, deployment configuration on `actualbot`

- [ ] **Step 1: Document trusted source configuration and Home/Summary workflows**

- [ ] **Step 2: Deploy the merged main branch with `trustedAutoLoginRemote` set to the four approved addresses**

- [ ] **Step 3: Verify services and private API behavior**

Run on the LXC: `systemctl is-active receipt-bot borton-web`, password fallback from an untrusted allowed address, and trusted session/summary requests from configured source addresses where reachable.

- [ ] **Step 4: Commit documentation**

`git commit -m "docs: document Borton trusted access"`

## Self-review

- All approved design requirements map to Tasks 1–4.
- Trusted access, all-time data, drill-down identity/paging, cache invalidation, and duplicate-safe quick add have explicit test coverage.
- Summary aggregation and detail display are separate interfaces so normal Recent loading remains bounded.
- The plan keeps browser work in the existing client instead of introducing a framework or new deployment service.
