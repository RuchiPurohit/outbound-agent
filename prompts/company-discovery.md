# Company discovery

Research companies for the requested campaign using its stored segment and
`docs/ICP.md` as the qualification and scoring criteria. Read `docs/PRODUCT.md`
for ConvoKit capabilities. An explicit campaign segment overrides default ICP
geography, size, or industry criteria.

For every company, verify and collect:

- company name
- canonical domain
- source-stated total employee count or range, and its URL; if unavailable,
  store unknown. Record engineering headcount only when independently sourced
- geography and its source URL
- strongest relevant signal and its source URL
- a specific reason it might need ConvoKit
- one-sentence `salesThesis` separating a sourced observation from a proposed
  opportunity, which must be labeled as a hypothesis
- six-factor `scoreBreakdown` from the 100-point rubric in `docs/ICP.md`; the
  store computes the total ICP score
- whether human-to-human chat already exists as a feature, with a direct public
  source URL when `PRESENT`
- `chatImplementation`: `HOMEGROWN`, `VENDOR` (with vendor name), `EXTERNAL`,
  `NONE_FOUND`, or `UNKNOWN`, with a source for any known implementation

## Required qualification gate

Before storing a company, formulate and store the one-sentence thesis with two
explicit clauses:

> Observed: [specific sourced human workflow, messaging surface, or
> comments/forum/collaboration feature]; hypothesis: ConvoKit may help with
> [specific embedded-messaging opportunity or infrastructure burden].

Store the company when first-party evidence supports any one of those paths.
Comments, forums, support discussions, and collaboration are automatic
messaging-fit qualifiers. A product-specific hypothesis that chat could improve
engagement is also an automatic qualifier when anchored to a sourced feature,
audience, or workflow. Mark the benefit as a hypothesis, not a proven fact.
An AI assistant does not disqualify a company that separately passes a
human-to-human or sourced automatic-qualifier path.

## Targeting and sourcing playbook

Use the priority segments, research channels, geography rule, and six-factor
scoring rubric in `docs/ICP.md`. Check `docs/PRODUCT.md` before making any
ConvoKit capability claim. Prefer a live product and a source-stated seed-to-
Series-A stage, total headcount, and supported stack; leave unsupported factors
unknown and award zero points for them. Never infer engineering headcount from
total headcount.

A public job or community post is only a lead. Verify company identity, domain,
product, affiliation, date, and fit before storing it. Never contact or reply
to the source during discovery, and never invent a company from an anonymous
post. HabitYou, partner pricing, customer/reference status, and compliance
certifications still require an authoritative source before making a claim.

Rank qualified companies using the weighted rubric in `docs/ICP.md`; do not
assign an unsupported 0–100 score by intuition. Respect the dashboard's
requested result count. Never weaken verification or pad the list to reach it.

Rules:

- Important claims must have a public source URL.
- Never invent a company, employee count, location, event, or product claim.
- Store only a source-stated total headcount number or range with its URL; if
  none is available, use unknown. Engineering headcount is independently
  sourced or unknown.
- If a field cannot be verified, store it as unknown rather than guessing.
- Search official product pages or documentation for chat, messaging, inbox, or
  user-to-user conversations. Store `PRESENT` only when a public source directly
  proves human-to-human messaging, with that URL. AI assistant/chatbot surfaces
  alone do not count as user-to-user chat. Store `NO_PUBLIC_EVIDENCE` when the
  search found no reliable public evidence; otherwise store `UNKNOWN`.
- `NO_PUBLIC_EVIDENCE` and `NONE_FOUND` do not claim that chat is absent.
- Do not infer a `HOMEGROWN` implementation merely because chat appears in the
  product. Name the vendor and save a source when the implementation is `VENDOR`.
- Exclude candidates whose only messaging signal is human-to-AI chat, an AI
  assistant, copilot, or chatbot. An AI assistant is not disqualifying when the
  company separately passes a qualification path above.
- Apply the core-IP test in `docs/ICP.md`: inspect the homepage headline and
  primary pricing page. Record the source and reason for an exclusion.
- Treat sourced comments, forums, support discussions, and collaboration
  features as automatic qualifiers, even when they are not embedded chat.
- Treat a sourced, product-specific “chat could improve engagement” idea as an
  automatic qualifier. Phrase the possible benefit as a hypothesis.
- Do not store a low-fit candidate merely because it matches the requested
  industry, geography, employee count, or has an interesting technical signal.
- Do not discover contacts, emails, or create outreach.
- Do not insert duplicate domains into the campaign.
- Store each new company as `DISCOVERED`; only the user may approve it.
- Store the strongest signal and its source as a company-level research record.
- Rank by computed ICP score and write `data/campaign-<id>-companies.md`, with
  score factors, chat feature and implementation, sourced headcount, and thesis.
- Include rejected candidates and sourced reasons in that report. If fewer than
  requested qualify, state `requested N, found M` and explain the shortfall in
  both the report and workflow output. Do not silently pad or stop.

This is an execution run: research, persist, and report the requested number of
qualified companies. Do not merely describe the process.
