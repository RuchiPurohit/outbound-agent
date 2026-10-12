import { randomUUID } from "node:crypto";
import type { OutboundStore } from "../db/store.js";
import type { EmailDelivery } from "../db/types.js";
import { followUpSubject } from "../db/store.js";
import type { EmailTransport, EmailTransportSession, ReplySource } from "../email/transport.js";
import { EmailTransportError } from "../email/transport.js";

export const TEST_SUBJECT = "Outbound Agent — email transport test";
export const TEST_BODY = "This is a test email sent manually from the local Outbound Agent dashboard.\n\nNo prospect was contacted, and no campaign outreach state was changed.\n\nRuchi";
export const TEST_FOLLOW_UP_BODY = "This is a test follow-up sent manually from the local Outbound Agent dashboard.\n\nIt should appear in the same thread as the earlier test email. No prospect was contacted.\n\nRuchi";

export function validateEmail(value: string): string {
  if (value.length > 254 || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)
    || value.includes("..")) throw new Error("Enter one valid email address, without a display name or extra recipients.");
  return value;
}

const messageIdFor = (id: string): string => `<${id}@outbound-agent.local>`;

export function composeMessage(input: {
  id: string; fromEmail: string; toEmail: string; subject: string; body: string; inReplyTo?: string;
}): string {
  validateEmail(input.fromEmail); validateEmail(input.toEmail);
  if (!/^[a-f0-9-]{36}$/i.test(input.id)) throw new Error("Invalid message ID");
  if (input.inReplyTo !== undefined && !/^[a-f0-9-]{36}$/i.test(input.inReplyTo)) throw new Error("Invalid reply message ID");
  if (!input.subject.trim() || input.subject.length > 250 || /[\r\n\x00]/.test(input.subject)) {
    throw new Error("Email subject must be nonempty, under 250 characters, and contain no newlines.");
  }
  if (!input.body.trim() || Buffer.byteLength(input.body) > 100_000) throw new Error("Email body is empty or too large");
  const chunks: string[] = [];
  let chunk = "";
  for (const character of input.subject) {
    if (Buffer.byteLength(chunk + character) > 42) { chunks.push(chunk); chunk = ""; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  const subject = chunks.map((item) => `=?UTF-8?B?${Buffer.from(item).toString("base64")}?=`).join("\r\n ");
  const body = Buffer.from(input.body, "utf8").toString("base64").match(/.{1,76}/g)!.join("\r\n");
  return Buffer.from([
    `From: ${input.fromEmail}`, `To: ${input.toEmail}`, `Subject: ${subject}`,
    `Message-ID: ${messageIdFor(input.id)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${messageIdFor(input.inReplyTo)}`, `References: ${messageIdFor(input.inReplyTo)}`] : []),
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64", "", body, "",
  ].join("\r\n"), "utf8").toString("base64url");
}

export class EmailSending {
  constructor(private readonly store: OutboundStore, private readonly transport: EmailTransport) {}

  async sendApproved(outreachId: number, expected: {
    fromEmail: string; toEmail: string; subject: string; body: string;
  }): Promise<EmailDelivery> {
    const outreach = this.store.assertReadyToSend(outreachId);
    let replyTo: ReplySource | undefined;
    if (outreach.followUpOf !== null) {
      const parent = this.store.listEmailDeliveries()
        .find((item) => item.outreachId === outreach.followUpOf && item.status === "SENT");
      if (!parent) throw new Error("The first-touch delivery record was not found; the follow-up cannot be threaded.");
      // MCP follow-ups derive recipients from the first email, so they must match the approved recipient.
      if (parent.toEmail.toLowerCase() !== expected.toEmail.toLowerCase()) {
        throw new Error(`The first email went to ${parent.toEmail}, but this follow-up is approved for ${expected.toEmail}. Return it to draft and review the recipient.`);
      }
      replyTo = this.replySource(parent);
    }
    const session = await this.transport.authorizedSession();
    if (session.email !== expected.fromEmail) throw new Error("Connected email account changed. Review the send confirmation again.");
    return this.dispatch({ ...expected, replyTo, outreachId, kind: "OUTREACH", id: randomUUID() }, session);
  }

  async sendTestFollowUp(parentDeliveryId: string, requestId: string, expectedSender: string): Promise<EmailDelivery> {
    const parent = this.store.getEmailDelivery(parentDeliveryId);
    if (!parent || parent.kind !== "TEST" || parent.status !== "SENT") {
      throw new Error("Choose a sent test email to follow up.");
    }
    const session = await this.transport.authorizedSession();
    if (session.email !== expectedSender) throw new Error("Connected email account changed. Reload the test form.");
    return this.dispatch({ id: requestId, kind: "TEST", fromEmail: session.email, toEmail: parent.toEmail,
      subject: followUpSubject(parent.subject), body: TEST_FOLLOW_UP_BODY, replyTo: this.replySource(parent) }, session);
  }

  // A follow-up continues the thread on the transport that delivered the original email.
  private replySource(parent: EmailDelivery): ReplySource {
    if (parent.provider !== this.transport.id) {
      throw new Error(`The original email was sent with ${parent.provider}; switch EMAIL_TRANSPORT back to it to send the follow-up in the same thread.`);
    }
    const threadId = (parent.outreachId === null ? undefined : this.store.getOutreach(parent.outreachId)?.gmailThreadId)
      ?? parent.gmailThreadId ?? undefined;
    return { deliveryId: parent.id, providerMessageId: parent.gmailMessageId ?? undefined, threadId,
      sentCopy: parent.sentFolder && parent.sentUid ? { folder: parent.sentFolder, uid: parent.sentUid } : undefined,
      toEmail: parent.toEmail, subject: parent.subject, sentAt: parent.finishedAt ?? parent.createdAt };
  }

  async sendTest(toEmail: string, requestId: string, expectedSender: string): Promise<EmailDelivery> {
    const session = await this.transport.authorizedSession();
    if (session.email !== expectedSender) throw new Error("Connected email account changed. Reload the test form.");
    return this.dispatch({ id: requestId, kind: "TEST", fromEmail: session.email,
      toEmail, subject: TEST_SUBJECT, body: TEST_BODY }, session);
  }

  private async dispatch(input: {
    id: string; outreachId?: number; kind: EmailDelivery["kind"];
    fromEmail: string; toEmail: string; subject: string; body: string; replyTo?: ReplySource;
  }, session: EmailTransportSession): Promise<EmailDelivery> {
    const raw = composeMessage({ ...input, inReplyTo: input.replyTo?.deliveryId });
    const delivery = this.store.beginEmailDelivery({ ...input, provider: this.transport.id });
    this.store.markDeliverySending(delivery.id);
    try {
      const result = await this.transport.send(session, { ...input, raw });
      return this.store.completeEmailDelivery(delivery.id, result);
    } catch (error) {
      const uncertain = !(error instanceof EmailTransportError) || error.uncertain;
      const message = error instanceof EmailTransportError ? error.message
        : "Delivery could not be recorded reliably. Check the sender's Sent folder; retry is blocked.";
      this.store.failEmailDelivery(delivery.id, uncertain ? "UNCERTAIN" : "FAILED", message);
      throw new Error(message);
    }
  }
}

// Compatibility export for existing callers while the provider-neutral name rolls out.
export { EmailSending as GmailSending };
