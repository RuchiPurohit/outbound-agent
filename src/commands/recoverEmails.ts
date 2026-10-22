import { setTimeout as sleep } from "node:timers/promises";
import { config } from "dotenv";
import { openDatabase } from "../db/database.js";
import { OutboundStore } from "../db/store.js";
import { launchEmailRecovery } from "../workflows/runner.js";

config({ quiet: true });
const rawCampaignId = process.argv[2];
const campaignId = Number(rawCampaignId);
if (!rawCampaignId || !Number.isSafeInteger(campaignId) || campaignId <= 0) {
  console.error("Usage: npm run emails:recover -- <campaign-id>");
  process.exitCode = 1;
} else {
  const db = openDatabase(process.env.OUTBOUND_DB_PATH ?? "data/outbound.sqlite");
  try {
    const store = new OutboundStore(db);
    const count = store.listEmailRecoveryCandidates(campaignId).length;
    const run = launchEmailRecovery(db, campaignId);
    console.log(`Started paid Treg recovery for ${count} contact(s) (run ${run.id}).`);
    // The Codex child writes into this database, so keep it open until the run ends.
    let printed = 0;
    for (;;) {
      const current = store.getWorkflowRun(run.id)!;
      process.stdout.write(current.output.slice(printed));
      printed = current.output.length;
      if (current.status === "COMPLETED" || current.status === "FAILED") {
        console.log(`\nTreg recovery ${current.status.toLowerCase()}${current.error ? `: ${current.error}` : ""}.`);
        if (current.status === "FAILED") process.exitCode = 1;
        break;
      }
      await sleep(2000);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
