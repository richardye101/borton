# Review Later Design

## Intent

Let a person flag an existing Actual transaction for follow-up—such as waiting for a repayment before creating a split—without changing the transaction or its notes.

## Chosen approach

Create a small open review record linked to the Actual transaction. The Home and Summary row action opens a compact prompt for an optional reminder. Reviews shows it alongside other open work; resolving it only completes the review record.

## Alternatives considered

- Add a marker to transaction notes: rejected because workflow text would pollute the user's notes.
- Create the split immediately: rejected because repayment details may be unknown.

## Constraints

- Reuse the existing persisted review inbox and resolution endpoint.
- Do not modify the Actual transaction when flagging or completing a review-later item.
- No new dependency or storage system.
