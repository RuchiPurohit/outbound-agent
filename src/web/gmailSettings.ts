import { randomUUID } from "node:crypto";
import type { OutboundStore } from "../db/store.js";
import type { EmailTransport } from "../email/transport.js";
import { TEST_BODY, TEST_SUBJECT } from "../gmail/sending.js";

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

export function renderGmailSettings(
  store: OutboundStore, options: {
    providers: Array<{ client: EmailTransport; expectedSender: string; canSend: boolean }>;
    activeId: string;
    recipient: string; expectedSender: string; signTest: (id: string, sender: string) => string;
    mcpTools?: Array<{ name: string; inputFields: string[]; profile: boolean }>;
  },
): string {
  const active = options.providers.find(({ client }) => client.id === options.activeId)?.client;
  if (!active) throw new Error("Active email transport is unavailable");
  const email = active.connectedEmail();
  const requestId = randomUUID();
  const deliveries = store.listEmailDeliveries();
  const busy = deliveries.some(({ status }) => status === "SENDING" || status === "PREPARING");
  const history = deliveries.slice(0, 30).map((delivery) => `<details><summary>${delivery.kind === "TEST" ? "Test email" : `Outreach ${delivery.outreachId}`} · ${escapeHtml(delivery.toEmail)} <span class="badge ${delivery.status}">${delivery.status}</span></summary><p><strong>Provider:</strong> ${escapeHtml(delivery.provider)}<br><strong>From:</strong> ${escapeHtml(delivery.fromEmail)}<br><strong>To:</strong> ${escapeHtml(delivery.toEmail)}<br><strong>Subject:</strong> ${escapeHtml(delivery.subject)}</p><p class="muted">${escapeHtml(delivery.createdAt)}${delivery.providerReceipt ? `<br>Receipt: ${escapeHtml(delivery.providerReceipt)}` : ""}${delivery.gmailMessageId ? `<br>Provider message: ${escapeHtml(delivery.gmailMessageId)}${delivery.gmailThreadId ? ` · Thread: ${escapeHtml(delivery.gmailThreadId)}` : ""}` : ""}</p>${delivery.error ? `<div class="notice error">${escapeHtml(delivery.error)}</div>` : ""}</details>`).join("");
  const connectionCards = options.providers.map(({ client, expectedSender, canSend }) => {
    const connected = client.connectedEmail();
    const configurationHelp = client.id === "gmail"
      ? "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env. See docs/GMAIL_SETUP.md."
      : "Set MCP_EMAIL_URL and MCP_EMAIL_SENDER_EMAIL in .env. See docs/MCP_EMAIL_SETUP.md.";
    return `<section class="card span4"><h2>${escapeHtml(client.label)} ${client.id === options.activeId ? '<span class="badge APPROVED">Active sender</span>' : ""}</h2><p>${connected ? `<span class="badge APPROVED">Connected</span><br><strong>${escapeHtml(connected)}</strong>` : `<span class="badge UNKNOWN">Not connected</span><br>Expected sender: ${escapeHtml(expectedSender || "Not configured")}`}</p><p class="muted">${client.id === options.activeId ? "Approved sends use this transport." : `Available as an alternative. Set EMAIL_TRANSPORT=${escapeHtml(client.id)} and restart to use it for sends.`}</p>${!client.configured() ? `<div class="notice">${configurationHelp}</div>` : ""}${connected && !canSend ? '<div class="notice">Connected, but sending stays disabled until MCP_EMAIL_SEND_TOOL names the verified send tool.</div>' : ""}<form method="post" action="/gmail/connect"><input type="hidden" name="provider" value="${escapeHtml(client.id)}"><button ${!client.configured() || busy ? "disabled" : ""}>${connected ? `Reconnect ${escapeHtml(client.label)}` : `Connect ${escapeHtml(client.label)}`}</button></form>${connected ? `<form method="post" action="/gmail/disconnect" style="margin-top:10px"><input type="hidden" name="provider" value="${escapeHtml(client.id)}"><button class="secondary" ${busy ? "disabled" : ""}>Disconnect ${escapeHtml(client.label)}</button></form>` : ""}</section>`;
  }).join("");
  const toolDetails = options.mcpTools?.length
    ? `<section class="card span12"><h2>Authenticated MCP tools</h2><p class="muted">Use the exact verified tool name in MCP_EMAIL_SEND_TOOL. A compatible send tool must expose accountId, to, subject, and either text or body.</p>${options.mcpTools.map((tool) => `<p><code>${escapeHtml(tool.name)}</code>${tool.profile ? ' <span class="badge APPROVED">Profile</span>' : ""}<br><span class="muted">Inputs: ${escapeHtml(tool.inputFields.join(", ") || "none")}</span></p>`).join("")}</section>` : "";
  const activeView = options.providers.find(({ client }) => client.id === active.id)!;
  const testDisabled = !email || !activeView.canSend;
  return `<a href="/">← Campaigns</a><h1 style="margin-top:18px">Email connections</h1><p class="lede">Connect Gmail and/or a compatible mail MCP. Only the transport marked Active sender can send; changing it requires configuration and a restart.</p><div class="grid" style="margin-top:24px">${connectionCards}<section class="card span12"><h2>Send a test via ${escapeHtml(active.label)}</h2><p class="muted">This sends the fixed test message below, not a prospect draft. No campaign outreach is changed.</p><form method="post" action="/gmail/test"><input type="hidden" name="requestId" value="${requestId}"><input type="hidden" name="testSignature" value="${!testDisabled ? escapeHtml(options.signTest(requestId, email!)) : ""}"><p><strong>From:</strong> ${escapeHtml(email ?? (options.expectedSender || "Connect the active sender first"))}</p><label><span>Test recipient</span><input name="recipient" type="email" value="${escapeHtml(options.recipient)}" required ${testDisabled ? "disabled" : ""}></label><p><strong>Subject:</strong> ${escapeHtml(TEST_SUBJECT)}</p><pre class="email-preview">${escapeHtml(TEST_BODY)}</pre><label class="inline"><input type="checkbox" name="confirm" value="yes" required>I confirm sending this test email to the recipient above.</label><button ${testDisabled || busy ? "disabled" : ""}>Send test email now</button></form></section>${toolDetails}<section class="card span12"><h2>Delivery history</h2><p class="muted">Uncertain delivery is blocked from retry to avoid duplicate emails. Check the sender's Sent folder if an attempt is uncertain.</p>${history || '<div class="empty">No sends have been attempted yet.</div>'}</section></div>`;
}
