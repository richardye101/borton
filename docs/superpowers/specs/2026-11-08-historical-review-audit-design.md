# Historical Review Audit Design

## Intent

Show prior Plaid transactions that Borton directly imported before the Reviews workflow existed, without importing, editing, or duplicating anything in Actual.

## Chosen approach

The audit reads up to 180 days of transaction history for mapped Plaid accounts, then matches each Plaid transaction to the Actual transaction with the same `imported_id`. It saves only verified matches as completed review rows with the `already_imported` resolution. They appear in the Completed Reviews view and never create an Open review or write to Actual.

## Constraints

- No historical-audit action may write a transaction to Actual.
- Only mapped accounts participate.
- Records already in the inbox remain unchanged.
- The audit result reports how many rows were scanned and how many verified matches were recorded.

## Non-goals

- Replaying old imports.
- Treating same-import-ID records as possible duplicate merges.
- Adding unmatched historical transactions to the review queue.
