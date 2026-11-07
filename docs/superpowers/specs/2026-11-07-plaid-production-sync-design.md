# Plaid production transaction sync design

**Status:** Proposed

## Intent

Connect the owner's real Canadian bank and credit-card accounts through Plaid, then bring new transactions into the matching Actual Budget accounts without exposing banking credentials or Plaid access tokens to the browser.

## Goals

- Launch Plaid Link from Borton’s private web UI and allow the owner to connect real accounts.
- Keep Plaid secrets and access tokens only on the Borton server.
- Require the owner to map every selected Plaid account to an existing Actual account before any imports.
- Import new and modified Plaid transactions idempotently using Plaid transaction IDs as Actual `imported_id` values.
- Show connection status, last successful sync, per-account mapping, and a **Sync now** action in Borton.
- Import transactions as cleared Actual transactions with the configured fallback category; the existing Borton table remains the place to categorize or edit them.

## Non-goals

- Plaid Balance, Investments, Identity, Auth, payment initiation, or any public multi-user service.
- Creating or renaming Actual accounts from Plaid account data.
- Replacing Actual’s budgeting workflow, reconciliation, or direct bank-sync service.
- Automatically deleting an Actual transaction when Plaid later removes one. Removal needs manual review because the transaction may have been edited or reconciled in Actual.

## Approaches considered

1. **Plaid Sandbox.** Safe for testing but cannot connect the owner’s real accounts.
2. **Plaid Link plus server-side Transactions Sync. Selected.** It provides the real bank authorization flow, exchanges the short-lived public token on the server, and incrementally reads transaction changes using a saved cursor.
3. **Have the browser call Plaid directly.** Rejected because Plaid access tokens and credentials must never be exposed to browser JavaScript.

The owner selected production accounts, so the integration uses production credentials and Canada (`CA`) as the Link country. Plaid Link creates a short-lived Link token; the completed public token is exchanged server-side for a long-lived access token. Transactions Sync maintains a cursor for incremental updates. [Plaid Link](https://plaid.com/docs/link/), [Transactions Sync](https://plaid.com/docs/transactions/)

## User flow

1. On a new **Connections** page, the owner selects **Connect an account**.
2. Borton asks the server for a one-time Link token, then opens Plaid Link.
3. After Link succeeds, Borton sends the public token to the server. The server exchanges it and lists the linked accounts.
4. Borton shows a mapping screen: each Plaid checking, savings, or credit account is mapped to one existing Actual account, or excluded. Duplicate Actual mappings are rejected.
5. The server stores the encrypted Plaid Item token, selected account IDs, Actual account mappings, and an empty Sync cursor. It immediately runs the first sync.
6. The connections page shows imported/updated counts and errors. **Sync now** requests a fresh sync. A lightweight service timer also syncs all healthy items every 30 minutes while the service is running.
7. On credential-expiry or consent errors, the item is marked **Reconnect needed**; the owner opens Plaid Link in update mode, which preserves the existing mappings.

## Data handling and security

- New `.env` variables are `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=production`, and `PLAID_TOKEN_KEY`.
- `PLAID_TOKEN_KEY` is a 32-byte base64 value used to AES-256-GCM encrypt all persisted Plaid access tokens. The key and Plaid secret stay in root-owned `.env` and never enter API responses, static assets, logs, or tests.
- Encrypted connection state lives at `actual-web-data/plaid-items.json` with mode `0600`. It contains only the encrypted token, Item ID, cursor, mappings, sync status, and timestamps.
- Existing authentication, same-origin checks, CSRF validation, private-network restriction, and Actual write lock apply to every Plaid route and import.
- Link’s vendor script is loaded only when the Connections page is opened; the Content Security Policy is extended only for Plaid’s documented Link origin. No bank credential is handled by Borton.

## Import rules

- `/transactions/sync` runs page by page until `has_more` is false and commits the returned cursor only after the full result is applied.
- A Plaid outflow becomes a negative Actual amount; inflows become positive. Amounts are converted to integer cents.
- Plaid transaction ID becomes Actual `imported_id`, so retries cannot create duplicates.
- A new transaction is written only to its mapped Actual account. Merchant name becomes the Actual payee; pending transactions are skipped until posted.
- A modified Plaid transaction updates the existing, unreconciled Actual transaction only when it still has the matching `imported_id`. Categorization and notes set by the owner are preserved.
- A removed Plaid transaction is recorded in the connection status but does not delete the Actual transaction.
- Every sync obtains the existing cross-process Actual lock used by Borton’s other Actual writes.

## Server/API structure

A small `plaid-sync.mjs` module owns the Plaid REST calls, encrypted state, Link-token creation, token exchange, cursor pagination, and normalized sync results. It uses native `fetch` rather than adding an SDK dependency.

`web-app.mjs` gains connection, completion, mapping, sync, and reconnect methods. `web-server.mjs` exposes authenticated, CSRF-protected routes:

- `GET /api/plaid/connections`
- `POST /api/plaid/link-token`
- `POST /api/plaid/link-complete`
- `POST /api/plaid/connections/:id/mapping`
- `POST /api/plaid/connections/:id/sync`
- `POST /api/plaid/connections/:id/reconnect-token`

The Connections page is a simple private settings screen. It lists each institution, mappings, status, last sync, and the relevant action: connect, sync, reconnect, or disconnect. Disconnect first removes the Plaid Item through Plaid, then deletes the encrypted local token and state.

## Configuration and deployment

Borton validates that all four Plaid variables are present when `PLAID_ENV=production`; otherwise the Connections page explains that Plaid is not configured. The production server gets these values in `/root/borton/.env`, followed by the ordinary Borton deploy and service restart. The user will create the Plaid app and provide the Client ID, Production secret, and the generated encryption key.

## Verification

- Unit tests cover encrypted token storage, Link token request construction, public-token exchange, mapping validation, cursor pagination, retry safety, amount sign/cents conversion, and imported-ID deduplication.
- Server tests cover authentication, CSRF, and ensure tokens/secrets are absent from all responses.
- A Plaid Sandbox smoke test verifies the full Link-to-sync flow without touching Actual production data.
- Before connecting real accounts, verify that the first production sync imports only selected mappings and every imported transaction has an `imported_id`.

## Rollback

Disabling the Plaid variables hides the connections feature without changing imported Actual transactions. Disconnecting a connection removes its stored token and stops future imports; existing Actual entries remain intact.
