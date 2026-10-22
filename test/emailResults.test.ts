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

      store.recordEmailGuess({ contactId: contact.id, guessedEmail: "pat@example.com",
        pattern: "firstname", confidence: "COMMON_PATTERN",
        basis: "Verified name maps to the common first-name pattern" });
      const guessed = renderEmailResults([company], store.listContacts(company.id), store.listResearch(company.id));
      assert.match(guessed, /Guessed email/);
      assert.match(guessed, /pat@example.com/);
      assert.match(guessed, /COMMON PATTERN/);
      assert.match(guessed, /Email not found/);
    } finally { db.close(); }
  });

  it("stores a manually confirmed email in place of a guess, with its source", () => {
    const db = openDatabase(":memory:");
    try {
      const store = new OutboundStore(db);
      const campaign = store.createCampaign({ name: "Test", segment: "SaaS" });
      const company = store.createCompany({ campaignId: campaign.id, name: "Example", domain: "example.com" });
      store.reviewCompany(company.id, "APPROVED");
      const contact = store.createContact({ companyId: company.id, name: "Pat Lee" });
      store.reviewContact(contact.id, "APPROVED");
      const unchecked = renderEmailResults([company], store.listContacts(company.id), [], campaign.id);
      assert.match(unchecked, /Not checked yet/);
      assert.match(unchecked, new RegExp(`action="/campaigns/${campaign.id}/contacts/${contact.id}/email"`));

      store.recordEmailDiscovery({ contactId: contact.id, emailStatus: "EMAIL_NOT_FOUND" });
      store.recordEmailGuess({ contactId: contact.id, guessedEmail: "pat@example.com",
        pattern: "firstname", confidence: "COMMON_PATTERN", basis: "Common pattern" });
      assert.throws(() => store.recordManualEmail({ contactId: contact.id, email: "pat.lee@example.com",
        emailStatus: "VERIFIED", sourceUrl: "" }), /source URL/);
      assert.throws(() => store.recordManualEmail({ contactId: contact.id, email: "not-an-email",
        emailStatus: "VERIFIED", sourceUrl: "https://hunter.io/verify" }), /valid email/);

      const updated = store.recordManualEmail({ contactId: contact.id, email: "Pat.Lee@Example.com ",
        emailStatus: "VERIFIED", sourceUrl: "https://hunter.io/verify", note: "Checked in Hunter" });
      assert.equal(updated.email, "pat.lee@example.com");
      assert.equal(updated.emailStatus, "VERIFIED");
      assert.equal(updated.guessedEmail, null);
      assert.equal(store.getContactRecipient(contact.id)?.guessed, false);
      const html = renderEmailResults([company], store.listContacts(company.id), store.listResearch(company.id), campaign.id);
      assert.match(html, /href="https:\/\/hunter.io\/verify"/);
      assert.match(html, /Manually entered by the user: Checked in Hunter/);
      assert.doesNotMatch(html, /Guessed ·/);
    } finally { db.close(); }
  });

  it("shows an empty state before discovery", () => {
    assert.match(renderEmailResults([], [], []), /No email discovery results yet/);
  });
});
