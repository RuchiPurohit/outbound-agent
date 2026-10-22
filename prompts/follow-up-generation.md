# Follow-up email generation

Read AGENTS.md, docs/PRODUCT.md, and docs/EMAIL_RULES.md. Use the campaign and
database supplied by the dashboard. Never modify application code or approval
states.

The dashboard supplies an explicit list of first-touch outreach IDs. Process
ONLY those IDs. An empty or missing selection means no drafting is authorized.
Never expand the selection to other sent emails.

1. For each ID, read getOutreach(id). It must be a first touch
   (`followUpOf` is null) with status SENT. Skip REPLIED emails and any email
   where getFollowUp(id) already returns a follow-up.
2. Read the first touch's subject, body, and cited signal
   (getResearchRecord(researchId)), plus listProspectSignals(contactId),
   painHypothesis, and relevance from getProspectResearch(contactId).
3. Write Follow-up 1 per `docs/EMAIL_RULES.md`:
   - Add one new, verified piece of information that the first email did not
     use, such as another sourced prospect signal or a ConvoKit capability
     confirmed in docs/PRODUCT.md, convokit.app, or convokit.app/docs. Make
     ConvoKit concrete for the prospect's workflow. If no new verified
     information exists, restate the original workflow more concretely rather
     than inventing anything.
   - Prefer 70–100 words and never exceed 130.
   - Start with `Hi <first name>,` and end with `Ruchi` and `https://convokit.app/` on
     separate lines. Keep the low-friction 10-minute call invitation.
   - Never claim or imply that the recipient read, opened, or ignored the first
     email. Do not say "just checking in", "bumping this", or "following up on
     my last email". Do not guilt the recipient or fabricate urgency.
   - Apply the phrase and tone rules for first touches.
4. Use createFollowUp({outreachId, body}) to store one DRAFT. The subject
   (`Re: <original subject>`) and cited signal are inherited automatically so
   the email threads under the first touch; do not try to change them.

For a requested rewrite of a follow-up (the outreach has `followUpOf` set), use
rewriteOutreach(id, {subject, body, researchId}) with the follow-up's existing
subject and researchId. Only the body may change.

Write/update data/campaign-<id>-follow-ups.md with each processed first-touch
ID, the new information used (with source URL), and the created or skipped
follow-up ID. Summarize the created follow-up IDs.

No messages may be sent, no Gmail drafts created, no sending scheduled, and no
approval granted. Sending unlocks only after the 7-day wait and an explicit
human send confirmation in the dashboard.
