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
      "Location source": company.locationSourceUrl ?? "—",
      Employees: company.employeeCount ?? company.employeeCountRange ?? "UNKNOWN",
      "Headcount source": company.employeeCountSourceUrl ?? "—",
      Engineers: company.engineeringHeadcount ?? "UNKNOWN",
      "Engineers source": company.engineeringHeadcountSourceUrl ?? "—",
      Score: company.score ?? "UNKNOWN",
      "Score breakdown": company.scoreBreakdown ? JSON.stringify(company.scoreBreakdown) : "—",
      "Chat feature": company.chatFeatureStatus === "PRESENT" ? "YES"
        : company.chatFeatureStatus === "NO_PUBLIC_EVIDENCE" ? "NO PUBLIC EVIDENCE" : "UNKNOWN",
      "Chat source": company.chatFeatureSourceUrl ?? "—",
      "Chat implementation": company.chatImplementation,
      "Chat vendor": company.chatVendorName ?? "—",
      "Implementation source": company.chatImplementationSourceUrl ?? "—",
      "Sales thesis": company.salesThesis ?? "—",
      Status: company.status,
      Reason: company.reason ?? "UNKNOWN",
    }));
    if (rows.length === 0) console.log("No companies found.");
    else console.table(rows);
  });
}
