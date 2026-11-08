# Reviews inbox

## Intent

Bank synchronization must not silently create financial records or assign arbitrary
categories. Borton will stage every newly discovered Plaid transaction in one
global **Reviews** inbox, where the owner can search, filter, decide whether it
matches an existing record, and apply only the selected decisions.

## Goals

- Add a routable `/reviews` page and main navigation entry.
- Show all open bank-import work across institutions in one sortable/filterable
  table: status, date, merchant, mapped account, amount, possible match,
  category, and source.
- Preserve a completed audit trail, filterable separately from open work.
- Let the owner explicitly merge a bank transaction into an existing Actual
  transaction, import it as a new uncategorized transaction, or ignore it.
- Accept a batch of receipt images, OCR them slowly in a durable queue, and
  review receipt-to-bank and receipt-to-Actual matches in the same inbox.
- Explain every proposed match with compact evidence: same amount, posting-date
  distance, and merchant comparison.
- Preserve existing Actual amount, merchant, category, notes, and splits on a
  merge. A merge only associates the current Plaid transaction ID and marks it
  cleared.

## Non-goals

- No automatic merge or automatic category assignment.
- No AI categorization, transfer reconciliation, or arbitrary cross-account
  matching in this iteration.
- No modification of a reviewed transaction without a user action.

## Current constraint

The importer currently writes rows immediately and assigns its first visible
category. For this budget that category is `Tuition`. The reviews flow replaces
that path for Plaid rows; unmatched transactions remain staged until the owner
chooses Import.

## Matching

Candidates are only compared with existing transactions in the mapped Actual
account. A candidate requires the same signed integer-cent amount and a posting
date within 21 days. It is ranked by date distance and normalized merchant
similarity. The UI exposes strong, review, and weak confidence labels plus the
evidence; it does not apply any confidence level by itself.

An Actual `imported_id` is not enough to exclude a candidate: it can originate
from a different importer. Only the same Plaid transaction ID means a row has
already been handled.

## Receipt ingestion and evidence

- The Reviews page accepts multiple receipt images in one upload. Each image
  gets a durable, idempotent job identified by its content hash and upload
  request ID. Files live in a private Borton directory with mode `0600` while
  they are awaiting OCR or review.
- A single worker processes one receipt at a time, with at least a 20-second
  gap between OCR starts (three scans per minute). It honors a provider retry
  delay when supplied and uses exponential backoff on a 429/temporary failure.
  In-flight work returns to retry state on restart; failed work remains
  manually retryable.
- OCR results become Reviews rows with `source: receipt`. They are matched
  against staged Plaid rows first and then existing Actual transactions using
  unsigned amounts, receipt date, card last-four where present, and normalized
  merchant evidence. The UI identifies a receipt candidate as evidence; it
  never resolves a Plaid decision automatically.
- A receipt may be attached to the Actual transaction selected by the owner,
  whether that transaction was an existing merged match or a newly imported
  Plaid row. If the receipt remains unmatched, it stays in Reviews.
- The installed Actual API exposes text transaction notes but no transaction
  image attachment API. Receipt images therefore remain in private Borton
  storage with mode `0600`, linked to the stable Actual transaction ID after
  resolution. Borton shows a receipt indicator and authenticated preview from
  that link; it never puts image/base64 data into Actual notes or overwrites
  user notes. A cleanup task permanently removes each private image 30 days
  after upload, while retaining its extracted fields, review decision, and
  transaction link in the audit history.

## Data and operations

- Persist staged Plaid rows and their decision/audit state in the existing
  private Borton data directory with mode `0600`.
- Sync receives bank changes, records pending review rows, and advances the
  Plaid cursor only after those rows are durably staged.
- A decision is applied under the existing Actual lock.
  - **Merge:** update the chosen existing Actual transaction with the Plaid
    `imported_id` and `cleared: true`; preserve all other fields.
  - **Import:** create a transaction with no category and the Plaid
    `imported_id`.
  - **Ignore:** store the decision without creating or changing an Actual
    transaction.
- Completed rows retain their decision, timestamp, candidate evidence, and
  linked Actual transaction ID. Incoming Plaid modifications refresh an open
  row; removed transactions are recorded as removed rather than silently lost.

## UI

The Reviews page uses the existing table/filter pattern rather than a new
component library. Open is the default status filter, with Completed and All
available. It supports receipt-batch upload and displays queue states:
Queued, Reading, Retrying, Failed, Match, New, and Completed. Each row has a
compact action menu and an expandable match detail showing the source row
beside the proposed Plaid or Actual transaction. The user can select multiple
rows and apply their already-selected decisions in one explicit confirmation
action. Individual row actions remain available.

Columns are searchable/filterable and sortable where meaningful: status,
date, merchant, Actual account, amount, match confidence, category, and
institution. Notes are not a first-pass filter column.

## Approaches considered

1. **Global persistent Reviews inbox — selected.** One queue and audit history
   across all institutions. It gives the owner a dependable place to work
   imports, supports column filtering, and prevents accidental writes.
2. **Duplicate-only dialog.** Smaller but leaves new/categorization/import
   decisions scattered and does not meet the request for a general review view.
3. **Immediately import unmatched records.** Faster but reintroduces arbitrary
   categorization and makes the budget change before review.

For receipts, the selected approach is a durable, integrated Reviews queue
rather than the current browser-only, one-image OCR request. This preserves
work across refreshes and rate limits while keeping receipt evidence alongside
the transaction decision.

## Implementation boundaries

This will extend `plaid-sync.mjs`, `actual-web.mjs`, `web-app.mjs`,
`web-server.mjs`, the Svelte router/navigation, and focused unit tests. It
will add a small receipt-review queue/state module rather than repurpose the
message queue, because receipt jobs carry private files and OCR-specific
retry state. It will reuse private JSON/file-lock patterns; no database or
dependency is needed.
