import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { describe, it } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { OutboundStore } from "../src/db/store.js";
import { renderProspectStages } from "../src/web/prospectStages.js";
import { buildPrompt, launchWorkflow, nextWorkflowRequest, validateRequest } from "../src/workflows/runner.js";

function fixture() {
  const db = openDatabase(":memory:");
  const store = new OutboundStore(db);
  const campaign = store.createCampaign({ name: "Test", segment: "SaaS" });
  const company = store.createCompany({ campaignId: campaign.id, name: "Example", domain: "example.com" });
  store.reviewCompany(company.id, "APPROVED");
  const contact = store.createContact({ companyId: company.id, name: "Pat <Lee>", title: "CTO" });
  store.reviewContact(contact.id, "APPROVED");
  const email = () => store.recordEmailDiscovery({ contactId: contact.id, emailStatus: "PUBLICLY_LISTED",
    email: "pat@example.com", sourceUrl: "https://example.com/team" });
  const research = () => store.saveProspectResearch({ contactId: contact.id,
    signals: [{ signal: "Launched shared workspaces", sourceUrl: "https://example.com/launch" }],
    strongestSignalIndex: 0, painHypothesis: "Shared workspaces may need conversation infrastructure.",
    relevance: "ConvoKit provides chat infrastructure.",
  });
  return { db, store, campaign, company, contact, email, research };
}

async function waitForRuns(store: OutboundStore, count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const runs = store.listWorkflowRuns();
    if (runs.length === count && runs.every(({ status }) => status === "COMPLETED" || status === "FAILED")) return;
    await setTimeout(10);
  }
  assert.fail("Background workflow did not finish within two seconds");
}

describe("Prospect workflow", () => {
  it("distinguishes research prerequisites, ready prospects, and research in progress", () => {
    const { db, store, campaign, email } = fixture();
    try {
      assert.match(renderProspectStages(store, campaign.id), /No eligible prospects are ready for research/);
      email();
      const ready = renderProspectStages(store, campaign.id);
      assert.match(ready, /Approved prospects with business emails are ready for research/);
      assert.match(ready, /Click Research → generate drafts/);
      assert.doesNotMatch(ready, /then discover their business emails to unlock/);
      const run = store.createWorkflowRun({ campaignId: campaign.id, kind: "EMAIL_DISCOVERY" });
      store.startWorkflowRun(run.id);
      assert.match(renderProspectStages(store, campaign.id), /Wait for the active workflow to finish/);
      store.completeWorkflowRun(run.id);
      const researchRun = store.createWorkflowRun({ campaignId: campaign.id, kind: "PROSPECT_RESEARCH" });
      store.startWorkflowRun(researchRun.id);
      const running = renderProspectStages(store, campaign.id);
      assert.match(running, /Prospect research is in progress/);
      assert.doesNotMatch(running, /Click Research → generate drafts/);
    } finally { db.close(); }
  });

  it("chains email discovery to research to generation, then stops for human approval", async () => {
    const { db, store, campaign, contact, email, research } = fixture();
    const prompts: string[] = [];
    try {
      const fakeSpawn = (_executable: string, args: string[]) => {
        const prompt = args[args.length - 1]!;
        prompts.push(prompt);
        if (prompt.includes("Run email discovery")) email();
        if (prompt.includes("Run prospect research")) research();
        if (prompt.includes("Generate first-touch drafts")) {
          store.createOutreach({ contactId: contact.id, subject: "Shared workspaces",
            body: "Saw the shared-workspace launch. If messaging grows, ConvoKit may help. Worth sending API docs? Ruchi",
            researchId: store.getProspectResearch(contact.id)!.strongestResearchId!,
          });
        }
        return spawn(process.execPath, ["-e", "console.log('Simulated worker completed')"]);
      };
      launchWorkflow(db, { campaignId: campaign.id, kind: "EMAIL_DISCOVERY" }, {
        resolveExecutable: () => "simulated-codex", spawnProcess: fakeSpawn,
      });
      await waitForRuns(store, 3);
      assert.deepEqual(store.listWorkflowRuns().reverse().map(({ kind }) => kind),
        ["EMAIL_DISCOVERY", "PROSPECT_RESEARCH", "EMAIL_GENERATION"]);
      assert.equal(store.listOutreach(contact.id)[0]?.status, "DRAFT");
      assert.equal(store.listOutreach(contact.id)[0]?.reviewedAt, null);
      assert.equal(store.listOutreach(contact.id)[0]?.sentAt, null);
      assert.equal(prompts.length, 3);
      assert.equal(nextWorkflowRequest(store, { campaignId: campaign.id, kind: "EMAIL_GENERATION" }), undefined);
    } finally { db.close(); }
  });

  it("does not continue failed research or prospects without credible signals", async () => {
    const { db, store, campaign, contact, email } = fixture();
    try {
      email();
      const fakeSpawn = () => spawn(process.execPath, ["-e", "process.exit(1)"]);
      launchWorkflow(db, { campaignId: campaign.id, kind: "PROSPECT_RESEARCH" }, {
        resolveExecutable: () => "simulated-codex", spawnProcess: fakeSpawn,
      });
      await waitForRuns(store, 1);
      assert.equal(store.listWorkflowRuns()[0]?.status, "FAILED");
      assert.equal(store.listOutreach(contact.id).length, 0);
      store.saveProspectResearch({ contactId: contact.id, signals: [], notes: "No useful signal" });
      assert.equal(nextWorkflowRequest(store, { campaignId: campaign.id, kind: "PROSPECT_RESEARCH" }), undefined);
      assert.throws(() => validateRequest(store, { campaignId: campaign.id, kind: "EMAIL_GENERATION" }), /No researched/);
      assert.match(renderProspectStages(store, campaign.id), /No credible angle/);
    } finally { db.close(); }
  });

  it("checks live approvals, campaign ownership, and rewrite eligibility", () => {
    const { db, store, campaign, company, contact, email, research } = fixture();
    try {
      assert.throws(() => validateRequest(store, { campaignId: campaign.id, kind: "PROSPECT_RESEARCH" }), /No approved prospects/);
      email();
      research();
      const draft = store.createOutreach({ contactId: contact.id, subject: "Subject", body: "Body",
        researchId: store.getProspectResearch(contact.id)!.strongestResearchId! });
      const other = store.createCampaign({ name: "Other", segment: "SaaS" });
      assert.throws(() => validateRequest(store, { campaignId: other.id, kind: "DRAFT_REWRITE",
        outreachId: draft.id, feedback: "Shorter" }), /eligible DRAFT/);
      validateRequest(store, { campaignId: campaign.id, kind: "DRAFT_REWRITE", outreachId: draft.id, feedback: "Shorter" });
      store.reviewCompany(company.id, "REJECTED");
      assert.throws(() => store.approveOutreachForSending(draft.id), /currently APPROVED/);
      store.reviewCompany(company.id, "APPROVED");
      store.approveOutreachForSending(draft.id);
      assert.throws(() => validateRequest(store, { campaignId: campaign.id, kind: "DRAFT_REWRITE",
        outreachId: draft.id, feedback: "Shorter" }), /eligible DRAFT/);
    } finally { db.close(); }
  });

  it("shows sourced research and one full draft at a time with review controls", () => {
    const { db, store, campaign, company, contact, email, research } = fixture();
    try {
      email(); research();
      store.createOutreach({ contactId: contact.id, subject: "First draft", body: "FIRST_BODY",
        researchId: store.getProspectResearch(contact.id)!.strongestResearchId! });
      const second = store.createContact({ companyId: company.id, name: "Second contact" });
      store.reviewContact(second.id, "APPROVED");
      store.recordEmailDiscovery({ contactId: second.id, emailStatus: "PUBLICLY_LISTED",
        email: "second@example.com", sourceUrl: "https://example.com/team" });
      const analysis = store.saveProspectResearch({ contactId: second.id,
        signals: [{ signal: "Hiring platform engineers", sourceUrl: "https://example.com/jobs" }],
        strongestSignalIndex: 0, painHypothesis: "May face platform work", relevance: "Chat infrastructure" });
      const draft = store.createOutreach({ contactId: second.id, subject: "Second draft", body: "SECOND_BODY",
        researchId: analysis.strongestResearchId! });
      const html = renderProspectStages(store, campaign.id, draft.id);
      assert.match(html, /SECOND_BODY/);
      assert.doesNotMatch(html, /FIRST_BODY/);
      assert.match(html, /Pain hypothesis \(not verified\)/);
      assert.match(html, /href="https:\/\/example.com\/jobs"/);
      assert.match(html, /Approve → Ready to send/);
      assert.match(html, /Request rewrite/);
      assert.match(html, /Reject draft/);
      assert.match(html, /Pat &lt;Lee&gt;/);
      assert.match(html, /no sending integration is enabled/);
    } finally { db.close(); }
  });

  it("pins execution to the supplied database and retains safety instructions", () => {
    const prompt = buildPrompt({ campaignId: 2, kind: "DRAFT_REWRITE", outreachId: 4, feedback: "Less salesy" });
    assert.match(prompt, /docs\/EMAIL_RULES.md/);
    assert.match(prompt, /Rewrite outreach 4 in campaign 2/);
    assert.match(prompt, /Less salesy/);
    assert.match(prompt, /Never send messages/);
  });
});
