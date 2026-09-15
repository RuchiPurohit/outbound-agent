# Prospect research

Read AGENTS.md and docs/ICP.md. Use the campaign and database supplied by the
dashboard (default data/outbound.sqlite).

Use `listEligibleProspects(campaignId)` and skip contacts with existing
`getProspectResearch(contactId)`. Both contact and company must be APPROVED,
and the contact must have a sourced professional email.

Research deeply enough for one credible personalization angle. Find at most
three useful signals: recent product launches, engineering hiring, technical
posts, collaboration/chat features, marketplace/community functionality,
infrastructure changes, or funding. Prefer direct, recent public sources.
Do not substitute generic company information, job titles, or email listings.

Read the actual source pages. Never invent dates, launches, titles, claims,
or problems. Distinguish verified facts from a plausible pain hypothesis.

Persist with `saveProspectResearch`:

- contactId
- signals: up to three {signal, sourceUrl, notes} objects
- strongestSignalIndex: zero-based index into signals
- painHypothesis: explicitly conditional, not a claim of known pain
- relevance: specific relationship to ConvoKit
- notes: optional limitations / uncertainty

If no credible angle is found, use signals: [] and explain why in notes. This
stores NO_SIGNAL and blocks drafting for that prospect. Do not manufacture an
angle to reach a quota. Persistence is transactional and idempotent: skip
completed prospects after an interruption.

Write a readable report to data/campaign-<id>-research.md with signals, sources,
the strongest signal, pain hypothesis, and ConvoKit relevance. Do not generate
emails, change approval states, modify application code, or send anything.
Stop after research. The user must check researched contacts in the dashboard
before any draft generation may start.
