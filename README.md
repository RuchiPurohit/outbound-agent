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
  segment: "US/Canada software companies with 20-200 employees",
});

db.close();
```

Run `npm test` to build and exercise the schema and workflow safeguards.

## Commands

All commands use the same `data/outbound.sqlite` file:

```sh
npm run campaign:create -- "Initial ICP" "US/Canada software companies with 20-200 employees"
npm run campaign:list
npm run companies:list
npm run companies:list -- 1
npm run companies:approve -- 3 6 8 9
npm run companies:reject -- 4 7
npm run contacts:discover -- 1
npm run contacts:list -- 1
npm run contacts:approve -- 1 2 3
npm run contacts:reject -- 4 5
npm run emails:discover -- 1
```

The optional argument to `companies:list` is a campaign ID. Company review
commands are atomic: if one ID is invalid, no company in that invocation is
changed.

`contacts:discover` validates that the campaign exists and has approved
companies, then runs the installed Codex CLI with live web search and the
instructions in `prompts/contact-discovery.md`. It writes verified contacts to
SQLite but does not research email addresses or create outreach.

`emails:discover` similarly runs `prompts/email-discovery.md` for approved
contacts only. It stores sourced outcomes in SQLite and writes a readable report
to `data/campaign-<id>-emails.md`.

If `codex` is not on the shell `PATH`, the command also checks common VS Code,
VS Code Insiders, Cursor, and Windsurf extension locations. You can override
discovery explicitly:

```sh
CODEX_CLI_PATH=/absolute/path/to/codex npm run contacts:discover -- 1
```

## Local dashboard

Start the campaign control center:

```sh
npm run dashboard
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000). From the dashboard
you can create a campaign, launch company/contact/email discovery, inspect
Codex run output, and approve or reject companies and contacts. Research runs
in the background and the page refreshes while a run is active. There is no
chat interface and the dashboard does not call the OpenAI API directly; it uses
the installed Codex CLI and the same local SQLite database as the CLI commands.

Set `OUTBOUND_PORT` to use a different port or `OUTBOUND_DB_PATH` to use a
different SQLite file.
