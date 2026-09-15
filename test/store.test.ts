import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type Database from "better-sqlite3";
import { openDatabase } from "../src/db/database.js";
import { OutboundStore } from "../src/db/store.js";

describe("OutboundStore", () => {
  let db: Database.Database;
  let store: OutboundStore;

  beforeEach(() => {
    db = openDatabase(":memory:");
    store = new OutboundStore(db);
  });
  afterEach(() => db.close());

  function campaignAndCompany() {
    const campaign = store.createCampaign({ name: "Initial ICP", segment: "20-200 employee SaaS" });
    const company = store.createCompany({
      campaignId: campaign.id,
      name: "Example Co",
      domain: "example.com",
      location: "Canada",
      employeeCount: 80,
      score: 75,
      reason: "Has user-to-user collaboration",
    });
    return { campaign, company };
  }

  function researchFor(contactId: number): number {
    store.recordEmailDiscovery({ contactId, emailStatus: "PUBLICLY_LISTED",
      email: `person-${contactId}@example.com`, sourceUrl: "https://example.com/team" });
    return store.saveProspectResearch({ contactId,
      signals: [{ signal: "Launched shared workspaces", sourceUrl: "https://example.com/launch" }],
      strongestSignalIndex: 0, painHypothesis: "Shared workspaces may need contextual conversations.",
      relevance: "ConvoKit can provide chat infrastructure.",
    }).strongestResearchId!;
  }

  it("uses numeric IDs and explicit initial statuses", () => {
    const { campaign, company } = campaignAndCompany();
    assert.equal(campaign.id, 1);
    assert.equal(campaign.status, "DRAFT");
    assert.equal(company.id, 1);
    assert.equal(company.status, "DISCOVERED");
  });

  it("persists records after reopening the SQLite file", () => {
    const directory = mkdtempSync(join(tmpdir(), "outbound-store-"));
    const filename = join(directory, "outbound.sqlite");
    const diskDb = openDatabase(filename);
    const campaign = new OutboundStore(diskDb).createCampaign({ name: "Disk campaign", segment: "Canada" });
    diskDb.close();
    const reopenedDb = openDatabase(filename);
    assert.equal(new OutboundStore(reopenedDb).getCampaign(campaign.id)?.name, "Disk campaign");
    assert.equal(reopenedDb.pragma("user_version", { simple: true }), 5);
    reopenedDb.close();
    rmSync(directory, { recursive: true });
  });

  it("approves multiple companies atomically", () => {
    const { campaign, company } = campaignAndCompany();
    const second = store.createCompany({ campaignId: campaign.id, name: "Second", domain: "second.test" });
    const approved = store.reviewCompanies([company.id, second.id], "APPROVED");
    assert.deepEqual(approved.map(({ status }) => status), ["APPROVED", "APPROVED"]);

    assert.throws(() => store.reviewCompanies([company.id, 999], "REJECTED"), /Company not found/);
    assert.equal(store.getCompany(company.id)?.status, "APPROVED");
  });

  it("only allows contacts for approved companies and never assumes email addresses", () => {
    const { company } = campaignAndCompany();
    assert.throws(() => store.createContact({ companyId: company.id, name: "Pat Lee" }), /APPROVED companies/);
    store.reviewCompany(company.id, "APPROVED");
    const contact = store.createContact({ companyId: company.id, name: "Pat Lee", emailStatus: "EMAIL_NOT_FOUND" });
    assert.equal(contact.email, null);
    assert.equal(contact.status, "DISCOVERED");
    assert.throws(
      () => store.createContact({ companyId: company.id, name: "Alex", emailStatus: "VERIFIED" }),
      /CHECK constraint failed/,
    );
  });

  it("reviews multiple contacts atomically", () => {
    const { company } = campaignAndCompany();
    store.reviewCompany(company.id, "APPROVED");
    const first = store.createContact({ companyId: company.id, name: "First" });
    const second = store.createContact({ companyId: company.id, name: "Second" });
    assert.deepEqual(
      store.reviewContacts([first.id, second.id], "APPROVED").map(({ status }) => status),
      ["APPROVED", "APPROVED"],
    );
    assert.throws(() => store.reviewContacts([first.id, 999], "REJECTED"), /Contact not found/);
    assert.equal(store.getContact(first.id)?.status, "APPROVED");
  });

  it("records sourced email discovery only for approved contacts", () => {
    const { company } = campaignAndCompany();
    store.reviewCompany(company.id, "APPROVED");
    const contact = store.createContact({ companyId: company.id, name: "Email Target" });
    assert.throws(() => store.recordEmailDiscovery({
      contactId: contact.id,
      emailStatus: "PUBLICLY_LISTED",
      email: "target@example.com",
      sourceUrl: "https://example.com/team",
    }), /APPROVED contacts/);

    store.reviewContact(contact.id, "APPROVED");
    assert.throws(() => store.recordEmailDiscovery({
      contactId: contact.id,
      emailStatus: "PUBLICLY_LISTED",
      email: "target@example.com",
    }), /source URL/);

    const updated = store.recordEmailDiscovery({
      contactId: contact.id,
      emailStatus: "PUBLICLY_LISTED",
      email: "target@example.com",
      sourceUrl: "https://example.com/team",
    });
    assert.equal(updated.email, "target@example.com");
    assert.equal(updated.emailStatus, "PUBLICLY_LISTED");
    assert.equal(store.listResearch(company.id).at(-1)?.sourceUrl, "https://example.com/team");
  });

  it("stores EMAIL_NOT_FOUND without an address", () => {
    const { company } = campaignAndCompany();
    store.reviewCompany(company.id, "APPROVED");
    const contact = store.createContact({ companyId: company.id, name: "No Email" });
    store.reviewContact(contact.id, "APPROVED");
    assert.throws(() => store.recordEmailDiscovery({
      contactId: contact.id,
      emailStatus: "EMAIL_NOT_FOUND",
      email: "guessed@example.com",
    }), /cannot include/);
    assert.equal(store.recordEmailDiscovery({
      contactId: contact.id,
      emailStatus: "EMAIL_NOT_FOUND",
    }).emailStatus, "EMAIL_NOT_FOUND");
  });

  it("enforces the outreach approval state machine", () => {
    const { company } = campaignAndCompany();
    store.reviewCompany(company.id, "APPROVED");
    const contact = store.createContact({ companyId: company.id, name: "Sam Kim" });
    assert.throws(() => store.createOutreach({ contactId: contact.id, subject: "Subject", body: "Body" }), /APPROVED company and contact/);
    store.reviewContact(contact.id, "APPROVED");

    const researchId = researchFor(contact.id);
    const outreach = store.createOutreach({ contactId: contact.id, subject: "Subject", body: "Body", researchId });
    assert.equal(outreach.status, "DRAFT");
    assert.throws(() => store.markOutreachSent(outreach.id), /READY_TO_SEND/);
    store.approveOutreach(outreach.id);
    store.markOutreachReady(outreach.id);
    const sent = store.markOutreachSent(outreach.id, "gmail-thread-1");
    assert.equal(sent.status, "SENT");
    assert.ok(sent.sentAt);
    assert.equal(store.markOutreachReplied(outreach.id).status, "REPLIED");
  });

  it("limits active outreach to two contacts per company", () => {
    const { company } = campaignAndCompany();
    store.reviewCompany(company.id, "APPROVED");
    const outreachIds = ["One", "Two", "Three"].map((name) => {
      const contact = store.createContact({ companyId: company.id, name });
      store.reviewContact(contact.id, "APPROVED");
      const researchId = researchFor(contact.id);
      const outreach = store.createOutreach({ contactId: contact.id, subject: "Subject", body: "Body", researchId });
      store.approveOutreach(outreach.id);
      return outreach.id;
    });
    store.markOutreachReady(outreachIds[0]);
    store.markOutreachReady(outreachIds[1]);
    assert.throws(() => store.markOutreachReady(outreachIds[2]), /No more than two contacts/);
  });

  it("persists background workflow runs and their output", () => {
    const { campaign } = campaignAndCompany();
    const run = store.createWorkflowRun({
      campaignId: campaign.id,
      kind: "COMPANY_DISCOVERY",
      details: JSON.stringify({ targetCount: 5 }),
    });
    assert.equal(run.status, "PENDING");
    assert.throws(
      () => store.createWorkflowRun({ campaignId: campaign.id, kind: "CONTACT_DISCOVERY" }),
      /already active/,
    );
    store.startWorkflowRun(run.id);
    store.appendWorkflowOutput(run.id, "Found one company.\n");
    const completed = store.completeWorkflowRun(run.id);
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.output, "Found one company.\n");
    assert.ok(completed.finishedAt);
  });

  it("requires sourced emails, limits signals to three, and preserves NO_SIGNAL", () => {
    const { company } = campaignAndCompany();
    store.reviewCompany(company.id, "APPROVED");
    const contact = store.createContact({ companyId: company.id, name: "Pat" });
    store.reviewContact(contact.id, "APPROVED");
    assert.throws(() => store.saveProspectResearch({ contactId: contact.id, signals: [] }), /sourced business email/);
    store.recordEmailDiscovery({ contactId: contact.id, emailStatus: "PUBLICLY_LISTED",
      email: "pat@example.com", sourceUrl: "https://example.com/team" });
    const signal = { signal: "Launched workspace", sourceUrl: "https://example.com/launch" };
    assert.throws(() => store.saveProspectResearch({ contactId: contact.id,
      signals: [signal, signal, signal, signal] }), /At most three/);
    assert.throws(() => store.saveProspectResearch({ contactId: contact.id,
      signals: [signal], strongestSignalIndex: 2, painHypothesis: "May need messaging", relevance: "Chat" }), /strongest signal/);
    const result = store.saveProspectResearch({ contactId: contact.id, signals: [], notes: "No specific public signal" });
    assert.equal(result.status, "NO_SIGNAL");
    assert.equal(result.strongestResearchId, null);
    assert.throws(() => store.createOutreach({ contactId: contact.id, subject: "Hi", body: "Hello" }), /research signal/);
    assert.throws(() => store.saveProspectResearch({ contactId: contact.id, signals: [] }), /already exists/);
  });

  it("requires prospect-specific draft evidence and rejects duplicate first touches", () => {
    const { company } = campaignAndCompany();
    store.reviewCompany(company.id, "APPROVED");
    const contact = store.createContact({ companyId: company.id, name: "Pat" });
    store.reviewContact(contact.id, "APPROVED");
    const researchId = researchFor(contact.id);
    const role = store.createResearchRecord({ companyId: company.id, contactId: contact.id,
      signal: "CTO role", sourceUrl: "https://example.com/team" });
    assert.throws(() => store.createOutreach({ contactId: contact.id, subject: "Hi", body: "Hello", researchId: role.id }), /research signal/);
    const draft = store.createOutreach({ contactId: contact.id, subject: "Hi", body: "Hello", researchId });
    assert.throws(() => store.createOutreach({ contactId: contact.id, subject: "Duplicate", body: "Hello", researchId }), /already exists/);
    store.rewriteOutreach(draft.id, { subject: "Shorter", body: "New draft", researchId });
    assert.equal(store.getOutreach(draft.id)?.status, "DRAFT");
    assert.equal(store.getOutreach(draft.id)?.reviewedAt, null);
    assert.equal(store.approveOutreachForSending(draft.id).status, "READY_TO_SEND");
    assert.ok(store.getOutreach(draft.id)?.reviewedAt);
    assert.equal(store.getOutreach(draft.id)?.sentAt, null);
    assert.throws(() => store.rewriteOutreach(draft.id, { subject: "Again", body: "Changed", researchId }), /Only DRAFT/);
  });

  it("retains rejection and rolls back approval when the contact limit is exceeded", () => {
    const { company } = campaignAndCompany();
    store.reviewCompany(company.id, "APPROVED");
    const drafts = ["One", "Two", "Three", "Rejected"].map((name) => {
      const contact = store.createContact({ companyId: company.id, name });
      store.reviewContact(contact.id, "APPROVED");
      return store.createOutreach({ contactId: contact.id, subject: name, body: "Body", researchId: researchFor(contact.id) });
    });
    store.approveOutreachForSending(drafts[0].id);
    store.approveOutreachForSending(drafts[1].id);
    assert.throws(() => store.approveOutreachForSending(drafts[2].id), /two contacts/);
    assert.equal(store.getOutreach(drafts[2].id)?.status, "DRAFT");
    assert.equal(store.getOutreach(drafts[2].id)?.reviewedAt, null);
    assert.equal(store.rejectOutreach(drafts[3].id).status, "REJECTED");
    assert.throws(() => store.approveOutreachForSending(drafts[3].id), /Only DRAFT/);
  });
});
