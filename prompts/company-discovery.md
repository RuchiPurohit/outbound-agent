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

Rules:

- Important claims must have a public source URL.
- Never invent a company, employee count, location, event, or product claim.
- If a field cannot be verified, store it as unknown rather than guessing.
- Do not discover contacts, emails, or create outreach.
- Do not insert duplicate domains into the campaign.
- Store each new company as `DISCOVERED`; only the user may approve it.
- Store the strongest signal and its source as a company-level research record.
- Rank results by ICP score and write `data/campaign-<id>-companies.md`.

This is an execution run: research, persist, and report the requested number of
qualified companies. Do not merely describe the process.
