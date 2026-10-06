# Outbound Agent

## Goal

Build a human-in-the-loop outbound sales workflow.

The system is primarily operated by Codex.

We are NOT building a standalone AI SaaS application and should not
call the OpenAI API unless explicitly requested.

Codex performs research, reasoning, qualification, and email writing
using its existing capabilities.

Local scripts provide deterministic operations and persistence.

## Workflow

The workflow is:

1. User defines a target segment / ICP.
2. Research companies matching the ICP.
3. Score companies.
4. Store companies locally.
5. User approves/rejects companies.
6. Research decision makers only for approved companies.
7. Store contacts locally.
8. User approves/rejects contacts.
9. Research approved prospects.
10. Draft personalized emails.
11. User approves/rejects drafts.
12. Create Gmail drafts or send approved emails.
13. Track outreach state.
14. Prepare follow-ups.

Never skip human approval before sending email.

## Target roles

Priority 1:
- CTO
- Technical Founder
- Founder where technically relevant

Priority 2:
- VP Engineering
- Head of Engineering

Priority 3:
- Staff Software Engineer
- Staff Engineer
- Principal Engineer

Priority 4:
- Engineering Manager

Normally identify at most 2 strong contacts per company.

Prefer people whose responsibilities relate to:
- platform engineering
- backend
- infrastructure
- developer experience
- realtime systems
- messaging
- APIs

Do not choose people merely because their title matches.

## Research rules

Never invent:
- companies
- employee counts
- job titles
- funding events
- product launches
- email addresses
- personalization claims

Important claims must have a source URL.

Company discovery must explicitly check whether chat or user-to-user messaging
already exists as a product feature. Record `PRESENT` only with direct public
evidence. Use `NO_PUBLIC_EVIDENCE` after a completed search finds none; this is
not proof that the feature is absent. Use `UNKNOWN` when the check is incomplete.

Company discovery must apply the messaging-fit gate in `docs/ICP.md` before
persisting a candidate. Human-to-AI chat alone is not a ConvoKit use case.
Sourced comments, forums, support discussions, or collaboration features are
automatic messaging-fit qualifiers. A plausible product-specific hypothesis
that chat could improve engagement is also an automatic qualifier; persist the
observed evidence and keep the benefit explicitly hypothetical. Products where
messaging/realtime collaboration is already mature core IP remain a negative.

`docs/PRODUCT.md` is the owner-confirmed internal source for ConvoKit's current
capabilities. Company discovery should prioritize the segments, channel
partners, sourcing channels, and ranking factors in `docs/ICP.md`. Public jobs
and community posts are leads only: verify company identity and affiliation
before persistence and never contact posters during research.

If something cannot be verified, mark it UNKNOWN.

## Email discovery

Search for a public professional business address before generating any guess.
An inferred address is never considered public, verified, or sendable. Store at
most one best guess only after recording `EMAIL_NOT_FOUND`, using the separate
guess fields and `recordEmailGuess`; never put a guess in `contacts.email`.

Prefer a publicly demonstrated same-domain employee pattern. Otherwise use the
ordered common patterns in `prompts/email-discovery.md`. Record the pattern,
confidence, and basis. `PATTERN_SUPPORTED` also requires a public source URL.

If no reliable professional business email can be found:

EMAIL_NOT_FOUND

## Outreach rules

Do not contact more than 2 people at one company simultaneously.

Every first-touch email requires explicit human approval.

Every email must have a real reason for contacting that company.

Avoid generic bulk outreach.

## Email writing

Emails should normally be under 100 words.

Avoid phrases like:
- Hope you're doing well
- game changer
- revolutionary
- touch base
- circle back
- unlock value

Tone:
technical founder / engineer speaking to another engineer.

Structure:

1. `Hi <first name>,` greeting.
2. Relevant researched signal.
3. Concrete, conditional business use case.
4. Two-engineer context and how verified ConvoKit capabilities relate.
5. Low-friction invitation to a quick 10-minute call.
6. `Ruchi` and `convokit.app` on separate signature lines.

Never invent personalization.

## Development philosophy

We are learning by building.

Prefer simple implementations first.

Do not introduce:
- microservices
- queues
- cloud infrastructure
- React frontend
- Postgres

unless there is a demonstrated need.

Use TypeScript.

Use SQLite for persistence.

Explain important architectural decisions before implementing them.

## Saved workflows

When the user asks to "run contact discovery", read and execute
`prompts/contact-discovery.md` against the live SQLite database. Use a campaign
ID supplied by the user; otherwise use the most recently created campaign that
has approved companies. Never run contact discovery for rejected or merely
discovered companies.

When the user asks to "run email discovery", read and execute
`prompts/email-discovery.md` against the live SQLite database. Use a campaign ID
supplied by the user; otherwise use the most recently created campaign that has
approved contacts. Process only approved contacts and never infer an address
from an email pattern.

Prospect research and email generation are separate dashboard workflows:
`prompts/prospect-research.md` and `prompts/email-generation.md`.
Approved contacts at approved companies with either sourced business emails or
separate guessed-email hints are eligible for prospect research and drafting.
The user has explicitly accepted the risk of sending to guessed addresses.
Always label a guessed recipient as unverified during draft review and final
send confirmation; never relabel it as public or verified. Keep verified signals
separate from pain hypotheses. Every draft must link to one of the prospect's sourced signals.
Generated and rewritten outreach stays DRAFT; only an explicit human dashboard review may approve it.
Never invoke approval operations from a research or generation workflow.
Research must stop for checklist selection. Generate first-touch drafts only
for the contact IDs explicitly checked in the dashboard generation request.

Gmail sending is a deterministic dashboard operation, never a research task.
Only an explicit human send confirmation may dispatch READY_TO_SEND outreach.
Never read .env, Gmail OAuth credentials, or tokens during research/generation.
Never invoke sending, approval withdrawal, or delivery-state operations from
a research, generation, or rewrite workflow.
