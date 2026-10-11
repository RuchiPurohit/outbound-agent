import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { OutboundStore } from "../src/db/store.js";
import { GmailClient, type GmailTokens, type TokenStore } from "../src/gmail/client.js";
import { EmailSending } from "../src/gmail/sending.js";
import { renderFollowUps } from "../src/web/followUps.js";
import { renderProspectStages } from "../src/web/prospectStages.js";
import { buildPrompt, validateRequest } from "../src/workflows/runner.js";

const sender = "sender@example.com";
const config = { clientId: "test-client", clientSecret: "test-secret", redirectUri: "http://127.0.0.1:3000/gmail/callback", expectedSender: sender };
class MemoryTokens implements TokenStore {
  constructor(public value?: GmailTokens) {}
  load() { return this.value; }
  save(value: GmailTokens) { this.value = value; }
  clear() { this.value = undefined; }
}

async function sentFixture() {
  const db = openDatabase(":memory:");
  const store = new OutboundStore(db);
  const campaign = store.createCampaign({ name: "Test", segment: "SaaS" });
  const company = store.createCompany({ campaignId: campaign.id, name: "Example", domain: "example.com" });
  store.reviewCompany(company.id, "APPROVED");
  const contact = store.createContact({ companyId: company.id, name: "Pat" });
  store.reviewContact(contact.id, "APPROVED");
  store.recordEmailDiscovery({ contactId: contact.id, emailStatus: "PUBLICLY_LISTED", email: "pat@example.com", sourceUrl: "https://example.com/team" });
  const research = store.saveProspectResearch({ contactId: contact.id,
    signals: [{ signal: "Launched shared workspaces", sourceUrl: "https://example.com/launch" }],
    strongestSignalIndex: 0, painHypothesis: "May need conversations", relevance: "ConvoKit chat infrastructure" });
  const first = store.createOutreach({ contactId: contact.id, subject: "Shared workspaces", body: "FIRST_BODY",
    researchId: research.strongestResearchId! });
  store.approveOutreachForSending(first.id);
  const requests: RequestInit[] = [];
  const gmail = new GmailClient(config, new MemoryTokens({ clientId: config.clientId, email: sender,
    accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 3_600_000 }), async (_url, init) => {
    requests.push(init!); return Response.json({ id: `message-${requests.length}`, threadId: "thread-1" });
  });
  const sending = new EmailSending(store, gmail);
  const firstDelivery = await sending.sendApproved(first.id, { fromEmail: sender, toEmail: "pat@example.com", subject: first.subject, body: first.body });
  const backdate = (days: number) => db.prepare("UPDATE outreach SET sent_at = ? WHERE id = ?")
    .run(new Date(Date.now() - days * 86_400_000).toISOString(), first.id);
  return { db, store, campaign, contact, first, firstDelivery, sending, requests, backdate };
}

describe("Follow-ups", () => {
  it("moves sent emails to the follow-ups tab and keeps follow-ups out of first-touch lists", async () => {
    const f = await sentFixture();
    try {
      assert.doesNotMatch(renderProspectStages(f.store, f.campaign.id), /FIRST_BODY/);
      const empty = renderFollowUps(f.store, f.campaign.id);
      assert.match(empty, new RegExp(`id="sent-${f.first.id}"`));
      assert.match(empty, /in 7 days/);
      assert.match(empty, new RegExp(`name="outreachIds" value="${f.first.id}"`));
      const followUp = f.store.createFollowUp({ outreachId: f.first.id, body: "FOLLOW_UP_BODY" });
      assert.equal(followUp.subject, "Re: Shared workspaces");
      assert.equal(followUp.researchId, f.first.researchId);
      assert.equal(followUp.status, "DRAFT");
      assert.deepEqual(f.store.listOutreach(f.contact.id).map(({ id }) => id), [f.first.id]);
      assert.throws(() => f.store.createFollowUp({ outreachId: f.first.id, body: "again" }), /already exists/);
      const html = renderFollowUps(f.store, f.campaign.id, f.first.id);
      assert.match(html, /FOLLOW_UP_BODY/);
      assert.match(html, /name="subject"[^>]*readonly/);
      assert.doesNotMatch(html, new RegExp(`name="outreachIds" value="${f.first.id}"`));
      f.store.editOutreach(followUp.id, { subject: "Changed", body: "Edited body" });
      assert.equal(f.store.getOutreach(followUp.id)?.subject, "Re: Shared workspaces");
    } finally { f.db.close(); }
  });

  it("allows approval early but blocks sending until day 7, then threads the reply", async () => {
    const f = await sentFixture();
    try {
      const followUp = f.store.createFollowUp({ outreachId: f.first.id, body: "FOLLOW_UP_BODY" });
      f.store.approveOutreachForSending(followUp.id);
      const expected = { fromEmail: sender, toEmail: "pat@example.com", subject: followUp.subject, body: followUp.body };
      await assert.rejects(f.sending.sendApproved(followUp.id, expected), /not due until/);
      assert.match(renderFollowUps(f.store, f.campaign.id), /Sending unlocks on/);
      f.backdate(7);
      await f.sending.sendApproved(followUp.id, expected);
      const payload = JSON.parse(String(f.requests[1]!.body)) as { raw: string; threadId?: string };
      assert.equal(payload.threadId, "thread-1");
      const mime = Buffer.from(payload.raw, "base64url").toString("utf8");
      assert.match(mime, new RegExp(`In-Reply-To: <${f.firstDelivery.id}@outbound-agent.local>`));
      assert.match(mime, new RegExp(`References: <${f.firstDelivery.id}@outbound-agent.local>`));
      assert.equal(f.store.getOutreach(followUp.id)?.status, "SENT");
      assert.match(renderFollowUps(f.store, f.campaign.id), /Follow-up sent/);
    } finally { f.db.close(); }
  });

  it("cancels the follow-up once the prospect is marked as replied", async () => {
    const f = await sentFixture();
    try {
      const followUp = f.store.createFollowUp({ outreachId: f.first.id, body: "FOLLOW_UP_BODY" });
      f.store.approveOutreachForSending(followUp.id);
      f.backdate(8);
      assert.throws(() => f.store.markOutreachReplied(followUp.id), /first-touch/);
      f.store.markOutreachReplied(f.first.id);
      assert.throws(() => f.store.assertReadyToSend(followUp.id), /replied/);
      assert.match(renderFollowUps(f.store, f.campaign.id), /Replied/);
      assert.throws(() => f.store.createFollowUp({ outreachId: f.first.id, body: "x" }), /SENT emails without a reply/);
    } finally { f.db.close(); }
  });

  it("validates follow-up generation selections and scopes the prompt", async () => {
    const f = await sentFixture();
    try {
      const request = { campaignId: f.campaign.id, kind: "FOLLOW_UP_GENERATION" as const };
      assert.throws(() => validateRequest(f.store, request), /Select at least one sent email/);
      assert.throws(() => validateRequest(f.store, { ...request, outreachIds: [f.first.id, f.first.id] }), /unique/);
      assert.throws(() => validateRequest(f.store, { ...request, outreachIds: [999] }), /Every selected email/);
      validateRequest(f.store, { ...request, outreachIds: [f.first.id] });
      const prompt = buildPrompt({ ...request, outreachIds: [f.first.id] });
      assert.match(prompt, /prompts\/follow-up-generation\.md/);
      assert.match(prompt, new RegExp(`outreach IDs: \\[${f.first.id}\\]`));
      assert.match(prompt, /Do not approve, schedule, or send anything/);
      f.store.createFollowUp({ outreachId: f.first.id, body: "FOLLOW_UP_BODY" });
      assert.throws(() => validateRequest(f.store, { ...request, outreachIds: [f.first.id] }), /no follow-up/);
    } finally { f.db.close(); }
  });
});
