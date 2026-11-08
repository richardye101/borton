# Reviews empty state

## Intent

Make an empty Reviews inbox feel purposeful rather than like an unused spreadsheet. It should tell the owner what will appear here and offer the two relevant next actions.

## Chosen approach

When there are no rows after the selected status and search filters, replace the filterable table with a compact dashboard:

- A calm **All caught up** status.
- A **Sync bank** action that takes the owner to Connections.
- An **Upload receipts** action using the existing batch receipt uploader.
- A short explanation that synced transactions are staged here before Actual changes.

The existing search, filters, sorting, table and resolution controls appear only when there are rows to review. Completed/All states keep the same behaviour: the dashboard is shown only when their selected result set is empty.

## Constraints

- Reuse the current Reviews route, receipt upload endpoint and Connections route; no new backend state or dependencies.
- Keep the empty state responsive and accessible.
- Do not imply a Plaid sync happened or write to Actual.

## Alternatives considered

- Keep the empty table and collapse controls behind a Filters button: rejected because it still presents a blank, low-information spreadsheet.
- Always show the dashboard under the table: rejected because it competes with real review rows.
