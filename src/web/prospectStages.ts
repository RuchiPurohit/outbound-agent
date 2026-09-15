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
  const researchInProgress = activeRuns.some((run) =>
    run.campaignId === campaignId && run.kind === "PROSPECT_RESEARCH");
  const researchEmptyMessage = researchInProgress
    ? "Prospect research is in progress. Saved signals and personalization angles will appear here as results arrive."
    : researchPending.length > 0
      ? active
        ? "Approved prospects with business emails are ready for research. Wait for the active workflow to finish before starting research."
        : "Approved prospects with business emails are ready for research. Click Research → generate drafts to find sourced signals and automatically generate first-touch drafts."
      : "No eligible prospects are ready for research. Approve companies and contacts, then discover their business emails to unlock this step.";
  const researchCards = contacts.map((contact) => {
    const analysis = store.getProspectResearch(contact.id);
    if (!analysis) return "";
    const company = companies.find(({ id }) => id === contact.companyId)!;
    const signals = store.listProspectSignals(contact.id);
    return `<details><summary>${escapeHtml(contact.name)} · ${escapeHtml(company.name)} <span class="badge ${analysis.status === "READY" ? "COMPLETED" : "UNKNOWN"}">${analysis.status === "READY" ? "Researched" : "No credible angle"}</span></summary>${signals.map((signal) => `<p>${signal.id === analysis.strongestResearchId ? "<strong>Strongest signal:</strong> " : "Signal: "}${escapeHtml(signal.signal)}<br><a href="${escapeHtml(signal.sourceUrl)}" target="_blank" rel="noreferrer">Source ↗</a></p>`).join("")}${analysis.status === "READY" ? `<p><strong>Pain hypothesis (not verified):</strong> ${escapeHtml(analysis.painHypothesis)}</p><p><strong>ConvoKit relevance:</strong> ${escapeHtml(analysis.relevance)}</p>` : `<p class="muted">${escapeHtml(analysis.notes ?? "No sufficiently specific, sourced personalization signal was found. Drafting is blocked.")}</p>`}</details>`;
  }).join("");

  const outreach = contacts.flatMap(({ id }) => store.listOutreach(id));
  const drafts = outreach.filter(({ status }) => status === "DRAFT");
  const selected = drafts.find(({ id }) => id === selectedDraftId) ?? drafts[0];
  let review = '<div class="empty">No drafts awaiting review. Completed research automatically moves into draft generation.</div>';
  if (selected) {
    const contact = contacts.find(({ id }) => id === selected.contactId)!;
    const company = companies.find(({ id }) => id === contact.companyId)!;
    const signal = selected.researchId === null ? undefined : store.getResearchRecord(selected.researchId);
    const canApprove = eligible.some(({ id }) => id === contact.id)
      && store.getProspectResearch(contact.id)?.status === "READY"
      && store.listProspectSignals(contact.id).some(({ id }) => id === selected.researchId);
    review = `<div class="cardhead"><h3>${escapeHtml(contact.name)} · ${escapeHtml(contact.title)} · ${escapeHtml(company.name)}</h3><span class="badge DRAFT">Draft ${selected.id}</span></div><p><strong>To:</strong> ${escapeHtml(contact.email ?? "No email")}</p><p><strong>Subject:</strong> ${escapeHtml(selected.subject)}</p><pre class="email-preview">${escapeHtml(selected.body)}</pre>${signal ? `<p class="muted"><strong>Cited signal:</strong> ${escapeHtml(signal.signal)} <a href="${escapeHtml(signal.sourceUrl)}" target="_blank" rel="noreferrer">Source ↗</a></p>` : '<div class="notice error">This legacy draft has no linked prospect signal and cannot be approved. Reject it or complete research and request a rewrite.</div>'}<form method="post" action="/campaigns/${campaignId}/outreach/${selected.id}/review" class="actions"><button name="decision" value="APPROVED" ${active || !canApprove ? "disabled" : ""}>Approve → Ready to send</button><button name="decision" value="REJECTED" class="danger" ${active ? "disabled" : ""}>Reject draft</button></form><form method="post" action="/campaigns/${campaignId}/outreach/${selected.id}/rewrite" style="margin-top:16px"><label><span>Rewrite instructions</span><textarea name="feedback" required maxlength="2000" placeholder="Less salesy; shorten the opening and keep the technical detail."></textarea></label><button class="secondary" ${active ? "disabled" : ""}>Request rewrite</button></form><p class="muted">${drafts.length} draft(s) awaiting review. Approval or rejection opens the next draft.</p><nav class="actions">${drafts.map((draft, index) => `<a class="button secondary" href="/campaigns/${campaignId}?draftId=${draft.id}#draft-review">Draft ${index + 1}</a>`).join("")}</nav>`;
  }
  const reviewed = outreach.filter(({ status }) => status !== "DRAFT");
  const history = reviewed.length ? `<details><summary>Reviewed drafts (${reviewed.length})</summary>${reviewed.map((draft) => `<p><strong>${escapeHtml(contacts.find(({ id }) => id === draft.contactId)?.name)}</strong> · ${escapeHtml(draft.subject)} <span class="badge ${draft.status}">${escapeHtml(draft.status.replaceAll("_", " "))}</span></p>`).join("")}</details>` : "";

return `<section class="card span12"><div class="cardhead"><div><span class="eyebrow">Stage 4 · Phase 10</span><h2>Prospect research</h2></div><form method="post" action="/campaigns/${campaignId}/workflows/prospect-research"><button ${active || researchPending.length === 0 ? "disabled" : ""}>Research → generate drafts</button></form></div><p class="muted">${researchPending.length} eligible prospect(s) awaiting research. At most three useful sourced signals per prospect; pain is a hypothesis, never an assumed fact. Successful research automatically starts draft generation.</p>${researchCards || `<div class="empty">${researchEmptyMessage}</div>`}</section><section class="card span12" id="draft-review"><div class="cardhead"><div><span class="eyebrow">Stage 5 · Phases 11–12</span><h2>First-touch drafts &amp; human review</h2></div><form method="post" action="/campaigns/${campaignId}/workflows/email-generation"><button ${active || draftPending.length === 0 ? "disabled" : ""}>Generate missing drafts</button></form></div><p class="muted">Generated emails follow docs/EMAIL_RULES.md and cite a sourced research signal. This workflow stops here for human review. Ready to send does not mean sent; no sending integration is enabled.</p>${review}${history}</section>`;
}
