import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { config } from "dotenv";
import { openDatabase } from "../db/database.js";
import { OutboundStore, WorkflowError } from "../db/store.js";
import type { Campaign, ResearchRecord, WorkflowRun } from "../db/types.js";
import {
  isCheckingGuesses, lastGuessCheck, launchEmailRecovery, launchPatternEvidence, launchWorkflow, startGuessCheck,
} from "../workflows/runner.js";
import { guessVerificationBadge, renderEmailPipelineStatus, renderEmailResults } from "./emailResults.js";
import { renderProspectStages } from "./prospectStages.js";
import { countDueFollowUps, renderFollowUps } from "./followUps.js";
import { FileTokenStore, GmailClient } from "../gmail/client.js";
import { EmailSending } from "../gmail/sending.js";
import { isSending, SEND_QUEUE_GAP_MS, sendQueueState, startSendQueue } from "../gmail/sendQueue.js";
import { renderGmailSettings } from "./gmailSettings.js";
import type { EmailTransport } from "../email/transport.js";
import { FileMcpTokenStore, McpEmailTransport } from "../email/mcpTransport.js";

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
const expectedSender = process.env.GMAIL_SENDER_EMAIL ?? "";
const redirectUri = process.env.GMAIL_REDIRECT_URI ?? `${appOrigin}/gmail/callback`;
const gmail = new GmailClient({ clientId: process.env.GOOGLE_CLIENT_ID ?? "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "", redirectUri, expectedSender: expectedSender || undefined,
}, new FileTokenStore(join(dirname(databasePath), "gmail-oauth.json")));
const mcpEmail = new McpEmailTransport({
  url: process.env.MCP_EMAIL_URL ?? "",
  redirectUri: process.env.MCP_EMAIL_REDIRECT_URI ?? `${appOrigin}/gmail/callback`,
  expectedSender: process.env.MCP_EMAIL_SENDER_EMAIL ?? "",
  profileTool: process.env.MCP_EMAIL_PROFILE_TOOL ?? "",
  sendTool: process.env.MCP_EMAIL_SEND_TOOL ?? "",
  followUpTool: process.env.MCP_EMAIL_FOLLOW_UP_TOOL ?? "",
  accountId: process.env.MCP_EMAIL_ACCOUNT_ID ?? "",
}, new FileMcpTokenStore(join(dirname(databasePath), "mcp-email-oauth.json")));
const emailTransport: EmailTransport = process.env.EMAIL_TRANSPORT === "mcp" ? mcpEmail : gmail;
const selectedExpectedSender = emailTransport.id === "mcp"
  ? process.env.MCP_EMAIL_SENDER_EMAIL ?? "" : expectedSender;
const emailSending = new EmailSending(store, emailTransport);
const signature = (...values: unknown[]): string => createHmac("sha256", csrfToken)
  .update(JSON.stringify(values)).digest("hex");
const validSignature = (actual: string | null, expected: string): boolean =>
  !!actual && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const humanize = (value: string): string => value.toLowerCase().replaceAll("_", " ")
  .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());

// While a workflow runs, polls the current page every 3s and swaps only the sections whose
// server HTML changed, keeping scroll position, checked boxes, typed input, and open <details>.
const LIVE_REFRESH_SCRIPT = `(function(){
if(!document.body.hasAttribute('data-live-refresh'))return;
var main=document.querySelector('main.shell'),last=new Map();
function regions(root){var out=[];Array.prototype.forEach.call(root.children,function(el){
if(el.classList.contains('toasts'))return;
if(el.classList.contains('grid')){Array.prototype.forEach.call(el.children,function(c,i){out.push({key:'grid:'+(c.id||i),el:c})});return}
out.push({key:(el.id||el.tagName+'.'+el.className)+':'+out.length,el:el})});return out}
regions(main).forEach(function(r){last.set(r.key,r.el.outerHTML)});
function keep(el){var s={checks:[],values:[],open:[]};
el.querySelectorAll('input[type=checkbox]').forEach(function(c){if(c.checked!==c.defaultChecked)s.checks.push([c.name,c.value,c.checked])});
el.querySelectorAll('input:not([type=checkbox]):not([type=hidden]),textarea,select').forEach(function(f){if(f.name&&f.value!==f.defaultValue)s.values.push([f.closest('form')&&f.closest('form').action,f.name,f.value])});
el.querySelectorAll('details[id]').forEach(function(d){s.open.push([d.id,d.open])});return s}
function restore(el,s){s.checks.forEach(function(k){el.querySelectorAll('input[type=checkbox]').forEach(function(c){if(c.name===k[0]&&c.value===k[1]&&!c.disabled)c.checked=k[2]})});
s.values.forEach(function(k){el.querySelectorAll('[name]').forEach(function(f){if(f.name===k[1]&&(f.closest('form')&&f.closest('form').action)===k[0])f.value=k[2]})});
s.open.forEach(function(k){var d=el.querySelector('details[id="'+k[0]+'"]');if(d)d.open=k[1]})}
function swap(oldEl,html){var t=document.createElement('template');t.innerHTML=html;var n=t.content.firstElementChild;var s=keep(oldEl);var a=document.activeElement,focused=a&&oldEl.contains(a)&&a.name?a.name:null;oldEl.replaceWith(n);restore(n,s);if(focused){var f=n.querySelector('[name="'+focused+'"]');if(f)f.focus()}return n}
function tick(){var u=new URL(location.href);u.searchParams.delete('notice');u.searchParams.delete('error');u.hash='';
fetch(u,{headers:{Accept:'text/html'},cache:'no-store'}).then(function(r){return r.ok?r.text():Promise.reject(r.status)}).then(function(html){
var doc=new DOMParser().parseFromString(html,'text/html'),next=doc.querySelector('main.shell');if(!next)return;
var cur=regions(main),fresh=regions(next);
var same=cur.length===fresh.length&&cur.every(function(r,i){return r.key===fresh[i].key});
if(same){fresh.forEach(function(r,i){var h=r.el.outerHTML;if(last.get(r.key)!==h){last.set(r.key,h);swap(cur[i].el,h)}})}
else{var toasts=main.querySelector('.toasts');var y=scrollY;main.innerHTML=next.innerHTML;if(toasts&&!main.querySelector('.toasts'))main.prepend(toasts);last.clear();regions(main).forEach(function(r){last.set(r.key,r.el.outerHTML)});scrollTo(0,y)}
document.title=doc.title;
if(doc.body.hasAttribute('data-live-refresh'))setTimeout(tick,3000)}).catch(function(){setTimeout(tick,3000)})}
setTimeout(tick,3000)})();`;

function layout(title: string, body: string, options: { refreshing?: boolean } = {}): string {
  body = body.replace(/<form\b[^>]*method="post"[^>]*>/g,
    (form) => `${form}<input type="hidden" name="csrfToken" value="${csrfToken}">`);
  body = body.replace("<th>Score</th><th>Why ConvoKit</th>",
    "<th>Score</th><th>Chat feature / implementation</th><th>Why ConvoKit / thesis</th>");
  body = body.replace('<table><thead><tr><th></th><th>Company</th><th>Fit</th>',
    '<table class="company-results"><thead><tr><th></th><th>Company</th><th>Fit</th>');
  body = body.replaceAll('name="targetCount" type="number" min="1" max="25"',
    'name="targetCount" type="number" min="1" max="30"');
  body = body.replace(
    "Only approved contacts with an unknown email status are checked. Inferred addresses are never stored as verified.",
    "Approved contacts awaiting discovery are checked; earlier EMAIL_NOT_FOUND results can receive a separate guess. Guesses remain EMAIL_NOT_FOUND and can only be sent as clearly labelled, unverified recipients.",
  );
  body = body.replace(">Find public emails</button>", ">Find emails / guesses</button>");
  body = body.replace("approved contact(s) awaiting discovery", "approved contact(s) awaiting email check or guess");
  body = body.replace(
    '<section class="card span8" id="email-discovery"><div class="cardhead"><div><span class="eyebrow">Stage 3</span>',
    '<section class="card span12" id="email-discovery"><div class="cardhead"><div><span class="eyebrow">Stage 3</span>',
  );
  body = body.replace(
    '<aside class="card span4"><span class="eyebrow">Safety gates</span>',
    '<aside class="card span12"><span class="eyebrow">Safety gates</span>',
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Outbound</title>
<style>
:root{--ink:#17211b;--muted:#67736b;--paper:#f4f1e8;--card:#fffdf7;--line:#d9d5c9;--green:#236448;--green2:#dcebdd;--amber:#9a5b16;--red:#9e3c34;--blue:#315d83;--shadow:0 14px 36px rgba(27,36,30,.08)}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.48 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--green);text-decoration:none}a:hover{text-decoration:underline}.shell{max-width:1240px;margin:auto;padding:28px}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}.brand{font:700 20px/1 ui-monospace,SFMono-Regular,monospace;letter-spacing:-.04em;color:var(--ink)}.brand span{color:var(--green)}h1{font:650 clamp(28px,4vw,46px)/1.05 Georgia,serif;letter-spacing:-.035em;margin:0 0 8px}h2{font-size:19px;margin:0}h3{font-size:15px;margin:0}.lede,.muted{color:var(--muted)}.lede{font-size:17px;margin:0;max-width:760px}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:18px}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:20px}.span4{grid-column:span 4}.span8{grid-column:span 8}.span12{grid-column:span 12}.cardhead{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.stat{font:650 34px/1 Georgia,serif;margin:12px 0 4px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:750;color:var(--muted)}.button,button{border:0;border-radius:9px;background:var(--green);color:white;padding:10px 14px;font:650 13px/1.2 inherit;cursor:pointer}.button.secondary,button.secondary{background:#e8e5dc;color:var(--ink)}button.danger{background:var(--red)}button:disabled{opacity:.45;cursor:not-allowed}input,textarea,select{width:100%;border:1px solid var(--line);border-radius:9px;padding:10px 11px;background:white;color:var(--ink);font:inherit}textarea{min-height:92px;resize:vertical}label{display:block;font-size:13px;font-weight:650;margin-bottom:12px}label span{display:block;margin-bottom:5px}.inline{display:flex;gap:10px;align-items:center}.inline input[type=checkbox]{width:auto}.actions{display:flex;gap:8px;flex-wrap:wrap}.notice{padding:12px 14px;border:1px solid #e4bd78;background:#fff2d9;border-radius:10px;margin:16px 0}.notice.error{border-color:#e1a29c;background:#fae5e2;color:#70261f}.badge{display:inline-flex;padding:4px 8px;border-radius:999px;font-size:11px;font-weight:750;letter-spacing:.04em;background:#e8e5dc;color:var(--muted)}.badge.APPROVED,.badge.COMPLETED,.badge.VERIFIED,.badge.PUBLICLY_LISTED{background:var(--green2);color:var(--green)}.badge.REJECTED,.badge.FAILED{background:#f4deda;color:var(--red)}.badge.RUNNING,.badge.ACTIVE{background:#dfeaf5;color:var(--blue)}.badge.PENDING,.badge.DISCOVERED,.badge.UNKNOWN{background:#f2e5c9;color:var(--amber)}table{border-collapse:collapse;width:100%;font-size:13px}th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}th,td{padding:11px 9px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}.score{font:700 18px/1 Georgia,serif}.source{max-width:310px}.source a{word-break:break-all}.empty{border:1px dashed var(--line);border-radius:12px;padding:22px;text-align:center;color:var(--muted)}details{border-top:1px solid var(--line);padding:12px 0}details:last-child{padding-bottom:0}summary{cursor:pointer;font-weight:650}pre{white-space:pre-wrap;word-break:break-word;background:#19231d;color:#dcebdd;padding:14px;border-radius:10px;max-height:360px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,monospace}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:22px 0}.step{border-top:3px solid var(--line);padding-top:9px;color:var(--muted);font-size:12px}.step strong{display:block;color:var(--ink);font-size:14px}.check{width:16px;height:16px}.tablewrap{overflow-x:auto}.campaign{display:block;color:inherit}.campaign:hover{text-decoration:none;border-color:#9eaa9f}.campaign p{margin:7px 0 0}.footer{margin-top:28px;color:var(--muted);font-size:12px}@media(max-width:800px){.shell{padding:20px 14px}.span4,.span8{grid-column:span 12}.steps{grid-template-columns:1fr}.top{margin-bottom:20px}th:nth-child(5),td:nth-child(5){display:none}}
@media(max-width:800px){.email-results th:nth-child(5),.email-results td:nth-child(5){display:table-cell}}
@media(max-width:800px){.company-results th:nth-child(5),.company-results td:nth-child(5){display:table-cell}}
.email-preview{background:white;color:var(--ink);border:1px solid var(--line);font-family:inherit;font-size:15px;line-height:1.6;max-height:none}
.badge.READY_TO_SEND{background:var(--green2);color:var(--green)}
.badge.SENT{background:var(--green2);color:var(--green)}
.jump{position:sticky;top:0;z-index:5;display:flex;gap:6px;overflow-x:auto;margin:0 -28px 18px;padding:10px 28px;background:var(--paper);border-bottom:1px solid var(--line)}.jump a{flex:none;padding:5px 11px;border-radius:999px;background:#e8e5dc;color:var(--ink);font-size:12px;font-weight:650}.jump a:hover{text-decoration:none;background:var(--green2);color:var(--green)}.grid>[id],.email-draft{scroll-margin-top:64px}@media(max-width:800px){.jump{margin:0 -14px 14px;padding:10px 14px}}
.tabs{display:flex;gap:4px;margin:22px 0 0;border-bottom:1px solid var(--line)}.tabs a{padding:10px 14px;color:var(--muted);font-weight:650;border-bottom:2px solid transparent;margin-bottom:-1px}.tabs a:hover{text-decoration:none;color:var(--ink)}.tabs a.active{color:var(--ink);border-bottom-color:var(--green)}
.campaign-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.campaign-heading .button{flex:none}@media(max-width:600px){.campaign-heading{display:block}.campaign-heading .button{display:inline-block;margin-top:14px}}
.toasts{position:fixed;top:16px;right:16px;left:16px;margin-left:auto;max-width:420px;z-index:10}.toasts .notice{display:flex;gap:10px;align-items:flex-start;justify-content:space-between;margin:0 0 8px;box-shadow:var(--shadow)}.toasts .dismiss{background:none;color:inherit;padding:0 2px;font-size:16px;line-height:1}.badge.UNCERTAIN,.badge.SENDING,.badge.PREPARING{background:#f2e5c9;color:var(--amber)}
.manual-email{border-top:0;padding:0;min-width:200px}.manual-email form{margin-top:10px}
</style></head><body${options.refreshing ? " data-live-refresh" : ""}><main class="shell"><header class="top"><a class="brand" href="/"><span>→</span> outbound</a><div class="inline"><a href="/gmail">Email connections</a><span class="badge">Local SQLite</span></div></header>${body}<footer class="footer">Runs locally on ${escapeHtml(host)} · No emails are sent without explicit approval.</footer></main>
<script>(function(){var u=new URL(location.href);if(u.searchParams.has('notice')||u.searchParams.has('error')){u.searchParams.delete('notice');u.searchParams.delete('error');history.replaceState(null,'',u.pathname+u.search+u.hash)}})();document.addEventListener('click',function(e){var b=e.target.closest('.toasts .dismiss');if(b)b.parentElement.remove();b=e.target.closest('[data-select]');if(b)b.closest('form').querySelectorAll('input[type="checkbox"]'+(b.dataset.select?'[name="'+b.dataset.select+'"]':'')+':not(:disabled)').forEach(function(c){c.checked=true})});</script>
<script>${LIVE_REFRESH_SCRIPT}</script></body></html>`;
}

/** First-touch READY_TO_SEND emails that pass every send check now, with what would be sent. */
function sendBatch(campaignId: number, sender: string) {
  const deliveries = store.listEmailDeliveries();
  return store.listCampaignOutreach(campaignId).flatMap((outreach) => {
    if (outreach.status !== "READY_TO_SEND") return [];
    if (deliveries.some((item) => item.outreachId === outreach.id && item.status !== "FAILED")) return [];
    try { store.assertReadyToSend(outreach.id); } catch { return []; }
    const contact = store.getContact(outreach.contactId)!;
    const company = store.getCompany(contact.companyId)!;
    const recipient = store.getContactRecipient(contact.id)!;
    return [{ outreach, label: `${contact.name} · ${company.name}`, guessed: recipient.guessed,
      guessBadge: guessVerificationBadge(recipient.verification, contact.guessedEmailVerificationDetail),
      expected: { fromEmail: sender, toEmail: recipient.address, subject: outreach.subject, body: outreach.body } }];
  });
}

function sendQueueStatus(campaignId: number): string {
  const state = sendQueueState(campaignId);
  if (!state) return "";
  const done = `${state.sent.length} of ${state.total} sent`;
  if (state.running) {
    return `<div class="notice" data-sending><strong>Sending queue running:</strong> ${done}${state.current ? `; now sending to ${escapeHtml(state.current)}` : ""}. Emails go out ${Math.round(SEND_QUEUE_GAP_MS / 1000)}s apart; keep the dashboard running.</div>`;
  }
  return state.failed
    ? `<div class="notice error"><strong>Sending queue stopped:</strong> ${done}. ${escapeHtml(state.failed.label)} failed: ${escapeHtml(state.failed.error)} ${state.remaining} email(s) were not sent and stay READY_TO_SEND.</div>`
    : `<div class="notice"><strong>Sending queue finished:</strong> ${done}.</div>`;
}

function redirect(
  response: ServerResponse, path: string, message?: Record<string, string>, anchor?: string,
): void {
  const query = message ? new URLSearchParams(message).toString() : "";
  response.writeHead(303, { Location: `${path}${query ? `?${query}` : ""}${anchor ? `#${anchor}` : ""}` }).end();
}

// Returns the redirect target that keeps the user at the section a campaign POST came from.
function campaignReturn(campaignId: number, action: string): { path: string; params: Record<string, string>; anchor?: string } {
  const path = `/campaigns/${campaignId}`;
  const draftId = action.match(/^outreach\/(\d+)\//)?.[1];
  const outreach = draftId ? store.getOutreach(Number(draftId)) : undefined;
  if (outreach && (outreach.followUpOf !== null || outreach.status === "SENT" || outreach.status === "REPLIED" || outreach.status === "BOUNCED")) {
    const sentId = String(outreach.followUpOf ?? outreach.id);
    return { path: `${path}/follow-ups`, params: { open: sentId }, anchor: `sent-${sentId}` };
  }
  if (draftId) return { path, params: { draftId }, anchor: `email-${draftId}` };
  if (action === "outreach/send-all") return { path, params: {}, anchor: "draft-review" };
  if (action === "outreach/approve-all") return { path, params: {}, anchor: "draft-review" };
  if (action === "contacts/recheck-angles" || /^contacts\/\d+\/recheck-angle$/.test(action)) return { path, params: {}, anchor: "prospect-research" };
  if (/^contacts\/\d+\/email$/.test(action)) return { path, params: {}, anchor: "email-discovery" };
  if (action === "workflows/follow-up-generation") return { path: `${path}/follow-ups`, params: {}, anchor: "generate-follow-ups" };
  const anchors: Record<string, string> = {
    "companies/review": "companies", "workflows/company-discovery": "companies",
    "contacts/review": "contacts", "workflows/contact-discovery": "contacts",
    "workflows/email-discovery": "email-discovery", "emails/verify-guesses": "email-discovery",
    "emails/treg-recovery": "email-discovery", "emails/pattern-evidence": "email-discovery",
    "workflows/prospect-research": "prospect-research", "workflows/email-generation": "draft-review",
  };
  return { path, params: {}, anchor: anchors[action] };
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
  if (!error && !notice) return "";
  return `<div class="toasts">${error ? `<div class="notice error">${escapeHtml(error)}<button type="button" class="dismiss" aria-label="Dismiss">×</button></div>` : ""}${notice ? `<div class="notice">${escapeHtml(notice)}<button type="button" class="dismiss" aria-label="Dismiss">×</button></div>` : ""}</div>`;
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

function campaignHeader(campaign: Campaign, url: URL, tab: "pipeline" | "follow-ups"): string {
  const due = countDueFollowUps(store, campaign.id);
  return `<a href="/">← All campaigns</a><section class="campaign-heading" style="margin-top:18px"><div><span class="eyebrow">Campaign ${campaign.id}</span><h1>${escapeHtml(campaign.name)}</h1><p class="lede">${escapeHtml(campaign.segment)}</p></div><a class="button secondary" href="/campaigns/${campaign.id}/edit">Edit campaign</a></section>${notices(url)}<nav class="tabs"><a href="/campaigns/${campaign.id}"${tab === "pipeline" ? ' class="active"' : ""}>Pipeline</a><a href="/campaigns/${campaign.id}/follow-ups"${tab === "follow-ups" ? ' class="active"' : ""}>Sent &amp; follow-ups${due ? ` <span class="badge PENDING">${due} due</span>` : ""}</a></nav>${sectionNav(tab)}`;
}

function editCampaignPage(campaign: Campaign, url: URL): string {
  return layout(`Edit ${campaign.name}`, `<a href="/campaigns/${campaign.id}">← Campaign ${campaign.id}</a>${notices(url)}<section class="card" style="max-width:760px;margin-top:18px"><div class="cardhead"><div><span class="eyebrow">Campaign ${campaign.id}</span><h1>Edit campaign</h1></div><span class="badge ${campaign.status}">${humanize(campaign.status)}</span></div><p class="muted">This updates campaign metadata only. Existing companies, contacts, approvals, research, and outreach are preserved.</p><form method="post" action="/campaigns/${campaign.id}/edit"><label><span>Name</span><input name="name" value="${escapeHtml(campaign.name)}" maxlength="200" required></label><label><span>Target segment</span><textarea name="segment" maxlength="5000" required>${escapeHtml(campaign.segment)}</textarea></label><div class="actions"><button type="submit">Save changes</button><a class="button secondary" href="/campaigns/${campaign.id}">Cancel</a></div></form></section>`);
}

const SECTIONS = {
  pipeline: [["companies", "Companies"], ["contacts", "Contacts"], ["email-discovery", "Email discovery"],
    ["prospect-research", "Prospect research"], ["draft-review", "Emails"], ["runs", "Workflow runs"]],
  "follow-ups": [["generate-follow-ups", "Draft follow-ups"], ["sent-emails", "Sent emails"]],
} as const;

function sectionNav(tab: keyof typeof SECTIONS): string {
  return `<nav class="jump" aria-label="Jump to section">${SECTIONS[tab]
    .map(([id, label]) => `<a href="#${id}">${label}</a>`).join("")}</nav>`;
}

function followUpsPage(campaign: Campaign, url: URL): string {
  const isRunning = store.listWorkflowRuns(campaign.id).some(({ status }) => status === "PENDING" || status === "RUNNING");
  const running = isRunning ? `<div class="notice">A workflow is running. This page refreshes every 3s; output is under Workflow runs on the <a href="/campaigns/${campaign.id}#runs">Pipeline</a> tab.</div>` : "";
  return layout(`${campaign.name} · Follow-ups`, `${campaignHeader(campaign, url, "follow-ups")}${running}<div class="grid">${renderFollowUps(store, campaign.id, Number(url.searchParams.get("open")) || undefined)}</div>`, { refreshing: isRunning });
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
  const contactsAwaitingEmail = contacts.filter(({ status, emailStatus, guessedEmail }) =>
    status === "APPROVED"
      && (emailStatus === "UNKNOWN" || (emailStatus === "EMAIL_NOT_FOUND" && !guessedEmail))).length;
  const uncheckedGuesses = store.listGuessesAwaitingVerification(campaign.id).length;
  const inconclusiveGuesses = store.listGuessesAwaitingVerification(campaign.id, { includeInconclusive: true }).length
    - uncheckedGuesses;
  const smtpLabel = uncheckedGuesses || !inconclusiveGuesses
    ? `SMTP-check guesses (${uncheckedGuesses})` : `Re-check inconclusive (${inconclusiveGuesses})`;
  const recoverable = store.listEmailRecoveryCandidates(campaign.id);
  const evidenceCandidates = store.listPatternEvidenceCandidates(campaign.id).length;
  const verifying = isCheckingGuesses(campaign.id);
  const sending = isSending(campaign.id);
  const verifyStatus = renderEmailPipelineStatus(contacts, runs,
    { checking: verifying, lastCheck: lastGuessCheck(campaign.id) });

  const companyRows = companies.map((company) => {
    const signal = sourceFor(research, company.id);
    const chatFeature = company.chatFeatureStatus === "PRESENT"
      ? `<span class="badge APPROVED">Yes</span>${company.chatFeatureSourceUrl ? `<br><a href="${escapeHtml(company.chatFeatureSourceUrl)}" target="_blank" rel="noreferrer">Evidence ↗</a>` : ""}`
      : company.chatFeatureStatus === "NO_PUBLIC_EVIDENCE"
        ? '<span class="badge UNKNOWN">No public evidence</span>'
        : '<span class="badge UNKNOWN">Unknown</span>';
    const chat = `${chatFeature}<br><strong>Implementation:</strong> ${escapeHtml(humanize(company.chatImplementation))}${company.chatVendorName ? ` (${escapeHtml(company.chatVendorName)})` : ""}${company.chatImplementationSourceUrl ? `<br><a href="${escapeHtml(company.chatImplementationSourceUrl)}" target="_blank" rel="noreferrer">Implementation source ↗</a>` : ""}`;
    const headcount = company.employeeCount ?? company.employeeCountRange ?? "?";
    const fit = `${escapeHtml(company.location ?? "Unknown")}${company.locationSourceUrl ? ` <a href="${escapeHtml(company.locationSourceUrl)}" target="_blank" rel="noreferrer">↗</a>` : ""}<br><span class="muted">${escapeHtml(headcount)} employees${company.employeeCountSourceUrl ? ` <a href="${escapeHtml(company.employeeCountSourceUrl)}" target="_blank" rel="noreferrer">↗</a>` : ""}<br>${company.engineeringHeadcount ?? "Unknown"} engineers${company.engineeringHeadcountSourceUrl ? ` <a href="${escapeHtml(company.engineeringHeadcountSourceUrl)}" target="_blank" rel="noreferrer">↗</a>` : ""}</span>`;
    const thesis = company.salesThesis ? `<br><strong>Thesis:</strong> ${escapeHtml(company.salesThesis)}` : "";
    const breakdown = company.scoreBreakdown ? `<details><summary>Score factors</summary>${Object.entries(company.scoreBreakdown).map(([key, value]) => `${escapeHtml(humanize(key.replaceAll(/([A-Z])/g, " $1")))}: ${value}`).join("<br>")}</details>` : "";
    return `<tr><td><input class="check" type="checkbox" name="ids" value="${company.id}" aria-label="Select ${escapeHtml(company.name)}"></td><td><strong>${escapeHtml(company.name)}</strong><br><a href="https://${escapeHtml(company.domain)}" target="_blank" rel="noreferrer">${escapeHtml(company.domain)}</a></td><td>${fit}</td><td class="score">${company.score ?? "—"}${breakdown}</td><td>${chat}</td><td>${escapeHtml(company.reason ?? "No reason recorded")}${thesis}</td><td class="source">${signal ? `${escapeHtml(signal.signal)}<br><a href="${escapeHtml(signal.sourceUrl)}" target="_blank" rel="noreferrer">Source ↗</a>` : '<span class="muted">No source recorded</span>'}</td><td><span class="badge ${company.status}">${humanize(company.status)}</span></td></tr>`;
  }).join("");

  const contactRows = contacts.map((contact) => {
    const company = companies.find(({ id }) => id === contact.companyId)!;
    const source = sourceFor(research, contact.companyId, contact.id);
    return `<tr><td><input class="check" type="checkbox" name="ids" value="${contact.id}" aria-label="Select ${escapeHtml(contact.name)}"></td><td><strong>${escapeHtml(contact.name)}</strong><br><span class="muted">${escapeHtml(contact.title ?? "Unknown title")}</span></td><td>${escapeHtml(company.name)}</td><td>${escapeHtml(contact.roleCategory ?? "—")}<br><span class="score">${contact.roleScore ?? "—"}</span></td><td>${contact.linkedinUrl ? `<a href="${escapeHtml(contact.linkedinUrl)}" target="_blank" rel="noreferrer">Profile ↗</a>` : "—"}${source ? `<br><a href="${escapeHtml(source.sourceUrl)}" target="_blank" rel="noreferrer">Role source ↗</a>` : ""}</td><td>${contact.email ? `<strong>${escapeHtml(contact.email)}</strong><br>` : ""}<span class="badge ${contact.emailStatus}">${humanize(contact.emailStatus)}</span></td><td><span class="badge ${contact.status}">${humanize(contact.status)}</span></td></tr>`;
  }).join("");

  const runRows = runs.map((run) => `<details${run.status === "RUNNING" ? " open" : ""}><summary>${escapeHtml(runLabel(run))} <span class="badge ${run.status}">${humanize(run.status)}</span></summary>${run.error ? `<div class="notice error">${escapeHtml(run.error)}</div>` : ""}<pre>${escapeHtml(run.output || (run.status === "RUNNING" ? "Starting Codex…" : "No output captured."))}</pre></details>`).join("");

  return layout(campaign.name, `${campaignHeader(campaign, url, "pipeline")}<div class="steps"><div class="step"><strong>${companies.length} companies</strong>${approvedCompanies} approved</div><div class="step"><strong>${contacts.length} contacts</strong>${approvedContacts} approved</div><div class="step"><strong>${emailComplete} email checks</strong>${contactsAwaitingEmail} approved contact(s) awaiting discovery</div></div><div class="grid"><section class="card span12" id="companies"><div class="cardhead"><div><span class="eyebrow">Stage 1</span><h2>Company discovery</h2></div><form method="post" action="/campaigns/${campaign.id}/workflows/company-discovery" class="inline"><input name="targetCount" type="number" min="1" max="25" value="5" style="width:70px" aria-label="Target count"><button ${isRunning ? "disabled" : ""}>${companies.length ? "Find more" : "Run discovery"}</button></form></div>${companies.length ? `<form method="post" action="/campaigns/${campaign.id}/companies/review"><div class="actions"><button type="button" class="secondary" data-select>Select all</button><button name="decision" value="APPROVED">Approve selected</button><button class="danger" name="decision" value="REJECTED">Reject selected</button></div><div class="tablewrap"><table><thead><tr><th></th><th>Company</th><th>Fit</th><th>Score</th><th>Why ConvoKit</th><th>Signal</th><th>Status</th></tr></thead><tbody>${companyRows}</tbody></table></div></form>` : '<div class="empty">No companies stored yet. Run discovery to populate this stage.</div>'}</section><section class="card span12" id="contacts"><div class="cardhead"><div><span class="eyebrow">Stage 2</span><h2>Contact discovery</h2></div><form method="post" action="/campaigns/${campaign.id}/workflows/contact-discovery"><button ${isRunning || approvedCompanies === 0 ? "disabled" : ""}>Run contact discovery</button></form></div>${contacts.length ? `<form method="post" action="/campaigns/${campaign.id}/contacts/review"><div class="actions"><button type="button" class="secondary" data-select>Select all</button><button name="decision" value="APPROVED">Approve selected</button><button class="danger" name="decision" value="REJECTED">Reject selected</button></div><div class="tablewrap"><table><thead><tr><th></th><th>Contact</th><th>Company</th><th>Role / score</th><th>Evidence</th><th>Email</th><th>Status</th></tr></thead><tbody>${contactRows}</tbody></table></div></form>` : `<div class="empty">${approvedCompanies ? "Approved companies are ready for contact discovery." : "Approve companies to unlock contact discovery."}</div>`}</section><section class="card span8" id="email-discovery"><div class="cardhead"><div><span class="eyebrow">Stage 3</span><h2>Email discovery</h2></div><div class="actions"><form method="post" action="/campaigns/${campaign.id}/workflows/email-discovery"><button ${isRunning || contactsAwaitingEmail === 0 ? "disabled" : ""}>Find public emails</button></form><form method="post" action="/campaigns/${campaign.id}/emails/verify-guesses"><button class="secondary" ${verifying || isRunning || uncheckedGuesses + inconclusiveGuesses === 0 ? "disabled" : ""}>${smtpLabel}</button></form><form method="post" action="/campaigns/${campaign.id}/emails/pattern-evidence"><button class="secondary" ${verifying || isRunning || evidenceCandidates === 0 ? "disabled" : ""}>Find pattern evidence (${evidenceCandidates})</button></form><form method="post" action="/campaigns/${campaign.id}/emails/treg-recovery"><button class="secondary" ${verifying || isRunning || recoverable.length === 0 ? "disabled" : ""}>Recover with Treg (${recoverable.length})</button></form></div></div><p class="muted">Only approved contacts with an unknown email status are checked. Inferred addresses are never stored as verified.</p><p class="muted">After email discovery, the free SMTP check runs automatically: it asks the mail server which guessed pattern exists, without sending mail, then prospect research starts. Publicly listed and verified emails are never probed, and a valid result keeps the address labelled as a guess. Find pattern evidence (free) searches public pages for a real same-domain address that confirms the pattern. Treg (paid) runs only when you click Recover with Treg, once per contact whose guess was invalid, catch-all, or inconclusive.</p>${verifyStatus}${renderEmailResults(companies, contacts, research, campaign.id)}</section><aside class="card span4"><span class="eyebrow">Safety gates</span><h2 style="margin-top:5px">Human approval stays required</h2><p class="muted">Research may run automatically. Company, contact, and future email-draft approvals remain manual.</p></aside>${renderProspectStages(store, campaign.id, Number(url.searchParams.get("draftId")) || undefined, sendQueueStatus(campaign.id))}<section class="card span12" id="runs"><div class="cardhead"><div><span class="eyebrow">Activity</span><h2>Workflow runs</h2></div>${isRunning ? '<span class="badge RUNNING">Refreshing every 3s</span>' : ""}</div>${runRows || '<div class="empty">No research runs yet.</div>'}</section></div>`, { refreshing: isRunning || verifying || sending });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);
  if (request.headers.host !== `${host}:${port}`
    || (request.method === "POST" && request.headers.origin && request.headers.origin !== appOrigin)) {
    send(response, 403, layout("Forbidden", '<div class="notice error">Use the local dashboard URL printed in your terminal. Cross-origin requests are not allowed.</div>')); return;
  }
  if (request.method === "GET" && url.pathname === "/gmail") {
    const mcpTools = mcpEmail.connectedEmail()
      ? await mcpEmail.inspectTools().catch(() => []) : [];
    send(response, 200, layout("Email connections", notices(url) + renderGmailSettings(store, {
      providers: [
        { client: gmail, expectedSender, canSend: true },
        { client: mcpEmail, expectedSender: process.env.MCP_EMAIL_SENDER_EMAIL ?? "", canSend: mcpEmail.sendConfigured() },
      ],
      activeId: emailTransport.id,
      recipient: process.env.EMAIL_TEST_RECIPIENT ?? process.env.GMAIL_TEST_RECIPIENT ?? "",
      expectedSender: selectedExpectedSender,
      signTest: (id, sender) => signature("test", id, sender),
      signTestFollowUp: (id, parentId, sender) => signature("test-follow-up", id, parentId, sender),
      mcpTools,
    }))); return;
  }
  if (request.method === "POST" && ["/gmail/connect", "/gmail/disconnect", "/gmail/test", "/gmail/test-follow-up"].includes(url.pathname)) {
    const form = await formData(request);
    if (store.listEmailDeliveries().some(({ status }) => status === "PREPARING" || status === "SENDING")) {
      throw new WorkflowError("Wait for active delivery to finish before changing Gmail or sending another test");
    }
    if (url.pathname === "/gmail/connect") {
      const providerId = form.get("provider");
      const provider = providerId === "gmail" ? gmail : providerId === "mcp" ? mcpEmail : undefined;
      if (!provider) throw new WorkflowError("Choose a valid email provider");
      const mcpRedirectUri = process.env.MCP_EMAIL_REDIRECT_URI ?? `${appOrigin}/gmail/callback`;
      if (provider.id === "gmail" && redirectUri !== `${appOrigin}/gmail/callback`) {
        throw new WorkflowError("GMAIL_REDIRECT_URI must match the current dashboard origin and /gmail/callback path.");
      }
      if (provider.id === "mcp" && mcpRedirectUri !== `${appOrigin}/gmail/callback`) {
        throw new WorkflowError("MCP_EMAIL_REDIRECT_URI must match the current dashboard origin and /gmail/callback path.");
      }
      const authorization = provider.id === "gmail"
        ? gmail.beginAuthorization() : await mcpEmail.beginAuthorization();
      const cookie = provider.id === "gmail" ? "gmail_oauth_state" : "mcp_oauth_state";
      response.setHeader("Set-Cookie", [
        `${cookie}=${authorization.state}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/gmail/callback`,
        `email_oauth_provider=${provider.id}; HttpOnly; SameSite=Lax; Max-Age=600; Path=/gmail/callback`,
      ]);
      redirect(response, authorization.url); return;
    }
    if (url.pathname === "/gmail/disconnect") {
      const providerId = form.get("provider");
      const provider = providerId === "gmail" ? gmail : providerId === "mcp" ? mcpEmail : undefined;
      if (!provider) throw new WorkflowError("Choose a valid email provider");
      if (provider.id === "gmail") await gmail.disconnect(); else await mcpEmail.disconnect();
      redirect(response, "/gmail", { notice: `${provider.label} access revoked and local credentials removed` }); return;
    }
    const sender = emailTransport.connectedEmail();
    const requestId = form.get("requestId") ?? "";
    if (url.pathname === "/gmail/test-follow-up") {
      const parentId = form.get("parentId") ?? "";
      if (!sender || form.get("confirm") !== "yes"
        || !validSignature(form.get("testFollowUpSignature"), signature("test-follow-up", requestId, parentId, sender))) {
        throw new WorkflowError("Review the test follow-up and explicitly confirm sending it");
      }
      const delivery = await emailSending.sendTestFollowUp(parentId, requestId, sender);
      redirect(response, "/gmail", { notice: `Test follow-up sent to ${delivery.toEmail}. Check that it is in the same thread. ${emailTransport.label} receipt ${delivery.providerReceipt}.` }, "test-follow-up"); return;
    }
    if (!sender || !validSignature(form.get("testSignature"), signature("test", requestId, sender))
      || form.get("confirm") !== "yes") throw new WorkflowError("Review the test message and explicitly confirm sending it");
    const delivery = await emailSending.sendTest(form.get("recipient")?.trim() ?? "", requestId, sender);
    redirect(response, "/gmail", { notice: `Test email sent to ${delivery.toEmail}. ${emailTransport.label} receipt ${delivery.providerReceipt}.` }); return;
  }
  if (request.method === "GET" && url.pathname === "/gmail/callback") {
    const providerId = request.headers.cookie?.match(/(?:^|;\s*)email_oauth_provider=([^;]*)/)?.[1];
    const provider = providerId === "gmail" ? gmail : providerId === "mcp" ? mcpEmail : undefined;
    if (!provider) { redirect(response, "/gmail", { error: "Email connection expired. Start the connection again." }); return; }
    const cookie = provider.id === "gmail" ? "gmail_oauth_state" : "mcp_oauth_state";
    response.setHeader("Set-Cookie", [
      `${cookie}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/gmail/callback`,
      "email_oauth_provider=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/gmail/callback",
    ]);
    if (url.searchParams.get("error")) {
      redirect(response, "/gmail", { error: `${provider.label} authorization was not completed. No email was sent.` }); return;
    }
    const cookieState = request.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${cookie}=([^;]*)`))?.[1] ?? "";
    try {
      const email = provider.id === "gmail"
        ? await gmail.finishAuthorization(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "", cookieState)
        : await mcpEmail.finishAuthorization(url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "", cookieState);
      redirect(response, "/gmail", { notice: `Connected ${email} to ${provider.label}.` }); return;
    } catch (error) { redirect(response, "/gmail", { error: messageOf(error) }); return; }
  }

  const sendAllPreview = url.pathname.match(/^\/campaigns\/(\d+)\/send-all$/);
  if (request.method === "GET" && sendAllPreview) {
    const campaignId = Number(sendAllPreview[1]);
    if (!store.getCampaign(campaignId)) throw new WorkflowError("Campaign not found");
    const sender = emailTransport.connectedEmail();
    if (!sender) { redirect(response, "/gmail", { error: `Configure ${emailTransport.label} before sending approved emails` }); return; }
    if (isSending(campaignId)) throw new WorkflowError("A send queue is already running for this campaign");
    const batch = sendBatch(campaignId, sender);
    if (batch.length === 0) throw new WorkflowError("No READY_TO_SEND emails can be sent right now");
    const guessed = batch.filter(({ guessed }) => guessed).length;
    const items = batch.map(({ outreach, label, expected, guessed, guessBadge }) => `<details class="email-draft"><summary>${escapeHtml(label)} · <strong>${escapeHtml(expected.toEmail)}</strong>${guessed ? ` <span class="badge UNKNOWN">Guessed · unverified</span> ${guessBadge}` : ""} · ${escapeHtml(expected.subject)}</summary><pre class="email-preview">${escapeHtml(expected.body)}</pre></details><input type="hidden" name="ids" value="${outreach.id}"><input type="hidden" name="sig-${outreach.id}" value="${signature("outreach", outreach.id, expected)}">`).join("");
    const gap = Math.round(SEND_QUEUE_GAP_MS / 1000);
    send(response, 200, layout("Confirm sending all", `<a href="/campaigns/${campaignId}#draft-review">← Emails</a><section class="card" style="margin-top:18px"><h1>Confirm sending ${batch.length} email(s)</h1><p><strong>From:</strong> ${escapeHtml(sender)}</p>${guessed ? `<div class="notice error"><strong>Warning:</strong> ${guessed} of these go to guessed, unverified addresses. They may bounce or reach someone else.</div>` : ""}<p class="muted">Expand any email to read it. They are sent one after another, ${gap}s apart. Each is re-checked just before sending; if its approval, recipient, or content changed, or a send fails, the queue stops and the rest stay READY_TO_SEND.</p><form method="post" action="/campaigns/${campaignId}/outreach/send-all">${items}<div class="notice">This sends real emails to these prospects. Sending cannot be undone by this dashboard.</div><label class="inline"><input type="checkbox" name="confirm" value="yes" required>I confirm sending each exact approved email above to its recipient${guessed ? ", knowing some addresses are guessed and unverified" : ""}.</label><button>Send ${batch.length} email(s)</button></form></section>`)); return;
  }

  const sendPreview = url.pathname.match(/^\/campaigns\/(\d+)\/outreach\/(\d+)\/send$/);
  if (request.method === "GET" && sendPreview) {
    const campaignId = Number(sendPreview[1]);
    const id = Number(sendPreview[2]);
    const draft = store.assertReadyToSend(id);
    const contact = store.getContact(draft.contactId)!;
    if (store.getCompany(contact.companyId)?.campaignId !== campaignId) throw new WorkflowError("Email does not belong to this campaign");
    const sender = emailTransport.connectedEmail();
    if (!sender) { redirect(response, "/gmail", { error: `Configure ${emailTransport.label} before sending approved emails` }); return; }
    const blocked = store.listEmailDeliveries().find((delivery) => delivery.outreachId === id && delivery.status !== "FAILED");
    if (blocked) throw new WorkflowError("Delivery is already active, sent, or uncertain. Do not resend.");
    const recipient = store.getContactRecipient(contact.id)!;
    const expected = { fromEmail: sender, toEmail: recipient.address, subject: draft.subject, body: draft.body };
    const recipientWarning = recipient.guessed
      ? `<div class="notice error"><strong>Warning:</strong> ${escapeHtml(recipient.address)} is a guessed, unverified address. It may bounce or belong to someone else.</div>`
      : "";
    const back = draft.followUpOf === null
      ? `<a href="/campaigns/${campaignId}?draftId=${id}#email-${id}">← Emails</a>`
      : `<a href="/campaigns/${campaignId}/follow-ups?open=${draft.followUpOf}#sent-${draft.followUpOf}">← Sent &amp; follow-ups</a>`;
    const threadNote = draft.followUpOf === null ? ""
      : `<div class="notice">Follow-up: sent as a reply in the same thread as the first email.${emailTransport.id === "mcp" ? " The original email is located and verified in your Sent folder first; if it can't be verified, nothing is sent." : ""}</div>`;
    send(response, 200, layout("Confirm send", `${back}<section class="card" style="margin-top:18px"><h1>Confirm sending</h1>${threadNote}<p><strong>From:</strong> ${escapeHtml(sender)}<br><strong>To:</strong> ${escapeHtml(recipient.address)}${recipient.guessed ? ` <span class="badge UNKNOWN">Guessed</span> ${guessVerificationBadge(recipient.verification, contact.guessedEmailVerificationDetail)}` : ""}<br><strong>Subject:</strong> ${escapeHtml(draft.subject)}</p>${recipientWarning}<pre class="email-preview">${escapeHtml(draft.body)}</pre><div class="notice">This sends a real email to this prospect. Sending cannot be undone by this dashboard.</div><form method="post" action="/campaigns/${campaignId}/outreach/${id}/send"><input type="hidden" name="sendSignature" value="${signature("outreach", id, expected)}"><label class="inline"><input type="checkbox" name="confirm" value="yes" required>I confirm sending this exact approved email to the recipient above${recipient.guessed ? ", knowing the address is guessed and unverified" : ""}.</label><button>Send email now</button></form></section>`)); return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    send(response, 200, dashboardPage(url)); return;
  }

  const campaignEditMatch = url.pathname.match(/^\/campaigns\/(\d+)\/edit$/);
  if (request.method === "GET" && campaignEditMatch) {
    const campaign = store.getCampaign(Number(campaignEditMatch[1]));
    if (!campaign) throw new WorkflowError("Campaign not found");
    send(response, 200, editCampaignPage(campaign, url)); return;
  }

  const campaignMatch = url.pathname.match(/^\/campaigns\/(\d+)(\/follow-ups)?$/);
  if (request.method === "GET" && campaignMatch) {
    const campaign = store.getCampaign(Number(campaignMatch[1]));
    if (!campaign) throw new WorkflowError("Campaign not found");
    send(response, 200, campaignMatch[2] ? followUpsPage(campaign, url) : campaignPage(campaign, url)); return;
  }

  if (request.method === "POST" && url.pathname === "/campaigns") {
    const form = await formData(request);
    const name = form.get("name")?.trim() ?? "";
    const segment = form.get("segment")?.trim() ?? "";
    if (!name || !segment) throw new WorkflowError("Campaign name and segment are required");
    const targetCount = requirePositiveId(form.get("targetCount"), "company target count");
    if (targetCount > 30) throw new WorkflowError("Company target count cannot exceed 30");
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
    const back = (message: Record<string, string>): void => {
      const target = campaignReturn(campaignId, action);
      redirect(response, target.path, { ...target.params, ...message }, target.anchor);
    };

    if (action === "edit") {
      const name = form.get("name")?.trim() ?? "";
      const segment = form.get("segment")?.trim() ?? "";
      if (name.length > 200) throw new WorkflowError("Campaign name cannot exceed 200 characters");
      if (segment.length > 5000) throw new WorkflowError("Target segment cannot exceed 5000 characters");
      store.updateCampaign(campaignId, { name, segment });
      back({ notice: "Campaign updated" }); return;
    }

    const draftAction = action.match(/^outreach\/(\d+)\/(edit|review|rewrite|restore|send|replied|bounced)$/);
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
        const sender = emailTransport.connectedEmail();
        const current = store.assertReadyToSend(outreachId);
        const recipient = store.getContactRecipient(contact!.id);
        const expected = { fromEmail: sender ?? "", toEmail: recipient?.address ?? "", subject: current.subject, body: current.body };
        if (!sender || form.get("confirm") !== "yes"
          || !validSignature(form.get("sendSignature"), signature("outreach", outreachId, expected))) {
          throw new WorkflowError("Send confirmation expired or recipient/content changed. Review the email and confirm sending again.");
        }
        const delivery = await emailSending.sendApproved(outreachId, expected);
        back({ notice: `Email sent to ${delivery.toEmail}. ${emailTransport.label} receipt ${delivery.providerReceipt}.` }); return;
      }
      if (draftAction[2] === "replied") {
        store.markOutreachReplied(outreachId);
        back({ notice: "Marked as replied. No follow-up will be sent." }); return;
      }
      if (draftAction[2] === "bounced") {
        store.markOutreachBounced(outreachId, form.get("detail") ?? "");
        back({ notice: "Marked as bounced. No follow-up will be sent." }); return;
      }
      if (draftAction[2] === "edit") {
        store.editOutreach(outreachId, { subject: form.get("subject") ?? "", body: form.get("body") ?? "" });
        back({ notice: "Draft changes saved. Fresh approval is still required." }); return;
      }
      if (draftAction[2] === "restore") {
        store.withdrawOutreachApproval(outreachId);
        back({ notice: "Returned to DRAFT for a fresh human review. Nothing was sent." }); return;
      }
      if (draftAction[2] === "rewrite") {
        const feedback = form.get("feedback")?.trim() ?? "";
        if (!feedback || feedback.length > 2000) throw new WorkflowError("Provide up to 2000 characters of rewrite feedback");
        launchWorkflow(db, { campaignId, kind: "DRAFT_REWRITE", outreachId, feedback });
        back({ notice: "Rewrite started; draft remains unapproved" }); return;
      }
      const decision = form.get("decision");
      if (decision === "APPROVED") store.approveOutreachForSending(outreachId);
      else if (decision === "REJECTED") store.rejectOutreach(outreachId);
      else throw new WorkflowError("Choose approve or reject");
      back({
        notice: decision === "APPROVED" ? "Draft approved and READY_TO_SEND. Nothing was sent." : "Draft rejected",
      }); return;
    }

    if (action === "outreach/send-all") {
      const sender = emailTransport.connectedEmail();
      if (!sender || form.get("confirm") !== "yes") throw new WorkflowError("Confirm sending to start the queue");
      if (store.listWorkflowRuns().some(({ status }) => status === "RUNNING" || status === "PENDING")) {
        throw new WorkflowError("Wait for the active workflow to finish before sending");
      }
      const confirmed = new Map(sendBatch(campaignId, sender).map((item) => [item.outreach.id, item]));
      const ids = form.getAll("ids").map((value) => requirePositiveId(value, "email ID"));
      // Every email must still match exactly what the confirmation page showed.
      const queue = ids.map((id) => {
        const item = confirmed.get(id);
        if (!item || !validSignature(form.get(`sig-${id}`), signature("outreach", id, item.expected))) {
          throw new WorkflowError("Send confirmation expired or a recipient/content changed. Review the emails and confirm again.");
        }
        return item;
      });
      if (queue.length === 0) throw new WorkflowError("No emails were confirmed");
      void startSendQueue(campaignId, queue.map(({ outreach, label }) => ({ outreachId: outreach.id, label })),
        async (outreachId) => {
          const item = sendBatch(campaignId, sender).find(({ outreach }) => outreach.id === outreachId);
          const original = confirmed.get(outreachId)!;
          if (!item || JSON.stringify(item.expected) !== JSON.stringify(original.expected)) {
            throw new Error("Its approval, recipient, or content changed after confirmation; review it again");
          }
          await emailSending.sendApproved(outreachId, item.expected);
        });
      back({ notice: `Sending ${queue.length} email(s) one after another, ${Math.round(SEND_QUEUE_GAP_MS / 1000)}s apart. Progress is shown under Emails.` }); return;
    }
    if (action === "outreach/approve-all") {
      if (store.listWorkflowRuns().some(({ status }) => status === "RUNNING" || status === "PENDING")) {
        throw new WorkflowError("Wait for the active workflow to finish before reviewing drafts");
      }
      const ids = form.getAll("ids").map((value) => requirePositiveId(value, "draft ID"));
      if (ids.length === 0) throw new WorkflowError("No drafts to approve");
      // Only the first-touch drafts the reviewer saw on the page; newer drafts need their own review.
      const campaignDrafts = new Set(store.listCampaignOutreach(campaignId)
        .filter(({ status }) => status === "DRAFT").map(({ id }) => id));
      let approved = 0;
      const skipped: string[] = [];
      for (const id of ids) {
        if (!campaignDrafts.has(id)) { skipped.push(`#${id}: no longer a draft in this campaign`); continue; }
        try { store.approveOutreachForSending(id); approved += 1; }
        catch (error) { skipped.push(`#${id}: ${messageOf(error)}`); }
      }
      back({ notice: `${approved} draft(s) approved and READY_TO_SEND. Nothing was sent.${skipped.length ? ` Skipped ${skipped.length}: ${skipped.join("; ")}` : ""}` }); return;
    }
    const recheck = action.match(/^contacts\/(\d+)\/recheck-angle$/);
    if (recheck || action === "contacts/recheck-angles") {
      const ids = recheck ? [Number(recheck[1])]
        : [...new Set(form.getAll("recheckIds").map((value) => requirePositiveId(value, "contact ID")))];
      if (ids.length === 0) throw new WorkflowError("Check at least one prospect to recheck");
      if (store.listWorkflowRuns().some(({ status }) => status === "RUNNING" || status === "PENDING")) {
        throw new WorkflowError("Wait for the active workflow to finish before rechecking an angle");
      }
      const eligible = new Set(store.listResearchEligibleProspects(campaignId).map(({ id }) => id));
      for (const id of ids) {
        const contact = store.getContact(id);
        if (!contact || store.getCompany(contact.companyId)?.campaignId !== campaignId) {
          throw new WorkflowError("Contact does not belong to this campaign");
        }
        if (!eligible.has(id)) {
          throw new WorkflowError(`${contact.name} is not eligible for prospect research (it needs a usable email)`);
        }
      }
      const reset = store.resetNoSignalResearchMany(ids);
      const run = launchWorkflow(db, { campaignId, kind: "PROSPECT_RESEARCH" });
      back({ notice: `Rechecking the angle for ${reset.length} prospect(s): ${reset.map(({ name }) => name).join(", ")} (run ${run.id}). Results stay separate from drafting until you select them.` }); return;
    }
    const manualEmail = action.match(/^contacts\/(\d+)\/email$/);
    if (manualEmail) {
      const contact = store.getContact(Number(manualEmail[1]));
      if (!contact || store.getCompany(contact.companyId)?.campaignId !== campaignId) {
        throw new WorkflowError("Contact does not belong to this campaign");
      }
      if (store.listWorkflowRuns().some(({ status }) => status === "RUNNING" || status === "PENDING")) {
        throw new WorkflowError("Wait for the active workflow to finish before updating emails");
      }
      const emailStatus = form.get("emailStatus");
      if (emailStatus !== "VERIFIED" && emailStatus !== "PUBLICLY_LISTED") {
        throw new WorkflowError("Choose whether the email is verified or publicly listed");
      }
      const updated = store.recordManualEmail({ contactId: contact.id, email: form.get("email") ?? "",
        emailStatus, sourceUrl: form.get("sourceUrl") ?? "", note: form.get("note") ?? undefined });
      back({ notice: `Email for ${updated.name} updated to ${updated.email}` }); return;
    }
    if (action === "emails/verify-guesses") {
      // New guesses first; once all are checked, the button re-checks inconclusive ones.
      const includeInconclusive = store.listGuessesAwaitingVerification(campaignId).length === 0;
      const count = store.listGuessesAwaitingVerification(campaignId, { includeInconclusive }).length;
      if (count === 0) throw new WorkflowError("No guessed emails are awaiting an SMTP check");
      void startGuessCheck(db, campaignId, { includeInconclusive });
      back({ notice: `SMTP-checking ${count} guessed email(s). Treg does not run automatically.` }); return;
    }
    if (action === "emails/pattern-evidence") {
      const run = launchPatternEvidence(db, campaignId);
      back({ notice: `Started pattern-evidence search (run ${run.id}). Updated guesses are SMTP-checked automatically afterwards.` }); return;
    }
    if (action === "emails/treg-recovery") {
      const run = launchEmailRecovery(db, campaignId);
      back({ notice: `Started Treg recovery (run ${run.id}). Recovered contacts need prospect research afterwards.` }); return;
    }
    if (action.startsWith("workflows/")) {
      const kinds = {
        "workflows/company-discovery": "COMPANY_DISCOVERY",
        "workflows/contact-discovery": "CONTACT_DISCOVERY",
        "workflows/email-discovery": "EMAIL_DISCOVERY",
        "workflows/prospect-research": "PROSPECT_RESEARCH",
        "workflows/email-generation": "EMAIL_GENERATION",
        "workflows/follow-up-generation": "FOLLOW_UP_GENERATION",
      } as const;
      const kind = kinds[action as keyof typeof kinds];
      if (!kind) throw new WorkflowError("Unknown workflow");
      const targetCount = kind === "COMPANY_DISCOVERY"
        ? requirePositiveId(form.get("targetCount"), "company target count") : undefined;
      if (targetCount !== undefined && targetCount > 30) {
        throw new WorkflowError("Company target count cannot exceed 30");
      }
      const contactIds = kind === "EMAIL_GENERATION"
        ? form.getAll("contactIds").map((value) => requirePositiveId(value, "selected contact ID")) : undefined;
      const outreachIds = kind === "FOLLOW_UP_GENERATION"
        ? form.getAll("outreachIds").map((value) => requirePositiveId(value, "selected email ID")) : undefined;
      const run = launchWorkflow(db, { campaignId, kind, targetCount, contactIds, outreachIds });
      back({ notice: `Started ${humanize(run.kind)}` }); return;
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
      back({ notice: `${ids.length} record(s) ${decision.toLowerCase()}` }); return;
    }
  }

  send(response, 404, layout("Not found", '<div class="card"><h1>Page not found</h1><a href="/">Return to campaigns</a></div>'));
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    const campaignAction = request.url?.match(/^\/campaigns\/(\d+)\/([^?#]+)/);
    if (request.method === "POST" && campaignAction) {
      const target = campaignReturn(Number(campaignAction[1]), campaignAction[2]);
      redirect(response, target.path, { ...target.params, error: messageOf(error) }, target.anchor);
    } else if (request.method === "POST") {
      redirect(response, request.url?.startsWith("/gmail") ? "/gmail" : "/", { error: messageOf(error) });
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
