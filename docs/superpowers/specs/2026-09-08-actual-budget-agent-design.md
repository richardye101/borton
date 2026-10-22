# Actual Budget conversational agent — design

## Context

The Telegram bot currently has reliable, purpose-built flows for receipt photos, spoken or typed
expenses, confirmation, editing, splitting, and deletion. Gemini extracts structured expense data;
the application—not the model—performs the Actual Budget writes.

The next step is a real tool-using agent: a user should be able to ask natural-language questions,
refer to earlier results, and request multi-step changes across the Actual budget. This design keeps
the existing expense paths intact and adds the agent only as the fallback for messages those paths do
not consume.

This design supersedes the unimplemented read-only query design in
`2026-06-23-queries-design.md`. Queries become one part of the broader agent tool surface.

## Goals

- Understand natural-language Actual Budget questions and commands in Telegram.
- Let Gemini choose and call allowlisted tools, inspect results, and continue for multiple rounds.
- Support the full user-facing control surface exposed by the installed `@actual-app/api` package:
  transactions, transfers, accounts, category groups/categories, payees, budgets, schedules, rules,
  tags, and bank sync.
- Execute reads immediately and require one explicit confirmation for an entire mutation plan.
- Preserve short per-chat context across process restarts.
- Send Gemini only the minimum Actual data needed to complete the current request.
- Preserve every existing receipt, photo, voice-expense, split, edit, and delete flow.

## Non-goals

- Arbitrary JavaScript, shell, SQL, or direct model access to the Actual API.
- Sending credentials, server URLs, sync IDs, filesystem paths, or the raw budget database to Gemini.
- Becoming a general-purpose web or life assistant; the agent is scoped to Actual Budget and
  explanations based on its data.
- Automatic rollback of a partially completed mixed-operation plan. Actual does not expose a single
  atomic transaction spanning all supported operation types.
- A new agent framework or SDK. The existing Gemini REST transport and `@actual-app/api` are enough.

## User experience

### Routing

The current deterministic handlers remain first in the routing order:

1. Telegram authorization, callbacks, pending confirmations, and pending field/card answers.
2. Receipt photos.
3. Voice transcription. A recognized expense continues through the current expense flow; otherwise
   its transcript becomes an agent message.
4. Typed expense parsing and existing commands.
5. Agent fallback for any remaining natural-language text.

The fallback must not reinterpret an expense after the existing flow has accepted it.

### Read example

For “How much did I spend on groceries last month compared with August?” the model may call a
category resolver and a local aggregation tool. The bot answers directly; there is no confirmation
because nothing changed.

### Write example

For “Move the five Costco charges from Household to Groceries and add $200 to September Groceries,”
the agent reads the matching records and current budget, then presents one plan:

```text
Ready to apply 6 changes:
• Re-categorize 5 Costco transactions ($412.18 total): Household → Groceries
• Set September Groceries budget: $650.00 → $850.00

⚠ This changes Actual Budget.
[Confirm] [Cancel]
```

The user may say “also clear those transactions” before confirming. The agent revises and replaces
the pending plan. Confirm executes that frozen plan once; Cancel discards it.

## Architecture

### `bot.mjs`

`bot.mjs` retains Telegram polling and all existing specialized flows. It adds only the fallback
entry points, agent confirmation callbacks, and Telegram rendering needed to connect the two new
modules.

### `agent.mjs`

This module owns:

- the Gemini function-calling loop;
- the system instruction and conversation trimming;
- per-chat history and pending plans;
- read-tool execution and write-tool staging;
- final answer and plan rendering data;
- persistence and single-use confirmation state.

The loop sends Gemini the user message, limited conversation context, tool declarations, and scoped
tool results. Gemini can make sequential tool calls until it returns a final response. The
application caps a turn at eight tool rounds and 60 seconds total. Parallel calls may be accepted for
independent reads; write proposals remain ordered.

Gemini function calling is used directly through the existing REST request helper. No agent library
or new runtime dependency is added.

### `actual-tools.mjs`

This module is the only agent-facing gateway to `@actual-app/api`. It exports tool declarations and a
dispatcher with two kinds of handlers:

- **Read handlers** execute against Actual and return normalized, size-limited results.
- **Mutation handlers** validate and stage operations; they never change Actual during the model
  loop.

The model cannot choose arbitrary API method names. Each declared tool maps to fixed application
code and a strict argument schema.

## Tool surface

The first version exposes a small domain-oriented tool set rather than one declaration per Actual API
method.

### Read tools

- `list_accounts`: open/closed and on/off-budget accounts, balances, and stable IDs.
- `list_categories`: category groups, categories, budget values, and stable IDs for a requested month.
- `list_payees`: matching payees and stable IDs.
- `find_transactions`: filtered transactions by date, account, payee, category, amount, text, cleared
  state, and limit.
- `get_budget`: category budgets and balances for one or more months.
- `list_schedules`, `list_rules`, and `list_tags`: normalized configuration records.
- `get_note`: a requested Actual note by stable note ID.
- `run_report`: local aggregations such as spending, income, cash flow, category totals, balances,
  and net worth. Raw rows remain local when an aggregate answers the question.

Read lists return at most 50 rows. If more match, the result says it was truncated so the model can
refine the query instead of receiving the full history.

### Mutation proposal tools

- `propose_transaction_changes`: create, transfer, update, delete, clear, or reconcile transactions.
- `propose_account_change`: create, update, close/reopen, or delete an account.
- `propose_category_change`: create, update, move, or delete a category or category group.
- `propose_payee_change`: create, update, or delete a payee.
- `propose_budget_change`: set budget amount or carryover for a category/month.
- `propose_schedule_change`: create, update, or delete a schedule.
- `propose_rule_change`: create, update, or delete a rule.
- `propose_tag_change`: create, update, or delete a tag.
- `propose_note_change`: update an Actual note by stable note ID.
- `propose_bank_sync`: run bank sync for selected or all eligible accounts.

Every proposal contains stable Actual IDs where available, human-readable before/after values, and
the minimum original snapshot needed for stale-data detection. Temporary references let later
operations in the same plan depend on earlier creates, such as creating a category and then budgeting
it.

## Agent loop and data flow

1. `bot.mjs` hands an unmatched message and its chat ID to `agent.mjs`.
2. `agent.mjs` loads the short chat history and pending plan, if any.
3. Gemini receives the system instruction, conversation, and tool schemas.
4. Read calls execute through `actual-tools.mjs`; their normalized results return to Gemini.
5. Mutation calls are validated and appended to a draft plan. They return a staged result to Gemini,
   not an Actual write result.
6. The loop ends with either a conversational answer or a complete mutation plan.
7. A plan is persisted before Telegram displays its Confirm/Cancel buttons.
8. Confirm revalidates the plan and executes it in deterministic order. Creates precede dependent
   updates, and destructive deletes run last.
9. The bot syncs once after successful execution and sends a result summary. Partial failures report
   completed and unexecuted operations separately.

Tool results are data, not instructions. The system instruction explicitly tells Gemini to ignore
commands embedded in payee names, notes, rules, tags, or any other tool result.

## Confirmation and execution safety

- Only `telegram.allowedChatId` can access the agent or confirm a plan.
- Every mutation, including bank sync, is staged. No mutation tool writes during reasoning.
- One confirmation covers the displayed plan. Any revision creates a new plan ID and invalidates the
  old buttons.
- Plans expire after 24 hours.
- Confirmation IDs are single-use. Repeated Telegram callback delivery returns the recorded result
  without executing again.
- Before the first write, every target is re-read and compared with its stored relevant fields. A
  changed or missing target rejects the whole plan and asks the agent to refresh it.
- All operation arguments and dependencies are prevalidated before execution starts.
- Destructive operations are labeled with `⚠` and name the affected object and known impact in the
  same single confirmation preview.
- Mixed Actual operations are sequential, not atomic. On failure, execution stops, persists the exact
  completed subset, calls `api.sync()` after any successful writes, and reports both completed and
  remaining work. If that sync fails, the report says the changes may remain local and allows a sync
  retry. The bot does not attempt an unreliable automatic rollback.

## Conversation memory

State is stored beside the existing transaction map in the configured Actual data directory as
`agent-state.json`, written atomically with a temporary file and rename.

For the one authorized chat it stores:

- the last 12 user and assistant text messages;
- recent referenced Actual entity IDs and display names;
- one pending plan;
- the last 100 confirmation results for deduplication and audit.

Raw tool-result histories are not persisted. After a successful write, stored entity summaries are
updated or dropped so follow-up references do not silently point at stale values.

## Data minimization

Actual queries execute locally. Gemini receives only fields needed for the request:

- Aggregation questions receive totals, periods, grouping labels, and counts—not source rows.
- Transaction lookup receives only matching IDs, dates, amounts, payees, accounts, categories,
  cleared status, and notes when notes are relevant to the request.
- Mutations receive the targeted before/after preview and the eventual execution result.
- Account or budget work receives only the named accounts/categories and required balances or budget
  values.

Credentials, API keys, the Actual server URL, sync ID, local paths, Telegram token, configuration
files, and unrelated budget records are excluded from prompts and tool results.

## Errors and limits

- Gemini, Telegram, and Actual calls retain explicit timeouts. A transient read may retry once.
- Invalid tool arguments return a compact structured error to Gemini so it can correct one call.
- Unknown names return close matches rather than guessing an ID.
- Ambiguous or broad mutations cause the agent to ask a clarifying question instead of staging work.
- A tool-loop limit or total timeout produces a short retry/refine response and leaves Actual
  untouched.
- If Actual becomes unavailable during confirmation, the plan remains pending unless it has expired;
  the user can retry confirmation after recovery.
- No exception falls through into the existing expense path after the agent has accepted a message.

## Testing

Add one runnable `tools/test_agent.mjs` script using Node assertions, a scripted fake Gemini
transport, and an in-memory fake Actual adapter. It covers:

- fallback routing without changing accepted receipt or expense behavior;
- sequential and independent read tool calls;
- data minimization and row limits;
- write calls staging without mutation;
- one-confirmation multi-operation execution;
- plan revision, cancellation, expiry, stale targets, and duplicate callbacks;
- persisted conversational references across restart;
- invalid arguments, loop limits, timeouts, and partial execution failure;
- prompt-injection text inside Actual records remaining inert.

The existing `node bot.mjs selftest`, `node tools/test_split.mjs`, and syntax checks remain required.
The deployment smoke test checks service startup, Telegram long-poll connectivity, and read-only agent
queries. It performs no live financial mutation without the user's Telegram confirmation.

## Files changed during implementation

- `bot.mjs`: fallback routing, voice fallback, and confirmation callbacks.
- `agent.mjs`: Gemini loop, state, plans, and confirmation coordinator.
- `actual-tools.mjs`: tool declarations, local reads, proposals, validation, and execution.
- `tools/test_agent.mjs`: one dependency-free behavior test script.
- `README.md` and `config.example.json`: usage, privacy, and operational documentation. No new runtime
  dependency is planned.

## Rollout

1. Run syntax checks and all three self-test scripts in the isolated worktree.
2. Deploy the commit and restart `receipt-bot`.
3. Verify the deployed commit, startup marker, and established Telegram connection.
4. Run one read-only natural-language query from the authorized chat.
5. Exercise a mutation only when the user reviews its Telegram plan and taps Confirm.

Rollback is a redeploy of the previous known-good commit followed by a service restart; the previous
commit continues to provide the existing receipt handling without the agent fallback.

## References

- Gemini function calling: <https://ai.google.dev/gemini-api/docs/function-calling>
- Actual Budget API: <https://actualbudget.org/docs/api/>
- Actual Budget API reference: <https://actualbudget.org/docs/api/reference/>
