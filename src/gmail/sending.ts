import { randomUUID } from "node:crypto";
import type { OutboundStore } from "../db/store.js";
import type { EmailDelivery } from "../db/types.js";
import { GmailClient, GmailSendError } from "./client.js";

export const TEST_SUBJECT = "Outbound Agent — Gmail integration test";
export const TEST_BODY = "This is a test email sent manually from the local Outbound Agent dashboard.\n\nNo prospect was contacted, and no campaign outreach state was changed.\n\nRuchi";

export function validateEmail(value: string): string {
  if (value.length > 254 || !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)
    || value.includes("..")) throw new Error("Enter one valid email address, without a display name or extra recipients.");
  return value;
}

export function composeMessage(input: { id: string; fromEmail: string; toEmail: string; subject: string; body: string }): string {
  validateEmail(input.fromEmail); validateEmail(input.toEmail);
  if (!/^[a-f0-9-]{36}$/i.test(input.id)) throw new Error("Invalid message ID");
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
    `Message-ID: <${input.id}@outbound-agent.local>`, `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64", "", body, "",
  ].join("\r\n"), "utf8").toString("base64url");
}

export class GmailSending {
  constructor(private readonly store: OutboundStore, private readonly gmail: GmailClient) {}

  async sendApproved(outreachId: number, expected: {
    fromEmail: string; toEmail: string; subject: string; body: string;
  }): Promise<EmailDelivery> {
    this.store.assertReadyToSend(outreachId);
    const session = await this.gmail.authorizedSession();
    if (session.email !== expected.fromEmail) throw new Error("Connected Gmail account changed. Review the send confirmation again.");
    return this.dispatch({ ...expected, outreachId, kind: "OUTREACH", id: randomUUID() }, session);
  }

  async sendTest(toEmail: string, requestId: string, expectedSender: string): Promise<EmailDelivery> {
    const session = await this.gmail.authorizedSession();
    if (session.email !== expectedSender) throw new Error("Connected Gmail account changed. Reload the test form.");
    return this.dispatch({ id: requestId, kind: "TEST", fromEmail: session.email,
      toEmail, subject: TEST_SUBJECT, body: TEST_BODY }, session);
  }

  private async dispatch(input: {
    id: string; outreachId?: number; kind: EmailDelivery["kind"];
    fromEmail: string; toEmail: string; subject: string; body: string;
  }, session: { accessToken: string }): Promise<EmailDelivery> {
    const raw = composeMessage(input);
    const delivery = this.store.beginEmailDelivery(input);
    this.store.markDeliverySending(delivery.id);
    try {
      const result = await this.gmail.send(session, raw);
      return this.store.completeEmailDelivery(delivery.id, result);
    } catch (error) {
      const uncertain = !(error instanceof GmailSendError) || error.uncertain;
      const message = error instanceof GmailSendError ? error.message
        : "Delivery could not be recorded reliably. Check Gmail Sent; retry is blocked.";
      this.store.failEmailDelivery(delivery.id, uncertain ? "UNCERTAIN" : "FAILED", message);
      throw new Error(message);
    }
  }
}
