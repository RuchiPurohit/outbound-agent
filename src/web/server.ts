import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { config } from "dotenv";
import { openDatabase } from "../db/database.js";
import { OutboundStore, WorkflowError } from "../db/store.js";
import type { Campaign, ResearchRecord, WorkflowRun } from "../db/types.js";
import { launchWorkflow } from "../workflows/runner.js";
import { renderEmailResults } from "./emailResults.js";
import { renderProspectStages } from "./prospectStages.js";
import { FileTokenStore, GmailClient } from "../gmail/client.js";
import { GmailSending } from "../gmail/sending.js";
import { renderGmailSettings } from "./gmailSettings.js";

config({ quiet: true });
const databasePath = process.env.OUTBOUND_DB_PATH ?? "data/outbound.sqlite";
const host = "127.0.0.1";
const port = Number(process.env.OUTBOUND_PORT ?? 3000);
const db = openDatabase(databasePath);
const store = new OutboundStore(db);
const interrupted = store.failInterruptedWorkflowRuns();
const interruptedDeliveries = store.recoverInterruptedDeliveries();
const appOrigin = `http://${host}:${port}`;
const csrfToken = randomBytes(32).toString("hex");
const expectedSender = process.env.GMAIL_SENDER_EMAIL ?? "aiwithruchi@gmail.com";
const redirectUri = process.env.GMAIL_REDIRECT_URI ?? `${appOrigin}/gmail/callback`;
const gmail = new GmailClient({ clientId: process.env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "", redirectUri, expectedSender,
}, new FileTokenStore(join(dirname(databasePath), "gmail-oauth.json")));
const gmailSending = new GmailSending(store, gmail);
const signature = (...values: unknown[]): string => createHmac("sha256", csrfToken)
  .update(JSON.stringify(values)).digest("hex");
const validSignature = (actual: string | null, expected: string): boolean =>
  !!actual && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const humanize = (value: string): string => value.toLowerCase().replaceAll("_", " ")
  .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());

function layout(title: string, body: string, options: { refreshing?: boolean } = {}): string {
  body = body.replace(/<form\b[^>]*method="post"[^>]*>/g,
    (form) => `${form}<input type="hidden" name="csrfToken" value="${csrfToken}">`);
  body = body.replace("<th>Score</th><th>Why ConvoKit</th>",
    "<th>Score</th><th>Chat feature</th><th>Why ConvoKit</th>");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Outbound</title>${options.refreshing ? '<meta http-equiv="refresh" content="3">' : ""}
<style>
:root{--ink:#17211b;--muted:#67736b;--paper:#f4f1e8;--card:#fffdf7;--line:#d9d5c9;--green:#236448;--green2:#dcebdd;--amber:#9a5b16;--red:#9e3c34;--blue:#315d83;--shadow:0 14px 36px rgba(27,36,30,.08)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.48 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--green);text-decoration:none}a:hover{text-decoration:underline}.shell{max-width:1240px;margin:auto;padding:28px}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}.brand{font:700 20px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:-.04em;color:var(--ink)}.brand span{color:var(--green)}h1{font:650 clamp(28px,4vw,46px)/1.05 Georgia,serif;letter-spacing:-.035em;margin:0 0 8px}h2{font-size:19px;margin:0}h3{font-size:15px;margin:0}.lede,.muted{color:var(--muted)}.lede{font-size:17px;margin:0;max-width:760px}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:18px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:20px}.span4{grid-column:span 4}.span8{grid-column:span 8}.span12{grid-column:span 12}.cardhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.stat{font:650 34px/1 Georgia,serif;margin:12px 0 4px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:750;color:var(--muted)}.button,button{border:0;border-radius:9px;background:var(--green);color:white;padding:10px 14px;font:650 13px/1.2 inherit;cursor:pointer}.button.secondary,button.secondary{background:#e8e5dc;color:var(--ink)}button.danger{background:var(--red)}button:disabled{opacity:.45;cursor:not-allowed}input,textarea{width:100%;border:1px solid var(--line);border-radius:9px;padding:10px 11px;background:white;color:var(--ink);font:inherit}textarea{min-height:92px;resize:vertical}label{display:block;font-size:13px;font-weight:650;margin-bottom:12px}label span{display:block;margin-bottom:5px}.inline{display:flex;gap:10px;align-items:center}.inline input[type=checkbox]{width:auto}.actions{display:flex;gap:8px;flex-wrap:wrap}.notice{padding:12px 14px;border:1px solid #e4bd78;background:#fff2d9;border-radius:10px;margin:16px 0}.notice.error{border-color:#e1a29c;background:#fae5e2;color:#70261f}.badge{display:inline-flex;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:750;letter-spacing:.04em;background:#e8e5dc;color:var(--muted)}.badge.APPROVED,.badge.COMPLETED,.badge.VERIFIED,.badge.PUBLICLY_LISTED{background:var(--green2);color:var(--green)}.badge.REJECTED,.badge.FAILED{background:#f4deda;color:var(--red)}.badge.RUNNING,.badge.ACTIVE{background:#dfeaf5;color:var(--blue)}.badge.PENDING,.badge.DISCOVERED,.badge.UNKNOWN{background:#f2e5c9;color:var(--amber)}table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}th,td{padding:11px 9px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}.score{font:700 18px/1 Georgia,serif}.source{max-width:310px}.source a{word-break:break-all}.empty{border:1px dashed var(--line);border-radius:12px;padding:22px;text-align:center;color:var(--muted)}details{border-top:1px solid var(--line);padding:12px 0}details:last-child{padding-bottom:0}summary{cursor:pointer;font-weight:650}pre{white-space:pre-wrap;word-break:break-word;background:#19231d;color:#dcebdd;padding:14px;border-radius:10px;max-height:360px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,monospace}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:22px 0}.step{border-top:3px solid var(--line);padding-top:9px;color:var(--muted);font-size:12px}.step strong{display:block;color:var(--ink);font-size:14px}.check{width:16px;height:16px}.tablewrap{overflow-x:auto}.campaign{display:block;color:inherit}.campaign:hover{text-decoration:none;border-color:#9eaa9f}.campaign p{margin:7px 0 0}.footer{margin-top:28px;color:var(--muted);font-size:12px}@media(max-width:800px){.shell{padding:20px 14px}.span4,.span8{grid-column:span 12}.steps{grid-template-columns:1fr}.top{margin-bottom:20px}th:nth-child(5),td:nth-child(5){display:none}}
@media(max-width:800px){.email-results th:nth-child(5),.email-results td:nth-child(5){display:table-cell}}
.email-preview{background:white;color:var(--ink);border:1px solid var(--line);font-family:inherit;font-size:15px;line-height:1.6;max-height:none}
.badge.READY_TO_SEND{background:var(--green2);color:var(--green)}
.badge.SENT{background:var(--green2);color:var(--green)}.badge.UNCERTAIN,.badge.SENDING,.badge.PREPARING{background:#f2e5c9;color:var(--amber)}
</style></head><body><main class="shell"><header class="top"><a class="brand" href="/"><span>→</span> outbound</a><div class="inline"><a href="/gmail">Gmail</a><span class="badge">Local SQLite</span></div></header>${body}<footer class="footer">Runs locally on ${escapeHtml(host)} · No emails are sent without explicit approval.</footer></main>
<script>document.querySelectorAll('[data-select]').forEach(function(b){b.addEventListener('click',function(){b.closest('form').querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach(function(c){c.checked=true})})})</script></body></html>`;
}

function redirect(response: ServerResponse, path: string, message?: { error?: string; notice?: string }): void {
  const query = message ? new URLSearchParams(message as Record<string, string>).toString() : "";
  response.writeHead(303, { Location: `${path}${query ? `?${query}` : ""}` }).end();
}

function send(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end(html);
}

async function formData(request: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 100_000) throw new WorkflowError("Form submission is too large");
  }
  const form = new URLSearchParams(body);
  if (form.get("csrfToken") !== csrfToken) throw new WorkflowError("Form expired or could not be verified. Refresh the page and try again.");
  return form;
}

function requirePositiveId(value: string | null, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new WorkflowError(`Invalid ${label}`);
  return id;
}

function notices(url: URL): string {
  const error = url.searchParams.get("error");
  const notice = url.searchParams.get("notice");
  return `${error ? `<div class="notice error">${escapeHtml(error)}</div>` : ""}${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}`;
}

function dashboardPage(url: URL): string {
  const campaigns = store.listCampaigns().reverse();
  const cards = campaigns.map((campaign) => {
    const companies = store.listCompanies({ campaignId: campaign.id });
    const contacts = companies.flatMap(({ id }) => store.listContacts(id));
    return `<a class="card span4 campaign" href="/campaigns/${campaign.id}"><div class="cardhead"><span class="eyebrow">Campaign ${campaign.id}</span><span class="badge ${campaign.status}">${humanize(campaign.status)}</span></div><h2>${escapeHtml(campaign.name)}</h2><p class="muted">${escapeHtml(campaign.segment)}</p><div class="inline"><span><strong>${companies.length}</strong> companies</span><span><strong>${contacts.length}</strong> contacts</span></div></a>`;
  }).join("");

  return layout("Campaigns", `<section><span class="eyebrow">Control center</span><h1>Outbound campaigns</h1><p class="lede">Research, review, and qualify prospects through explicit approval gates.</p></section>${notices(url)}<div class="grid" style="margin-top:24px"><section class="card span4"><div class="cardhead"><h2>New campaign</h2><span class="badge">Step 1</span></div><form method="post" action="/campaigns"><label><span>Name</span><input name="name" required placeholder="Developer tools · North America"></label><label><span>Target segment</span><textarea name="segment" required placeholder="Developer tools and B2B SaaS companies in USA and Canada, 20–200 employees."></textarea></label><label><span>Number of companies</span><input name="targetCount" type="number" min="1" max="25" value="5" required></label><label class="inline"><input type="checkbox" name="startResearch" value="yes" checked> Start company discovery now</label><button type="submit">Create campaign</button></form></section>${cards || '<div class="card span8 empty">No campaigns yet. Create one to begin.</div>'}</div>`);
}

function sourceFor(research: ResearchRecord[], companyId: number, contactId?: number): ResearchRecord | undefined {
  return research.find((item) => item.companyId === companyId
    && (contactId === undefined ? item.contactId === null : item.contactId === contactId));
}

function runLabel(run: WorkflowRun): string {
  const time = new Date(run.requestedAt).toLocaleString();
  return `${humanize(run.kind)} · ${time}`;
}

function campaignPage(campaign: Campaign, url: URL): string {
  const companies = store.listCompanies({ campaignId: campaign.id })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const contacts = companies.flatMap(({ id }) => store.listContacts(id))
    .sort((a, b) => (b.roleScore ?? -1) - (a.roleScore ?? -1));
  const research = companies.flatMap(({ id }) => store.listResearch(id));
  const runs = store.listWorkflowRuns(campaign.id);
  const isRunning = runs.some(({ status }) => status === "PENDING" || status === "RUNNING");
  const approvedCompanies = companies.filter(({ status }) => status === "APPROVED").length;
  const approvedContacts = contacts.filter(({ status }) => status === "APPROVED").length;
  const emailComplete = contacts.filter(({ emailStatus }) => emailStatus !== "UNKNOWN").length;
  const contactsAwaitingEmail = contacts.filter(({ status, emailStatus }) =>
    status === "APPROVED" && emailStatus === "UNKNOWN").length;

  const companyRows = companies.map((company) => {
    const signal = sourceFor(research, company.id);
    const chat = company.chatFeatureStatus === "PRESENT"
      ? `<span class="badge APPROVED">Yes</span>${company.chatFeatureSourceUrl ? `<br><a href="${escapeHtml(company.chatFeatureSourceUrl)}" target="_blank" rel="noreferrer">Evidence ↗</a>` : ""}`
      : company.chatFeatureStatus === "NO_PUBLIC_EVIDENCE"
        ? '<span class="badge UNKNOWN">No public evidence</span>'
        : '<span class="badge UNKNOWN">Unknown</span>';
    return `<tr><td><input class="check" type="checkbox" name="ids" value="${company.id}" aria-label="Select ${escapeHtml(company.name)}"></td><td><strong>${escapeHtml(company.name)}</strong><br><a href="https://${escapeHtml(company.domain)}" target="_blank" rel="noreferrer">${escapeHtml(company.domain)}</a></td><td>${escapeHtml(company.location ?? "Unknown")}<br><span class="muted">${company.employeeCount ?? "?"} employees</span></td><td class="score">${company.score ?? "—"}</td><td>${chat}</td><td>${escapeHtml(company.reason ?? "No reason recorded")}</td><td class="source">${signal ? `${escapeHtml(signal.signal)}<br><a href="${escapeHtml(signal.sourceUrl)}" target="_blank" rel="noreferrer">Source ↗</a>` : '<span class="muted">No source recorded</span>'}</td><td><span class="badge ${company.status}">${humanize(company.status)}</span></td></tr>`;
  }).join("");

  const contactRows = contacts.map((contact) => {
    const company = companies.find(({ id }) => id === contact.companyId)!;
    const source = sourceFor(research, contact.companyId, contact.id);
    return `<tr><td><input class="check" type="checkbox" name="ids" value="${contact.id}" aria-label="Select ${escapeHtml(contact.name)}"></td><td><strong>${escapeHtml(contact.name)}</strong><br><span class="muted">${escapeHtml(contact.title ?? "Unknown title")}</span></td><td>${escapeHtml(company.name)}</td><td>${escapeHtml(contact.roleCategory ?? "—")}<br><span class="score">${contact.roleScore ?? "—"}</span></td><td>${contact.linkedinUrl ? `<a href="${escapeHtml(contact.linkedinUrl)}" target="_blank" rel="noreferrer">Profile ↗</a>` : "—"}${source ? `<br><a href="${escapeHtml(source.sourceUrl)}" target="_blank" rel="noreferrer">Role source ↗</a>` : ""}</td><td>${contact.email ? `<strong>${escapeHtml(contact.email)}</strong><br>` : ""}<span class="badge ${contact.emailStatus}">${humanize(contact.emailStatus)}</span></td><td><span class="badge ${contact.status}">${humanize(contact.status)}</span></td></tr>`;
  }).join("");

  const runRows = runs.map((run) => `<details${run.status === "RUNNING" ? " open" : ""}><summary>${escapeHtml(runLabel(run))} <span class="badge ${run.status}">${humanize(run.status)}</span></summary>${run.error ? `<div class="notice error">${escapeHtml(run.error)}</div>` : ""}<pre>${escapeHtml(run.output || (run.status === "RUNNING" ? "Starting Codex…" : "No output captured."))}</pre></details>`).join("");

  return layout(campaign.name, `<a href="/">← All campaigns</a><section style="margin-top:18px"><span class="eyebrow">Campaign ${campaign.id}</span><h1>${escapeHtml(campaign.name)}</h1><p class="lede">${escapeHtml(campaign.segment)}</p></section>${notices(url)}<div class="steps"><div class="step"><strong>${companies.length} companies</strong>${approvedCompanies} approved</div><div class="step"><strong>${contacts.length} contacts</strong>${approvedContacts} approved</div><div class="step"><strong>${emailComplete} email checks</strong>${contactsAwaitingEmail} approved contact(s) awaiting discovery</div></div><div class="grid"><section class="card span12"><div class="cardhead"><div><span class="eyebrow">Stage 1</span><h2>Company discovery</h2></div><form method="post" action="/campaigns/${campaign.id}/workflows/company-discovery" class="inline"><input name="targetCount" type="number" min="1" max="25" value="5" style="width:70px" aria-label="Target count"><button ${isRunning ? "disabled" : ""}>${companies.length ? "Find more" : "Run discovery"}</button></form></div>${companies.length ? `<form method="post" action="/campaigns/${campaign.id}/companies/review"><div class="actions"><button type="button" class="secondary" data-select>Select all</button><button name="decision" value="APPROVED">Approve selected</button><button class="danger" name="decision" value="REJECTED">Reject selected</button></div><div class="tablewrap"><table><thead><tr><th></th><th>Company</th><th>Fit</th><th>Score</th><th>Why ConvoKit</th><th>Signal</th><th>Status</th></tr></thead><tbody>${companyRows}</tbody></table></div></form>` : '<div class="empty">No companies stored yet. Run discovery to populate this stage.</div>'}</section><section class="card span12"><div class="cardhead"><div><span class="eyebrow">Stage 2</span><h2>Contact discovery</h2></div><form method="post" action="/campaigns/${campaign.id}/workflows/contact-discovery"><button ${isRunning || approvedCompanies === 0 ? "disabled" : ""}>Run contact discovery</button></form></div>${contacts.length ? `<form method="post" action="/campaigns/${campaign.id}/contacts/review"><div class="actions"><button type="button" class="secondary" data-select>Select all</button><button name="decision" value="APPROVED">Approve selected</button><button class="danger" name="decision" value="REJECTED">Reject selected</button></div><div class="tablewrap"><table><thead><tr><th></th><th>Contact</th><th>Company</th><th>Role / score</th><th>Evidence</th><th>Email</th><th>Status</th></tr></thead><tbody>${contactRows}</tbody></table></div></form>` : `<div class="empty">${approvedCompanies ? "Approved companies are ready for contact discovery." : "Approve companies to unlock contact discovery."}</div>`}</section><section class="card span8"><div class="cardhead"><div><span class="eyebrow">Stage 3</span><h2>Email discovery</h2></div><form method="post" action="/campaigns/${campaign.id}/workflows/email-discovery"><button ${isRunning || contactsAwaitingEmail === 0 ? "disabled" : ""}>Find public emails</button></form></div><p class="muted">Only approved contacts with an unknown email status are checked. Inferred addresses are never stored as verified.</p>${renderEmailResults(companies, contacts, research)}</section><aside class="card span4"><span class="eyebrow">Safety gates</span><h2 style="margin-top:5px">Human approval stays required</h2><p class="muted">Research may run automatically. Company, contact, and future email-draft approvals remain manual.</p></aside>${renderProspectStages(store, campaign.id, Number(url.searchParams.get("draftId")) || undefined)}<section class="card span12"><div class="cardhead"><div><span class="eyebrow">Activity</span><h2>Workflow runs</h2></div>${isRunning ? '<span class="badge RUNNING">Refreshing every 3s</span>' : ""}</div>${runRows || '<div class="empty">No research runs yet.</div>'}</section></div>`, { refreshing: isRunning });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.headers.host !== `${host}:${port}`
    || (request.method === "POST" && request.headers.origin && request.headers.origin !== appOrigin)) {
    send(response, 403, layout("Forbidden", '<div class="notice error">Use the local dashboard URL printed in your terminal. Cross-origin requests are not allowed.</div>')); return;
  }
  if (request.method === "GET" && url.pathname === "/gmail") {
    send(response, 200, layout("Gmail", notices(url) + renderGmailSettings(gmail, store, {
      recipient: process.env.GMAIL_TEST_RECIPIENT ?? "abstract.ruch@gmail.com", expectedSender,
      signTest: (id, sender) => signature("test", id, sender),
    }))); return;
  }
  if (request.method === "POST" && ["/gmail/connect", "/gmail/disconnect", "/gmail/test"].includes(url.pathname)) {
    const form = await formData(request);
    if (store.listEmailDeliveries().some(({ status }) => status === "PREPARING" || status === "SENDING")) {
      throw new WorkflowError("Wait for active delivery to finish before changing Gmail or sending another test");
    }
    if (url.pathname === "/gmail/connect") {
      if (redirectUri !== `${appOrigin}/gmail/callback`) throw new WorkflowError("GMAIL_REDIRECT_URI must match the current dashboard origin and /gmail/callback path.");
      const authorization = gmail.beginAuthorization();
      response.setHeader("Set-Cookie", `gmail_oauth_state=${authorization.state}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/gmail/callback`);
      redirect(response, authorization.url); return;
    }
    if (url.pathname === "/gmail/disconnect") {
      await gmail.disconnect();
      redirect(response, "/gmail", { notice: "Gmail access revoked and local credentials removed" }); return;
    }
    const sender = gmail.connectedEmail();
    const requestId = form.get("requestId") ?? "";
    if (!sender || !validSignature(form.get("testSignature"), signature("test", requestId, sender))
      || form.get("confirm") !== "yes") throw new WorkflowError("Review the test message and explicitly confirm sending it");
    const delivery = await gmailSending.sendTest(form.get("recipient")?.trim() ?? "", requestId, sender);
    redirect(response, "/gmail", { notice: `Test email sent to ${delivery.toEmail}. Gmail message ${delivery.gmailMessageId}.` }); return;
  }
  if (request.method === "GET" && url.pathname === "/gmail/callback") {
    response.setHeader("Set-Cookie", "gmail_oauth_state=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/gmail/callback");
    if (url.searchParams.get("error")) {
      redirect(response, "/gmail", { error: "Google authorization was not completed. No email was sent." }); return;
    }
    const cookieState = request.headers.cookie?.match(/(?:^|;\s*)gmail_oauth_state=([^;]*)/)?.[1] ?? "";
    try {
      const email = await gmail.finishAuthorization(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "", cookieState);
      redirect(response, "/gmail", { notice: `Connected ${email}. Review and send the test message below.` }); return;
    } catch (error) { redirect(response, "/gmail", { error: messageOf(error) }); return; }
  }

  const sendPreview = url.pathname.match(/^\/campaigns\/(\d+)\/outreach\/(\d+)\/send$/);
  if (request.method === "GET" && sendPreview) {
    const campaignId = Number(sendPreview[1]);
    const id = Number(sendPreview[2]);
    const draft = store.assertReadyToSend(id);
    const contact = store.getContact(draft.contactId)!;
    if (store.getCompany(contact.companyId)?.campaignId !== campaignId) throw new WorkflowError("Email does not belong to this campaign");
    const sender = gmail.connectedEmail();
    if (!sender) { redirect(response, "/gmail", { error: "Connect Gmail before sending approved emails" }); return; }
    const blocked = store.listEmailDeliveries().find((delivery) => delivery.outreachId === id && delivery.status !== "FAILED");
    if (blocked) throw new WorkflowError("Delivery is already active, sent, or uncertain. Do not resend.");
    const expected = { fromEmail: sender, toEmail: contact.email!, subject: draft.subject, body: draft.body };
    send(response, 200, layout("Confirm send", `<a href="/campaigns/${campaignId}#draft-review">← Emails</a><section class="card" style="margin-top:18px"><h1>Confirm sending</h1><p><strong>From:</strong> ${escapeHtml(sender)}<br><strong>To:</strong> ${escapeHtml(contact.email)}<br><strong>Subject:</strong> ${escapeHtml(draft.subject)}</p><pre class="email-preview">${escapeHtml(draft.body)}</pre><div class="notice">This sends a real email to this prospect. Sending cannot be undone by this dashboard.</div><form method="post" action="/campaigns/${campaignId}/outreach/${id}/send"><input type="hidden" name="sendSignature" value="${signature("outreach", id, expected)}"><label class="inline"><input type="checkbox" name="confirm" value="yes" required>I confirm sending this exact approved email to the recipient above.</label><button>Send email now</button></form></section>`)); return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    send(response, 200, dashboardPage(url)); return;
  }

  const campaignMatch = url.pathname.match(/^\/campaigns\/(\d+)$/);
  if (request.method === "GET" && campaignMatch) {
    const campaign = store.getCampaign(Number(campaignMatch[1]));
    if (!campaign) throw new WorkflowError("Campaign not found");
    send(response, 200, campaignPage(campaign, url)); return;
  }

  if (request.method === "POST" && url.pathname === "/campaigns") {
    const form = await formData(request);
    const name = form.get("name")?.trim() ?? "";
    const segment = form.get("segment")?.trim() ?? "";
    if (!name || !segment) throw new WorkflowError("Campaign name and segment are required");
    const targetCount = requirePositiveId(form.get("targetCount"), "company target count");
    if (targetCount > 25) throw new WorkflowError("Company target count cannot exceed 25");
    const campaign = store.createCampaign({ name, segment, status: "ACTIVE" });
    if (form.get("startResearch") === "yes") {
      try {
        launchWorkflow(db, { campaignId: campaign.id, kind: "COMPANY_DISCOVERY", targetCount });
      } catch (error) {
        redirect(response, `/campaigns/${campaign.id}`, { error: messageOf(error) }); return;
      }
    }
    redirect(response, `/campaigns/${campaign.id}`, { notice: "Campaign created" }); return;
  }

  const actionMatch = url.pathname.match(/^\/campaigns\/(\d+)\/(.+)$/);
  if (request.method === "POST" && actionMatch) {
    const campaignId = Number(actionMatch[1]);
    const action = actionMatch[2];
    if (!store.getCampaign(campaignId)) throw new WorkflowError("Campaign not found");
    const form = await formData(request);

    const draftAction = action.match(/^outreach\/(\d+)\/(review|rewrite|restore|send)$/);
    if (draftAction) {
      const outreachId = Number(draftAction[1]);
      const draft = store.getOutreach(outreachId);
      const contact = draft ? store.getContact(draft.contactId) : undefined;
      const company = contact ? store.getCompany(contact.companyId) : undefined;
      if (!draft || company?.campaignId !== campaignId) {
        throw new WorkflowError("Draft does not belong to this campaign");
      }
      if (store.listWorkflowRuns().some(({ status }) => status === "RUNNING" || status === "PENDING")) {
        throw new WorkflowError("Wait for the active workflow to finish before reviewing drafts");
      }
      if (draftAction[2] === "send") {
        const sender = gmail.connectedEmail();
        const current = store.assertReadyToSend(outreachId);
        const expected = { fromEmail: sender ?? "", toEmail: contact!.email!, subject: current.subject, body: current.body };
        if (!sender || form.get("confirm") !== "yes"
          || !validSignature(form.get("sendSignature"), signature("outreach", outreachId, expected))) {
          throw new WorkflowError("Send confirmation expired or recipient/content changed. Review the email and confirm sending again.");
        }
        const delivery = await gmailSending.sendApproved(outreachId, expected);
        redirect(response, `/campaigns/${campaignId}`, { notice: `Email sent to ${delivery.toEmail}. Gmail message ${delivery.gmailMessageId}.` }); return;
      }
      if (draftAction[2] === "restore") {
        store.withdrawOutreachApproval(outreachId);
        redirect(response, `/campaigns/${campaignId}`, { notice: "Returned to DRAFT for a fresh human review. Nothing was sent." }); return;
      }
      if (draftAction[2] === "rewrite") {
        const feedback = form.get("feedback")?.trim() ?? "";
        if (!feedback || feedback.length > 2000) throw new WorkflowError("Provide up to 2000 characters of rewrite feedback");
        launchWorkflow(db, { campaignId, kind: "DRAFT_REWRITE", outreachId, feedback });
        redirect(response, `/campaigns/${campaignId}`, { notice: "Rewrite started; draft remains unapproved" }); return;
      }
      const decision = form.get("decision");
      if (decision === "APPROVED") store.approveOutreachForSending(outreachId);
      else if (decision === "REJECTED") store.rejectOutreach(outreachId);
      else throw new WorkflowError("Choose approve or reject");
      redirect(response, `/campaigns/${campaignId}`, {
        notice: decision === "APPROVED" ? "Draft approved and READY_TO_SEND. Nothing was sent." : "Draft rejected",
      }); return;
    }

    if (action.startsWith("workflows/")) {
      const kinds = {
        "workflows/company-discovery": "COMPANY_DISCOVERY",
        "workflows/contact-discovery": "CONTACT_DISCOVERY",
        "workflows/email-discovery": "EMAIL_DISCOVERY",
        "workflows/prospect-research": "PROSPECT_RESEARCH",
        "workflows/email-generation": "EMAIL_GENERATION",
      } as const;
      const kind = kinds[action as keyof typeof kinds];
      if (!kind) throw new WorkflowError("Unknown workflow");
      const targetCount = kind === "COMPANY_DISCOVERY"
        ? requirePositiveId(form.get("targetCount"), "company target count") : undefined;
      if (targetCount !== undefined && targetCount > 25) {
        throw new WorkflowError("Company target count cannot exceed 25");
      }
      const contactIds = kind === "EMAIL_GENERATION"
        ? form.getAll("contactIds").map((value) => requirePositiveId(value, "selected contact ID")) : undefined;
      const run = launchWorkflow(db, { campaignId, kind, targetCount, contactIds });
      redirect(response, `/campaigns/${campaignId}`, { notice: `Started ${humanize(run.kind)}` }); return;
    }

    if (action === "companies/review" || action === "contacts/review") {
      const decision = form.get("decision");
      if (decision !== "APPROVED" && decision !== "REJECTED") {
        throw new WorkflowError("Choose approve or reject");
      }
      const ids = form.getAll("ids").map((value) => requirePositiveId(value, "selected ID"));
      if (ids.length === 0) throw new WorkflowError("Select at least one row");
      if (action === "companies/review") {
        const allowed = new Set(store.listCompanies({ campaignId }).map(({ id }) => id));
        if (ids.some((id) => !allowed.has(id))) throw new WorkflowError("Company does not belong to this campaign");
        store.reviewCompanies(ids, decision);
      } else {
        const companyIds = new Set(store.listCompanies({ campaignId }).map(({ id }) => id));
        if (ids.some((id) => {
          const contact = store.getContact(id);
          return !contact || !companyIds.has(contact.companyId);
        })) throw new WorkflowError("Contact does not belong to this campaign");
        store.reviewContacts(ids, decision);
      }
      redirect(response, `/campaigns/${campaignId}`, { notice: `${ids.length} record(s) ${decision.toLowerCase()}` }); return;
    }
  }

  send(response, 404, layout("Not found", '<div class="card"><h1>Page not found</h1><a href="/">Return to campaigns</a></div>'));
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    const campaignId = request.url?.match(/^\/campaigns\/(\d+)/)?.[1];
    if (request.method === "POST") {
      redirect(response, campaignId ? `/campaigns/${campaignId}` : request.url?.startsWith("/gmail") ? "/gmail" : "/", { error: messageOf(error) });
    } else {
      send(response, error instanceof WorkflowError ? 400 : 500,
        layout("Error", `<div class="notice error">${escapeHtml(messageOf(error))}</div><a href="/">Return to campaigns</a>`));
    }
  });
});

server.listen(port, host, () => {
  console.log(`Outbound dashboard: http://${host}:${port}`);
  console.log(`SQLite database: ${databasePath}`);
  if (interrupted) console.log(`Marked ${interrupted} interrupted workflow run(s) as failed.`);
  if (interruptedDeliveries) console.log(`Blocked ${interruptedDeliveries} interrupted send(s) as uncertain. Check Gmail Sent.`);
});

function shutDown(): void {
  server.close(() => { db.close(); process.exit(0); });
}
process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);
