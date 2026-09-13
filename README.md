# Outbound Agent

An agent for managing outbound sales campaigns: sourcing companies and contacts, running campaigns, and sending email.

## Structure

- `src/db/` — data storage/access
- `src/companies/` — company sourcing and enrichment
- `src/contacts/` — contact sourcing and enrichment
- `src/campaigns/` — campaign definitions and orchestration
- `src/email/` — email drafting and sending
- `data/` — local data files
- `docs/` — workflow, ICP, and email rules documentation

See [AGENTS.md](AGENTS.md) for agent-specific instructions.

## Local persistence

The TypeScript persistence layer uses SQLite and creates `data/outbound.sqlite`
by default. Opening a database automatically applies versioned migrations:

```ts
import { openDatabase, OutboundStore } from "./src/index.js";

const db = openDatabase();
const store = new OutboundStore(db);

const campaign = store.createCampaign({
  name: "Initial ICP",
  productName: "ConvoKit",
  icp: "US/Canada software companies with 20-200 employees",
});

db.close();
```

Run `npm test` to build and exercise the schema and workflow safeguards.
