import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { describe, it } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { OutboundStore } from "../src/db/store.js";
import { FileTokenStore, GmailClient, GMAIL_SEND_SCOPE, type GmailTokens, type TokenStore } from "../src/gmail/client.js";
import { composeMessage, GmailSending, TEST_BODY, TEST_SUBJECT } from "../src/gmail/sending.js";

const sender = "sender@example.com";
const recipient = "recipient@example.net";
const config = { clientId: "test-client", clientSecret: "test-secret", redirectUri: "http://127.0.0.1:3000/gmail/callback", expectedSender: sender };
class MemoryTokens implements TokenStore {
  constructor(public value?: GmailTokens) {}
  load() { return this.value; }
  save(value: GmailTokens) { this.value = value; }
  clear() { this.value = undefined; }
}
const savedTokens = (): GmailTokens => ({ clientId: config.clientId, email: sender,
  accessToken: "test-access-token", refreshToken: "test-refresh-token", expiresAt: Date.now() + 3_600_000 });

function fixture(request: typeof fetch, approved = true) {
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
  const draft = store.createOutreach({ contactId: contact.id, subject: "Shared workspaces", body: "Saw the workspace launch. If messaging grows, ConvoKit may help. API docs? Ruchi",
    researchId: research.strongestResearchId! });
  if (approved) store.approveOutreachForSending(draft.id);
  const tokens = new MemoryTokens(savedTokens());
  const gmail = new GmailClient(config, tokens, request);
  return { db, store, draft, contact, tokens, gmail, sending: new GmailSending(store, gmail),
    expected: { fromEmail: sender, toEmail: "pat@example.com", subject: draft.subject, body: draft.body } };
}
const success = () => Response.json({ id: "gmail-message", threadId: "gmail-thread" });

describe("Gmail sending", () => {
  it("sends approved outreach once, records IDs, and prevents duplicate sends", async () => {
    const requests: RequestInit[] = [];
    const mock: typeof fetch = async (url, init) => {
      assert.equal(String(url), "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
      requests.push(init!); return success();
    };
    const f = fixture(mock);
    try {
      const delivery = await f.sending.sendApproved(f.draft.id, f.expected);
      assert.equal(delivery.status, "SENT");
      assert.equal(delivery.gmailMessageId, "gmail-message");
      assert.equal(f.store.getOutreach(f.draft.id)?.status, "SENT");
      assert.equal(f.store.getOutreach(f.draft.id)?.gmailThreadId, "gmail-thread");
      assert.ok(f.store.getOutreach(f.draft.id)?.sentAt);
      await assert.rejects(f.sending.sendApproved(f.draft.id, f.expected), /READY_TO_SEND/);
      assert.equal(requests.length, 1);
      const payload = JSON.parse(String(requests[0]!.body)) as { raw: string };
      const mime = Buffer.from(payload.raw, "base64url").toString("utf8");
      assert.match(mime, /To: pat@example.com\r\n/);
      assert.match(mime, /From: sender@example\.com\r\n/);
      assert.doesNotMatch(mime, /\r\n(?:Cc|Bcc):/);
    } finally { f.db.close(); }
  });

  it("sends to a guessed recipient only after draft approval", async () => {
    const requests: RequestInit[] = [];
    const f = fixture(async (_url, init) => { requests.push(init!); return success(); }, false);
    try {
      f.store.recordEmailDiscovery({ contactId: f.contact.id, emailStatus: "EMAIL_NOT_FOUND" });
      f.store.recordEmailGuess({ contactId: f.contact.id, guessedEmail: "pat.guessed@example.com",
        pattern: "firstname.lastname", confidence: "COMMON_PATTERN",
        basis: "Explicit test guess" });
      assert.equal(f.store.getOutreach(f.draft.id)?.status, "DRAFT");
      const approved = f.store.approveOutreachForSending(f.draft.id);
      assert.equal(approved.approvedRecipient, "pat.guessed@example.com");
      const expected = { ...f.expected, toEmail: "pat.guessed@example.com" };
      const delivery = await f.sending.sendApproved(f.draft.id, expected);
      assert.equal(delivery.toEmail, "pat.guessed@example.com");
      const payload = JSON.parse(String(requests[0]!.body)) as { raw: string };
      assert.match(Buffer.from(payload.raw, "base64url").toString("utf8"),
        /To: pat\.guessed@example\.com\r\n/);
    } finally { f.db.close(); }
  });

  it("never dispatches unapproved drafts, changed recipients, or changed content", async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return success(); }, false);
    try {
      await assert.rejects(f.sending.sendApproved(f.draft.id, f.expected), /READY_TO_SEND/);
      f.store.approveOutreachForSending(f.draft.id);
      f.store.recordEmailDiscovery({ contactId: f.contact.id, emailStatus: "PUBLICLY_LISTED", email: "new@example.com", sourceUrl: "https://example.com/team" });
      await assert.rejects(f.sending.sendApproved(f.draft.id, f.expected), /saved approval/);
      f.store.withdrawOutreachApproval(f.draft.id);
      f.store.approveOutreachForSending(f.draft.id);
      f.db.prepare("UPDATE outreach SET subject = 'Changed after approval' WHERE id = ?").run(f.draft.id);
      await assert.rejects(f.sending.sendApproved(f.draft.id, f.expected), /saved approval/);
      assert.equal(calls, 0);
      assert.equal(f.store.listEmailDeliveries().length, 0);
    } finally { f.db.close(); }
  });

  it("keeps definite rejection retryable only through another explicit call", async () => {
    let calls = 0;
    const f = fixture(async () => ++calls === 1 ? Response.json({}, { status: 403 }) : success());
    try {
      await assert.rejects(f.sending.sendApproved(f.draft.id, f.expected), /HTTP 403/);
      assert.equal(calls, 1);
      assert.equal(f.store.listEmailDeliveries()[0]?.status, "FAILED");
      assert.equal(f.store.getOutreach(f.draft.id)?.status, "READY_TO_SEND");
      await f.sending.sendApproved(f.draft.id, f.expected);
      assert.equal(calls, 2);
      assert.equal(f.store.listEmailDeliveries().length, 2);
    } finally { f.db.close(); }
  });

  for (const failure of ["timeout", "server-error", "incomplete-response"] as const) {
    it(`blocks retries after uncertain ${failure}`, async () => {
      let calls = 0;
      const f = fixture(async () => {
        calls++;
        if (failure === "timeout") throw new Error("Simulated timeout");
        return failure === "server-error" ? Response.json({}, { status: 503 }) : Response.json({ id: "partial" });
      });
      try {
        await assert.rejects(f.sending.sendApproved(f.draft.id, f.expected), /blocked/);
        assert.equal(f.store.listEmailDeliveries()[0]?.status, "UNCERTAIN");
        await assert.rejects(f.sending.sendApproved(f.draft.id, f.expected), /already sending, sent, or uncertain/);
        assert.equal(calls, 1);
        assert.throws(() => f.store.withdrawOutreachApproval(f.draft.id), /uncertain/);
      } finally { f.db.close(); }
    });
  }

  it("handles concurrent double-clicks with only one provider request", async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; await setTimeout(20); return success(); });
    try {
      const results = await Promise.allSettled([
        f.sending.sendApproved(f.draft.id, f.expected), f.sending.sendApproved(f.draft.id, f.expected),
      ]);
      assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
      assert.equal(calls, 1);
      assert.equal(f.store.listEmailDeliveries().length, 1);
    } finally { f.db.close(); }
  });

  it("sends the fixed test message to the requested recipient without affecting outreach", async () => {
    let mime = ""; let calls = 0;
    const f = fixture(async (_url, init) => {
      calls++; mime = Buffer.from(JSON.parse(String(init?.body)).raw, "base64url").toString("utf8");
      return success();
    });
    try {
      const id = randomUUID();
      const delivery = await f.sending.sendTest(recipient, id, sender);
      assert.equal(delivery.kind, "TEST");
      assert.equal(delivery.outreachId, null);
      assert.equal(delivery.toEmail, recipient);
      assert.equal(delivery.subject, TEST_SUBJECT);
      assert.equal(delivery.body, TEST_BODY);
      assert.match(mime, /To: recipient@example\.net\r\n/);
      assert.equal(f.store.getOutreach(f.draft.id)?.status, "READY_TO_SEND");
      assert.equal(f.store.getOutreach(f.draft.id)?.sentAt, null);
      await assert.rejects(f.sending.sendTest(recipient, id, sender), /already been submitted/);
      assert.equal(calls, 1);
    } finally { f.db.close(); }
  });

  it("blocks a changed Gmail account and preserves interrupted sends as uncertain", async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return success(); });
    try {
      await assert.rejects(f.sending.sendApproved(f.draft.id, { ...f.expected, fromEmail: "other@example.com" }), /account changed/);
      const delivery = f.store.beginEmailDelivery({ ...f.expected, kind: "OUTREACH", outreachId: f.draft.id });
      f.store.markDeliverySending(delivery.id);
      assert.equal(f.store.recoverInterruptedDeliveries(), 1);
      assert.equal(f.store.getEmailDelivery(delivery.id)?.status, "UNCERTAIN");
      await assert.rejects(f.sending.sendApproved(f.draft.id, f.expected), /already sending/);
      assert.equal(calls, 0);
    } finally { f.db.close(); }
  });

  it("rejects MIME header injection and multiple recipients", () => {
    const message = { id: randomUUID(), fromEmail: sender, toEmail: recipient, subject: "Hello", body: "Test" };
    assert.throws(() => composeMessage({ ...message, toEmail: `${recipient}, victim@example.com` }), /one valid email/);
    assert.throws(() => composeMessage({ ...message, subject: "Hello\r\nBcc: victim@example.com" }), /no newlines/);
    const mime = Buffer.from(composeMessage({ ...message, subject: "Workspaces → messaging" }), "base64url").toString("utf8");
    assert.match(mime, /Subject: =\?UTF-8\?B\?/);
    assert.match(mime, /Content-Transfer-Encoding: base64/);
  });
});

describe("Gmail OAuth", () => {
  it("uses send-only scope, offline access, PKCE, cookie-bound state, and one-time callbacks", async () => {
    let calls = 0;
    const tokens = new MemoryTokens();
    const mock: typeof fetch = async (url, init) => {
      calls++;
      if (String(url).includes("/token")) {
        assert.ok(String(init?.body).includes("code_verifier="));
        return Response.json({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600,
          scope: `${GMAIL_SEND_SCOPE} openid email` });
      }
      assert.equal(String(url), "https://openidconnect.googleapis.com/v1/userinfo");
      return Response.json({ email: sender, email_verified: true });
    };
    const client = new GmailClient(config, tokens, mock);
    const authorization = client.beginAuthorization();
    const url = new URL(authorization.url);
    assert.equal(url.searchParams.get("access_type"), "offline");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("scope"), `${GMAIL_SEND_SCOPE} openid email`);
    await assert.rejects(client.finishAuthorization("code", authorization.state, "wrong-cookie"), /could not be verified/);
    assert.equal(calls, 0);
    assert.equal(await client.finishAuthorization("code", authorization.state, authorization.state), sender);
    assert.equal(client.connectedEmail(), sender);
    await assert.rejects(client.finishAuthorization("code", authorization.state, authorization.state), /could not be verified/);
    assert.equal(calls, 2);
  });

  it("rejects a different sender account and missing send permission", async () => {
    for (const permission of [true, false]) {
      const tokens = new MemoryTokens();
      const mock: typeof fetch = async (url) => String(url).includes("/token")
        ? Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: permission ? GMAIL_SEND_SCOPE : "email" })
        : Response.json({ email: "other@example.com", email_verified: true });
      const client = new GmailClient(config, tokens, mock);
      const auth = client.beginAuthorization();
      await assert.rejects(client.finishAuthorization("code", auth.state, auth.state),
        permission ? /does not match/ : /send permission/);
      assert.equal(tokens.load(), undefined);
    }
  });

  it("refreshes expired tokens before dispatch and does not attempt a send on refresh failure", async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return Response.json({}, { status: 400 }); });
    try {
      f.tokens.value!.expiresAt = 0;
      await assert.rejects(f.sending.sendApproved(f.draft.id, f.expected), /authorization failed/);
      assert.equal(calls, 1);
      assert.equal(f.store.listEmailDeliveries().length, 0);
    } finally { f.db.close(); }
  });

  it("writes credentials with owner-only permissions and clears them on disconnect", () => {
    const directory = mkdtempSync(join(tmpdir(), "outbound-gmail-token-"));
    const filename = join(directory, "gmail-oauth.json");
    try {
      const tokens = new FileTokenStore(filename);
      tokens.save(savedTokens());
      assert.equal(statSync(filename).mode & 0o777, 0o600);
      assert.equal(tokens.load()?.email, sender);
      tokens.clear();
      assert.equal(tokens.load(), undefined);
    } finally { rmSync(directory, { recursive: true }); }
  });
});
