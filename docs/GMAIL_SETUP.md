# Gmail dashboard setup

The local dashboard sends through the Gmail API using Google OAuth. It requests
`gmail.send`, `openid`, and `email`: permission to send and identify the connected
account, not to read the inbox. Google documents the permission in its
[Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Configure Google

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Gmail API** for that project.
3. Configure Google Auth Platform's consent screen (branding and audience).
   For a personal Gmail account, use **External**, keep the app in **Testing**,
   and add the Gmail account you will connect as a test user.
4. Configure the scopes `https://www.googleapis.com/auth/gmail.send`, `openid`,
   and `email`.
5. Create an OAuth client with application type **Web application**.
6. Add this exact authorized redirect URI:
   `http://127.0.0.1:3000/gmail/callback`.
7. Copy `.env.example` to `.env` locally, then fill in `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` from that client. Set `GMAIL_SENDER_EMAIL` to the
   exact account you will connect. Never paste credentials into chat or commit them.

Google's [web-server OAuth guide](https://developers.google.com/identity/protocols/oauth2/web-server)
explains client credentials, redirect URI matching, and offline authorization.
If using a different `OUTBOUND_PORT`, update both the registered redirect URI
and `GMAIL_REDIRECT_URI` to that port.

## Connect and send the test

1. Stop the running dashboard and restart it with `npm run dashboard`.
2. Open [the Gmail page](http://127.0.0.1:3000/gmail). Use `127.0.0.1`, not `localhost`.
3. Click **Connect Gmail**, choose the configured sender, and grant permission.
   The dashboard refuses a different sender account.
4. In the test form, enter an address you control, inspect
   the displayed test subject/body, check the confirmation box, and send.
5. Check the recipient's inbox (and spam folder). The delivery history records
   Google's message and thread IDs on success.

The test is a fixed, clearly labeled integration message. It does not use a
prospect draft or change any campaign outreach status. A real test cannot be
sent until Google credentials are configured and the account is connected.

## Send approved prospect emails

Expand the email under **Emails**, approve it, then choose **Review & send via
Gmail**. Verify the exact sender, recipient, subject, and body and explicitly
confirm sending. Approval alone never sends. Only `READY_TO_SEND` emails with
current company/contact approval and sourced research are eligible.

Approval captures the recipient and content. Changes require fresh approval.
Previously approved emails from before this integration have no approval
snapshot: choose **Return to draft for review**, review, and approve again.
The limit of two active contacts per company remains enforced.

Gmail receives a MIME message through
[messages.send](https://developers.google.com/workspace/gmail/api/guides/sending).
Only a confirmed successful API response marks outreach `SENT` and stores its
Gmail thread ID. API acceptance is not proof of inbox placement or a reply.

## Failures and credentials

- Definite rejected requests are `FAILED`; review the error before manually
  trying again. There are no automatic retries.
- Timeouts, ambiguous provider responses, or interrupted sends are `UNCERTAIN`.
  Sending again is blocked because the message might already have been sent.
  Check Gmail's Sent folder before resolving the record. Automated reconciliation
  and an uncertainty-resolution UI are not implemented yet.
- **Disconnect** revokes Google authorization and removes the local token file.
  Testing-mode authorization may require reconnecting later.
- Tokens are stored in `data/gmail-oauth.json` (beside the configured SQLite file)
  with owner-only file permissions. This is local plaintext storage, not
  encryption. Treat backups as sensitive. `.env` and OAuth token files are
  ignored by Git; never add them with `git add -f`.
- Research workers do not receive Google/Gmail environment variables and are
  instructed not to read credentials or send email.
- Run the dashboard locally only. Do not expose it to the internet. Inbox
  reading, reply tracking, Gmail drafts, and follow-ups are not implemented.
