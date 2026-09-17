import { randomUUID } from "node:crypto";
import type { OutboundStore } from "../db/store.js";
import type { GmailClient } from "../gmail/client.js";
import { TEST_BODY, TEST_SUBJECT } from "../gmail/sending.js";

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export function renderGmailSettings(
  client: GmailClient, store: OutboundStore, options: {
    recipient: string; expectedSender: string; signTest: (id: string, sender: string) => string;
  },
): string {
  const email = client.connectedEmail();
  const requestId = randomUUID();
  const deliveries = store.listEmailDeliveries();
  const busy = deliveries.some(({ status }) => status === "SENDING" || status === "PREPARING");
  const history = deliveries.slice(0, 30).map((delivery) => `<details><summary>${delivery.kind === "TEST" ? "Test email" : `Outreach ${delivery.outreachId}`} · ${escapeHtml(delivery.toEmail)} <span class="badge ${delivery.status}">${delivery.status}</span></summary><p><strong>From:</strong> ${escapeHtml(delivery.fromEmail)}<br><strong>To:</strong> ${escapeHtml(delivery.toEmail)}<br><strong>Subject:</strong> ${escapeHtml(delivery.subject)}</p><p class="muted">${escapeHtml(delivery.createdAt)}${delivery.gmailMessageId ? `<br>Gmail message: ${escapeHtml(delivery.gmailMessageId)} · Thread: ${escapeHtml(delivery.gmailThreadId)}` : ""}</p>${delivery.error ? `<div class="notice error">${escapeHtml(delivery.error)}</div>` : ""}</details>`).join("");
  return `<a href="/">← Campaigns</a><h1 style="margin-top:18px">Gmail</h1><p class="lede">Connect your sender, test delivery, and send approved emails from the dashboard.</p><div class="grid" style="margin-top:24px"><section class="card span4"><h2>Sender account</h2><p>${email ? `<span class="badge APPROVED">Connected</span><br><strong>${escapeHtml(email)}</strong>` : `<span class="badge UNKNOWN">Not connected</span><br>Expected sender: ${escapeHtml(options.expectedSender || "Your chosen Google account")}`}</p><p class="muted">Permission is limited to sending email and identifying the connected Google account. Inbox reading is not requested.</p>${!client.configured() ? '<div class="notice">Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, register the redirect URI, and restart. See docs/GMAIL_SETUP.md.</div>' : ""}<form method="post" action="/gmail/connect"><button ${!client.configured() || busy ? "disabled" : ""}>${email ? "Reconnect Gmail" : "Connect Gmail"}</button></form>${email ? `<form method="post" action="/gmail/disconnect" style="margin-top:10px"><button class="secondary" ${busy ? "disabled" : ""}>Disconnect Gmail</button></form>` : ""}</section><section class="card span8"><h2>Send a test email</h2><p class="muted">This sends the fixed test message below, not a prospect draft. No campaign outreach is changed.</p><form method="post" action="/gmail/test"><input type="hidden" name="requestId" value="${requestId}"><input type="hidden" name="testSignature" value="${email ? escapeHtml(options.signTest(requestId, email)) : ""}"><p><strong>From:</strong> ${escapeHtml(email ?? options.expectedSender ?? "Connect Gmail first")}</p><label><span>Test recipient</span><input name="recipient" type="email" value="${escapeHtml(options.recipient)}" required ${!email ? "disabled" : ""}></label><p><strong>Subject:</strong> ${escapeHtml(TEST_SUBJECT)}</p><pre class="email-preview">${escapeHtml(TEST_BODY)}</pre><label class="inline"><input type="checkbox" name="confirm" value="yes" required>I confirm sending this test email to the recipient above.</label><button ${!email || busy ? "disabled" : ""}>Send test email now</button></form></section><section class="card span12"><h2>Delivery history</h2><p class="muted">Uncertain delivery is blocked from retry to avoid duplicate emails. Check Gmail Sent if an attempt is uncertain.</p>${history || '<div class="empty">No sends have been attempted yet.</div>'}</section></div>`;
}
