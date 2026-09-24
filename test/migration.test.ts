import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { migrations } from "../src/db/schema.js";
import { OutboundStore } from "../src/db/store.js";

it("migrates version 4 without losing existing outreach or workflow output", () => {
  const directory = mkdtempSync(join(tmpdir(), "outbound-migration-"));
  const filename = join(directory, "test.sqlite");
  const old = new Database(filename);
  try {
    old.pragma("foreign_keys = ON");
    for (let i = 0; i < 4; i++) old.exec(migrations[i]!);
    old.pragma("user_version = 4");
    old.prepare("INSERT INTO campaigns VALUES (1, 'Legacy', 'SaaS', '2026-09-01', 'DRAFT')").run();
    old.prepare(`INSERT INTO companies (id,campaign_id,name,domain,score,status,created_at)
      VALUES (1,1,'Example','example.com',88,'APPROVED','2026-09-01')`).run();
    old.prepare("INSERT INTO contacts (id,company_id,name,status) VALUES (1,1,'Pat','APPROVED')").run();
    old.prepare("INSERT INTO outreach (id,contact_id,subject,body) VALUES (1,1,'Old subject','Old body')").run();
    old.prepare(`INSERT INTO workflow_runs (id,campaign_id,kind,status,output,requested_at,started_at,finished_at)
      VALUES (1,1,'CONTACT_DISCOVERY','COMPLETED','Existing output','2026-09-01','2026-09-01','2026-09-01')`).run();
  } finally { old.close(); }
  const db = openDatabase(filename);
  try {
    const store = new OutboundStore(db);
    assert.equal(store.getOutreach(1)?.subject, "Old subject");
    assert.equal(store.getOutreach(1)?.researchId, null);
    assert.equal(store.getWorkflowRun(1)?.output, "Existing output");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(db.pragma("user_version", { simple: true }), 9);
    assert.equal(store.getCompany(1)?.chatFeatureStatus, "UNKNOWN");
    assert.equal(store.getCompany(1)?.chatFeatureSourceUrl, null);
    assert.equal(store.getCompany(1)?.chatImplementation, "UNKNOWN");
    assert.equal(store.getCompany(1)?.salesThesis, null);
    assert.equal(store.getCompany(1)?.score, 88);
    assert.equal(store.getCompany(1)?.scoreBreakdown, null);
    assert.equal(store.getContact(1)?.guessedEmail, null);
    assert.equal(store.getContact(1)?.guessedEmailConfidence, null);
    assert.throws(() => store.approveOutreachForSending(1), /sourced or explicitly guessed/);
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});

it("migrates version 7 company chat evidence without changing historic scores", () => {
  const directory = mkdtempSync(join(tmpdir(), "outbound-company-migration-"));
  const filename = join(directory, "test.sqlite");
  const old = new Database(filename);
  try {
    old.pragma("foreign_keys = ON");
    for (let i = 0; i < 7; i++) old.exec(migrations[i]!);
    old.pragma("user_version = 7");
    old.prepare("INSERT INTO campaigns (name,segment,created_at) VALUES ('Legacy','SaaS','2026-09-01')").run();
    old.prepare(`INSERT INTO companies (campaign_id,name,domain,score,status,created_at,
      chat_feature_status,chat_feature_source_url)
      VALUES (1,'Example','example.com',92,'APPROVED','2026-09-01',
      'PRESENT','https://example.com/messages')`).run();
  } finally { old.close(); }
  const db = openDatabase(filename);
  try {
    const company = new OutboundStore(db).getCompany(1)!;
    assert.equal(company.score, 92);
    assert.equal(company.scoreBreakdown, null);
    assert.equal(company.chatFeatureStatus, "PRESENT");
    assert.equal(company.chatFeatureSourceUrl, "https://example.com/messages");
    assert.equal(company.chatImplementation, "UNKNOWN");
    assert.equal(company.engineeringHeadcount, null);
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    assert.equal(db.pragma("user_version", { simple: true }), 9);
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});
