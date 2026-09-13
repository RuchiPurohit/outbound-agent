import { withStore } from "./shared.js";

withStore((store) => {
  const rows = store.listCampaigns().map((campaign) => ({
    ID: campaign.id,
    Name: campaign.name,
    Segment: campaign.segment,
    Status: campaign.status,
    Created: campaign.createdAt,
  }));
  if (rows.length === 0) console.log("No campaigns found.");
  else console.table(rows);
});
