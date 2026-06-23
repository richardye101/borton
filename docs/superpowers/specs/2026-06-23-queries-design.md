# Telegram money queries — design

## Context
The bot writes expenses (and soon income/investments) to Actual. Actual's web UI can report
on all of it, but the user wants those answers **from Telegram** — quick questions answered in
chat ("how much did I spend this month?", "net worth?", "tax paid YTD?"). This spec covers the
**read-only query subsystem**. Writing income/investments and the paystub CLI are separate specs.

## Scope
**In:** read-only queries over the Actual budget, answered in the same chat the question came from
(DM or relay channel). Fixed commands for the common asks; natural-language fallback for the rest.

**Out:** any writes (this subsystem never mutates Actual); the money-in write features; the paystub
CLI/backfill. Queries that depend on not-yet-loaded data (e.g. `tax YTD`) will simply return what's
in Actual today (often $0) until those features land — that's expected, not an error.

## Routing
In `dispatch` (DM) and `onRelayPost` (channel), **before** the expense-entry path, classify the
message as a query when:
- it starts with `/` (a fixed command), **or**
- it has **no leading amount** AND matches a question cue (`/^(how|what|when|how much|show|list)\b/i`
  or ends with `?`).

A query is **read-only**: no confirmation, no reaction-as-write. (A 👀→👍 reaction is fine.)
Anything not classified as a query falls through to the existing entry path unchanged.

## Query spec (internal representation)
Both fixed commands and the NL parser produce the same object, which `runReport` executes:

```
{
  metric: 'spent' | 'income' | 'net' | 'categories' | 'category' | 'balance' | 'networth' | 'invested',
  category: string | null,   // for metric 'category' / filtering 'spent'
  account:  string | null,   // for metric 'balance'
  period:   { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', label: string }   // inclusive
}
```

## Period parsing
A small deterministic parser turns words into `{start,end,label}`:
- default / `this month` → current calendar month
- `last month`, `this year`, `last year`, `ytd` (= this year to today)
- a bare month name (`may`) → most recent occurrence of that month
- `YYYY-MM` → that month; `all` → everything
Used both as a command suffix (`/spent groceries last month`) and by the NL parser.

## Fixed commands
| Command | metric | Notes |
|---|---|---|
| `/month [period]` | net | shows income in, spending out, net |
| `/spent [category] [period]` | spent | total outflow, optionally one category |
| `/income [period]` | income | total inflow to on-budget accounts |
| `/cats [period]` | categories | top spending categories, descending |
| `/balances` | balance | every account's current balance |
| `/networth` | networth | sum of all account balances |
| `/invested [period]` | invested | transfers into `defaults.investmentAccounts` |
| `/cat <name> [period]` | category | one category's total (aliases: `/tax`, `/pension`, …) |

Unknown command → short help listing the above.

## Natural-language fallback
Non-command question → Gemini with a JSON schema mirroring the query spec (metric + category +
account + period words), then the period parser resolves the dates, then `runReport`. The question
**text** goes to Gemini; **no budget data does** (numbers are computed locally afterward). If Gemini
is unavailable or returns nothing usable → reply "couldn't parse that — try /month or /spent <cat>".

## runReport(spec) — aggregation
Reads from the in-memory Actual budget (already downloaded at startup). Source of truth:
`getTransactions(accountId, start, end)` per account (proven in the backfill scans), summed in code.
Use `aqlQuery`/`runQuery` if it proves simpler for an aggregation, but manual summation is the
baseline and the fallback.

- **spent**: sum of negative categorized amounts across on-budget accounts (optionally one category).
- **income**: sum of positive amounts to on-budget accounts (exclude transfers).
- **net**: income − spent for the period.
- **categories**: group spending by category, return top N (default 8).
- **category**: one category's signed total.
- **balance / networth**: per-account balance (sum of all its txns, or `getAccountBalance` if
  available); networth = sum across accounts.
- **invested**: sum of transfers whose destination is in `defaults.investmentAccounts`.

Transfers are excluded from spent/income so internal moves don't distort totals.

## Output
Compact chat text, currency formatted, with the period label. Examples:
```
/month            → 📅 Jun 2026 — in $5,200 · out $3,140 · net +$2,060
/spent groceries  → 🛒 Groceries (Jun 2026): $412.30 · 18 txns
/cats             → Jun 2026 top: Groceries $412 · Eating Out $300 · …
/networth         → 💼 Net worth: $X across N accounts
```

## Config additions
- `defaults.investmentAccounts`: string[] — account names treated as investments (for `/invested`
  and to keep contributions out of spend/income). Empty by default.

## Errors
- Unknown category/account → reply with the closest matches from Actual.
- Empty result → "no matching transactions in <period>" (not an error).
- Read path never throws into a write; failures reply with a short message only.

## Architecture
New, self-contained, read-only unit — `parseQuery(text)` (command + period parsing, with a Gemini
branch for NL), `runReport(spec)`, `formatReport(result)`, and a `maybeQuery(text)` classifier called
from `dispatch`/`onRelayPost`. Lives in `bot.mjs`; extract to `queries.mjs` if it outgrows ~one
screen. Reuses existing `ACCT`/`CAT` maps and `getTransactions`.

## Testing
`node bot.mjs selftest` gains a fixture: a small in-memory transaction array fed to `runReport` for
each metric (spent / income / net / categories / invested), asserting the totals; plus period-parser
assertions (`this month`, `last month`, `may`, `2026-05`). No network.
