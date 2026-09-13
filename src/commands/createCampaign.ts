import { withStore } from "./shared.js";

const [name, segment] = process.argv.slice(2);
if (!name || !segment) {
  console.error('Usage: npm run campaign:create -- "Campaign name" "Target segment"');
  process.exitCode = 1;
} else {
  withStore((store) => {
    const campaign = store.createCampaign({ name, segment });
    console.log(`Created campaign ${campaign.id}: ${campaign.name}`);
  });
}
