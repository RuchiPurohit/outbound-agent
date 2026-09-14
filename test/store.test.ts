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
    assert.equal(reopenedDb.pragma("user_version", { simple: true }), 4);
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

    const outreach = store.createOutreach({ contactId: contact.id, subject: "Subject", body: "Body" });
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
      const outreach = store.createOutreach({ contactId: contact.id, subject: "Subject", body: "Body" });
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
});
