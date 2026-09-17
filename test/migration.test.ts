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
    old.prepare(`INSERT INTO companies (id,campaign_id,name,domain,status,created_at)
      VALUES (1,1,'Example','example.com','APPROVED','2026-09-01')`).run();
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
    assert.equal(db.pragma("user_version", { simple: true }), 7);
    assert.equal(store.getCompany(1)?.chatFeatureStatus, "UNKNOWN");
    assert.equal(store.getCompany(1)?.chatFeatureSourceUrl, null);
    assert.throws(() => store.approveOutreachForSending(1), /sourced business email/);
  } finally { db.close(); rmSync(directory, { recursive: true }); }
});
