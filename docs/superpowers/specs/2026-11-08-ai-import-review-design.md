# AI-assisted imported-transaction review

## Intent

Every newly synced Plaid transaction remains in Borton's Reviews inbox until the owner chooses what to do with it. Borton proposes a category from the owner's existing Actual categories, but never writes that category—or an empty category—to Actual without an explicit review decision. The owner can change the suggested category and add a note before importing.

## Goals

- Stage every new Plaid row in Reviews before any Actual write.
- Attach one persisted AI category suggestion, with a short confidence/reason, to each staged row.
- Let the owner edit the category and note while reviewing, then import with those exact fields.
- Run suggestions serially with backoff so a burst of synced transactions stays below model limits.
- Keep duplicate/merge and ignore paths available; a merge never overwrites the already-existing Actual transaction's category or note.

## Non-goals

- Do not recategorize historical transactions already in Actual without explicit approval.
- Do not auto-accept suggestions.
- Do not invent categories; suggestions must be one of the existing, non-income Actual categories.
- Do not use transaction notes or bank memo text beyond the normal Plaid merchant/date/amount/account context unless explicitly available in the staged row.

## Approaches considered

1. Import every transaction as Uncategorized, then suggest categories in Actual later. This avoids a review queue but floods Actual with incomplete records and makes it hard to distinguish new imports from normal transactions.
2. Review-first with a serialized AI suggestion queue. This keeps imported data reversible until confirmed, fits the existing Reviews inbox, and is selected.
3. Categorize immediately from a local merchant rule map. It is cheaper but would not satisfy the requested AI suggestion and would require a separate rule-management interface.

## Selected flow

1. Plaid sync stages every new transaction in `reviews.json`; it does not call Actual's transaction-import API.
2. A durable, single-worker suggestion queue takes staged rows one at a time. Its prompt includes only merchant, date, signed amount, account/institution, and the current permitted category names. It returns a category name, confidence, and a short reason.
3. The worker maps the returned name back to an Actual category ID. Invalid, unavailable, or failed suggestions are recorded as unavailable; the row remains manually reviewable and retries transient provider failures with backoff.
4. Reviews displays the suggestion on each row. Opening a row provides a category picker (preselected to the suggestion when present) and notes field.
5. The owner chooses **Import** only from that review form. The server validates the selected account/category against the current Actual bootstrap data and writes the chosen category and note with the imported transaction. The row then becomes completed.
6. **Merge** only marks an existing Actual transaction as the imported row; it does not modify that transaction's category or note. **Ignore** makes no Actual write.

## Safety and data rules

- Suggestions are metadata in the private review inbox, not an Actual write.
- A selected category ID and note are validated on the server at the moment of import.
- Existing imported records stay unchanged. A later bulk reset/review requires a separate, explicit confirmation.
- Queue state, attempts, next retry time, and result persist across service restarts.

## Approved legacy-import reset

The owner explicitly approved clearing the category only from existing imported transactions currently tagged `Tuition`. A one-time migration will find transactions with an Actual `imported_id` and the Tuition category, clear that category without deleting or changing their amount, date, payee, account, or existing note, then stage each affected transaction for the same AI-assisted review. This is intentionally narrower than clearing all Tuition transactions: manually entered Tuition expenses are untouched.

## UI

The Reviews table keeps its compact columns and gains a visible `Suggested category` indicator. Expanded rows use labelled fields rather than inline dot-separated text: imported transaction details, `Suggested`, `Category`, and `Note`. A pending suggestion has a small `Suggesting…` state; an unavailable suggestion shows `No suggestion` without blocking manual categorization.

## Verification

- Unit tests prove Plaid sync does not write to Actual before a review decision.
- Unit tests cover category suggestion validation, transient retry, and persistent queue recovery.
- Review resolution tests prove the confirmed category and note reach Actual and merges leave existing transaction fields intact.
- Frontend tests prove suggested category, editable fields, and the confirmation action render.
