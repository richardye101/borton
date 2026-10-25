# Manual Shared Splits Design

## Intent
Let a transaction be shared by named people using equal shares, exact dollar amounts, or percentages, while keeping the existing running balances correct.

## Behaviour
- The inline split panel offers Equal, Amount, and % modes.
- On an account owned by the user, each added person owes the entered share; the remaining amount is the user's spending.
- Equal shares divide the total between the user and all named people.
- On a named owner's card, the owner is fixed and the chosen amount is the user's share, so the user owes the owner.
- Dollar and percentage entries must be positive and must not exceed the transaction total. The UI shows the remaining amount before saving.

## Approach
Extend the existing `splitTransaction` endpoint with a mode and participant shares. Keep Actual's established representation: an on-card parent split with transfer subtransactions when the user paid, and an owner-card charge plus a negative debt-account transaction when another owner paid. No new dependency or database is needed.
