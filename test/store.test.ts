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
    const campaign = store.createCampaign({
      name: "Initial ICP", productName: "ConvoKit", icp: "20-200 employee SaaS",
    });
    const company = store.createCompany({
      campaignId: campaign.id, name: "Example Co", website: "https://example.com",
      sourceUrls: ["https://example.com/about"],
    });
    return { campaign, company };
  }

  it("persists campaigns and companies with pending human review", () => {
    const { campaign, company } = campaignAndCompany();
    assert.equal(store.getCampaign(campaign.id)?.productName, "ConvoKit");
    assert.equal(company.approvalStatus, "pending");
    assert.deepEqual(store.getCompany(company.id)?.sourceUrls, ["https://example.com/about"]);
  });

  it("persists records after the database is reopened", () => {
    const directory = mkdtempSync(join(tmpdir(), "outbound-store-"));
    const filename = join(directory, "outbound.sqlite");
    const diskDb = openDatabase(filename);
    const diskStore = new OutboundStore(diskDb);
    const campaign = diskStore.createCampaign({ name: "Disk campaign", productName: "ConvoKit", icp: "Canada" });
    diskDb.close();

    const reopenedDb = openDatabase(filename);
    assert.equal(new OutboundStore(reopenedDb).getCampaign(campaign.id)?.name, "Disk campaign");
    assert.equal(reopenedDb.pragma("user_version", { simple: true }), 1);
    reopenedDb.close();
    rmSync(directory, { recursive: true });
  });

  it("only permits contacts after company approval", () => {
    const { company } = campaignAndCompany();
    assert.throws(
      () => store.createContact({ companyId: company.id, fullName: "Pat Lee" }),
      /approved companies/,
    );
    store.reviewCompany(company.id, "approved");
    const contact = store.createContact({ companyId: company.id, fullName: "Pat Lee", emailStatus: "not_found" });
    assert.equal(contact.email, null);
    assert.equal(contact.approvalStatus, "pending");
  });

  it("requires company/contact approval and explicit outreach approval before sending", () => {
    const { campaign, company } = campaignAndCompany();
    store.reviewCompany(company.id, "approved");
    const contact = store.createContact({ companyId: company.id, fullName: "Sam Kim" });
    const input = {
      campaignId: campaign.id, companyId: company.id, contactId: contact.id,
      kind: "first_touch" as const, sequenceNumber: 0, subject: "Chat infrastructure",
      body: "A short draft", reason: "Verified collaborative product signal",
    };
    assert.throws(() => store.createOutreach(input), /approved company and contact/);

    store.reviewContact(contact.id, "approved");
    const outreach = store.createOutreach(input);
    assert.throws(() => store.markOutreachSent(outreach.id), /explicit approval/);
    store.submitOutreachForApproval(outreach.id);
    const approved = store.reviewOutreach(outreach.id, "approved");
    assert.ok(approved.approvedAt);
    assert.equal(store.markOutreachSent(outreach.id, "message-1").status, "sent");
  });

  it("limits active outreach to two contacts at a company", () => {
    const { campaign, company } = campaignAndCompany();
    store.reviewCompany(company.id, "approved");
    const outreachIds = ["One", "Two", "Three"].map((name) => {
      const contact = store.createContact({ companyId: company.id, fullName: name });
      store.reviewContact(contact.id, "approved");
      return store.createOutreach({
        campaignId: campaign.id, companyId: company.id, contactId: contact.id,
        kind: "first_touch", sequenceNumber: 0, subject: "Subject", body: "Body",
        reason: "Company-specific reason",
      }).id;
    });
    store.submitOutreachForApproval(outreachIds[0]);
    store.submitOutreachForApproval(outreachIds[1]);
    assert.throws(() => store.submitOutreachForApproval(outreachIds[2]), /No more than two contacts/);
  });

  it("rejects a verified email without an address", () => {
    const { company } = campaignAndCompany();
    store.reviewCompany(company.id, "approved");
    assert.throws(() => store.createContact({
      companyId: company.id, fullName: "Alex Chen", emailStatus: "verified",
    }), /CHECK constraint failed/);
  });
});
