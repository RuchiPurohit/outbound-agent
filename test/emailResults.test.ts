import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { OutboundStore } from "../src/db/store.js";
import { renderEmailResults } from "../src/web/emailResults.js";

describe("Email discovery results", () => {
  it("renders persisted addresses with email evidence, not role evidence", () => {
    const db = openDatabase(":memory:");
    try {
      const store = new OutboundStore(db);
      const campaign = store.createCampaign({ name: "Test", segment: "SaaS" });
      const company = store.createCompany({ campaignId: campaign.id, name: "Example", domain: "example.com" });
      store.reviewCompany(company.id, "APPROVED");
      const contact = store.createContact({ companyId: company.id, name: "Pat <Lee>" });
      store.reviewContact(contact.id, "APPROVED");
      store.createResearchRecord({ companyId: company.id, contactId: contact.id,
        signal: "CTO role", sourceUrl: "https://example.com/team" });
      store.recordEmailDiscovery({ contactId: contact.id, emailStatus: "PUBLICLY_LISTED",
        email: "pat@example.com", sourceUrl: "https://example.com/email-evidence" });
      const html = renderEmailResults([company], store.listContacts(company.id), store.listResearch(company.id));
      assert.match(html, /pat@example.com/);
      assert.match(html, /Publicly listed/);
      assert.match(html, /href="https:\/\/example.com\/email-evidence"/);
      assert.doesNotMatch(html, /href="https:\/\/example.com\/team"/);
      assert.match(html, /Pat &lt;Lee&gt;/);

      store.recordEmailDiscovery({ contactId: contact.id, emailStatus: "EMAIL_NOT_FOUND" });
      const notFound = renderEmailResults([company], store.listContacts(company.id), store.listResearch(company.id));
      assert.match(notFound, /Email not found/);
      assert.doesNotMatch(notFound, /pat@example.com/);
      assert.doesNotMatch(notFound, /email-evidence/);
    } finally { db.close(); }
  });

  it("shows an empty state before discovery", () => {
    assert.match(renderEmailResults([], [], []), /No email discovery results yet/);
  });
});
