import { config } from "dotenv";
import { openDatabase } from "../db/database.js";
import { OutboundStore } from "../db/store.js";
import { SmtpVerifier } from "../email/smtpVerifier.js";
import { formatSummary, verifyGuessedEmails } from "../email/verifyGuesses.js";

config({ quiet: true });
const rawCampaignId = process.argv[2];
const db = openDatabase(process.env.OUTBOUND_DB_PATH ?? "data/outbound.sqlite");
try {
  const store = new OutboundStore(db);
  // Default to the most recent campaign with guesses awaiting an SMTP check.
  const campaignId = rawCampaignId === undefined
    ? store.listCampaigns().reverse().find(({ id }) => store.listGuessesAwaitingVerification(id).length > 0)?.id
    : Number(rawCampaignId);
  if (campaignId === undefined) {
    console.log("No guessed emails are awaiting an SMTP check.");
  } else {
    if (!Number.isSafeInteger(campaignId) || campaignId <= 0) throw new Error(`Invalid campaign ID: ${rawCampaignId}`);
    console.log(`SMTP-verifying guessed emails for campaign ${campaignId}…`);
    const summary = await verifyGuessedEmails(store, campaignId, new SmtpVerifier(), (contact, result) => {
      console.log(`${contact.name} <${result.address}>: ${result.verdict} — ${result.detail}`);
    });
    console.log(`SMTP check done: ${formatSummary(summary)}.`);
    const recoverable = store.listEmailRecoveryCandidates(campaignId).length;
    if (recoverable) console.log(`${recoverable} contact(s) can be recovered with: npm run emails:recover -- ${campaignId}`);
  }
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  db.close();
}
