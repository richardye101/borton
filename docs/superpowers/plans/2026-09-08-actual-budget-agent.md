# Actual Budget Agent Implementation Plan

**Goal:** Ship the approved conversational Actual agent through the existing Telegram bot.

**Architecture:** `actual-tools.mjs` exposes validated reads and staged writes. `agent.mjs` coordinates Gemini, persisted conversations and frozen confirmations. `bot.mjs` retains receipt workflows and routes remaining requests to the agent.

**Tech stack:** Node ESM, built-in fetch/fs/assert, `@actual-app/api` 26.8.1 (matched to the live server after the smoke test exposed a migration mismatch).

**Spec:** `docs/superpowers/specs/2026-09-08-actual-budget-agent-design.md`

## Global constraints

- Use the existing Paseo worktree; preserve uncommitted main-checkout split work.
- No new dependencies, financial writes in tests, separate code review, or review agents.
- Eight model rounds, 60-second reasoning deadline, 50-row results, 12 conversation messages.
- Every agent mutation requires one explicit confirmation of the complete plan.
- Plan lifetime: 24 hours. Retain the last 100 execution records and persist before executing.
- A process crash or uncertain write must never automatically replay a mutation.

## Task 1: Actual tool boundary

**Files:** Create `actual-tools.mjs`; test in `tools/test_agent.mjs`.

**Interfaces:** `createActualTools(api)` returns `{ declarations, read(name,args), prepare(name,args,previous), validate(operations), execute(operation,refs), sync() }`.

- [ ] Build a fake adapter and assert `prepare` creates no financial writes.
  ```js
  const op = await actual.prepare('propose_budget_change', { month:'2026-09', category:'food', amount:85000 }, []);
  assert.equal(writes.length, 0);
  await actual.validate([op]);
  await actual.execute(op, {});
  assert.equal(writes.length, 1);
  ```
- [ ] Define strict recursive schemas, stable ID resolution, exact date/integer-cent validation, bounded local aggregation, and normalized projections.
- [ ] Implement transaction/account/category/group/payee/budget/schedule/rule/tag/note/bank-sync proposals with snapshots, preview labels and typed references to staged creates.
- [ ] Re-read all snapshots before writes; reject changed targets, invalid cross-references and unsupported mixed effects before the first write.
- [ ] Exercise API signatures against the installed package and run `node tools/test_agent.mjs`.

## Task 2: Gemini loop and persistent execution

**Files:** Create `agent.mjs`; extend `tools/test_agent.mjs`.

**Interfaces:** `createAgent({tools,generate,statePath,allowedChatId,now})` returns `{ message(chatId,text), confirm(chatId,planId), cancel(chatId,planId), pending(chatId), remember(chatId,text) }`; responses are `{text,planId?}`.

- [ ] Script read → proposal → model answer and assert no writes before `confirm`.
  ```js
  const result = await agent.message(42, 'Increase groceries by $200');
  assert.ok(result.planId);
  assert.equal(writes.length, 0);
  await agent.confirm(42, result.planId);
  await agent.confirm(42, result.planId);
  assert.equal(writes.length, 1);
  ```
- [ ] Implement native Gemini function calling, preserve function-call IDs/signatures within a turn, validate arguments and cap rounds/time/output.
- [ ] Persist short conversation text, entity references and one pending plan atomically with mode 0600.
- [ ] Invalidate old confirmations on revision, freeze a deterministic preview, persist each execution step before invoking Actual, and retain exact partial results.
- [ ] Test cancellation, expiry, stale plans, concurrent/double confirmations, restart during execution, output minimization, invalid tools, timeout, and failed sync.

## Task 3: Telegram routing and regressions

**Files:** Modify `bot.mjs`, `README.md`, `config.example.json`; extend `tools/test_agent.mjs` and existing selftest.

- [ ] Guard expense parsing from questions/commands with numbers; preserve terse expenses and explicit receipt edits.
  ```js
  assert.equal(isAgentRequest('show groceries for August 2026'), true);
  assert.equal(isAgentRequest('12.50 starbucks on amex'), false);
  ```
- [ ] Route text and once-transcribed voice fallback to the same agent, with receipt reply context and pending-plan precedence.
- [ ] Render full deterministic plan in Telegram-sized chunks and put one Confirm/Cancel keyboard on the final chunk; bind callbacks to the authorized chat and plan ID.
- [ ] Serialize incoming mutations from Telegram and HTTP ingest, refresh Actual maps after agent writes, and bound network waits.
- [ ] Run offline agent tests and the existing receipt selftest using synthetic config/cardmap. Existing uncommitted multi-person split test belongs to main-checkout user work and must remain there.
- [ ] Document Actual control, single confirmation, scoped Gemini data, memory, partial-failure behavior and read-only smoke command.

## Task 4: Publish, deploy, verify

- [ ] Commit implementation after tests, fast-forward main preserving dirty user files via safety stash if required, then push.
- [ ] Verify clean tracked production files, fast-forward deployment and restart `receipt-bot`.
- [ ] Check exact deployed hash, service startup, and a live read-only Gemini/Actual agent smoke query. Do not create sample financial transactions.
- [ ] Report deployment/test result and preserve any conflicting user work and its backup.

Execution is inline in the existing worktree. The user approved the design and authorized the repo/deployment update; no additional planning approval is needed.

## Verification results

Tasks 1–3 implemented. Offline agent checks and the receipt selftest pass. Staging against the
live server verified budget/transaction reads, transaction proposal validation, a real Gemini
tool call returning the open-account count, and Gemini staging a complete plan with execution
disabled. No real budget mutations were executed by these checks.

Compatibility findings: Actual 26.6.0 cannot open the live 26.8.1 budget, so the API pin now
matches the server. `getCategories({hidden:true})` selects only hidden categories; the tool
layer combines visible/hidden queries, with a regression assertion.
