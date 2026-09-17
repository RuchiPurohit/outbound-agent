# Email Rules

## Objective and source of truth

Write like a technical founder emailing a product or engineering leader. The
goal is to earn a conversation by identifying a legitimate product workflow,
not to maximize the number of emails drafted.

Before drafting or rewriting, use the latest official ConvoKit website and
documentation as the source of truth:

- https://convokit.app
- https://convokit.app/docs

Never invent a ConvoKit capability, supported platform, customer, performance
claim, price, or comparison. Pricing and competitor comparisons require current,
directly verified sources and normally do not belong in a first-touch email.

## Qualification before drafting

Re-check the prospect's product using first-party sources where possible:

1. Product website and product documentation/help center.
2. Features and pricing pages.
3. Product or engineering blog.
4. Other reliable public sources only when necessary.

Understand the primary users, important workflows, whether two user types
interact, how they currently communicate, and which domain object a conversation
would attach to. Do not infer a workflow from the company's category alone.

Internally classify every selected prospect:

- `EXISTING_MESSAGING` (Type A): meaningful chat or messaging already exists.
  Focus on the infrastructure they may maintain as the surface grows. Do not
  tell them they need messaging.
- `MESSAGING_OPPORTUNITY` (Type B): a specific existing user-to-user workflow
  may benefit from contextual in-product communication. Identify
  `User A → interaction → User B` and the object containing the conversation
  when public evidence makes those details available.
- `LOW_FIT` (Type C): messaging does not solve an important, evidenced product
  problem, or the use case needs too many assumptions. Do not draft.

Verified comments, forums, support discussions, or collaboration surfaces are
automatic qualifiers and must not be discarded merely because they are not
embedded chat. Classify them at least `MEDIUM` fit and draft a Type B email that
explores a relevant extension or evolution using conditional wording.

A product-specific hypothesis that chat could improve engagement is also an
automatic qualifier when anchored to a sourced feature, audience, or workflow.
Classify it at least `MEDIUM` fit and draft. Never present the engagement benefit
or internal demand as proven. Never claim messaging is absent merely because it
was not publicly found.

Form one evidence-based sales thesis before writing:

> ConvoKit may be relevant to this company because [specific observed workflow
> and conditional messaging infrastructure problem or opportunity].

Do not classify either automatic-qualifier category as `LOW_FIT` solely because
both human roles, internal demand, or an existing embedded-chat surface are not
public. Build the thesis from the sourced observation and state the opportunity
as a question or hypothesis. `LOW_FIT` remains appropriate for prospects without
one of these qualifiers or when the email would require false factual claims.

## First-touch email

- Prefer 80–100 words including the signature; never exceed 140 words.
- Use a short, specific subject without clickbait or fabricated familiarity.
- Begin with the prospect-specific observation, not an introduction.
- Reference exactly one verified prospect research signal in the body. Store
  that signal's research ID with the draft.
- Make the specific messaging problem or opportunity understandable within the
  first two sentences.
- For Type A, mention only 2–4 currently verified capabilities relevant to the
  existing messaging surface and acknowledge that the prospect controls its UI.
- For Type B, describe the concrete user-to-user interaction and use conditional
  language such as “It made me wonder whether…”, “may”, or “could”. Sell the
  workflow rather than generic “chat” or “engagement.”
- End with one low-pressure invitation to a 15-minute conversation, varied to
  fit the prospect.
- Sign as Ruchi. Never invent previous contact or a personal relationship.

Structure:

1. Specific, sourced product observation.
2. Specific messaging infrastructure problem or workflow opportunity.
3. How verified ConvoKit capabilities relate.
4. A concise 15-minute CTA.

If replacing the company name makes most of the email work for another company,
rewrite it.

## Accuracy and wording

Keep observed facts separate from inferred hypotheses. Do not present an
inference as an internal company fact. Never invent product features, technical
architecture, user workflows, integrations, counts, priorities, or problems.

Avoid generic openings such as “Hope you're doing well,” “I wanted to reach
out,” “I'm reaching out because,” or “I came across your company.” Avoid hype,
fake urgency, excessive adjectives, long feature lists, and unnecessary em
dashes. Do not use “revolutionize,” “seamlessly,” “game-changing,” “powerful
solution,” “unlock,” “supercharge,” “best-in-class,” “cutting-edge,” “boost
engagement,” “touch base,” or “circle back.”

## Follow-up sequence rules

These apply when a dedicated follow-up workflow is implemented. The current
workflow stores only the first touch and must not put three messages into one
outreach record.

- Follow-up 1 adds new, verified information and makes ConvoKit concrete for the
  prospect's workflow. Keep capabilities short. Include pricing or comparisons
  only when current plans are directly verified and comparable. Prefer 70–100
  words and never exceed 130.
- Follow-up 2 closes the loop and reinforces why this company was contacted.
  Make the workflow concrete; do not repeat features or pricing. Do not guilt
  the recipient, fabricate urgency, or say “just checking in.” Prefer 70–100
  words and never exceed 130.

## Persistence and human review

The readable report should record company, fit (`HIGH`, `MEDIUM`, or `LOW`),
prospect type, one-sentence sales thesis, 2–4 sourced observations, proposed
workflow, and conversation context. For `LOW` fit, record why it was skipped and
do not create outreach.

A public email listing is not a personalization signal. If there is no credible
signal, skip drafting rather than inventing one. Every generated or rewritten
email stays `DRAFT`. Only explicit human dashboard approval can advance it to
`READY_TO_SEND`. Never send messages, create Gmail drafts, or grant approval
during generation or rewriting.
