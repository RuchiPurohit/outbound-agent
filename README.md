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
npm run emails:verify-guesses -- 1
npm run emails:recover -- 1
```

The optional argument to `companies:list` is a campaign ID. Company review
commands are atomic: if one ID is invalid, no company in that invocation is
changed.

`contacts:discover` validates that the campaign exists and has approved
companies, then runs the installed Codex CLI with live web search and the
instructions in `prompts/contact-discovery.md`. It writes verified contacts to
SQLite but does not research email addresses or create outreach.

`emails:discover` similarly runs `prompts/email-discovery.md` for approved
contacts only, using public sources only (no Treg). It stores sourced outcomes in
SQLite and writes a readable report to `data/campaign-<id>-emails.md`. When no
public business address is found, it stores one clearly labeled company-domain
guess. Guesses remain `EMAIL_NOT_FOUND` and are never treated as sourced or
verified. They may be researched, drafted, approved, and sent only through the
same explicit human review and final Gmail confirmation used for sourced emails.

Email discovery is a three-step pipeline:

1. **Discovery (Codex, free):** public sources, then a pattern guess.
2. **SMTP check (local, free):** runs automatically when discovery finishes,
   and in the dashboard it then starts prospect research. It asks the domain's
   mail server to accept `RCPT TO` for the guess, then for the runbook's other
   patterns (`firstname`, `firstname.lastname`, `firstnamelastname`,
   `firstinitiallastname`, `firstname_lastname`), and keeps the first accepted
   address as the guess. A random address is probed to detect catch-all domains.
   It disconnects without sending mail and never probes `PUBLICLY_LISTED` or
   `VERIFIED` emails. Verdicts are `VALID`, `INVALID`, `CATCH_ALL`, or `UNKNOWN`
   (greylisting, IP blocks, or outbound port 25 blocked). A `VALID` guess stays
   labelled as a guess; an `INVALID` guess cannot be drafted or sent. Re-run it
   with **SMTP-check guesses** or `emails:verify-guesses`.
3. **Treg recovery (Codex, paid, manual):** only when you click **Recover with
   Treg (N)** or run `emails:recover`. It covers guesses whose SMTP result was
   `INVALID`, `CATCH_ALL`, or `UNKNOWN`. Treg promotes a contact to `VERIFIED`
   only on an exact `valid` verdict with an identity match. An identity-matched
   Treg address that verifies only as `catch_all` replaces the pattern guess but
   stays an unverified guess, labelled with its Treg audit URL. Contacts with a
   recorded outcome are never sent to Treg again. If Treg fails for credits,
   quota, or an outage, the dashboard shows "Treg recovery paused" and those
   contacts retry on the next click. Recovered contacts need **Run prospect
   research** afterwards. Because dashboard workflows run Codex with
   `--ask-for-approval never`, recovery runs alone pass
   `-c mcp_servers.treg.default_tools_approval_mode="approve"` so paid Treg
   calls are not rejected; your click on the button is that approval. Normal
   discovery runs keep the default policy, so Treg calls there are refused.

Optional `.env` overrides for the SMTP check: `SMTP_VERIFY_HELO` (EHLO name,
default hostname) and `SMTP_VERIFY_FROM` (envelope sender, default `<>`).

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

Company discovery also checks whether chat or user-to-user messaging is already
a public product feature. The company table shows **Yes** with supporting
evidence, **No public evidence**, or **Unknown**. “No public evidence” is not a
claim that the feature is absent.

Newly discovered companies also show a separate chat implementation assessment
(`HOMEGROWN`, `VENDOR`, `EXTERNAL`, `NONE_FOUND`, or `UNKNOWN`), a sourced total
headcount or range, a persisted sales thesis, and a six-factor score breakdown.
Engineering headcount remains **Unknown** unless independently sourced.
Existing companies retain their historical scores; new evidence fields start
unknown until researched. The [ICP](docs/ICP.md) owns the qualification paths,
geography rule, exclusions, and 100-point rubric; the discovery runbook describes
how to apply them and report candidates that did not qualify.

### Prospect research, drafting, and review

After email discovery, the dashboard automatically researches approved
prospects at approved companies with sourced business emails or separate
guessed-email hints. Guessed recipients remain visibly marked as unverified
through draft review and final send confirmation. Prospect research stores at
most three useful signals per contact, the strongest signal, a conditional pain
hypothesis, and ConvoKit relevance. Prospects without a credible signal are
marked `NO_SIGNAL` and are not drafted.

Research stops at a checklist. Check the researched contacts you want to draft
for, then click **Generate drafts for checked contacts**. Only that explicit
selection is passed to the worker and persisted in the workflow run. Empty,
ineligible, and already-drafted selections are rejected. Every generated email
uses `docs/EMAIL_RULES.md`, links to its cited research signal, and stays `DRAFT`.

For campaigns that already finished email discovery, click **Run prospect
research**. After a failed drafting run, select the still-undrafted contacts
and retry; existing first-touch emails are never duplicated.

The **Emails** section shows every saved email as a collapsible item with its
recipient, body, status, and source. Expand a draft to approve it atomically to
`READY_TO_SEND`, request a rewrite with style feedback, or reject it. Rewrites
remain `DRAFT`; approved and rejected emails remain available to expand.
The two-active-contacts-per-company limit is enforced at approval. Approval
alone never sends: Gmail sending requires a separate confirmation.

The saved runbooks are `prompts/prospect-research.md` and
`prompts/email-generation.md`. Their generated Markdown reports are covered by
the existing `data/campaign-*.md` ignore pattern.

### Gmail sending

Follow [Gmail setup](docs/GMAIL_SETUP.md) to configure a Gmail sender. The
dashboard's **Email connections** page provides separate Gmail and Custom Mail
MCP connection buttons and a clearly labeled test email. No prospect outreach
state changes during a test.

For an approved email, expand it under **Emails**, click **Review & send via
Gmail**, check the exact sender, recipient, subject, and body, then confirm.
Successful delivery stores Gmail message/thread IDs and marks the email `SENT`.
Uncertain delivery blocks another send to avoid duplicates; no automatic
retries or automatic sending are implemented.

The same guarded send pipeline can alternatively use a compatible Custom Mail
MCP through dashboard-managed OAuth. Gmail remains the default. See
[MCP email setup](docs/MCP_EMAIL_SETUP.md).
