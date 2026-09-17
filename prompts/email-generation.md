# First-touch email generation and rewriting

Read AGENTS.md and docs/EMAIL_RULES.md. Use the campaign/database supplied by
the dashboard. Never modify application code or approval states.

For generation:

The dashboard supplies an explicit contact ID selection. Process ONLY those
checked IDs. An empty or missing selection means no drafting is authorized.
Never expand the selection to other eligible prospects.

1. Use listEligibleProspects(campaignId). Both company and contact must remain
   APPROVED, with a PUBLICLY_LISTED or VERIFIED professional business email.
2. Require getProspectResearch(contactId).status === READY. Skip NO_SIGNAL.
3. Skip any contact with existing outreach, including rejected or sent outreach.
   Do not duplicate first-touch emails on retry.
4. Read listProspectSignals(contactId), strongestResearchId, painHypothesis,
   and relevance. Reference the strongest verified signal in the email body.
5. Apply the qualification and prospect-type rules in `docs/EMAIL_RULES.md`.
   Re-check the workflow using current first-party sources and verify every
   mentioned ConvoKit capability against convokit.app or convokit.app/docs.
   Sourced comments, forums, support discussions, or collaboration features and
   sourced product-specific chat engagement hypotheses are automatic qualifiers:
   treat them as at least MEDIUM fit and create a conditional Type B draft. Do
   not discard them merely because embedded chat, both participant roles, or
   internal demand are not public. For other LOW-fit prospects, record the skip
   and create no draft.
6. Use createOutreach({contactId, subject, body, researchId}) to store one DRAFT.
   researchId must identify the cited prospect signal, not role/email evidence.
   This workflow creates one first-touch only, not follow-ups.

For a requested rewrite:

- Re-read the target outreach record and its contact's research.
- Process only the specified DRAFT ID in the specified campaign.
- Apply the human style feedback without inventing facts or dropping the signal.
- Use rewriteOutreach(id, {subject, body, researchId}); update the same record.
- Never rewrite APPROVED, READY_TO_SEND, REJECTED, SENT, or REPLIED emails.

Write/update data/campaign-<id>-drafts.md with fit, prospect type, sales thesis,
sourced observations, proposed workflow, conversation context, and completed or
skipped draft IDs. Summarize completed draft IDs.
No messages may be sent, no Gmail drafts created, and no approval granted.
The workflow must stop for human review.
