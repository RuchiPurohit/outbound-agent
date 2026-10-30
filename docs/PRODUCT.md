# ConvoKit product profile

This file records product capabilities confirmed directly by the ConvoKit owner.
It is an authoritative internal source for company research and email drafting,
alongside the current public website and documentation. Last confirmed:
2026-10-30.

## Product shape

ConvoKit is hosted chat infrastructure for teams that want chat as a feature,
not as their core product. Customers can build and control their own product UI
on top of ConvoKit's backend.

## Confirmed capabilities

- hosted conversation APIs
- participant management and access controls
- realtime message delivery
- custom UI support
- Flutter support
- React web support
- React Native support
- webhooks, including event delivery suitable for analytics integrations
- signed, retried `message.created` webhooks that carry the message and its
  recipient IDs, so a customer can notify recipients by email or Slack in
  their own product
- audit trails

## Live demo

A no-signup demo runs at https://convokit.app/demo. The visitor plays both
people in a real ConvoKit conversation: they type in the left window and it
arrives in the right window instantly, with typing indicators and history. A
QR code makes their phone the second screen. The client code behind it is shown
on the same page. Demo messages are deleted after 15 minutes.

Link format: `https://convokit.app/demo?for=<Company>&s=<scenario>`

- `for` puts the company's name in the page headings. Use the company's own
  capitalization (`ToolJet`, not `tooljet`); only letters, digits, spaces, and
  hyphens are shown.
- `s` picks one scenario per segment. Omit it when no scenario fits; the page
  then shows the generic live chat.

| Scenario (`s=`) | Use for | Opens on |
| --- | --- | --- |
| `agent-review` | Agent platforms, AI coding and dev tools, internal-tool builders | an agent that finished a change but skipped two failing tests, and a teammate deciding whether to ship it or rerun |
| `marketplace` | Marketplaces with buyers and sellers | a buyer and seller sorting out an order |
| `coaching` | Health, coaching, wellness, tutoring | a weekly check-in between a client and their coach |
| `support` | Products whose customers contact a support team | a customer starting a chat with support |
| `community` | Edtech, cohorts, communities | a cohort thread where members ask about this week's lesson |
| (omit `s`) | Anything else | a live chat with a visitor |

## Not yet available

Do not mention these in outreach until this file lists them as confirmed:

- email notifications to a team when a website visitor writes in the chat
  widget's support inbox

Do not extrapolate additional capabilities, compliance certifications, service
levels, pricing, or customer/reference claims from this list. Re-check this file
and public sources before every research or drafting run.
