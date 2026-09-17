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

Rules:

- Important claims must have a public source URL.
- Never invent a company, employee count, location, event, or product claim.
- If a field cannot be verified, store it as unknown rather than guessing.
- Search official product pages or documentation for chat, messaging, inbox, or
  user-to-user conversations. Store `PRESENT` only when a public source directly
  proves the feature, with that URL. Store `NO_PUBLIC_EVIDENCE` when the search
  was completed but found no reliable public evidence. Otherwise store `UNKNOWN`.
- `NO_PUBLIC_EVIDENCE` is not a claim that the feature is absent.
- Do not discover contacts, emails, or create outreach.
- Do not insert duplicate domains into the campaign.
- Store each new company as `DISCOVERED`; only the user may approve it.
- Store the strongest signal and its source as a company-level research record.
- Rank results by ICP score and write `data/campaign-<id>-companies.md`, including
  a readable "Chat feature" column and the chat source when present.

This is an execution run: research, persist, and report the requested number of
qualified companies. Do not merely describe the process.
