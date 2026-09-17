import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const SCOPES = [GMAIL_SEND_SCOPE, "openid", "email"];

export interface GmailConfig { clientId: string; clientSecret: string; redirectUri: string; expectedSender?: string }
export interface GmailTokens {
  clientId: string; email: string; accessToken: string; refreshToken: string; expiresAt: number;
}
export interface TokenStore { load(): GmailTokens | undefined; save(tokens: GmailTokens): void; clear(): void }

export class FileTokenStore implements TokenStore {
  constructor(private readonly filename: string) {}
  load(): GmailTokens | undefined {
    if (!existsSync(this.filename)) return undefined;
    try {
      const token = JSON.parse(readFileSync(this.filename, "utf8")) as GmailTokens;
      if (!token.clientId || !token.email || !token.accessToken || !token.refreshToken
        || !Number.isFinite(token.expiresAt)) throw new Error("Invalid token file");
      return token;
    } catch { throw new Error("Gmail credentials could not be read. Reconnect Gmail."); }
  }
  save(tokens: GmailTokens): void {
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomBytes(8).toString("hex")}.json`;
    try {
      writeFileSync(temporary, JSON.stringify(tokens), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.filename);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  clear(): void { if (existsSync(this.filename)) unlinkSync(this.filename); }
}

export class GmailSendError extends Error {
  constructor(message: string, public readonly uncertain: boolean) { super(message); }
}

export class GmailClient {
  private readonly pending = new Map<string, { verifier: string; expiresAt: number }>();
  private refreshing?: Promise<GmailTokens>;
  constructor(
    private readonly config: GmailConfig,
    private readonly tokens: TokenStore,
    private readonly request: typeof fetch = fetch,
  ) {}

  configured(): boolean { return !!this.config.clientId && !!this.config.clientSecret; }
  connectedEmail(): string | undefined {
    const token = this.tokens.load();
    return this.configured() && token?.clientId === this.config.clientId
      && (!this.config.expectedSender || token.email === this.config.expectedSender) ? token.email : undefined;
  }

  beginAuthorization(): { url: string; state: string } {
    if (!this.configured()) throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart the dashboard.");
    for (const [key, value] of this.pending) if (value.expiresAt < Date.now()) this.pending.delete(key);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    this.pending.set(state, { verifier, expiresAt: Date.now() + 600_000 });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri,
      response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    }).toString();
    return { url: url.href, state };
  }

  async finishAuthorization(code: string, state: string, cookieState: string): Promise<string> {
    const pending = this.pending.get(state);
    if (!state || state !== cookieState || !pending || pending.expiresAt < Date.now()) {
      throw new Error("Gmail connection expired or could not be verified. Start Connect Gmail again.");
    }
    this.pending.delete(state);
    const token = await this.exchange({ code, code_verifier: pending.verifier,
      redirect_uri: this.config.redirectUri, grant_type: "authorization_code" });
    if (typeof token.scope !== "string" || !token.scope.split(" ").includes(GMAIL_SEND_SCOPE)) {
      throw new Error("Gmail send permission was not granted. Reconnect and grant send permission.");
    }
    if (typeof token.refresh_token !== "string") throw new Error("Offline Gmail access was not granted. Connect again.");
    const response = await this.request("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("Could not verify the connected Google account. Connect again.");
    const identity = await response.json() as { email?: string; email_verified?: boolean };
    if (!identity.email || identity.email_verified !== true) throw new Error("Google did not provide a verified account email.");
    if (this.config.expectedSender && identity.email !== this.config.expectedSender) {
      throw new Error(`Connect ${this.config.expectedSender}; the chosen Google account does not match the configured sender.`);
    }
    this.tokens.save({ clientId: this.config.clientId, email: identity.email,
      accessToken: token.access_token as string, refreshToken: token.refresh_token,
      expiresAt: Date.now() + (token.expires_in as number) * 1000,
    });
    return identity.email;
  }

  private async exchange(parameters: Record<string, string>): Promise<Record<string, unknown>> {
    if (!this.configured()) throw new Error("Gmail OAuth credentials are not configured");
    const response = await this.request("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...parameters, client_id: this.config.clientId, client_secret: this.config.clientSecret }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Google authorization failed (HTTP ${response.status}). Reconnect Gmail.`);
    const token = await response.json() as Record<string, unknown>;
    if (typeof token.access_token !== "string" || typeof token.expires_in !== "number" || token.expires_in <= 0) {
      throw new Error("Google returned incomplete authorization credentials. Reconnect Gmail.");
    }
    return token;
  }

  async authorizedSession(): Promise<{ email: string; accessToken: string }> {
    const saved = this.tokens.load();
    if (!this.configured() || !saved || saved.clientId !== this.config.clientId) throw new Error("Connect Gmail before sending.");
    if (this.config.expectedSender && saved.email !== this.config.expectedSender) {
      throw new Error("Connected account does not match GMAIL_SENDER_EMAIL. Reconnect the correct sender.");
    }
    if (saved.expiresAt > Date.now() + 60_000) return { email: saved.email, accessToken: saved.accessToken };
    if (!this.refreshing) {
      this.refreshing = (async () => {
        const refreshed = await this.exchange({ grant_type: "refresh_token", refresh_token: saved.refreshToken });
        const current = { ...saved, accessToken: refreshed.access_token as string,
          expiresAt: Date.now() + (refreshed.expires_in as number) * 1000 };
        this.tokens.save(current);
        return current;
      })().finally(() => { this.refreshing = undefined; });
    }
    const current = await this.refreshing;
    return { email: current.email, accessToken: current.accessToken };
  }

  async send(session: { accessToken: string }, raw: string): Promise<{ messageId: string; threadId: string }> {
    let response: Response;
    try {
      response = await this.request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST", headers: { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw }), signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new GmailSendError("Gmail did not confirm delivery. Check Gmail Sent; automatic retry is blocked.", true); }
    if (!response.ok) {
      const uncertain = response.status >= 500 || response.status === 408;
      throw new GmailSendError(`Gmail send failed (HTTP ${response.status}). ${uncertain
        ? "Delivery may have succeeded. Check Gmail Sent; retry is blocked."
        : "The request was rejected; nothing was confirmed sent. You may retry manually after fixing the issue."}`, uncertain);
    }
    try {
      const message = await response.json() as { id?: string; threadId?: string };
      if (typeof message.id !== "string" || !message.id || typeof message.threadId !== "string" || !message.threadId) throw new Error("Incomplete response");
      return { messageId: message.id, threadId: message.threadId };
    } catch { throw new GmailSendError("Gmail returned an incomplete result. Check Gmail Sent; retry is blocked.", true); }
  }

  async disconnect(): Promise<void> {
    const saved = this.tokens.load();
    if (saved) {
      const response = await this.request("https://oauth2.googleapis.com/revoke", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: saved.refreshToken }), signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok && response.status !== 400) throw new Error("Could not revoke Google access. Try disconnecting again.");
    }
    this.tokens.clear();
  }
}
