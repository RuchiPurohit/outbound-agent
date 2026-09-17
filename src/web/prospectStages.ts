import type { OutboundStore } from "../db/store.js";

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export function renderProspectStages(
  store: OutboundStore, campaignId: number, selectedDraftId?: number,
): string {
  const companies = store.listCompanies({ campaignId });
  const contacts = companies.flatMap(({ id }) => store.listContacts(id));
  const eligible = store.listEligibleProspects(campaignId);
  const activeRuns = store.listWorkflowRuns().filter(({ status }) => status === "RUNNING" || status === "PENDING");
  const active = activeRuns.length > 0;
  const researchPending = eligible.filter(({ id }) => !store.getProspectResearch(id));
  const draftPending = eligible.filter(({ id }) => store.getProspectResearch(id)?.status === "READY"
    && store.listOutreach(id).length === 0);
  const selectable = new Set(draftPending.map(({ id }) => id));
  const researchInProgress = activeRuns.some((run) =>
    run.campaignId === campaignId && run.kind === "PROSPECT_RESEARCH");
  const researchEmptyMessage = researchInProgress
    ? "Prospect research is in progress. Saved signals and personalization angles will appear here as results arrive."
    : researchPending.length > 0
      ? active
        ? "Approved prospects with business emails are ready for research. Wait for the active workflow to finish before starting research."
        : "Approved prospects with business emails are ready for research. Click Run prospect research, then check the researched contacts you want emails drafted for."
      : "No eligible prospects are ready for research. Approve companies and contacts, then discover their business emails to unlock this step.";

  const researchCards = contacts.map((contact) => {
    const analysis = store.getProspectResearch(contact.id);
    if (!analysis) return "";
    const company = companies.find(({ id }) => id === contact.companyId)!;
    const signals = store.listProspectSignals(contact.id);
    const hasDraft = store.listOutreach(contact.id).length > 0;
    const label = hasDraft ? "Draft already exists"
      : analysis.status === "NO_SIGNAL" ? "No credible angle"
      : selectable.has(contact.id) ? "Ready for drafting" : "Not eligible for drafting";
    return `<div style="padding:12px 0;border-top:1px solid var(--line)"><label class="inline"><input class="check" type="checkbox" name="contactIds" value="${contact.id}" aria-label="Generate draft for ${escapeHtml(contact.name)}" ${active || !selectable.has(contact.id) ? "disabled" : ""}>${escapeHtml(contact.name)} · ${escapeHtml(company.name)} <span class="badge ${analysis.status === "READY" ? "COMPLETED" : "UNKNOWN"}">${label}</span></label><details><summary>View research</summary>${signals.map((signal) => `<p>${signal.id === analysis.strongestResearchId ? "<strong>Strongest signal:</strong> " : "Signal: "}${escapeHtml(signal.signal)}<br><a href="${escapeHtml(signal.sourceUrl)}" target="_blank" rel="noreferrer">Source ↗</a></p>`).join("")}${analysis.status === "READY" ? `<p><strong>Pain hypothesis (not verified):</strong> ${escapeHtml(analysis.painHypothesis)}</p><p><strong>ConvoKit relevance:</strong> ${escapeHtml(analysis.relevance)}</p>` : `<p class="muted">${escapeHtml(analysis.notes ?? "No sufficiently specific, sourced personalization signal was found. Drafting is blocked.")}</p>`}</details></div>`;
  }).join("");

  const outreach = contacts.flatMap(({ id }) => store.listOutreach(id));
  const emails = outreach.map((draft) => {
    const contact = contacts.find(({ id }) => id === draft.contactId)!;
    const company = companies.find(({ id }) => id === contact.companyId)!;
    const signal = draft.researchId === null ? undefined : store.getResearchRecord(draft.researchId);
    const delivery = store.listEmailDeliveries().find((item) => item.outreachId === draft.id);
    const canApprove = eligible.some(({ id }) => id === contact.id)
      && store.getProspectResearch(contact.id)?.status === "READY"
      && store.listProspectSignals(contact.id).some(({ id }) => id === draft.researchId);
    const reviewControls = draft.status === "DRAFT"
      ? `<form method="post" action="/campaigns/${campaignId}/outreach/${draft.id}/review" class="actions"><button name="decision" value="APPROVED" ${active || !canApprove ? "disabled" : ""}>Approve → Ready to send</button><button name="decision" value="REJECTED" class="danger" ${active ? "disabled" : ""}>Reject draft</button></form><form method="post" action="/campaigns/${campaignId}/outreach/${draft.id}/rewrite" style="margin-top:16px"><label><span>Rewrite instructions</span><textarea name="feedback" required maxlength="2000" placeholder="Less salesy; shorten the opening and keep the technical detail."></textarea></label><button class="secondary" ${active ? "disabled" : ""}>Request rewrite</button></form>` : "";
    const blocked = delivery && delivery.status !== "FAILED";
    const approvalMatches = draft.approvedRecipient === contact.email
      && draft.approvedSubject === draft.subject && draft.approvedBody === draft.body && canApprove;
    const sendControls = draft.status === "READY_TO_SEND"
      ? blocked
        ? `<div class="notice">Delivery ${delivery.status.toLowerCase()}. ${escapeHtml(delivery.error ?? "Wait for Gmail confirmation. Sending again is blocked.")}</div>`
        : `${delivery?.error ? `<div class="notice error">${escapeHtml(delivery.error)}</div>` : ""}${approvalMatches
          ? active ? '<p class="muted">Wait for the active workflow before sending.</p>'
            : `<a class="button" href="/campaigns/${campaignId}/outreach/${draft.id}/send">Review &amp; send via Gmail</a>`
          : '<div class="notice">This email needs fresh approval before sending because its recipient or content was not captured by the original approval.</div>'}<form method="post" action="/campaigns/${campaignId}/outreach/${draft.id}/restore" style="margin-top:12px"><button class="secondary" ${active ? "disabled" : ""}>Return to draft for review</button></form>`
      : delivery?.status === "SENT"
        ? `<p class="muted">Sent from ${escapeHtml(delivery.fromEmail)} · ${escapeHtml(delivery.finishedAt)}<br>Gmail message: ${escapeHtml(delivery.gmailMessageId)} · Thread: ${escapeHtml(delivery.gmailThreadId)}</p>` : "";
    return `<details class="email-draft" id="email-${draft.id}"${draft.id === selectedDraftId ? " open" : ""}><summary>${escapeHtml(contact.name)} · ${escapeHtml(company.name)} · ${escapeHtml(draft.subject)} <span class="badge ${draft.status}">${escapeHtml(draft.status.replaceAll("_", " "))}</span></summary><p><strong>To:</strong> ${escapeHtml(delivery?.toEmail ?? draft.approvedRecipient ?? contact.email ?? "No email")} · ${escapeHtml(contact.title)}</p><p><strong>Subject:</strong> ${escapeHtml(draft.subject)}</p><pre class="email-preview">${escapeHtml(draft.body)}</pre>${signal ? `<p class="muted"><strong>Cited signal:</strong> ${escapeHtml(signal.signal)} <a href="${escapeHtml(signal.sourceUrl)}" target="_blank" rel="noreferrer">Source ↗</a></p>` : '<div class="notice error">This legacy draft has no linked prospect signal and cannot be approved. Reject it or complete research and request a rewrite.</div>'}${reviewControls}${sendControls}</details>`;
  }).join("");
  const emailEmptyMessage = draftPending.length
    ? "No emails generated yet. Check researched prospects above and click Generate drafts for checked contacts."
    : researchPending.length
      ? "No emails generated yet. Complete prospect research, then select contacts for drafting."
      : "No emails generated yet. Drafting requires an approved prospect with a business email and a credible research signal.";

  return `<section class="card span12"><div class="cardhead"><div><span class="eyebrow">Stage 4 · Phase 10</span><h2>Prospect research</h2></div><form method="post" action="/campaigns/${campaignId}/workflows/prospect-research"><button ${active || researchPending.length === 0 ? "disabled" : ""}>Run prospect research</button></form></div><p class="muted">${researchPending.length} eligible prospect(s) awaiting research. At most three useful sourced signals per prospect; pain is a hypothesis, never an assumed fact. Research stops here for selection. Only checked contacts will get email drafts.</p><form method="post" action="/campaigns/${campaignId}/workflows/email-generation">${researchCards || `<div class="empty">${researchEmptyMessage}</div>`}${researchCards ? `<p class="muted">${draftPending.length} researched prospect(s) available for drafting. Contacts with existing drafts or no credible angle cannot be selected.</p><div class="actions"><button type="button" class="secondary" data-select ${active || draftPending.length === 0 ? "disabled" : ""}>Select all available</button><button ${active || draftPending.length === 0 ? "disabled" : ""}>Generate drafts for checked contacts</button></div>` : ""}</form></section><section class="card span12" id="draft-review"><div class="cardhead"><div><span class="eyebrow">Stage 5 · Phases 11–12</span><h2>Emails</h2></div><span class="badge">${outreach.length} saved email(s)</span></div><p class="muted">Expand an email to review its draft and source, approve, request a rewrite, or reject. Generated emails follow docs/EMAIL_RULES.md. READY_TO_SEND emails require a separate Gmail send confirmation. Approval alone never sends an email.</p>${emails || `<div class="empty">${emailEmptyMessage}</div>`}</section>`;
}
