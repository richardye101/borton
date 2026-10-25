# Borton home, summary, and assisted expense design

## Intent

Borton should feel like a personal, private expense workspace rather than a row of equal utility tabs. Recent expenses become the default Home view. The user can add an expense quickly, inspect summaries without waiting on each visit, and ask Borton or send a receipt when they only partially remember an expense.

## Goals

- Automatically enter the app from the existing allowed WireGuard network, while retaining the password login for any later non-trusted access.
- Use a desktop side rail with separate View and Actions groups; on mobile, put Home and Summary at the top and actions in a dedicated section.
- Provide a two-row quick-add entry on Home: merchant, amount, prefilled date, account, category, and notes.
- Rename Breakdowns to Summary. Cache each period in the browser, add an explicit Refresh action, support 30 days, 90 days, 12 months, and all time, and offer a persisted amount-visibility toggle.
- Let a user open category, account, or month totals into a filtered transaction detail view.
- Replace Check duplicate with Check an expense: upload a receipt/screenshot, open Chat with a duplicate-check prompt, or expand a details form when known.
- Make Chat an always-available bubble in the top-right header instead of a navigation item.

## Non-goals

- Account importing/export automation (Automatch/Enter remains deferred).
- Editing existing Actual transactions from the Home or Summary views.
- Public or Internet access.

## Security and access

The current server continues to reject any remote outside `web.allowedRemote` (`10.88.111.0/24` is the LXC-visible WireGuard transport network). A separate `web.trustedAutoLoginRemote` list is limited to `10.88.111.5`, `10.88.111.7`, `10.0.0.3`, and `10.0.0.4`. A new trusted-session endpoint, handled before the normal session guard, issues an authenticated, sliding 30-day, HttpOnly cookie and CSRF token only for one of those exact source addresses. The web client calls it automatically on page load, so a refresh does not show a password prompt. Password sessions for other allowed WireGuard clients also last 30 days; the password endpoint does not create an Internet-access path.

The broad `allowedRemote` gate remains necessary because the LXC sees the WireGuard transport network. The automatic trusted-session path is strictly limited to the four listed device/VPN addresses.

## Approaches considered

1. **One horizontal tab bar with primary actions mixed in.** Compact but repeats the current crowded, equal hierarchy. Rejected.
2. **Persistent desktop side rail with a mobile action section.** Keeps viewing and actions distinct and adapts naturally to smaller screens. Chosen.
3. **Floating action menu.** Saves space but conceals important workflows and makes bulk receipt capture harder to discover. Rejected.

## User experience

### Navigation

Desktop side rail:

- View: Home, Summary
- Actions: Add expense, Check an expense

Chat remains a compact bubble in the top-right header. It opens an overlay/drawer above the current view, so it is available without competing with navigation.

Mobile shows Home and Summary first, then an explicit Actions section with the same two actions. Actions open their respective workspace rather than sharing a cramped navigation row.

### Home

Home is the initial view. It begins with a two-row quick-add card, then a searchable list of recent transactions with visible notes. The date defaults to today. Saving validates the row and checks for duplicates; a likely duplicate requires acknowledgement instead of silently writing.

### Summary

Summary caches a response for each selected period in browser memory: 30 days, 90 days, 12 months, and all time. It renders immediately from that cache when revisited. Refresh explicitly forces a fresh Actual sync and replaces that period’s cache. Any successful quick-add, receipt submission, or confirmed chat mutation clears every summary cache. A hide-amounts control persists locally and masks totals in Home, Summary, and summary drill-downs.

Each category, account, and month row is clickable. It opens a Summary detail view scoped to that grouping and time range, with the matching transactions and a clear way back to the summary. Detail rows load in pages of 100 with a Load more control, using stable category/account IDs and explicit month start/end dates rather than display-name matching.

### Check an expense

The primary controls are Upload a receipt/screenshot and Chat. Upload extracts candidate expenses and shows duplicate candidates; it remains editable and does not write until the user chooses Add as expense, acknowledges any duplicate, and passes the existing batch validation. Chat accepts incomplete natural language such as “Did I already buy something at Ikea last week?” and returns the assistant’s answer. A compact “Enter known details” option preserves manual lookup without making it the main path.

## Data and API changes

- Add authenticated `GET /api/session` for a trusted remote to obtain a session and CSRF token.
- Extend transaction queries with date, category, account, and offset/limit filters for drill-down results.
- Extend summaries with an all-time range, a force-sync flag for Refresh, and grouping entries with stable filters that the client can use to open details. All time begins at `1900-01-01`, includes open and closed on-budget accounts, and does not apply the 5,000-row display cap before aggregation.
- Reuse the existing batch validation and submission path for quick add and receipt-based checks; do not introduce a separate financial-write route.
- Calculate default dates, rolling periods, and month boundaries in the configured `America/Toronto` timezone.

## Validation

- Unit tests cover trusted-session access/renewal, summary period/all-time filtering including closed accounts, drill-down filter propagation/paging, cache invalidation, and quick-add duplicate validation.
- Existing web and agent tests remain green.
- Deployed verification covers passwordless trusted entry, cache/refresh API behavior, and both services active.
