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
      assert.match(ready, /Click Run prospect research/);
      assert.doesNotMatch(ready, /then discover their business emails to unlock/);
      const run = store.createWorkflowRun({ campaignId: campaign.id, kind: "EMAIL_DISCOVERY" });
      store.startWorkflowRun(run.id);
      assert.match(renderProspectStages(store, campaign.id), /Wait for the active workflow to finish/);
      store.completeWorkflowRun(run.id);
      const researchRun = store.createWorkflowRun({ campaignId: campaign.id, kind: "PROSPECT_RESEARCH" });
      store.startWorkflowRun(researchRun.id);
      const running = renderProspectStages(store, campaign.id);
      assert.match(running, /Prospect research is in progress/);
      assert.doesNotMatch(running, /Click Run prospect research/);
    } finally { db.close(); }
  });

  it("chains email discovery to research, then requires explicit selection before drafting", async () => {
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
      await waitForRuns(store, 2);
      assert.equal(store.listOutreach(contact.id).length, 0);
      assert.equal(nextWorkflowRequest(store, { campaignId: campaign.id, kind: "PROSPECT_RESEARCH" }), undefined);
      launchWorkflow(db, { campaignId: campaign.id, kind: "EMAIL_GENERATION", contactIds: [contact.id] }, {
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
      assert.throws(() => validateRequest(store, { campaignId: campaign.id, kind: "EMAIL_GENERATION",
        contactIds: [contact.id] }), /Every selected prospect/);
      assert.match(renderProspectStages(store, campaign.id), /No credible angle/);
      assert.match(renderProspectStages(store, campaign.id),
        new RegExp(`name="contactIds" value="${contact.id}"[^>]*disabled`));
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

  it("shows all saved emails as collapsible items with draft-only review controls", () => {
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
      assert.match(html, /FIRST_BODY/);
      assert.match(html, new RegExp(`class="email-draft" id="email-${draft.id}" open`));
      assert.doesNotMatch(renderProspectStages(store, campaign.id), /class="email-draft"[^>]* open/);
      assert.match(html, /<h2>Emails<\/h2>/);
      assert.match(html, /Pain hypothesis \(not verified\)/);
      assert.match(html, /href="https:\/\/example.com\/jobs"/);
      assert.match(html, /Approve → Ready to send/);
      assert.match(html, /Request rewrite/);
      assert.match(html, /Reject draft/);
      assert.match(html, /Pat &lt;Lee&gt;/);
      assert.match(html, /Approval alone never sends an email/);
    } finally { db.close(); }
  });

  it("shows unchecked selection boxes and disables contacts with existing drafts or no signal", () => {
    const { db, store, campaign, contact, email, research } = fixture();
    try {
      email(); research();
      const ready = renderProspectStages(store, campaign.id);
      assert.match(ready, new RegExp(`name="contactIds" value="${contact.id}"[^>]*>`));
      assert.doesNotMatch(ready, /type="checkbox"[^>]*\schecked/);
      assert.match(ready, /Generate drafts for checked contacts/);
      assert.doesNotMatch(ready, /automatically starts draft generation|Research → generate drafts|Generate missing drafts/);
      store.createOutreach({ contactId: contact.id, subject: "Subject", body: "Body",
        researchId: store.getProspectResearch(contact.id)!.strongestResearchId! });
      const drafted = renderProspectStages(store, campaign.id);
      assert.match(drafted, new RegExp(`name="contactIds" value="${contact.id}"[^>]*disabled`));
      assert.match(drafted, /Draft already exists/);
      const draft = store.listOutreach(contact.id)[0]!;
      store.rejectOutreach(draft.id);
      const rejected = renderProspectStages(store, campaign.id);
      assert.match(rejected, /email-draft/);
      assert.match(rejected, /REJECTED/);
      assert.match(rejected, /Body/);
      assert.doesNotMatch(rejected, /Approve → Ready to send|Request rewrite|Reject draft/);
    } finally { db.close(); }
  });

  it("rejects empty, duplicate, cross-campaign, unresearched, and already-drafted selections", () => {
    const { db, store, campaign, contact, email, research } = fixture();
    try {
      email();
      const request = { campaignId: campaign.id, kind: "EMAIL_GENERATION" as const };
      assert.throws(() => validateRequest(store, request), /Select at least one/);
      assert.throws(() => validateRequest(store, { ...request, contactIds: [] }), /Select at least one/);
      assert.throws(() => validateRequest(store, { ...request, contactIds: [contact.id] }), /Every selected prospect/);
      research();
      validateRequest(store, { ...request, contactIds: [contact.id] });
      assert.throws(() => validateRequest(store, { ...request, contactIds: [contact.id, contact.id] }), /unique/);
      assert.throws(() => validateRequest(store, { ...request, contactIds: [9999] }), /Every selected prospect/);
      const other = store.createCampaign({ name: "Other", segment: "SaaS" });
      assert.throws(() => validateRequest(store, { ...request, campaignId: other.id,
        contactIds: [contact.id] }), /Every selected prospect/);
      store.createOutreach({ contactId: contact.id, subject: "Subject", body: "Body",
        researchId: store.getProspectResearch(contact.id)!.strongestResearchId! });
      assert.throws(() => validateRequest(store, { ...request, contactIds: [contact.id] }), /Every selected prospect/);
    } finally { db.close(); }
  });

  it("persists the selection and prevents the worker from drafting for an unchecked eligible contact", async () => {
    const { db, store, campaign, company, contact, email, research } = fixture();
    try {
      email(); research();
      const checked = store.createContact({ companyId: company.id, name: "Checked contact" });
      store.reviewContact(checked.id, "APPROVED");
      store.recordEmailDiscovery({ contactId: checked.id, emailStatus: "PUBLICLY_LISTED",
        email: "checked@example.com", sourceUrl: "https://example.com/team" });
      const analysis = store.saveProspectResearch({ contactId: checked.id,
        signals: [{ signal: "Launched workspace", sourceUrl: "https://example.com/launch" }],
        strongestSignalIndex: 0, painHypothesis: "May need messaging", relevance: "Chat infrastructure" });
      const fakeSpawn = (_executable: string, args: string[]) => {
        const prompt = args[args.length - 1]!;
        assert.ok(prompt.includes(`ONLY for these checked contact IDs: [${checked.id}]`));
        assert.throws(() => store.createOutreach({ contactId: contact.id, subject: "Unauthorized", body: "Body",
          researchId: store.getProspectResearch(contact.id)!.strongestResearchId! }), /restricted to checked contacts/);
        store.createOutreach({ contactId: checked.id, subject: "Checked draft", body: "Body",
          researchId: analysis.strongestResearchId! });
        return spawn(process.execPath, ["-e", "console.log('Simulated selected drafting completed')"]);
      };
      const run = launchWorkflow(db, { campaignId: campaign.id, kind: "EMAIL_GENERATION", contactIds: [checked.id] }, {
        resolveExecutable: () => "simulated-codex", spawnProcess: fakeSpawn,
      });
      await waitForRuns(store, 1);
      assert.deepEqual(JSON.parse(store.getWorkflowRun(run.id)!.details!).contactIds, [checked.id]);
      assert.equal(store.listOutreach(contact.id).length, 0);
      assert.equal(store.listOutreach(checked.id).length, 1);
      assert.equal(store.listOutreach(checked.id)[0]?.status, "DRAFT");
    } finally { db.close(); }
  });

  it("pins execution to the supplied database and retains safety instructions", () => {
    const prompt = buildPrompt({ campaignId: 2, kind: "DRAFT_REWRITE", outreachId: 4, feedback: "Less salesy" });
    assert.match(prompt, /docs\/EMAIL_RULES.md/);
    assert.match(prompt, /Rewrite outreach 4 in campaign 2/);
    assert.match(prompt, /Less salesy/);
    assert.match(prompt, /Never send messages/);
    const generation = buildPrompt({ campaignId: 2, kind: "EMAIL_GENERATION", contactIds: [7] });
    assert.match(generation, /Type A, Type B, automatic-qualifier, and LOW_FIT/);
    assert.match(generation, /first-party sources/);
    assert.match(generation, /one first-touch draft, not follow-ups/);
    assert.match(generation, /at least MEDIUM fit/);
    const discovery = buildPrompt({ campaignId: 2, kind: "COMPANY_DISCOVERY", targetCount: 5 });
    assert.match(discovery, /automatically qualify/);
    assert.match(discovery, /engagement benefit as a hypothesis/);
    assert.match(discovery, /never fill the quota with low-fit candidates/);
  });
});
