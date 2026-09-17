import { withStore } from "./shared.js";

const rawCampaignId = process.argv[2];
const campaignId = rawCampaignId === undefined ? undefined : Number(rawCampaignId);
if (campaignId !== undefined && (!Number.isSafeInteger(campaignId) || campaignId <= 0)) {
  console.error(`Error: invalid campaign ID: ${rawCampaignId}`);
  process.exitCode = 1;
} else {
  withStore((store) => {
    const rows = store.listCompanies({ campaignId }).map((company) => ({
      ID: company.id,
      Campaign: company.campaignId,
      Name: company.name,
      Domain: company.domain,
      Location: company.location ?? "UNKNOWN",
      Employees: company.employeeCount ?? "UNKNOWN",
      Score: company.score ?? "UNKNOWN",
      "Chat feature": company.chatFeatureStatus === "PRESENT" ? "YES"
        : company.chatFeatureStatus === "NO_PUBLIC_EVIDENCE" ? "NO PUBLIC EVIDENCE" : "UNKNOWN",
      "Chat source": company.chatFeatureSourceUrl ?? "—",
      Status: company.status,
      Reason: company.reason ?? "UNKNOWN",
    }));
    if (rows.length === 0) console.log("No companies found.");
    else console.table(rows);
  });
}
