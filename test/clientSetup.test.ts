import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { OutboundStore } from "../src/db/store.js";
import {
  buildDocument, buildStagePrompt, defaultSetup, DOCUMENT_IDS, DOCUMENTS, missingInputs, parseSectionForm, resolveSetup,
  SECTIONS, type StageId,
} from "../src/prompts/clientSetup.js";
import { renderClientsPage } from "../src/web/clientsPage.js";

const STAGES = SECTIONS.filter(({ id }) => id !== "profile").map(({ id }) => id as StageId);

describe("Client setup prompts", () => {
  it("lists the seven stages in funnel order after the client profile", () => {
    assert.deepEqual(SECTIONS.map(({ id }) => id), ["profile", "company-discovery", "contact-discovery",
      "linkedin-profile-research", "email-discovery", "prospect-research", "email-generation", "follow-up-generation"]);
  });

  it("builds complete prompts from the ConvoKit defaults", () => {
    const setup = defaultSetup("convokit");
    for (const section of SECTIONS) assert.deepEqual(missingInputs(section.id, setup), [], section.id);
    for (const stage of STAGES) {
      const prompt = buildStagePrompt(stage, setup);
      assert.doesNotMatch(prompt, /NOT SET/, stage);
      assert.match(prompt, /ConvoKit/, stage);
    }
    const company = buildStagePrompt("company-discovery", setup);
    for (const key of ["workflowFit", "chatImplementation", "timingSignal", "teamFit", "stackFit", "liveProduct"]) {
      assert.match(company, new RegExp(`\`${key}\``));
    }
    assert.match(buildStagePrompt("email-generation", setup), /about 100 words including the signature; never exceed 140/);
    assert.match(buildStagePrompt("email-generation", setup), /```text\nRuchi\nhttps:\/\/convokit.app\/\n```/);
  });

  it("marks every missing input in prompts for a blank client", () => {
    const setup = defaultSetup("blank");
    assert.ok(missingInputs("company-discovery", setup).includes("Priority segments"));
    assert.match(buildStagePrompt("company-discovery", setup), /\[NOT SET: Priority segments\]/);
    assert.match(buildStagePrompt("email-generation", setup), /\[NOT SET: Product name\]/);
    assert.match(buildStagePrompt("contact-discovery", setup), /store up to two of the best publicly/);
  });

  it("parses form input and rejects out-of-range numbers", () => {
    const form = new URLSearchParams({ tone: "  plain  ", targetWords: "90", maxWords: "120",
      structure: "Hi <first name>,\r\n\r\n Observation \n", bannedPhrases: "" });
    const values = parseSectionForm("email-generation", form);
    assert.equal(values.tone, "plain");
    assert.equal(values.targetWords, 90);
    assert.deepEqual(values.structure, ["Hi <first name>,", "Observation"]);
    assert.deepEqual(values.bannedPhrases, []);
    assert.throws(() => parseSectionForm("email-generation", new URLSearchParams({ targetWords: "5", maxWords: "120" })), /whole number from 30/);
    assert.equal(parseSectionForm("contact-discovery", new URLSearchParams()).allowFallback, false);
    assert.equal(parseSectionForm("contact-discovery", new URLSearchParams({ allowFallback: "yes" })).allowFallback, true);
  });

  it("fills missing or malformed stored values with blanks", () => {
    const setup = resolveSetup({ profile: { productName: "Acme", capabilities: "not a list" }, nonsense: {} });
    assert.equal(setup.profile.productName, "Acme");
    assert.deepEqual(setup.profile.capabilities, []);
    assert.equal(setup["email-generation"].targetWords, 100);
  });
});

describe("Client documents", () => {
  it("builds complete PRODUCT.md, ICP.md, and EMAIL_RULES.md from the ConvoKit defaults", () => {
    const setup = defaultSetup("convokit");
    assert.deepEqual(DOCUMENTS.map(({ fileName }) => fileName), ["PRODUCT.md", "ICP.md", "EMAIL_RULES.md"]);
    for (const id of DOCUMENT_IDS) {
      assert.deepEqual(missingInputs(id, setup), [], id);
      assert.doesNotMatch(buildDocument(id, setup), /NOT SET/, id);
    }
    const product = buildDocument("doc-product", setup);
    assert.match(product, /^# ConvoKit product profile/);
    assert.match(product, /\| `marketplace` \| marketplaces with buyers and sellers \| a buyer and seller sorting out an order \|/);
    assert.match(product, /\| \(omit s\) \| anything else \|/);
    assert.match(product, /Do not mention these in outreach[\s\S]*support inbox/);
    const icp = buildDocument("doc-icp", setup);
    assert.match(icp, /\| Messaging workflow fit \(`workflowFit`\) \| 0–30 \|/);
    assert.match(icp, /1\. CTO or Technical Founder/);
    assert.match(icp, /### Tier 2 — pursue selectively\n\n- strong greenfield workflow/);
    assert.match(icp, /`workflowFit`:\n\n- 0: no sourced product workflow/);
    const rules = buildDocument("doc-email-rules", setup);
    assert.match(rules, /never exceed 140/);
    assert.match(rules, /- touch base/);
    assert.match(rules, /- https:\/\/convokit.app\/docs/);
  });

  it("uses each shared input once and points stage prompts at the client documents", () => {
    const setup = defaultSetup("convokit");
    setup.profile.capabilities = ["threaded replies"];
    setup["company-discovery"].prioritySegments = ["clinics"];
    setup["doc-icp"].notes = "Skip companies in stealth.";
    assert.match(buildDocument("doc-product", setup), /## Confirmed capabilities\n\n- threaded replies\n/);
    assert.match(buildDocument("doc-icp", setup), /Priority segments:\n\n- clinics\n/);
    assert.match(buildDocument("doc-icp", setup), /## Additional notes\n\nSkip companies in stealth\./);
    assert.match(buildStagePrompt("company-discovery", setup), /Read AGENTS\.md, ICP\.md \(client document\), PRODUCT\.md \(client document\)/);
    assert.match(buildStagePrompt("email-generation", setup), /PRODUCT\.md \(client document\), EMAIL_RULES\.md \(client document\)/);
    assert.doesNotMatch(buildStagePrompt("linkedin-profile-research", setup), /client document/);
  });

  it("flags missing document inputs for a blank client but never optional notes", () => {
    const setup = defaultSetup("blank");
    assert.ok(missingInputs("doc-icp", setup).includes("Tier 1: pursue first"));
    assert.ok(!missingInputs("doc-icp", setup).includes("Additional notes"));
    assert.match(buildDocument("doc-icp", setup), /\[NOT SET: Commercial objective\]/);
    assert.match(buildDocument("doc-product", setup), /Nothing is listed/);
  });
});

describe("Clients", () => {
  it("backfills sections added after an existing ConvoKit client was created", () => {
    const db = openDatabase(":memory:");
    try {
      const store = new OutboundStore(db);
      const old = defaultSetup("convokit") as Record<string, unknown>;
      for (const id of DOCUMENT_IDS) delete old[id];
      (old.profile as Record<string, unknown>).referenceDocs = ["AGENTS.md", "docs/ICP.md", "docs/PRODUCT.md", "docs/EMAIL_RULES.md"];
      (old.profile as Record<string, unknown>).productName = "ConvoKit Edited";
      db.prepare("INSERT INTO clients (name, settings, created_at, updated_at) VALUES ('ConvoKit', ?, 'x', 'x')").run(JSON.stringify(old));
      const client = store.ensureDefaultClient();
      for (const id of DOCUMENT_IDS) assert.deepEqual(missingInputs(id, client.setup), [], id);
      assert.deepEqual(client.setup.profile.referenceDocs, ["AGENTS.md"]);
      assert.equal(client.setup.profile.productName, "ConvoKit Edited");
    } finally { db.close(); }
  });

  it("creates the ConvoKit client once and attaches earlier campaigns", () => {
    const db = openDatabase(":memory:");
    try {
      const store = new OutboundStore(db);
      const campaign = store.createCampaign({ name: "Old", segment: "SaaS" });
      assert.equal(campaign.clientId, null);
      const convokit = store.ensureDefaultClient();
      assert.equal(convokit.name, "ConvoKit");
      assert.deepEqual(missingInputs("company-discovery", convokit.setup), []);
      assert.equal(store.getCampaign(campaign.id)?.clientId, convokit.id);
      assert.equal(store.ensureDefaultClient().id, convokit.id);
      assert.equal(store.listClients().length, 1);
    } finally { db.close(); }
  });

  it("creates, renames, and updates clients without sharing inputs", () => {
    const db = openDatabase(":memory:");
    try {
      const store = new OutboundStore(db);
      const convokit = store.ensureDefaultClient();
      const acme = store.createClient({ name: "Acme", setup: convokit.setup });
      assert.throws(() => store.createClient({ name: "acme" }), /already exists/);
      assert.throws(() => store.createClient({ name: "  " }), /name is required/);
      store.updateClientSection(acme.id, "profile", { ...acme.setup.profile, productName: "AcmeChat" });
      assert.equal(store.getClient(acme.id)?.setup.profile.productName, "AcmeChat");
      assert.equal(store.getClient(convokit.id)?.setup.profile.productName, "ConvoKit");
      assert.throws(() => store.renameClient(acme.id, "ConvoKit"), /already exists/);
      assert.equal(store.renameClient(acme.id, "Acme Inc").name, "Acme Inc");
      const campaign = store.createCampaign({ name: "New", segment: "SaaS", clientId: acme.id });
      assert.equal(campaign.clientId, acme.id);
      assert.throws(() => store.createCampaign({ name: "Bad", segment: "SaaS", clientId: 999 }), /Client not found/);

      const blank = store.createClient({ name: "Blank Co" });
      const html = renderClientsPage(store, new URL(`http://localhost/?client=${blank.id}`));
      assert.match(html, /Blank Co/);
      assert.match(html, /input\(s\) missing/);
      assert.match(html, new RegExp(`action="/clients/${blank.id}/sections/company-discovery"`));
      assert.match(html, new RegExp(`href="/clients/${blank.id}/prompts/follow-up-generation.md"`));
      assert.match(html, new RegExp(`href="/clients/${blank.id}/docs/doc-icp.md"`));
      assert.match(html, new RegExp(`action="/clients/${blank.id}/sections/doc-email-rules"`));
    } finally { db.close(); }
  });
});
