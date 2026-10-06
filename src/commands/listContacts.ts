import { withStore } from "./shared.js";

const rawCampaignId = process.argv[2];
const campaignId = rawCampaignId === undefined ? undefined : Number(rawCampaignId);

if (campaignId !== undefined && (!Number.isSafeInteger(campaignId) || campaignId <= 0)) {
  console.error(`Error: invalid campaign ID: ${rawCampaignId}`);
  process.exitCode = 1;
} else {
  withStore((store) => {
    const companies = store.listCompanies({ campaignId });
    const companyNames = new Map(companies.map(({ id, name }) => [id, name]));
    const rows = companies.flatMap((company) => store.listContacts(company.id))
      .sort((left, right) => {
        const companyOrder = left.companyId - right.companyId;
        return companyOrder || (right.roleScore ?? -1) - (left.roleScore ?? -1);
      })
      .map((contact) => ({
        ID: contact.id,
        Company: companyNames.get(contact.companyId),
        Name: contact.name,
        Title: contact.title ?? "UNKNOWN",
        Category: contact.roleCategory ?? "UNKNOWN",
        Score: contact.roleScore ?? "UNKNOWN",
        Profile: contact.linkedinUrl ?? "UNKNOWN",
        Status: contact.status,
        Email: contact.email ?? "UNKNOWN",
        EmailStatus: contact.emailStatus,
        GuessedEmail: contact.guessedEmail ?? "NONE",
        GuessConfidence: contact.guessedEmailConfidence ?? "NONE",
      }));

    if (rows.length === 0) console.log("No contacts found.");
    else console.table(rows);
  });
}
