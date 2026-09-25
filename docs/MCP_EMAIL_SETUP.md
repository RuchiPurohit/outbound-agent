# Custom Mail MCP dashboard setup

The dashboard can use a compatible OAuth-enabled mail MCP as an alternative
email transport. Gmail remains available and is still the default.

## Configure

Add these non-secret settings to the local `.env` file:

```env
EMAIL_TRANSPORT=mcp
MCP_EMAIL_URL=https://your-mail-mcp.example/mcp
MCP_EMAIL_SENDER_EMAIL=sender@example.com
MCP_EMAIL_REDIRECT_URI=http://127.0.0.1:3000/gmail/callback
MCP_EMAIL_PROFILE_TOOL=
MCP_EMAIL_SEND_TOOL=
MCP_EMAIL_ACCOUNT_ID=
```

Do not put the mailbox password or an OAuth bearer token in `.env`. The
dashboard performs OAuth 2.1 authorization-code authentication with PKCE,
registers its local client dynamically, and stores the resulting access and
refresh tokens in `data/mcp-email-oauth.json` with owner-only permissions.

`MCP_EMAIL_PROFILE_TOOL` may remain empty when exactly one server tool declares
`_meta["openai/profile"]: true`. Otherwise, the callback reports the advertised
tool names; set the verified profile tool name and reconnect.

Set `MCP_EMAIL_SEND_TOOL` to the exact compatible tool shown after connecting.
The adapter supports a single approved recipient as either a string or one-item
array and maps the approved body to `text` when required by the tool schema. If
the server exposes `list_mail_accounts`, the adapter resolves `accountId` by
matching `MCP_EMAIL_SENDER_EMAIL`. Set `MCP_EMAIL_ACCOUNT_ID` only if the server
returns multiple accounts without a unique matching address. A successful MCP
acknowledgement is stored as a receipt even when the server omits provider
message or thread IDs.

## Connect

1. Restart with `npm run dashboard`.
2. Open `http://127.0.0.1:3000/gmail`.
3. Choose **Connect Custom Mail MCP**.
4. Enter the mailbox credentials only on the provider's HTTPS authorization
   page and approve `profile`, `mail:read`, and `mail:send`. Read access is used
   to resolve the configured mailbox through `list_mail_accounts`; research and
   drafting workflows still receive no mailbox credentials or message access.
5. After returning to the dashboard, send only the fixed test email to an
   address you control.

Disconnecting requests token revocation and removes the local token file.
Research and generation workers never receive MCP email environment variables
or tokens. Every prospect email still requires its existing approval and a
separate final send confirmation.
