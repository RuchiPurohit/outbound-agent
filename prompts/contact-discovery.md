# Contact Discovery Runbook

Use this runbook only after the user has approved companies. This phase finds
people; it does not discover email addresses or create outreach.

## Inputs and campaign selection

1. Read `AGENTS.md` and `docs/ICP.md` before starting.
2. Open the live SQLite database at `data/outbound.sqlite`.
3. If the user supplies a campaign ID, use it.
4. Otherwise, use the most recently created campaign containing at least one
   `APPROVED` company. State the selected campaign ID before doing research.
5. Query the database for companies whose status is exactly `APPROVED`.
   Ignore `DISCOVERED` and `REJECTED` companies.
6. If there are no approved companies, stop and tell the user how to approve
   them. Do not research anyone.

## Goal

For each approved company in the selected campaign, find at most two strong
technical contacts.

Target roles in priority order:

1. CTO or Technical Founder
2. VP Engineering or Head of Engineering
3. Staff or Principal Software Engineer
4. Engineering Manager

Do not select someone merely because their title matches. Prefer evidence that
their responsibilities involve one or more of:

- platform engineering
- infrastructure
- backend systems
- developer experience
- realtime systems
- messaging
- APIs

A lower-title platform owner can be more relevant than a nontechnical founder.
Do not select a generic CEO or founder without evidence of technical relevance.

## Required fields

For every selected person, collect:

- full name
- exact current title
- company
- LinkedIn or another public professional profile, if verified
- role category
- role score from 0 to 100
- concise reason this person is relevant to ConvoKit
- source URL proving the current role

Use one of these normalized role categories:

- `CTO_TECHNICAL_FOUNDER`
- `VP_HEAD_ENGINEERING`
- `STAFF_PRINCIPAL_ENGINEER`
- `ENGINEERING_MANAGER`

## Evidence rules

- Verify the person, current company, and exact current title.
- Prefer current company leadership pages, team pages, technical posts, speaker
  biographies, and public professional profiles.
- Every stored role must have a source URL that directly supports it.
- Use additional sources when needed to prove responsibility relevance.
- Never invent a person, title, profile URL, responsibility, or claim.
- If a title or responsibility cannot be verified, mark it `UNKNOWN` and do not
  select that person unless the remaining evidence is still strong.
- Check existing contacts first and do not create duplicates.

## Persistence rules

Store selected people in `contacts` with:

- `company_id` set to the approved company
- `name`, `title`, `role_category`, `role_score`, and verified profile URL
- `email = NULL`
- `email_status = 'UNKNOWN'`
- `status = 'DISCOVERED'`

For each contact, add a contact-level `research` record containing:

- the verified role/responsibility signal
- the direct source URL
- the relevance reasoning in `notes`

Do not approve contacts automatically.

## Prohibited work

- Do not search for, infer, generate, or validate email addresses.
- Do not create email patterns.
- Do not draft outreach.
- Do not create Gmail drafts or send messages.
- Do not research more than two contacts per company.

## Completion report

When finished, show contacts grouped by company and ranked by role score. Include
the exact title, role category, relevance reason, and clickable evidence URL.
Report any approved company for which no strong verified contact was found.
Confirm that all new contacts remain `DISCOVERED` with email status `UNKNOWN`.
