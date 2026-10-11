import { FOLLOW_UP_DELAY_DAYS, followUpDueAt, type OutboundStore } from "../db/store.js";
import type { Outreach } from "../db/types.js";
import { listFollowUpCandidates } from "../workflows/runner.js";
import { renderOutreachReview } from "./prospectStages.js";

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const day = (date: Date): string => date.toISOString().slice(0, 10);

/** Badge text and class describing where a sent email is in its follow-up cycle. */
function followUpState(sent: Outreach, followUp: Outreach | undefined, dueAt: Date): { label: string; css: string } {
  if (sent.status === "REPLIED") return { label: "Replied", css: "APPROVED" };
  if (followUp?.status === "SENT") return { label: "Follow-up sent", css: "SENT" };
  const days = Math.ceil((dueAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return { label: followUp ? "Follow-up due" : "Follow-up due · no draft", css: "PENDING" };
  return { label: `Follow-up due ${day(dueAt)} · in ${days} day${days === 1 ? "" : "s"}`, css: "RUNNING" };
}

/** Sent first-touch emails awaiting a reply, with their scheduled follow-up drafts. */
export function renderFollowUps(store: OutboundStore, campaignId: number, openId?: number): string {
  const active = store.listWorkflowRuns().some(({ status }) => status === "RUNNING" || status === "PENDING");
  const sent = store.listCampaignOutreach(campaignId)
    .filter(({ status, sentAt }) => (status === "SENT" || status === "REPLIED") && sentAt)
    .map((outreach) => ({ outreach, dueAt: followUpDueAt(outreach.sentAt!), followUp: store.getFollowUp(outreach.id) }))
    .sort((a, b) => Number(a.outreach.status === "REPLIED") - Number(b.outreach.status === "REPLIED")
      || a.dueAt.getTime() - b.dueAt.getTime());
  const candidates = new Set(listFollowUpCandidates(store, campaignId).map(({ id }) => id));

  const label = (outreach: Outreach): string => {
    const contact = store.getContact(outreach.contactId)!;
    const company = store.getCompany(contact.companyId)!;
    return `${escapeHtml(contact.name)} · ${escapeHtml(company.name)}`;
  };

  const generationRows = sent.filter(({ outreach }) => candidates.has(outreach.id)).map(({ outreach, dueAt }) =>
    `<label class="inline" style="padding:8px 0;border-top:1px solid var(--line)"><input class="check" type="checkbox" name="outreachIds" value="${outreach.id}" ${active ? "disabled" : ""}>${label(outreach)} · ${escapeHtml(outreach.subject)} <span class="muted">due ${day(dueAt)}</span></label>`).join("");

  const cards = sent.map(({ outreach, dueAt, followUp }) => {
    const state = followUpState(outreach, followUp, dueAt);
    const rejected = store.listFollowUps(outreach.id).filter(({ status }) => status === "REJECTED").length;
    const followUpBlock = followUp
      ? `<h3 style="margin-top:18px">Follow-up <span class="badge ${followUp.status}">${escapeHtml(followUp.status.replaceAll("_", " "))}</span></h3>${renderOutreachReview(store, campaignId, followUp)}`
      : outreach.status === "REPLIED"
        ? ""
        : `<p class="muted">${candidates.has(outreach.id) ? "No follow-up drafted yet. Check this email under Draft follow-ups above." : "This prospect is no longer eligible for a follow-up draft."}${rejected ? ` ${rejected} rejected follow-up(s) hidden.` : ""}</p>`;
    const replied = outreach.status === "SENT"
      ? `<form method="post" action="/campaigns/${campaignId}/outreach/${outreach.id}/replied" style="margin-top:14px"><button class="secondary" ${active ? "disabled" : ""}>Mark as replied (cancels follow-up)</button></form>`
      : "";
    return `<details class="email-draft" id="sent-${outreach.id}"${outreach.id === openId ? " open" : ""}><summary>${label(outreach)} · ${escapeHtml(outreach.subject)} <span class="badge ${state.css}">${escapeHtml(state.label)}</span></summary><p class="muted">First email sent ${escapeHtml(new Date(outreach.sentAt!).toLocaleString())}. Follow-up becomes sendable ${day(dueAt)}, ${FOLLOW_UP_DELAY_DAYS} days later.</p><details><summary>First email</summary>${renderOutreachReview(store, campaignId, outreach)}</details>${followUpBlock}${replied}</details>`;
  }).join("");

  const due = sent.filter(({ outreach, followUp, dueAt }) => outreach.status === "SENT"
    && followUp?.status !== "SENT" && dueAt.getTime() <= Date.now()).length;

  return `<section class="card span12" id="generate-follow-ups"><div class="cardhead"><div><span class="eyebrow">Stage 6 · Phase 14</span><h2>Draft follow-ups</h2></div></div><p class="muted">Codex drafts one threaded follow-up per checked email, following the Follow-up 1 rules in docs/EMAIL_RULES.md. Drafts need your approval, and sending stays manual. It unlocks ${FOLLOW_UP_DELAY_DAYS} days after the first email, unless the prospect replied.</p>${generationRows ? `<form method="post" action="/campaigns/${campaignId}/workflows/follow-up-generation">${generationRows}<div class="actions" style="margin-top:12px"><button type="button" class="secondary" data-select ${active ? "disabled" : ""}>Select all</button><button ${active ? "disabled" : ""}>Generate follow-ups for checked emails</button></div></form>` : '<div class="empty">No sent emails are waiting for a follow-up draft.</div>'}</section><section class="card span12" id="sent-emails"><div class="cardhead"><div><span class="eyebrow">Outreach state</span><h2>Sent emails</h2></div><span class="badge${due ? " PENDING" : ""}">${due} due now</span></div>${cards || '<div class="empty">No emails have been sent in this campaign yet.</div>'}</section>`;
}

/** Number of sent emails whose follow-up window has opened and still need action. */
export function countDueFollowUps(store: OutboundStore, campaignId: number): number {
  return store.listCampaignOutreach(campaignId).filter((outreach) => outreach.status === "SENT" && outreach.sentAt
    && store.getFollowUp(outreach.id)?.status !== "SENT"
    && followUpDueAt(outreach.sentAt).getTime() <= Date.now()).length;
}
