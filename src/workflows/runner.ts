import { spawn } from "node:child_process";
import type { SqliteDatabase } from "../db/database.js";
import { OutboundStore, WorkflowError } from "../db/store.js";
import type { WorkflowRun, WorkflowRunKind } from "../db/types.js";
import { resolveCodexExecutable } from "../commands/codexExecutable.js";

export interface WorkflowRequest {
  campaignId: number;
  kind: WorkflowRunKind;
  targetCount?: number;
}

function buildPrompt(request: WorkflowRequest): string {
  switch (request.kind) {
    case "COMPANY_DISCOVERY":
      return [
        "Read AGENTS.md, docs/ICP.md, and prompts/company-discovery.md.",
        `Run company discovery for campaign ${request.campaignId}.`,
        `Find up to ${request.targetCount ?? 5} new companies matching the campaign's stored segment.`,
        "Persist verified results and company-level research in the live SQLite database.",
        "Do not discover contacts, emails, or create outreach.",
        "Complete the workflow; do not merely explain how to do it.",
      ].join(" ");
    case "CONTACT_DISCOVERY":
      return [
        "Read AGENTS.md, docs/ICP.md, and prompts/contact-discovery.md.",
        `Run contact discovery for campaign ${request.campaignId}.`,
        "Use only APPROVED companies from the live SQLite database.",
        "Persist verified results in SQLite and update the readable contacts report.",
        "Do not research or infer email addresses, and do not create outreach.",
        "Complete the workflow; do not merely explain how to do it.",
      ].join(" ");
    case "EMAIL_DISCOVERY":
      return [
        "Read AGENTS.md, docs/ICP.md, and prompts/email-discovery.md.",
        `Run email discovery for campaign ${request.campaignId}.`,
        "Process only APPROVED contacts whose email status is UNKNOWN.",
        "Persist every result through recordEmailDiscovery and update the readable email report.",
        "Never infer an address, draft outreach, create Gmail drafts, or send messages.",
        "Complete the workflow; do not merely explain how to do it.",
      ].join(" ");
  }
}

function validateRequest(store: OutboundStore, request: WorkflowRequest): void {
  const campaign = store.getCampaign(request.campaignId);
  if (!campaign) throw new WorkflowError(`Campaign ${request.campaignId} was not found`);

  const companies = store.listCompanies({ campaignId: request.campaignId });
  if (request.kind === "CONTACT_DISCOVERY"
      && !companies.some(({ status }) => status === "APPROVED")) {
    throw new WorkflowError("Approve at least one company before discovering contacts");
  }
  if (request.kind === "EMAIL_DISCOVERY") {
    const hasTarget = companies
      .flatMap(({ id }) => store.listContacts(id))
      .some(({ status, emailStatus }) => status === "APPROVED" && emailStatus === "UNKNOWN");
    if (!hasTarget) {
      throw new WorkflowError("Approve at least one contact awaiting email discovery first");
    }
  }
}

export function launchWorkflow(db: SqliteDatabase, request: WorkflowRequest): WorkflowRun {
  const store = new OutboundStore(db);
  validateRequest(store, request);

  const executable = resolveCodexExecutable();
  const run = store.createWorkflowRun({
    campaignId: request.campaignId,
    kind: request.kind,
    details: request.targetCount === undefined
      ? undefined
      : JSON.stringify({ targetCount: request.targetCount }),
  });
  store.startWorkflowRun(run.id);

  const child = spawn(executable, [
    "--search", "-C", process.cwd(), "--sandbox", "workspace-write",
    "--ask-for-approval", "never", "exec", buildPrompt(request),
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const append = (chunk: Buffer): void => {
    try {
      store.appendWorkflowOutput(run.id, chunk.toString());
    } catch {
      child.kill();
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.once("error", (error) => {
    try { store.failWorkflowRun(run.id, `Unable to start Codex: ${error.message}`); } catch { /* closed */ }
  });
  child.once("close", (code) => {
    try {
      if (code === 0) store.completeWorkflowRun(run.id);
      else {
        store.failWorkflowRun(run.id, `Codex exited with status ${code ?? "unknown"}`);
      }
    } catch { /* another terminal event already handled this run */ }
  });

  return store.getWorkflowRun(run.id)!;
}
