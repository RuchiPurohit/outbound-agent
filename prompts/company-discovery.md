# Company discovery

Research companies for the requested campaign using its stored segment and
`docs/ICP.md` as the qualification criteria.

For every company, verify and collect:

- company name
- canonical domain
- approximate employee count
- geography
- strongest relevant signal
- source URL for that signal
- a specific reason it might need ConvoKit
- ICP score from 0 to 100
- whether chat or user-to-user messaging already exists as a product feature
- public source URL proving the chat feature when it exists

## Required qualification gate

Before storing a company, write an internal one-sentence thesis:

> ConvoKit may be relevant because [verified human participant A] needs to
> communicate with [verified human participant B] about [specific product
> object/workflow], or because the company maintains [verified human-to-human
> messaging surface] that is not its core product/IP, or because [sourced
> comments/forum/collaboration feature or product workflow] creates a plausible
> embedded-chat opportunity.

Store the company when first-party evidence supports any one of those paths.
Comments, forums, support discussions, and collaboration are automatic
messaging-fit qualifiers. A product-specific hypothesis that chat could improve
engagement is also an automatic qualifier when it is anchored to a sourced
feature, audience, or workflow. Mark the benefit as a hypothesis; do not state
that improved engagement is proven.

Rules:

- Important claims must have a public source URL.
- Never invent a company, employee count, location, event, or product claim.
- If a field cannot be verified, store it as unknown rather than guessing.
- Search official product pages or documentation for chat, messaging, inbox, or
  user-to-user conversations. Store `PRESENT` only when a public source directly
  proves human-to-human messaging, with that URL. AI assistant/chatbot surfaces
  alone do not count as user-to-user chat. Store `NO_PUBLIC_EVIDENCE` when the
  search was completed but found no reliable public evidence. Otherwise store
  `UNKNOWN`.
- `NO_PUBLIC_EVIDENCE` is not a claim that the feature is absent.
- Exclude candidates whose only messaging signal is human-to-AI chat, an AI
  assistant, copilot, or chatbot. AI products qualify only when a separate,
  verified human-to-human workflow passes the gate above.
- Exclude mature chat, messaging, or realtime-collaboration products where that
  infrastructure is already the core product or clear core IP.
- Treat sourced comments, forums, support discussions, and collaboration
  features as automatic qualifiers for deeper ConvoKit research, even when they
  are not equivalent to embedded chat.
- Treat a plausible product-specific “chat could improve engagement” idea as an
  automatic qualifier. Persist the observed product evidence and phrase the
  possible benefit as a hypothesis rather than a fact.
- Do not store a low-fit candidate merely because it matches the requested
  industry, geography, employee count, or has an interesting technical signal.
- Do not discover contacts, emails, or create outreach.
- Do not insert duplicate domains into the campaign.
- Store each new company as `DISCOVERED`; only the user may approve it.
- Store the strongest signal and its source as a company-level research record.
- Rank results by ICP score and write `data/campaign-<id>-companies.md`, including
  a readable "Chat feature" column and the chat source when present.

This is an execution run: research, persist, and report the requested number of
qualified companies. Do not merely describe the process.
