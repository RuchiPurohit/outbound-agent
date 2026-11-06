import { formatDueAt, type OutboundStore, type SequenceState, type SequenceStepState } from "../db/store.js";
import type { Outreach } from "../db/types.js";
import { STEP_KINDS } from "../prompts/clientSetup.js";
import { listFollowUpCandidates } from "../workflows/runner.js";
import { renderOutreachReview } from "./prospectStages.js";

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const day = (date: Date): string => date.toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** Calendar days from today to the due date, in local time: 0 is today, 1 is tomorrow. */
function calendarDaysUntil(date: Date): number {
  const midnight = (value: Date): number => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  return Math.round((midnight(date) - midnight(new Date())) / (24 * 60 * 60 * 1000));
}

/** "Step 3 · LinkedIn connect": the first email is step 1, so sequence step N is shown as N + 1. */
export const stepLabel = (step: SequenceStepState): string => `Step ${step.step + 1} · ${step.def.name}`;

const isTask = (step: SequenceStepState): boolean => step.def.kind !== "email" && !step.email;

/** Badge text and class describing where a sent email is in its sequence. */
function sequenceBadge(store: OutboundStore, sent: Outreach, state: SequenceState): { label: string; css: string } {
  if (sent.status === "REPLIED") {
    return store.isContactSuppressed(store.getContact(sent.contactId)!)
      ? { label: "Not interested · do not contact", css: "REJECTED" } : { label: "Replied", css: "APPROVED" };
  }
  if (sent.status === "BOUNCED") return { label: "Bounced", css: "REJECTED" };
  const current = state.current;
  if (!current) return { label: state.steps.length ? "Sequence complete" : "No follow-up steps", css: "SENT" };
  const name = stepLabel(current);
  const dueAt = current.dueAt!;
  if (dueAt.getTime() <= Date.now()) {
    return { label: isTask(current) || current.email ? `${name} due` : `${name} due · no draft`, css: "PENDING" };
  }
  const days = calendarDaysUntil(dueAt);
  const when = days === 0 ? `today ${dueAt.toLocaleTimeString("en-US", { timeStyle: "short" })}`
    : days === 1 ? "tomorrow" : `in ${days} days`;
  return { label: `${name} due ${day(dueAt)} · ${when}`, css: "RUNNING" };
}

/** Follow-up drafts awaiting review whose first email was sent and has had no reply or bounce. */
export function listFollowUpDrafts(store: OutboundStore, campaignId: number): Outreach[] {
  return store.listCampaignOutreach(campaignId).filter(({ status }) => status === "SENT")
    .flatMap(({ id }) => store.listFollowUps(id)).filter(({ status }) => status === "DRAFT");
}

/** Sent first-touch emails with every step of their sequence. */
export function renderFollowUps(store: OutboundStore, campaignId: number, openId?: number, sendStatus = ""): string {
  const active = store.listWorkflowRuns().some(({ status }) => status === "RUNNING" || status === "PENDING");
  const finished = (outreach: Outreach, state: SequenceState) => outreach.status !== "SENT" || !state.current;
  const sent = store.listCampaignOutreach(campaignId)
    .filter(({ status, sentAt }) => (status === "SENT" || status === "REPLIED" || status === "BOUNCED") && sentAt)
    .map((outreach) => ({ outreach, state: store.sequenceState(outreach.id) }))
    .sort((a, b) => Number(finished(a.outreach, a.state)) - Number(finished(b.outreach, b.state))
      || (a.state.current?.dueAt?.getTime() ?? 0) - (b.state.current?.dueAt?.getTime() ?? 0));
  const candidates = new Set(listFollowUpCandidates(store, campaignId).map(({ id }) => id));

  const label = (outreach: Outreach): string => {
    const contact = store.getContact(outreach.contactId)!;
    const company = store.getCompany(contact.companyId)!;
    return `${escapeHtml(contact.name)} · ${escapeHtml(company.name)}`;
  };

  const generationRows = sent.filter(({ outreach }) => candidates.has(outreach.id)).map(({ outreach, state }) =>
    `<label class="inline" style="padding:8px 0;border-top:1px solid var(--line)"><input class="check" type="checkbox" name="outreachIds" value="${outreach.id}" ${active ? "disabled" : ""}>${label(outreach)} · ${escapeHtml(outreach.subject)} <span class="badge">${escapeHtml(stepLabel(state.current!))}</span> <span class="muted">due ${day(state.current!.dueAt!)}</span></label>`).join("");

  const stepBlock = (outreach: Outreach, state: SequenceState, step: SequenceStepState): string => {
    const kind = STEP_KINDS[step.email ? "email" : step.def.kind];
    const statusBadge = step.email
      ? `<span class="badge ${step.email.status}">${escapeHtml(step.email.status.replaceAll("_", " "))}</span>`
      : step.status === "DONE" || step.status === "SKIPPED"
        ? `<span class="badge ${step.status === "DONE" ? "COMPLETED" : "UNKNOWN"}">${step.status === "DONE" ? "Done" : "Skipped"}</span>`
        : step.status === "CURRENT" ? '<span class="badge PENDING">Current</span>' : '<span class="badge">Upcoming</span>';
    const heading = `<h3 style="margin-top:18px">${escapeHtml(stepLabel(step))} <span class="muted" style="font-weight:400;font-size:13px">${escapeHtml(kind)}</span> ${statusBadge}</h3>`;
    if (step.email) return `${heading}${renderOutreachReview(store, campaignId, step.email)}`;
    if (step.completion) {
      return `${heading}<p class="muted">${step.status === "DONE" ? "Done" : "Skipped"} ${escapeHtml(new Date(step.completion.completedAt).toLocaleString())}${step.completion.note ? `: ${escapeHtml(step.completion.note)}` : ""}</p>`;
    }
    if (step.status === "UPCOMING" || outreach.status !== "SENT") {
      return `${heading}<p class="muted">${step.def.delayDays} day(s) after the previous step.</p>`;
    }
    const due = `Due ${escapeHtml(formatDueAt(step.dueAt!))}, ${step.def.delayDays} day(s) after the previous step.`;
    if (step.def.kind === "email") {
      const rejected = store.listFollowUps(outreach.id).filter((item) => item.status === "REJECTED" && item.followUpStep === step.step).length;
      return `${heading}<p class="muted">${due} ${candidates.has(outreach.id) ? "No draft yet. Check this email under Draft follow-ups above." : "This prospect is no longer eligible for a follow-up draft."}${rejected ? ` ${rejected} rejected draft(s) hidden.` : ""}</p>`;
    }
    const instructions = step.def.instructions.trim() ? `<pre class="email-preview">${escapeHtml(step.def.instructions)}</pre>` : "";
    return `${heading}<p class="muted">${due} Do this yourself, then record it here so the next step's wait starts.</p>${instructions}<form method="post" action="/campaigns/${campaignId}/outreach/${outreach.id}/task" class="task-form"><input type="hidden" name="step" value="${step.step}"><label><span>Note (optional)</span><input name="note" maxlength="1000" placeholder="Sent a connection request with a short note"></label><div class="actions"><button name="decision" value="DONE" ${active ? "disabled" : ""}>Mark done</button><button name="decision" value="SKIPPED" class="secondary" ${active ? "disabled" : ""}>Skip step</button></div></form>`;
  };

  const cards = sent.map(({ outreach, state }) => {
    const badge = sequenceBadge(store, outreach, state);
    const timeline = outreach.status === "BOUNCED"
      ? `First email sent ${escapeHtml(new Date(outreach.sentAt!).toLocaleString())} and bounced, so the sequence stopped. ${escapeHtml(outreach.bounceDetail)}`
      : `First email sent ${escapeHtml(new Date(outreach.sentAt!).toLocaleString())}.${outreach.status === "REPLIED" ? " The prospect replied, so the sequence stopped." : state.current ? ` Now at ${escapeHtml(stepLabel(state.current))}.` : ""}`;
    const replied = outreach.status === "SENT" && state.current
      ? `<form method="post" action="/campaigns/${campaignId}/outreach/${outreach.id}/replied" style="margin-top:14px"><button class="secondary" ${active ? "disabled" : ""}>Mark as replied (stops the sequence)</button></form><form method="post" action="/campaigns/${campaignId}/outreach/${outreach.id}/bounced" style="margin-top:14px"><label><span>Bounce notice (sender, date, reason)</span><input name="detail" maxlength="1000" required></label><button class="secondary" ${active ? "disabled" : ""}>Mark as bounced (stops the sequence)</button></form>`
      : "";
    const steps = state.steps.map((step) => stepBlock(outreach, state, step)).join("");
    return `<details class="email-draft" id="sent-${outreach.id}"${outreach.id === openId ? " open" : ""}><summary>${label(outreach)} · ${escapeHtml(outreach.subject)} <span class="badge ${badge.css}">${escapeHtml(badge.label)}</span></summary><p class="muted">${timeline}</p><details><summary>Step 1 · First email</summary>${renderOutreachReview(store, campaignId, outreach)}</details>${steps}${replied}</details>`;
  }).join("");

  const sendable = store.listSendableOutreach(campaignId, "follow-ups").length;
  const waiting = sent.filter(({ outreach }) => outreach.status === "SENT")
    .flatMap(({ outreach }) => store.listFollowUps(outreach.id))
    .filter((followUp) => {
      const sendableAt = followUp.status === "READY_TO_SEND" ? store.followUpSendableAt(followUp) : undefined;
      return sendableAt !== undefined && sendableAt.getTime() > Date.now();
    }).length;
  const sendAll = sendable && !sendStatus.includes("data-sending")
    ? `<a class="button" href="/campaigns/${campaignId}/follow-ups/send-all">Send all approved follow-ups (${sendable})</a>` : "";
  const waitingNote = waiting > 0
    ? `<p class="muted">${waiting} approved follow-up(s) are waiting for their send date and will join Send all once due.</p>` : "";

  const drafts = listFollowUpDrafts(store, campaignId);
  const guessedDrafts = drafts.filter(({ contactId }) => store.getContactRecipient(contactId)?.guessed).length;
  const confirmText = `Approve ${drafts.length} follow-up draft(s) as READY_TO_SEND?${guessedDrafts ? ` ${guessedDrafts} go to unverified guessed recipients.` : ""} Nothing is sent; each follow-up still needs a send confirmation once it is due.`;
  const approveAll = drafts.length
    ? `<form method="post" action="/campaigns/${campaignId}/follow-ups/approve-all" onsubmit="return confirm(this.dataset.confirm)" data-confirm="${escapeHtml(confirmText)}">${drafts.map(({ id }) => `<input type="hidden" name="ids" value="${id}">`).join("")}<button ${active ? "disabled" : ""}>Approve all follow-up drafts → Ready to send (${drafts.length})</button></form>`
    : "";

  const due = sent.filter(({ outreach, state }) => outreach.status === "SENT" && state.current
    && state.current.dueAt!.getTime() <= Date.now()).length;

  return `<section class="card span12" id="generate-follow-ups"><div class="cardhead"><div><span class="eyebrow">Stage 6 · Phase 14</span><h2>Draft follow-ups</h2></div></div><p class="muted">Each sent email follows this campaign's <a href="/campaigns/${campaignId}/sequence">sequence</a>. Codex drafts the next email step for each checked email; manual steps such as LinkedIn or calls are yours to do and record below. Each step unlocks its wait after the previous step, unless the prospect replied. Drafts need your approval, and sending stays manual.</p>${generationRows ? `<form method="post" action="/campaigns/${campaignId}/workflows/follow-up-generation">${generationRows}<div class="actions" style="margin-top:12px"><button type="button" class="secondary" data-select ${active ? "disabled" : ""}>Select all</button><button ${active ? "disabled" : ""}>Generate follow-ups for checked emails</button></div></form>` : '<div class="empty">No sent emails are waiting for a follow-up draft.</div>'}</section><section class="card span12" id="sent-emails"><div class="cardhead"><div><span class="eyebrow">Outreach state</span><h2>Sent emails</h2></div><div class="actions" style="align-items:center">${approveAll}${sendAll}<span class="badge${due ? " PENDING" : ""}">${due} due now</span></div></div>${sendStatus}${waitingNote}${cards || '<div class="empty">No emails have been sent in this campaign yet.</div>'}</section>`;
}

/** Number of sent emails whose current sequence step (email or task) is due and still needs action. */
export function countDueFollowUps(store: OutboundStore, campaignId: number): number {
  return store.listCampaignOutreach(campaignId).filter((outreach) => {
    if (outreach.status !== "SENT" || !outreach.sentAt) return false;
    const current = store.sequenceState(outreach.id).current;
    return current !== undefined && current.dueAt!.getTime() <= Date.now();
  }).length;
}
