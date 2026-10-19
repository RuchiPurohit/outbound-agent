export interface EmailTransportSession {
  email: string;
  accessToken: string;
  accountId?: string;
}

export interface EmailMessage {
  id: string;
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  raw: string;
  /** Set for a follow-up: the delivered email this message replies to. */
  replyTo?: ReplySource;
}

/** What each provider needs to continue a delivered email's thread. */
export interface ReplySource {
  /** Local delivery ID, also the local part of the Message-ID this app composed for it. */
  deliveryId: string;
  /** Provider message ID; for MCP mail this is the RFC Message-ID of the sent email. */
  providerMessageId?: string;
  threadId?: string;
  sentCopy?: { folder: string; uid: number };
  toEmail: string;
  subject: string;
  sentAt: string;
}

export interface EmailTransportResult {
  receiptId: string;
  messageId?: string;
  threadId?: string;
  sentCopy?: { folder: string; uid: number };
}

export interface EmailTransport {
  readonly id: string;
  readonly label: string;
  configured(): boolean;
  connectedEmail(): string | undefined;
  authorizedSession(): Promise<EmailTransportSession>;
  send(session: EmailTransportSession, message: EmailMessage): Promise<EmailTransportResult>;
}

export class EmailTransportError extends Error {
  constructor(message: string, public readonly uncertain: boolean) { super(message); }
}
