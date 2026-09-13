# Email Discovery Runbook

Use this runbook only after the user has approved contacts. This phase discovers
public professional business email addresses; it does not draft or send email.

## Inputs and campaign selection

1. Read `AGENTS.md`, `docs/ICP.md`, and this file before starting.
2. Open the live SQLite database at `data/outbound.sqlite`.
3. If the user supplies a campaign ID, use it.
4. Otherwise, use the most recently created campaign containing at least one
   `APPROVED` contact. State the selected campaign ID before researching.
5. Process contacts whose status is exactly `APPROVED`. Ignore contacts with
   `DISCOVERED` or `REJECTED` status.
6. Skip contacts whose `email_status` is not `UNKNOWN`, unless the user
   explicitly requests a fresh check.
7. If no eligible contacts exist, stop without researching.

## Allowed outcomes

Record exactly one outcome for every eligible contact:

- `PUBLICLY_LISTED`: the exact professional business address is visibly
  published on a credible public source.
- `VERIFIED`: the exact publicly sourced address also has reliable evidence of
  current deliverability. A domain pattern or syntax check is not verification.
- `EMAIL_NOT_FOUND`: no reliable professional business address was found after
  a reasonable search.

`UNKNOWN` means email discovery has not yet been completed.

## Discovery rules

- Search only for professional business email addresses belonging to the
  approved contact.
- Prefer employer-controlled pages, public professional profiles, conference
  biographies, authored technical posts, and reputable public directories.
- The source page must display or directly substantiate the exact address.
- Never invent an address.
- Never generate or test likely address patterns.
- Never treat an inferred pattern as `PUBLICLY_LISTED` or `VERIFIED`.
- Never substitute a personal email address for a business email.
- Do not expose unrelated personal information.
- If evidence is ambiguous, store `EMAIL_NOT_FOUND`.

## Persistence rules

For `PUBLICLY_LISTED` or `VERIFIED`:

1. Store the exact address in `contacts.email`.
2. Store the corresponding status in `contacts.email_status`.
3. Add a contact-level `research` record containing the exact discovery status,
   address, direct source URL, and concise evidence notes.

For `EMAIL_NOT_FOUND`:

1. Keep `contacts.email` as `NULL`.
2. Set `contacts.email_status` to `EMAIL_NOT_FOUND`.
3. Do not fabricate a placeholder source.

Use the store's `recordEmailDiscovery` operation so approval, source, and email
constraints are enforced transactionally.

## Prohibited work

- Do not discover contacts for additional companies.
- Do not change company or contact approval status.
- Do not write personalized outreach.
- Do not create Gmail drafts or send messages.

## Completion report

Show one row per processed contact with company, contact, outcome, business
email when found, and clickable source URL. Clearly distinguish
`PUBLICLY_LISTED` from `VERIFIED`. Report totals for all three outcomes and
confirm that no inferred addresses were stored. Save the same readable report
to `data/campaign-<campaign-id>-emails.md`, replacing `<campaign-id>` with the
selected numeric campaign ID.
