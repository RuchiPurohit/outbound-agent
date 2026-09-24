# Email Discovery Runbook

Use this runbook only after the user has approved contacts. This phase discovers
public professional business email addresses and, when none is found, records
one clearly separated best-effort company-domain guess. It does not draft or
send email.

## Inputs and campaign selection

1. Read `AGENTS.md`, `docs/ICP.md`, and this file before starting.
2. Open the live SQLite database at `data/outbound.sqlite`.
3. If the user supplies a campaign ID, use it.
4. Otherwise, use the most recently created campaign containing at least one
   `APPROVED` contact. State the selected campaign ID before researching.
5. Process contacts whose status is exactly `APPROVED`. Ignore contacts with
   `DISCOVERED` or `REJECTED` status.
6. Process contacts whose `email_status` is `UNKNOWN`. Also process an existing
   `EMAIL_NOT_FOUND` result when it has no stored guess, but only to add the
   optional guess; do not relabel it or repeat public discovery unless the user
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
- Never invent or assume a discovered address. Any inferred candidate belongs
  only in the explicitly labelled guess fields below.
- Never treat an inferred pattern as `PUBLICLY_LISTED` or `VERIFIED`.
- Never substitute a personal email address for a business email.
- Do not expose unrelated personal information.
- If evidence is ambiguous, store `EMAIL_NOT_FOUND`.

## Guessing strategy

Only after persisting `EMAIL_NOT_FOUND`, record at most one guessed address with
`recordEmailGuess`. A guess is a non-sendable hint and must never be placed in
`contacts.email` or used to change `email_status`.

1. Use the approved contact's verified public name and the company's canonical
   domain. Never guess an address on a personal email domain.
2. Prefer a pattern demonstrated by another exact, publicly listed employee
   address on the same company domain. Save its public URL and use confidence
   `PATTERN_SUPPORTED`; this label still does not verify the guessed mailbox.
3. When no company pattern is publicly demonstrated, consider these patterns in
   order and store only the best candidate:
   - `firstname@company.com` (`firstname`)
   - `firstname.lastname@company.com` (`firstname.lastname`)
   - `firstnamelastname@company.com` (`firstnamelastname`)
   - `firstinitiallastname@company.com` (`firstinitiallastname`)
   - `firstname_lastname@company.com` (`firstname_lastname`)
4. Use confidence `COMMON_PATTERN` when the verified name maps cleanly to the
   selected conventional pattern. Use `AMBIGUOUS` when compound names,
   transliteration, suffixes, collisions, or another uncertainty affects it.
5. Normalize the local part to lowercase ASCII and explain the choice in
   `basis`. Do not probe, send to, or claim deliverability for the mailbox.

Skip guessing when the company domain or the contact's name cannot support a
responsible candidate. A domain or MX check does not prove that a mailbox exists.

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
4. Optionally store one separate guess through `recordEmailGuess`, including its
   pattern, confidence, basis, and pattern source when applicable.

Use `recordEmailDiscovery` for the discovery outcome and `recordEmailGuess` for
the separate optional hint so approval, source, domain, and status constraints
are enforced.

## Prohibited work

- Do not discover contacts for additional companies.
- Do not change company or contact approval status.
- Do not write personalized outreach.
- Do not create Gmail drafts or send messages.

## Completion report

Show one row per processed contact with company, contact, outcome, sourced
business email, guessed email, guess confidence, and clickable evidence URLs.
Clearly distinguish `PUBLICLY_LISTED`, `VERIFIED`, `EMAIL_NOT_FOUND`, and a
non-sendable guess. Report totals for all three discovery outcomes and the guess
count. Confirm that no inferred address was stored as a discovered email. Save
the same readable report to `data/campaign-<campaign-id>-emails.md`, replacing
`<campaign-id>` with the selected numeric campaign ID.
