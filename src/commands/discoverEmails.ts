import { spawnSync } from "node:child_process";
import { openDatabase } from "../db/database.js";
import { OutboundStore } from "../db/store.js";
import { resolveCodexExecutable } from "./codexExecutable.js";

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

    const prompt = [
      "Read AGENTS.md, docs/ICP.md, and prompts/email-discovery.md.",
      `Run email discovery for campaign ${campaignId}.`,
      "Process APPROVED contacts whose email status is UNKNOWN, plus EMAIL_NOT_FOUND contacts without a stored guess for guess-only completion.",
      "Persist every sourced result through recordEmailDiscovery and show the outcomes.",
      "After EMAIL_NOT_FOUND, optionally store one clearly labeled, non-sendable company-domain guess through recordEmailGuess, following the runbook's pattern order and evidence rules.",
      "Never store a guess in contacts.email or treat it as public or verified. Do not draft outreach, create Gmail drafts, or send messages.",
      "Complete the workflow; do not merely explain how to do it.",
    ].join(" ");

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
    }
  }
}
