# Follow-up email generation

Read AGENTS.md, docs/PRODUCT.md, and docs/EMAIL_RULES.md. Use the campaign and
database supplied by the dashboard. Never modify application code or approval
states.

The dashboard supplies an explicit list of first-touch outreach IDs. Process
ONLY those IDs. An empty or missing selection means no drafting is authorized.
Never expand the selection to other sent emails.

1. For each ID, read getOutreach(id). It must be a first touch
   (`followUpOf` is null) with status SENT. Skip REPLIED emails.
2. Call nextFollowUpStep(id). `1` means write Follow-up 1, `2` means write
   Follow-up 2, and `undefined` means skip it (a follow-up is still pending or
   both exist).
3. Read the first touch's subject, body, and cited signal
   (getResearchRecord(researchId)), plus the company, listProspectSignals(contactId),
   painHypothesis, and relevance from getProspectResearch(contactId). For
   Follow-up 2, also read Follow-up 1 with getFollowUp(id, 1) so the closing
   email does not repeat it.
4. Choose the demo scenario from the company's segment using the table in
   docs/PRODUCT.md, and build the link exactly as documented there:
   `https://convokit.app/demo?for=<Company>&s=<scenario>`.
5. Write the follow-up per that step's rules in `docs/EMAIL_RULES.md`:
   - Follow-up 1 shares the live demo. Name the idea from the first touch in a
     few words, give the one demo link, describe in one sentence what the
     scenario opens with (use the scenario's wording in docs/PRODUCT.md) and one
     sentence tying it to the prospect's product, then end with the easy
     "not now" line instead of a call request.
   - Follow-up 2 closes the loop: offer to send the demo to whoever owns the
     area, or leave it there, with the same demo link.
   - Start with `Hi <first name>,` and end with `Ruchi` and
     `https://convokit.app/` on separate lines.
   - Never claim or imply that the recipient read, opened, clicked, or ignored
     an earlier email. Do not say "just checking in", "bumping this", or
     "following up on my last email". Do not guilt the recipient or fabricate
     urgency.
   - Mention only capabilities confirmed in docs/PRODUCT.md. Never mention a
     capability listed there as not yet available.
   - Apply the phrase and tone rules for first touches.
6. Use createFollowUp({outreachId, body}) to store one DRAFT. The step, subject
   (`Re: <original subject>`), and cited signal are set automatically so the
   email threads under the first touch; do not try to change them.

For a requested rewrite of a follow-up (the outreach has `followUpOf` set), use
rewriteOutreach(id, {subject, body, researchId}) with the follow-up's existing
subject and researchId. Only the body may change. Its `followUpStep` says which
rules apply.

Write/update data/campaign-<id>-follow-ups.md with each processed first-touch
ID, the step written, the scenario and demo link used, and the created or
skipped follow-up ID. Summarize the created follow-up IDs.

No messages may be sent, no Gmail drafts created, no sending scheduled, and no
approval granted. Follow-up 1 unlocks 7 days after the first touch and
Follow-up 2 7 days after Follow-up 1, each only after an explicit human send
confirmation in the dashboard.
