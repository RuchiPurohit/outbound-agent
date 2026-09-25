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
}

export interface EmailTransportResult {
  receiptId: string;
  messageId?: string;
  threadId?: string;
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
