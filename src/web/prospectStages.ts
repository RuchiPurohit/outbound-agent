import { FOLLOW_UP_DELAY_DAYS, formatDueAt, type OutboundStore } from "../db/store.js";
import type { Outreach } from "../db/types.js";
import { guessVerificationBadge } from "./emailResults.js";

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export function renderProspectStages(
  store: OutboundStore, campaignId: number, selectedDraftId?: number, sendStatus = "",
): string {
  const companies = store.listCompanies({ campaignId });
  const contacts = companies.flatMap(({ id }) => store.listContacts(id));
  const eligible = store.listEligibleProspects(campaignId);
  const researchEligible = store.listResearchEligibleProspects(campaignId);
  const activeRuns = store.listWorkflowRuns().filter(({ status }) => status === "RUNNING" || status === "PENDING");
  const active = activeRuns.length > 0;
  const researchPending = researchEligible.filter(({ id }) => !store.getProspectResearch(id));
  const draftPending = eligible.filter(({ id }) => store.getProspectResearch(id)?.status === "READY"
    && store.listOutreach(id).length === 0);
  const selectable = new Set(draftPending.map(({ id }) => id));
  const researchInProgress = activeRuns.some((run) =>
    run.campaignId === campaignId && run.kind === "PROSPECT_RESEARCH");
  const researchEmptyMessage = researchInProgress
    ? "Prospect research is in progress. Saved signals and personalization angles will appear here as results arrive."
    : researchPending.length > 0
      ? active
        ? "Approved prospects with sourced or guessed emails are ready for research. Wait for the active workflow to finish before starting research."
        : "Approved prospects with sourced or guessed emails are ready for research. Click Run prospect research. Guessed recipients remain clearly labelled through drafting and send confirmation."
      : "No eligible prospects are ready for research. Approve companies and contacts, then discover or separately guess their business emails to unlock this step.";

  const noSignal = contacts.filter(({ id }) => store.getProspectResearch(id)?.status === "NO_SIGNAL"
    && store.listOutreach(id).length === 0).length;
  const researchCards = contacts.map((contact) => {
    const analysis = store.getProspectResearch(contact.id);
    if (!analysis) return "";
    const company = companies.find(({ id }) => id === contact.companyId)!;
    const signals = store.listProspectSignals(contact.id);
    const hasDraft = store.listOutreach(contact.id).length > 0;
    const label = hasDraft ? "Draft already exists"
      : analysis.status === "NO_SIGNAL" ? "No credible angle"
      : selectable.has(contact.id) ? "Ready for drafting" : "Not eligible for drafting";
    return `<div style="padding:12px 0;border-top:1px solid var(--line)"><label class="inline"><input class="check" type="checkbox" name="contactIds" value="${contact.id}" aria-label="Generate draft for ${escapeHtml(contact.name)}" ${active || !selectable.has(contact.id) ? "disabled" : ""}>${escapeHtml(contact.name)} · ${escapeHtml(company.name)} <span class="badge ${analysis.status === "READY" ? "COMPLETED" : "UNKNOWN"}">${label}</span></label>${analysis.status === "NO_SIGNAL" && !hasDraft ? ` <label class="inline" style="display:inline-flex;margin:0 0 0 8px"><input class="check" type="checkbox" name="recheckIds" value="${contact.id}" aria-label="Recheck angle for ${escapeHtml(contact.name)}" ${active ? "disabled" : ""}>Recheck</label> <button class="secondary" formaction="/campaigns/${campaignId}/contacts/${contact.id}/recheck-angle" formnovalidate ${active ? "disabled" : ""}>Recheck angle</button>` : ""}<details><summary>View research</summary>${signals.map((signal) => `<p>${signal.id === analysis.strongestResearchId ? "<strong>Strongest signal:</strong> " : "Signal: "}${escapeHtml(signal.signal)}<br><a href="${escapeHtml(signal.sourceUrl)}" target="_blank" rel="noreferrer">Source ↗</a></p>`).join("")}${analysis.status === "READY" ? `<p><strong>Pain hypothesis (not verified):</strong> ${escapeHtml(analysis.painHypothesis)}</p><p><strong>ConvoKit relevance:</strong> ${escapeHtml(analysis.relevance)}</p>` : `<p class="muted">${escapeHtml(analysis.notes ?? "No sufficiently specific, sourced personalization signal was found. Drafting is blocked.")}</p>`}</details></div>`;
  }).join("");

  const outreach = contacts.flatMap(({ id }) => store.listOutreach(id))
    .filter(({ status }) => status !== "SENT" && status !== "REPLIED" && status !== "BOUNCED");
  const drafts = outreach.filter(({ status }) => status === "DRAFT");
  const guessedDrafts = drafts.filter(({ contactId }) => store.getContactRecipient(contactId)?.guessed).length;
  const confirmText = `Approve ${drafts.length} draft(s) as READY_TO_SEND?${guessedDrafts ? ` ${guessedDrafts} go to unverified guessed recipients.` : ""} Nothing is sent; each email still needs its own send confirmation.`;
  const approveAll = drafts.length
    ? `<form method="post" action="/campaigns/${campaignId}/outreach/approve-all" onsubmit="return confirm(this.dataset.confirm)" data-confirm="${escapeHtml(confirmText)}">${drafts.map(({ id }) => `<input type="hidden" name="ids" value="${id}">`).join("")}<button ${active ? "disabled" : ""}>Approve all drafts → Ready to send (${drafts.length})</button></form>`
    : "";
  const deliveries = store.listEmailDeliveries();
  const sendable = outreach.filter((email) => {
    if (email.status !== "READY_TO_SEND" || email.followUpOf !== null) return false;
    if (deliveries.some((item) => item.outreachId === email.id && item.status !== "FAILED")) return false;
    try { store.assertReadyToSend(email.id); return true; } catch { return false; }
  }).length;
  const sendAll = sendable && !sendStatus.includes("data-sending")
    ? `<a class="button" href="/campaigns/${campaignId}/send-all">Send all ready emails (${sendable})</a>` : "";
  const emails = outreach.map((draft) => {
    const contact = contacts.find(({ id }) => id === draft.contactId)!;
    const company = companies.find(({ id }) => id === contact.companyId)!;
    return `<details class="email-draft" id="email-${draft.id}"${draft.id === selectedDraftId ? " open" : ""}><summary>${escapeHtml(contact.name)} · ${escapeHtml(company.name)} · ${escapeHtml(draft.subject)} <span class="badge ${draft.status}">${escapeHtml(draft.status.replaceAll("_", " "))}</span></summary>${renderOutreachReview(store, campaignId, draft)}</details>`;
  }).join("");
  const emailEmptyMessage = draftPending.length
    ? "No emails generated yet. Check researched prospects above and click Generate drafts for checked contacts."
    : researchPending.length
      ? "No emails generated yet. Complete prospect research, then select contacts for drafting."
      : "No emails generated yet. Drafting requires an approved prospect with a business email and a credible research signal.";

  return `<section class="card span12" id="prospect-research"><div class="cardhead"><div><span class="eyebrow">Stage 4 · Phase 10</span><h2>Prospect research</h2></div><form method="post" action="/campaigns/${campaignId}/workflows/prospect-research"><button ${active || researchPending.length === 0 ? "disabled" : ""}>Run prospect research</button></form></div><p class="muted">${researchPending.length} eligible prospect(s) awaiting research. At most three useful sourced signals per prospect; pain is a hypothesis, never an assumed fact. Research stops here for selection. Only checked contacts will get email drafts.</p><form method="post" action="/campaigns/${campaignId}/workflows/email-generation">${researchCards || `<div class="empty">${researchEmptyMessage}</div>`}${researchCards ? `<p class="muted">${draftPending.length} researched prospect(s) available for drafting. Contacts with existing drafts or no credible angle cannot be selected.</p><div class="actions"><button type="button" class="secondary" data-select="contactIds" ${active || draftPending.length === 0 ? "disabled" : ""}>Select all available</button><button ${active || draftPending.length === 0 ? "disabled" : ""}>Generate drafts for checked contacts</button>${noSignal ? `<button type="button" class="secondary" data-select="recheckIds" ${active ? "disabled" : ""}>Select all no-angle (${noSignal})</button><button class="secondary" formaction="/campaigns/${campaignId}/contacts/recheck-angles" formnovalidate ${active ? "disabled" : ""}>Recheck checked angles</button>` : ""}</div>` : ""}</form></section><section class="card span12" id="draft-review"><div class="cardhead"><div><span class="eyebrow">Stage 5 · Phases 11–12</span><h2>Emails</h2></div><div class="actions" style="align-items:center">${approveAll}${sendAll}<span class="badge">${outreach.length} saved email(s)</span></div></div><p class="muted">Expand an email to review its draft and source, approve, request a rewrite, or reject. Generated emails follow docs/EMAIL_RULES.md. READY_TO_SEND emails require a separate Gmail send confirmation. Approval alone never sends an email. Sent emails move to the <a href="/campaigns/${campaignId}/follow-ups">Sent &amp; follow-ups</a> tab.</p>${sendStatus}${emails || `<div class="empty">${emailEmptyMessage}</div>`}</section>`;
}

/** Recipient, editable draft, cited signal, and review/send controls for one email. */
export function renderOutreachReview(store: OutboundStore, campaignId: number, draft: Outreach): string {
  const active = store.listWorkflowRuns().some(({ status }) => status === "RUNNING" || status === "PENDING");
  const transportLabel = process.env.EMAIL_TRANSPORT === "mcp" ? "Custom Mail MCP" : "Gmail";
  const contact = store.getContact(draft.contactId)!;
  const eligible = store.listEligibleProspects(campaignId);
  const parent = draft.followUpOf === null ? undefined : store.getOutreach(draft.followUpOf);
  const dueAt = store.followUpSendableAt(draft);
  const notDue = dueAt !== undefined && Date.now() < dueAt.getTime();
  // Follow-up 2 has no send date until Follow-up 1 itself was sent.
  const awaitingPrevious = parent !== undefined && parent.status === "SENT" && dueAt === undefined;
  const previousEmail = draft.followUpStep === 2 ? "Follow-up 1" : "the first email";
  const recipient = store.getContactRecipient(contact.id);
  const signal = draft.researchId === null ? undefined : store.getResearchRecord(draft.researchId);
  const delivery = store.listEmailDeliveries().find((item) => item.outreachId === draft.id);
  const canApprove = eligible.some(({ id }) => id === contact.id)
    && store.getProspectResearch(contact.id)?.status === "READY"
    && store.listProspectSignals(contact.id).some(({ id }) => id === draft.researchId);
  const draftContent = draft.status === "DRAFT"
    ? `<form method="post" action="/campaigns/${campaignId}/outreach/${draft.id}/edit"><label><span>Subject${parent ? " (kept for threading)" : ""}</span><input name="subject" value="${escapeHtml(draft.subject)}" maxlength="250" required${parent ? " readonly" : ""}></label><label><span>Body</span><textarea name="body" maxlength="100000" required style="min-height:320px">${escapeHtml(draft.body)}</textarea></label><button class="secondary" ${active ? "disabled" : ""}>Save draft changes</button></form>`
    : `<p><strong>Subject:</strong> ${escapeHtml(draft.subject)}</p><pre class="email-preview">${escapeHtml(draft.body)}</pre>`;
  const reviewControls = draft.status === "DRAFT"
    ? `<form method="post" action="/campaigns/${campaignId}/outreach/${draft.id}/review" class="actions"><button name="decision" value="APPROVED" ${active || !canApprove ? "disabled" : ""}>Approve → Ready to send</button><button name="decision" value="REJECTED" class="danger" ${active ? "disabled" : ""}>Reject draft</button></form><form method="post" action="/campaigns/${campaignId}/outreach/${draft.id}/rewrite" style="margin-top:16px"><label><span>Rewrite instructions</span><textarea name="feedback" required maxlength="2000" placeholder="Less salesy; shorten the opening and keep the technical detail."></textarea></label><button class="secondary" ${active ? "disabled" : ""}>Request rewrite</button></form>` : "";
  const blocked = delivery && delivery.status !== "FAILED";
  const approvalMatches = draft.approvedRecipient === recipient?.address
    && draft.approvedSubject === draft.subject && draft.approvedBody === draft.body && canApprove;
  const guessedWarning = recipient?.guessed
    ? `<div class="notice error"><strong>Guessed recipient:</strong> ${escapeHtml(recipient.address)} is unverified. Approval and final send confirmation accept the risk of a bounce or wrong mailbox.</div>`
    : contact.guessedEmailVerification === "INVALID"
      ? `<div class="notice error"><strong>Guessed recipient rejected:</strong> ${escapeHtml(contact.guessedEmail)} was rejected by the recipient's mail server, so this email cannot be approved or sent.</div>`
      : "";
  const sendControls = draft.status === "READY_TO_SEND"
    ? blocked
      ? `<div class="notice">Delivery ${delivery.status.toLowerCase()}. ${escapeHtml(delivery.error ?? "Wait for Gmail confirmation. Sending again is blocked.")}</div>`
      : `${delivery?.error ? `<div class="notice error">${escapeHtml(delivery.error)}</div>` : ""}${approvalMatches
        ? active ? '<p class="muted">Wait for the active workflow before sending.</p>'
          : parent?.status === "REPLIED" ? '<p class="muted">The prospect replied, so this follow-up will not be sent.</p>'
          : parent?.status === "BOUNCED" ? '<p class="muted">The first email bounced, so this follow-up will not be sent.</p>'
          : awaitingPrevious ? `<p class="muted">Approved. Sending unlocks ${FOLLOW_UP_DELAY_DAYS} days after Follow-up 1 is sent.</p>`
          : notDue ? `<p class="muted">Approved. Sending unlocks ${escapeHtml(formatDueAt(dueAt!))}, ${FOLLOW_UP_DELAY_DAYS} days after ${previousEmail}.</p>`
          : `<a class="button" href="/campaigns/${campaignId}/outreach/${draft.id}/send">Review &amp; send via ${escapeHtml(transportLabel)}</a>`
        : '<div class="notice">This email needs fresh approval before sending because its recipient or content was not captured by the original approval.</div>'}<form method="post" action="/campaigns/${campaignId}/outreach/${draft.id}/restore" style="margin-top:12px"><button class="secondary" ${active ? "disabled" : ""}>Return to draft for review</button></form>`
    : delivery?.status === "SENT"
      ? `<p class="muted">Sent from ${escapeHtml(delivery.fromEmail)} via ${escapeHtml(delivery.provider)} · ${escapeHtml(delivery.finishedAt)}<br>Provider message: ${escapeHtml(delivery.gmailMessageId)} · Thread: ${escapeHtml(delivery.gmailThreadId)}</p>` : "";
  return `<p><strong>To:</strong> ${escapeHtml(delivery?.toEmail ?? draft.approvedRecipient ?? recipient?.address ?? "No email")}${recipient?.guessed ? ` <span class="badge UNKNOWN">Guessed</span> ${guessVerificationBadge(recipient.verification, contact.guessedEmailVerificationDetail)}` : ""} · ${escapeHtml(contact.title)}</p>${guessedWarning}${draftContent}${signal ? `<p class="muted"><strong>Cited signal:</strong> ${escapeHtml(signal.signal)} <a href="${escapeHtml(signal.sourceUrl)}" target="_blank" rel="noreferrer">Source ↗</a></p>` : '<div class="notice error">This legacy draft has no linked prospect signal and cannot be approved. Reject it or complete research and request a rewrite.</div>'}${reviewControls}${sendControls}`;
}
