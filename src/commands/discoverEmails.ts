import { spawnSync } from "node:child_process";
import { openDatabase } from "../db/database.js";
import { OutboundStore } from "../db/store.js";
import { resolveCodexExecutable } from "./codexExecutable.js";
import { SmtpVerifier } from "../email/smtpVerifier.js";
import { formatSummary, verifyGuessedEmails } from "../email/verifyGuesses.js";
import { buildPrompt } from "../workflows/runner.js";

const rawCampaignId = process.argv[2];
const campaignId = Number(rawCampaignId);

if (!rawCampaignId || !Number.isSafeInteger(campaignId) || campaignId <= 0) {
  console.error("Usage: npm run emails:discover -- <campaign-id>");
  process.exitCode = 1;
} else {
  const db = openDatabase();
  const store = new OutboundStore(db);
  const campaign = store.getCampaign(campaignId);
  const companies = campaign ? store.listCompanies({ campaignId }) : [];
  const approvedContacts = companies
    .flatMap(({ id }) => store.listContacts(id))
    .filter(({ status, emailStatus, guessedEmail }) => status === "APPROVED"
      && (emailStatus === "UNKNOWN" || (emailStatus === "EMAIL_NOT_FOUND" && !guessedEmail)));
  db.close();

  if (!campaign) {
    console.error(`Error: campaign ${campaignId} was not found.`);
    process.exitCode = 1;
  } else if (approvedContacts.length === 0) {
    console.error(`Error: campaign ${campaignId} has no APPROVED contacts awaiting email discovery or a guess.`);
    process.exitCode = 1;
  } else {
    let codexExecutable: string;
    try {
      codexExecutable = resolveCodexExecutable();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error: ${message}`);
      process.exitCode = 1;
      process.exit();
    }

    // Same prompt as the dashboard workflow, so the CLI never drifts (e.g. back to Treg-first).
    const prompt = buildPrompt({ campaignId, kind: "EMAIL_DISCOVERY" });

    console.log(
      `Starting Codex email discovery for campaign ${campaignId} `
      + `(${approvedContacts.length} approved contacts)...`,
    );
    const result = spawnSync(
      codexExecutable,
      [
        "--search", "-C", process.cwd(), "--sandbox", "workspace-write",
        "--ask-for-approval", "never", "exec", prompt,
      ],
      { stdio: "inherit" },
    );

    if (result.error) {
      console.error(`Unable to start Codex: ${result.error.message}`);
      process.exitCode = 1;
    } else if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
    } else {
      // Free step of the pipeline: SMTP-check the new guesses. Treg stays a separate command.
      const checkDb = openDatabase();
      try {
        const checkStore = new OutboundStore(checkDb);
        const summary = await verifyGuessedEmails(checkStore, campaignId, new SmtpVerifier());
        console.log(`SMTP guess check: ${formatSummary(summary)}.`);
        const recoverable = checkStore.listEmailRecoveryCandidates(campaignId).length;
        if (recoverable) console.log(`${recoverable} contact(s) can be recovered with: npm run emails:recover -- ${campaignId}`);
      } finally {
        checkDb.close();
      }
    }
  }
}
