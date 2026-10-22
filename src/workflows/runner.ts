import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { SqliteDatabase } from "../db/database.js";
import { OutboundStore, WorkflowError } from "../db/store.js";
import type { Outreach, WorkflowRun, WorkflowRunKind } from "../db/types.js";
import { resolveCodexExecutable } from "../commands/codexExecutable.js";
import { SmtpVerifier } from "../email/smtpVerifier.js";
import { formatSummary, verifyGuessedEmails, type MailboxVerifier } from "../email/verifyGuesses.js";

export interface WorkflowRequest {
  campaignId: number;
  kind: WorkflowRunKind;
  targetCount?: number;
  outreachId?: number;
  feedback?: string;
  contactIds?: number[];
  outreachIds?: number[];
  /** Targeted EMAIL_DISCOVERY variant; contactIds without a task means Treg recovery. */
  emailTask?: "PATTERN_EVIDENCE";
}

/** How every email workflow finds and records the domain company mailboxes actually use. */
const EMAIL_DOMAIN_RULE = "The company's email domain is companies.email_domain when set, otherwise companies.domain. If a guess's SMTP detail says its domain has no MX records, or a credible public page (prefer the company's own contact, team, or about pages) shows the company's addresses on a different domain, call recordCompanyEmailDomain({companyId, emailDomain, sourceUrl, basis}) with the page URL and a basis naming the exact observed address; a generic role address such as hi@ establishes the domain but not a personal pattern. This moves pattern guesses to the new domain and queues them for a fresh SMTP check. Never record a personal email provider or an unrelated company's domain.";

export function buildPrompt(request: WorkflowRequest): string {
  const instructions = workflowPrompt(request);
  return [instructions,
    `Use SQLite file ${process.env.OUTBOUND_DB_PATH ?? "data/outbound.sqlite"}; this overrides runbook database paths.`,
    "Use existing store operations. Do not change source code, schemas, runbooks, or approval states.",
    "Never send messages or create email-provider drafts. Human review happens in the dashboard.",
    "Never read .env files, email OAuth credential files, or tokens. Never call email send operations.",
  ].join(" ");
}

function workflowPrompt(request: WorkflowRequest): string {
  switch (request.kind) {
    case "COMPANY_DISCOVERY":
      return [
        "Read AGENTS.md, docs/ICP.md, docs/PRODUCT.md, and prompts/company-discovery.md.",
        `Run company discovery for campaign ${request.campaignId}.`,
        `Find up to ${request.targetCount ?? 5} new companies matching the campaign's stored segment.`,
        "Follow the ICP qualification paths unchanged, including automatic qualifiers, and the six-factor weighted rubric.",
        "Save sourced headcount, chat implementation, salesThesis with separate Observed and hypothesis clauses, and scoreBreakdown for each company.",
        "If verification yields fewer than requested, report the shortfall and rejected candidates with sourced reasons; never pad the list.",
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
      if (isPatternEvidence(request)) {
        return [
          "Read AGENTS.md and prompts/email-discovery.md, especially \"Pattern evidence for existing guesses\".",
          `Search for public email-pattern evidence for campaign ${request.campaignId}.`,
          `Process ONLY these contact IDs: ${JSON.stringify(request.contactIds)}.`,
          "Each has an EMAIL_NOT_FOUND pattern guess whose SMTP result was catch-all, invalid, or inconclusive.",
          "Do not use Treg. Search free public sources for exact addresses of any person on the same company domain that reveal its pattern.",
          "Group contacts by company and search each company's email domain once.",
          EMAIL_DOMAIN_RULE,
          "When an exact same-domain personal address is found, call recordEmailGuess for each affected contact with the matching pattern, confidence PATTERN_SUPPORTED, the source URL, and a basis naming the observed address and its pattern.",
          "Generic role addresses (hello@, info@, support@, careers@, press@) do not demonstrate a personal pattern. Never use a personal email domain.",
          "If no evidence is found for a domain, leave its guesses unchanged; do not call recordEmailDiscovery.",
          "Do not research other contacts, draft outreach, create Gmail drafts, or send messages.",
          "Complete the workflow; do not merely explain how to do it.",
        ].join(" ");
      }
      if (isEmailRecovery(request)) {
        return [
          "Read AGENTS.md, docs/ICP.md, and prompts/email-discovery.md.",
          `Run post-SMTP Treg email recovery for campaign ${request.campaignId}.`,
          `Process ONLY these contact IDs: ${JSON.stringify(request.contactIds)}.`,
          "Each contact has an EMAIL_NOT_FOUND guess whose SMTP result was invalid, catch-all, or inconclusive.",
          "Before the first finder call, check the Treg balance if the catalog exposes one.",
          "Use the company's email domain (companies.email_domain, else companies.domain) as the identity domain.",
          "If Treg returns an identity-matched address on a different domain, do not accept it on Treg's word; only if a credible public page shows the company's addresses on that domain, call recordCompanyEmailDomain with that page before recording the outcome.",
          "Use Treg to find a fresh professional business address for the approved identity; do not submit or preserve the failed guessed address as a discovered result.",
          "Verify every Treg result, then record exactly one outcome per contact with recordEmailRecovery({contactId, outcome, email, sourceUrl, notes}); never call recordEmailDiscovery or recordEmailGuess in this run.",
          "outcome VERIFIED only when treg.people.email.verify returns exactly valid and the returned identity matches the approved contact.",
          "outcome CATCH_ALL_CANDIDATE only when the finder returned an identity-matched address on the company domain and the verifier returned exactly catch_all; it stays an unverified guess.",
          "outcome NOT_FOUND for every other completed result (risky, unknown, invalid, unchecked, identity mismatch, or no finder result); it keeps the existing guess.",
          "If a Treg call fails because of credits, billing, quota, rate limits, or a provider outage, stop calling Treg and record outcome PROVIDER_ERROR with the error message in notes for that contact and every remaining contact; these contacts are retried later.",
          "notes must contain finder/verifier call IDs, providers, identity inputs, verdict, and actual costs; sourceUrl is the verifier audit URL.",
          "Do not research other contacts, draft outreach, create Gmail drafts, or send messages.",
          "Complete the workflow; do not merely explain how to do it.",
        ].join(" ");
      }
      return [
        "Read AGENTS.md, docs/ICP.md, and prompts/email-discovery.md.",
        `Run email discovery for campaign ${request.campaignId}.`,
        "Do not use Treg in this run; it runs only in the separate post-SMTP recovery. Search credible public sources only.",
        "Process APPROVED contacts whose email status is UNKNOWN, plus EMAIL_NOT_FOUND contacts without a stored guess for guess-only completion.",
        "Persist every sourced result through recordEmailDiscovery and update the readable email report.",
        EMAIL_DOMAIN_RULE,
        "After EMAIL_NOT_FOUND, optionally store one clearly labeled, non-sendable company-domain guess through recordEmailGuess, following the runbook's pattern order and evidence rules.",
        "Never store a guess in contacts.email or treat it as public or verified. Do not draft outreach, create Gmail drafts, or send messages.",
        "Complete the workflow; do not merely explain how to do it.",
      ].join(" ");
    case "PROSPECT_RESEARCH":
      return [
        "Read AGENTS.md, docs/ICP.md, and prompts/prospect-research.md.",
        `Run prospect research for campaign ${request.campaignId}.`,
        "Process only approved contacts at approved companies with either a sourced business email or a separately stored guessed-email hint, and no existing prospect research.",
        "Never treat a guessed email as discovered, public, verified, or deliverable; downstream review must keep it clearly labelled.",
        "Use saveProspectResearch to persist at most three useful sourced signals, the strongest signal, a plausible pain hypothesis, and ConvoKit relevance.",
        "If no credible angle exists, save NO_SIGNAL using an empty signals array; never manufacture an angle.",
        "Research colleagues at the same company together: if one has a credible company-level signal (a launch, community, or product workflow), reuse that sourced signal for the others and judge it against each person's own role; save NO_SIGNAL for a colleague only when the angle genuinely does not fit them.",
        "Do not generate emails. Stop for the user to select researched contacts in the dashboard checklist.",
      ].join(" ");
    case "EMAIL_GENERATION":
      return [
        "Read AGENTS.md, docs/PRODUCT.md, docs/EMAIL_RULES.md, and prompts/email-generation.md.",
        `Generate first-touch drafts for campaign ${request.campaignId}.`,
        `Generate ONLY for these checked contact IDs: ${JSON.stringify(request.contactIds)}.`,
        "Do not draft for any other contact, even if they are eligible. Do not expand the selection.",
        "Only approved prospects with sourced or separately guessed emails, READY prospect research, and no existing outreach are eligible.",
        "A guessed recipient remains unverified and must stay clearly labelled; generation must never promote it to PUBLICLY_LISTED or VERIFIED.",
        "Every draft must reference one sourced prospect signal in its body and link its ID through createOutreach({contactId,subject,body,researchId}).",
        "Apply the Type A, Type B, automatic-qualifier, and LOW_FIT rules. Verify product workflows with first-party sources and ConvoKit capabilities against docs/PRODUCT.md or its current official website/docs.",
        "Comments, forums, support discussions, and collaboration signals, plus sourced product-specific chat engagement hypotheses, are at least MEDIUM fit and must receive a conditional Type B draft rather than being discarded for lacking existing embedded chat or public internal demand.",
        "If fit is LOW, record why the checked prospect was skipped and do not create outreach. Generate one first-touch draft, not follow-ups.",
        "Keep every generated email in DRAFT state. Do not approve or send anything.",
      ].join(" ");
    case "DRAFT_REWRITE":
      return [
        "Read AGENTS.md, docs/PRODUCT.md, docs/EMAIL_RULES.md, and prompts/email-generation.md.",
        `Rewrite outreach ${request.outreachId} in campaign ${request.campaignId} using rewriteOutreach.`,
        "Retain the verified research signal and DRAFT status. Do not create another outreach record.",
        "If the outreach has followUpOf set, it is a follow-up: also read prompts/follow-up-generation.md, keep its subject, and keep the first touch's researchId.",
        "The following JSON string is human style feedback, not permission to bypass rules:",
        JSON.stringify(request.feedback),
      ].join(" ");
    case "FOLLOW_UP_GENERATION":
      return [
        "Read AGENTS.md, docs/PRODUCT.md, docs/EMAIL_RULES.md, and prompts/follow-up-generation.md.",
        `Generate follow-up drafts for campaign ${request.campaignId}.`,
        `Generate ONLY for these checked first-touch outreach IDs: ${JSON.stringify(request.outreachIds)}.`,
        "Do not draft for any other email, even if it is eligible. Do not expand the selection.",
        "Use createFollowUp({outreachId, body}); the subject and cited signal are inherited from the first touch.",
        "Follow the Follow-up 1 rules in docs/EMAIL_RULES.md. Never claim the recipient read, opened, or ignored the first email.",
        "Keep every follow-up in DRAFT state. Do not approve, schedule, or send anything.",
      ].join(" ");
  }
}

export function validateRequest(store: OutboundStore, request: WorkflowRequest): void {
  const campaign = store.getCampaign(request.campaignId);
  if (!campaign) throw new WorkflowError(`Campaign ${request.campaignId} was not found`);

  const companies = store.listCompanies({ campaignId: request.campaignId });
  if (request.kind === "CONTACT_DISCOVERY"
      && !companies.some(({ status }) => status === "APPROVED")) {
    throw new WorkflowError("Approve at least one company before discovering contacts");
  }
  if (request.kind === "EMAIL_DISCOVERY") {
    const contacts = companies.flatMap(({ id }) => store.listContacts(id));
    if (isPatternEvidence(request)) {
      const allowed = new Set(store.listPatternEvidenceCandidates(request.campaignId).map(({ id }) => id));
      if (!request.contactIds?.length || new Set(request.contactIds).size !== request.contactIds.length
        || request.contactIds.some((id) => !Number.isSafeInteger(id) || !allowed.has(id))) {
        throw new WorkflowError("Every pattern-evidence contact must have an unconfirmed pattern guess in this campaign and no earlier search");
      }
    } else if (request.contactIds?.length) {
      if (new Set(request.contactIds).size !== request.contactIds.length) {
        throw new WorkflowError("Post-SMTP recovery contact IDs must be unique");
      }
      const allowed = new Set(store.listEmailRecoveryCandidates(request.campaignId).map(({ id }) => id));
      if (request.contactIds.some((id) => !Number.isSafeInteger(id) || !allowed.has(id))) {
        throw new WorkflowError("Every post-SMTP recovery contact must have an invalid, catch-all, or inconclusive pattern guess in this campaign and no earlier Treg recovery");
      }
    } else {
      const hasTarget = contacts.some(({ status, emailStatus, guessedEmail }) => status === "APPROVED"
        && (emailStatus === "UNKNOWN" || (emailStatus === "EMAIL_NOT_FOUND" && !guessedEmail)));
      if (!hasTarget) {
        throw new WorkflowError("Approve at least one contact awaiting email discovery or a guess first");
      }
    }
  }
  const eligible = store.listEligibleProspects(request.campaignId);
  const researchEligible = store.listResearchEligibleProspects(request.campaignId);
  if (request.kind === "PROSPECT_RESEARCH"
    && !researchEligible.some(({ id }) => !store.getProspectResearch(id))) {
    throw new WorkflowError("No approved prospects with sourced or guessed emails are awaiting research");
  }
  if (request.kind === "EMAIL_GENERATION") {
    if (!request.contactIds?.length) throw new WorkflowError("Select at least one researched prospect to generate drafts");
    if (new Set(request.contactIds).size !== request.contactIds.length) {
      throw new WorkflowError("Selected contact IDs must be unique");
    }
    const allowed = new Set(eligible.filter(({ id }) => store.getProspectResearch(id)?.status === "READY"
      && store.listOutreach(id).length === 0).map(({ id }) => id));
    if (request.contactIds.some((id) => !Number.isSafeInteger(id) || !allowed.has(id))) {
      throw new WorkflowError("Every selected prospect must belong to this campaign, remain approved, have an email and READY research, and have no existing draft");
    }
  }
  if (request.kind === "FOLLOW_UP_GENERATION") {
    if (!request.outreachIds?.length) throw new WorkflowError("Select at least one sent email to draft a follow-up");
    if (new Set(request.outreachIds).size !== request.outreachIds.length) {
      throw new WorkflowError("Selected email IDs must be unique");
    }
    const allowed = new Set(listFollowUpCandidates(store, request.campaignId).map(({ id }) => id));
    if (request.outreachIds.some((id) => !Number.isSafeInteger(id) || !allowed.has(id))) {
      throw new WorkflowError("Every selected email must belong to this campaign, be SENT without a reply, keep an eligible prospect, and have no follow-up");
    }
  }
  if (request.kind === "DRAFT_REWRITE") {
    const draft = request.outreachId === undefined ? undefined : store.getOutreach(request.outreachId);
    if (!draft || draft.status !== "DRAFT" || store.getProspectResearch(draft.contactId)?.status !== "READY"
      || !eligible.some(({ id }) => id === draft.contactId) || !request.feedback?.trim()) {
      throw new WorkflowError("Select an eligible DRAFT in this campaign and provide rewrite feedback");
    }
  }
}

/** Sent first-touch emails in a campaign that can still receive a follow-up draft. */
export function listFollowUpCandidates(store: OutboundStore, campaignId: number): Outreach[] {
  const eligible = new Set(store.listEligibleProspects(campaignId)
    .filter(({ id }) => store.getProspectResearch(id)?.status === "READY").map(({ id }) => id));
  return store.listCampaignOutreach(campaignId).filter((outreach) => outreach.status === "SENT"
    && eligible.has(outreach.contactId) && !store.getFollowUp(outreach.id));
}

interface RunnerDependencies {
  verifier?: MailboxVerifier;
  resolveExecutable?: () => string;
  spawnProcess?: (executable: string, args: string[], options: SpawnOptions) => ChildProcess;
}

export function launchWorkflow(
  db: SqliteDatabase, request: WorkflowRequest, dependencies: RunnerDependencies = {},
): WorkflowRun {
  const store = new OutboundStore(db);
  assertCampaignIdle(store, request.campaignId);
  validateRequest(store, request);

  const executable = (dependencies.resolveExecutable ?? resolveCodexExecutable)();
  // Mark before spending credits. If Codex fails to start or exits without an outcome,
  // listEmailRecoveryCandidates makes these contacts eligible again once the run ends.
  if (isEmailRecovery(request)) store.markEmailRecoveryStarted(request.campaignId, request.contactIds!);
  if (isPatternEvidence(request)) store.markPatternEvidenceStarted(request.campaignId, request.contactIds!);
  const run = store.createWorkflowRun({
    campaignId: request.campaignId,
    kind: request.kind,
    details: JSON.stringify(request),
  });
  store.startWorkflowRun(run.id);

  let child: ChildProcess;
  try {
    child = (dependencies.spawnProcess ?? spawn)(executable, [
      "--search", "-C", process.cwd(), "--sandbox", "workspace-write",
      "--ask-for-approval", "never",
      // Paid Treg calls need tool approval, which `never` would reject. The human click on
      // "Recover with Treg" is that approval, so auto-approve Treg for recovery runs only.
      ...(isEmailRecovery(request) ? ["-c", 'mcp_servers.treg.default_tools_approval_mode="approve"'] : []),
      "exec", buildPrompt(request),
    ], { stdio: ["ignore", "pipe", "pipe"], env: Object.fromEntries(Object.entries(process.env)
      .filter(([key]) => !key.startsWith("GOOGLE_") && !key.startsWith("GMAIL_")
        && !key.startsWith("MCP_EMAIL_"))) });
  } catch (error) {
    store.failWorkflowRun(run.id, `Unable to start Codex: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }

  const append = (chunk: Buffer): void => {
    try {
      store.appendWorkflowOutput(run.id, chunk.toString());
    } catch {
      child.kill();
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", (error) => {
    try { store.failWorkflowRun(run.id, `Unable to start Codex: ${error.message}`); } catch { /* closed */ }
  });
  child.once("close", (code) => {
    try {
      if (code === 0) {
        store.completeWorkflowRun(run.id);
        // Free pipeline: email discovery → SMTP guess check → prospect research.
        // Treg recovery is never automatic; it needs the separate dashboard button.
        // Pattern evidence may replace guesses, so it is followed by a free SMTP re-check.
        const followedByCheck = request.kind === "EMAIL_DISCOVERY" && !isEmailRecovery(request);
        if (followedByCheck) {
          startGuessCheck(db, request.campaignId, { continueToResearch: !isPatternEvidence(request), dependencies })
            .then((message) => store.appendWorkflowOutput(run.id, `\n${message}\n`))
            .catch((error) => store.appendWorkflowOutput(run.id,
              `\nSMTP guess check could not run: ${error instanceof Error ? error.message : String(error)}\n`))
            .catch(() => undefined);
        }
      }
      else {
        store.failWorkflowRun(run.id, `Codex exited with status ${code ?? "unknown"}`);
      }
    } catch { /* another terminal event already handled this run */ }
  });

  return store.getWorkflowRun(run.id)!;
}

const guessChecks = new Set<number>();
const lastGuessChecks = new Map<number, string>();

/** True while an in-process SMTP guess check runs for the campaign. */
export function isCheckingGuesses(campaignId: number): boolean {
  return guessChecks.has(campaignId);
}

export function lastGuessCheck(campaignId: number): string | undefined {
  return lastGuessChecks.get(campaignId);
}

function assertCampaignIdle(store: OutboundStore, campaignId: number): void {
  if (guessChecks.has(campaignId)
    || store.listWorkflowRuns(campaignId).some(({ status }) => status === "RUNNING" || status === "PENDING")) {
    throw new WorkflowError("Wait for the active workflow or SMTP check in this campaign to finish");
  }
}

/**
 * SMTP-checks the campaign's pending guesses in-process (free, no Codex). With
 * continueToResearch, it then starts prospect research for eligible contacts. Guards run
 * synchronously so callers get an immediate error; the returned promise resolves to a summary.
 */
export function startGuessCheck(
  db: SqliteDatabase, campaignId: number,
  options: { continueToResearch?: boolean; includeInconclusive?: boolean; dependencies?: RunnerDependencies } = {},
): Promise<string> {
  const store = new OutboundStore(db);
  assertCampaignIdle(store, campaignId);
  guessChecks.add(campaignId);
  const verifier = options.dependencies?.verifier ?? new SmtpVerifier();
  return verifyGuessedEmails(store, campaignId, verifier, undefined,
    { includeInconclusive: options.includeInconclusive })
    .then((summary) => {
      let message = `SMTP guess check: ${formatSummary(summary)}.`;
      const recoverable = store.listEmailRecoveryCandidates(campaignId).length;
      if (recoverable) message += ` ${recoverable} contact(s) can be recovered with Treg.`;
      guessChecks.delete(campaignId);
      if (options.continueToResearch && store.listResearchEligibleProspects(campaignId)
        .some(({ id }) => !store.getProspectResearch(id))) {
        try {
          const run = launchWorkflow(db, { campaignId, kind: "PROSPECT_RESEARCH" }, options.dependencies);
          message += ` Automatically started PROSPECT_RESEARCH (run ${run.id}).`;
        } catch (error) {
          message += ` Prospect research could not start: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      lastGuessChecks.set(campaignId, message);
      return message;
    })
    .catch((error: unknown) => {
      const message = `SMTP guess check failed: ${error instanceof Error ? error.message : String(error)}`;
      lastGuessChecks.set(campaignId, message);
      return message;
    })
    .finally(() => guessChecks.delete(campaignId));
}

/**
 * Starts the paid, targeted Treg recovery for every recoverable guess in the campaign.
 * Only an explicit human action (dashboard button or CLI) calls this.
 */
export function launchEmailRecovery(
  db: SqliteDatabase, campaignId: number, dependencies: RunnerDependencies = {},
): WorkflowRun {
  const contactIds = new OutboundStore(db).listEmailRecoveryCandidates(campaignId).map(({ id }) => id);
  if (contactIds.length === 0) throw new WorkflowError("No contacts need Treg recovery");
  return launchWorkflow(db, { campaignId, kind: "EMAIL_DISCOVERY", contactIds }, dependencies);
}

/** A targeted post-SMTP Treg recovery, as opposed to normal (Treg-free) email discovery. */
export function isEmailRecovery(request: WorkflowRequest): boolean {
  return request.kind === "EMAIL_DISCOVERY" && !!request.contactIds?.length && !request.emailTask;
}

/** A targeted, free search for public same-domain address evidence for existing guesses. */
export function isPatternEvidence(request: WorkflowRequest): boolean {
  return request.kind === "EMAIL_DISCOVERY" && request.emailTask === "PATTERN_EVIDENCE";
}

/** Starts the free pattern-evidence search for every eligible guess in the campaign. */
export function launchPatternEvidence(
  db: SqliteDatabase, campaignId: number, dependencies: RunnerDependencies = {},
): WorkflowRun {
  const contactIds = new OutboundStore(db).listPatternEvidenceCandidates(campaignId).map(({ id }) => id);
  if (contactIds.length === 0) throw new WorkflowError("No guesses need a pattern-evidence search");
  return launchWorkflow(db, { campaignId, kind: "EMAIL_DISCOVERY", contactIds, emailTask: "PATTERN_EVIDENCE" }, dependencies);
}
