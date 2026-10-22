# Email Discovery Runbook

Use this runbook only after the user has approved contacts. This phase discovers
professional business email addresses through credible public sources and, when
none is found, records one clearly separated best-effort company-domain guess.
It does not draft or send email.

The full email pipeline is:

1. **Discovery (this runbook, Codex):** public sources only, then a pattern
   guess. Never call Treg here.
2. **SMTP check (deterministic, free):** runs automatically after dashboard
   discovery. It probes the guess, then the other patterns below, and keeps the
   first address the mail server accepts.
3. **Treg recovery (paid, human-triggered):** only for guesses whose SMTP result
   was `INVALID`, `CATCH_ALL`, or `UNKNOWN`. See "Post-SMTP Treg recovery".

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
   A targeted post-SMTP recovery is that explicit fresh check; follow
   "Post-SMTP Treg recovery" below instead of the discovery rules.
7. If no eligible contacts exist, stop without researching.

## Allowed outcomes

Record exactly one outcome for every eligible contact:

- `PUBLICLY_LISTED`: the exact professional business address is visibly
  published on a credible public source.
- `VERIFIED`: either the exact publicly sourced address has reliable evidence of
  current deliverability, or Treg discovered the address and
  `treg.people.email.verify` returned the exact verdict `valid`. A finder result,
  domain pattern, syntax check, unchecked result, `catch_all`, `risky`, or
  `unknown` verdict is not verification.
- `EMAIL_NOT_FOUND`: no reliable professional business address was found after
  a reasonable search.

`UNKNOWN` means email discovery has not yet been completed.

## Discovery rules

- Do not call Treg during discovery. Use credible public sources only.
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
- If evidence is ambiguous, store `EMAIL_NOT_FOUND`. A Treg result with an
  unchecked, `catch_all`, `risky`, `unknown`, or `invalid` verification outcome
  must not be stored in `contacts.email`.

## Company email domain

Guesses, SMTP checks, pattern evidence, and Treg identity inputs all use the
company's **email domain**: `companies.email_domain` when set, otherwise
`companies.domain`. Some companies receive mail on a different domain from
their website (for example, the website `enver.com` has no MX records, while its
contact page lists `hi@enverstudio.com`).

- Before guessing, check the company's own contact, team, about, imprint, and
  privacy pages for any address on the company. If they show addresses on a
  different domain, record it with
  `recordCompanyEmailDomain({companyId, emailDomain, sourceUrl, basis})`, using
  the page URL and a basis naming the exact observed address.
- A generic role address (`hi@`, `info@`, `careers@`) establishes the domain
  but never demonstrates a personal pattern.
- An SMTP detail saying the domain "has no MX records" or "does not accept
  mail" means the guess's domain cannot receive email; search for the real mail
  domain as above.
- Never record a personal email provider (Gmail, Outlook, etc.) or another
  company's domain. A Treg finder result alone is not evidence of the domain;
  a credible public page must show the company's addresses on it.
- Recording a domain moves existing pattern guesses to the same pattern on the
  new domain and queues them for a fresh SMTP check.

## Guessing strategy

Only after persisting `EMAIL_NOT_FOUND`, record at most one guessed address with
`recordEmailGuess`. A guess is a non-sendable hint and must never be placed in
`contacts.email` or used to change `email_status`.

1. Use the approved contact's verified public name and the company's email
   domain (see "Company email domain"). Never guess an address on a personal email domain.
2. Prefer a pattern demonstrated by another exact, publicly listed employee
   address on the same company domain. Save its public URL and use confidence
   `PATTERN_SUPPORTED`; this label still does not verify the guessed mailbox.
   Before falling back to a common pattern, search these free sources for any
   person's exact address on the domain (once per domain):
   - public GitHub commits by the company's org or its founders/engineers
     (commit author emails, e.g. a commit's `.patch` view);
   - the company site's team, about, contact, imprint/Impressum, privacy, and
     press pages;
   - press releases, podcast show notes, conference speaker pages, job posts,
     and app-store or package-registry listings that name a person.
   Generic role addresses (`hello@`, `info@`, `support@`, `careers@`,
   `press@`) do not demonstrate a personal pattern.
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
   `basis`. Do not probe, send to, or claim deliverability for the mailbox
   yourself; the deterministic SMTP check handles probing after this run.

Skip guessing when the company domain or the contact's name cannot support a
responsible candidate. A domain or MX check does not prove that a mailbox exists.

## Persistence rules

For `PUBLICLY_LISTED` or `VERIFIED`:

1. Store the exact address in `contacts.email`.
2. Store the corresponding status in `contacts.email_status`.
3. Add a contact-level `research` record containing the exact discovery status,
   address, evidence URL, and concise evidence notes. For `PUBLICLY_LISTED`, the
   evidence URL is the page displaying the address. For Treg-backed `VERIFIED`,
   it is the verifier call audit URL and the notes contain the finder/verifier
   provenance required above.

For `EMAIL_NOT_FOUND`:

1. Keep `contacts.email` as `NULL`.
2. Set `contacts.email_status` to `EMAIL_NOT_FOUND`.
3. Do not fabricate a placeholder source.
4. Optionally store one separate guess through `recordEmailGuess`, including its
   pattern, confidence, basis, and pattern source when applicable.

Use `recordEmailDiscovery` for the discovery outcome and `recordEmailGuess` for
the separate optional hint so approval, source, domain, and status constraints
are enforced.

## Pattern evidence for existing guesses

Run only when the request supplies contact IDs with the `PATTERN_EVIDENCE`
task (dashboard "Find pattern evidence"). Each contact has an `EMAIL_NOT_FOUND`
pattern guess whose SMTP result was `CATCH_ALL`, `INVALID`, or `UNKNOWN`, so the
mail server could not confirm it. This search is free; never call Treg.

- Group contacts by company and search each company's email domain once, using
  the free sources listed in step 2 of the guessing strategy.
- When an exact personal address on the same domain is found, derive its
  pattern and call `recordEmailGuess` for every affected contact with that
  pattern, confidence `PATTERN_SUPPORTED`, the page URL as `sourceUrl`, and a
  `basis` naming the observed address and pattern. This replaces the guess; the
  dashboard SMTP-checks it again automatically.
- If the guess's domain has no MX records, or evidence shows staff use another
  domain, record it with `recordCompanyEmailDomain` as described in "Company
  email domain", then look for pattern evidence on that domain. Report the
  domain change in the completion report.
- If nothing is found for a domain, leave its guesses unchanged. Do not call
  `recordEmailDiscovery`.

## Post-SMTP Treg recovery

Run only when the request supplies contact IDs (dashboard "Recover with Treg" or
`emails:recover`). Process exactly those contacts; each has an `EMAIL_NOT_FOUND`
pattern guess whose SMTP result was `INVALID`, `CATCH_ALL`, or `UNKNOWN`.

- Before the first finder call, check the Treg balance if the catalog exposes
  one. Search the catalog for the current email-finding and verification
  routes, inspect parameters and prices, then use the routed
  `treg.people.email.find` and `treg.people.email.verify` capabilities. Set a
  reasonable cost ceiling per contact.
- Send the strongest supported identity: prefer the approved contact's sourced
  LinkedIn URL; otherwise the verified public name and the company's email
  domain.
  A deliverable mailbox does not prove it belongs to the intended person, so a
  result whose identity conflicts with the approved contact is `NOT_FOUND`.
- Do not submit or preserve the failed guess as a discovered result.
- Record exactly one outcome per contact with `recordEmailRecovery({contactId,
  outcome, email, sourceUrl, notes})`. Never call `recordEmailDiscovery` or
  `recordEmailGuess` during recovery.
  - `VERIFIED`: the verifier's exact verdict is `valid` and the identity
    matches. This stores the address as `VERIFIED`.
  - `CATCH_ALL_CANDIDATE`: an identity-matched finder address on the company's
    email domain whose verifier verdict is exactly `catch_all`. It replaces the
    pattern guess and stays an unverified guess.
  - `NOT_FOUND`: every other completed result (`risky`, `unknown`, `invalid`,
    unchecked, identity mismatch, or no finder result). The guess is kept.
  - `PROVIDER_ERROR`: a Treg call failed because of credits, billing, quota,
    rate limits, or an outage. Stop calling Treg and record this for that
    contact and every remaining contact; they are retried later.
- `notes` must contain the finder and verifier call IDs, serving providers,
  identity inputs, verdict, and actual costs (or the provider error).
  `sourceUrl` is the verifier call audit URL.
- Treg discovery never makes an address `PUBLICLY_LISTED`.
- If Treg returns an identity-matched address on a different domain, record that
  domain with `recordCompanyEmailDomain` only when a credible public page shows
  the company's addresses on it, and do so before recording the outcome.

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
