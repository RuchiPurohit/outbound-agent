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
    assert.equal(reopenedDb.pragma("user_version", { simple: true }), 2);
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
});
