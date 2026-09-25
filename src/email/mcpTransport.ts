import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EmailMessage, EmailTransport, EmailTransportResult, EmailTransportSession } from "./transport.js";
import { EmailTransportError } from "./transport.js";

export interface McpEmailConfig {
  url: string;
  redirectUri: string;
  expectedSender: string;
  profileTool?: string;
  sendTool?: string;
  accountId?: string;
  scopes?: string[];
}

export interface McpEmailTokens {
  clientId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenEndpoint: string;
  revocationEndpoint?: string;
}

export interface McpTokenStore {
  load(): McpEmailTokens | undefined;
  save(tokens: McpEmailTokens): void;
  clear(): void;
}

export class FileMcpTokenStore implements McpTokenStore {
  constructor(private readonly filename: string) {}
  load(): McpEmailTokens | undefined {
    if (!existsSync(this.filename)) return undefined;
    try {
      const value = JSON.parse(readFileSync(this.filename, "utf8")) as McpEmailTokens;
      if (!value.clientId || !value.email || !value.accessToken || !value.refreshToken
        || !value.tokenEndpoint || !Number.isFinite(value.expiresAt)) throw new Error("Invalid token file");
      return value;
    } catch { throw new Error("MCP email credentials could not be read. Reconnect the email account."); }
  }
  save(tokens: McpEmailTokens): void {
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomBytes(8).toString("hex")}.json`;
    try {
      writeFileSync(temporary, JSON.stringify(tokens), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.filename);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  clear(): void { if (existsSync(this.filename)) unlinkSync(this.filename); }
}

interface McpTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
  _meta?: Record<string, unknown>;
}
interface McpResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
interface PendingAuthorization {
  verifier: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  expiresAt: number;
}

const protocolVersion = "2025-06-18";
const defaultScopes = ["profile", "mail:read", "mail:send"];

export class McpEmailTransport implements EmailTransport {
  readonly id = "mcp";
  readonly label = "Custom Mail MCP";
  private nextId = 1;
  private readonly pending = new Map<string, PendingAuthorization>();
  private refreshing?: Promise<McpEmailTokens>;

  constructor(
    private readonly config: McpEmailConfig,
    private readonly tokens: McpTokenStore,
    private readonly request: typeof fetch = fetch,
  ) {}

  configured(): boolean {
    return this.isHttps(this.config.url) && !!this.config.redirectUri && !!this.config.expectedSender;
  }
  sendConfigured(): boolean { return !!this.config.sendTool; }
  connectedEmail(): string | undefined {
    const saved = this.tokens.load();
    return this.configured() && saved?.email.toLowerCase() === this.config.expectedSender.toLowerCase()
      ? saved.email : undefined;
  }
  async inspectTools(): Promise<Array<{ name: string; inputFields: string[]; profile: boolean }>> {
    let saved = this.tokens.load();
    if (!saved) return [];
    if (saved.expiresAt <= Date.now() + 60_000) saved = await this.refresh(saved);
    return (await this.listTools(saved.accessToken)).map((tool) => ({ name: tool.name,
      inputFields: Object.keys(tool.inputSchema?.properties ?? {}),
      profile: tool._meta?.["openai/profile"] === true }));
  }

  async beginAuthorization(): Promise<{ url: string; state: string }> {
    if (!this.configured()) throw new Error("Set MCP_EMAIL_SENDER_EMAIL and a valid HTTPS MCP_EMAIL_URL, then restart.");
    for (const [key, value] of this.pending) if (value.expiresAt < Date.now()) this.pending.delete(key);
    const protectedMetadata = await this.getJson(new URL("/.well-known/oauth-protected-resource", this.config.url).href);
    const resource = this.requireUrl(protectedMetadata.resource, "OAuth resource");
    if (resource !== this.config.url) throw new Error("MCP OAuth resource metadata does not match MCP_EMAIL_URL.");
    const authorizationServers = protectedMetadata.authorization_servers;
    if (!Array.isArray(authorizationServers) || typeof authorizationServers[0] !== "string") {
      throw new Error("MCP server did not advertise an OAuth authorization server.");
    }
    const issuer = this.requireUrl(authorizationServers[0], "OAuth issuer");
    const metadata = await this.getJson(new URL("/.well-known/oauth-authorization-server", issuer).href);
    const authorizationEndpoint = this.requireUrl(metadata.authorization_endpoint, "authorization endpoint");
    const tokenEndpoint = this.requireUrl(metadata.token_endpoint, "token endpoint");
    const registrationEndpoint = this.requireUrl(metadata.registration_endpoint, "registration endpoint");
    const pkce = metadata.code_challenge_methods_supported;
    if (!Array.isArray(pkce) || !pkce.includes("S256")) throw new Error("MCP OAuth server does not support PKCE S256.");

    const registration = await this.request(registrationEndpoint, { method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_name: "Outbound Agent local dashboard", redirect_uris: [this.config.redirectUri],
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        token_endpoint_auth_method: "none" }),
    });
    if (!registration.ok) throw new Error(`MCP OAuth client registration failed (HTTP ${registration.status}).`);
    const registered = await registration.json() as Record<string, unknown>;
    if (typeof registered.client_id !== "string" || !registered.client_id) {
      throw new Error("MCP OAuth registration returned no client ID.");
    }

    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    this.pending.set(state, { verifier, clientId: registered.client_id, tokenEndpoint,
      revocationEndpoint: typeof metadata.revocation_endpoint === "string"
        ? this.requireUrl(metadata.revocation_endpoint, "revocation endpoint") : undefined,
      expiresAt: Date.now() + 600_000 });
    const url = new URL(authorizationEndpoint);
    url.search = new URLSearchParams({ response_type: "code", client_id: registered.client_id,
      redirect_uri: this.config.redirectUri, scope: this.scopes().join(" "), state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256", resource: this.config.url }).toString();
    return { url: url.href, state };
  }

  async finishAuthorization(code: string, state: string, cookieState: string): Promise<string> {
    const pending = this.pending.get(state);
    if (!state || state !== cookieState || !pending || pending.expiresAt < Date.now()) {
      throw new Error("MCP email connection expired or could not be verified. Start Connect again.");
    }
    this.pending.delete(state);
    const token = await this.exchange(pending.tokenEndpoint, { grant_type: "authorization_code", code,
      client_id: pending.clientId, redirect_uri: this.config.redirectUri, code_verifier: pending.verifier,
      resource: this.config.url });
    if (typeof token.refresh_token !== "string" || !token.refresh_token) {
      throw new Error("MCP OAuth did not grant refresh access. Reconnect the account.");
    }
    const accessToken = token.access_token as string;
    const profileTool = await this.resolveProfileTool(accessToken);
    const profile = await this.callTool(profileTool, {}, accessToken);
    const email = this.findString(profile, ["email", "emailAddress", "email_address"]);
    if (!email) throw new Error("The MCP profile tool did not return an email address.");
    if (email.toLowerCase() !== this.config.expectedSender.toLowerCase()) {
      throw new Error(`Connect ${this.config.expectedSender}; the authenticated MCP mailbox does not match.`);
    }
    this.tokens.save({ clientId: pending.clientId, email: this.config.expectedSender,
      accessToken, refreshToken: token.refresh_token, expiresAt: Date.now() + (token.expires_in as number) * 1000,
      tokenEndpoint: pending.tokenEndpoint, revocationEndpoint: pending.revocationEndpoint });
    return this.config.expectedSender;
  }

  async authorizedSession(): Promise<EmailTransportSession> {
    if (!this.config.sendTool) throw new Error("Set MCP_EMAIL_SEND_TOOL after inspecting the connected server's tools.");
    let saved = this.tokens.load();
    if (!this.configured() || !saved) throw new Error("Connect Custom Mail MCP before sending.");
    if (saved.email.toLowerCase() !== this.config.expectedSender.toLowerCase()) {
      throw new Error("Connected MCP mailbox does not match MCP_EMAIL_SENDER_EMAIL.");
    }
    if (saved.expiresAt <= Date.now() + 60_000) saved = await this.refresh(saved);
    const profileTool = await this.resolveProfileTool(saved.accessToken);
    const profile = await this.callTool(profileTool, {}, saved.accessToken);
    const email = this.findString(profile, ["email", "emailAddress", "email_address"]);
    if (!email || email.toLowerCase() !== this.config.expectedSender.toLowerCase()) {
      throw new Error("The connected MCP mailbox could not be verified. Reconnect before sending.");
    }
    const accountId = await this.resolveAccountId(saved.accessToken);
    return { email: this.config.expectedSender, accessToken: saved.accessToken, accountId };
  }

  async send(session: EmailTransportSession, message: EmailMessage): Promise<EmailTransportResult> {
    if (!this.config.sendTool) throw new EmailTransportError("MCP send tool is not configured.", false);
    if (session.email.toLowerCase() !== message.fromEmail.toLowerCase()) {
      throw new EmailTransportError("Connected MCP mailbox changed. Review the send confirmation again.", false);
    }
    if (!session.accountId) throw new EmailTransportError("MCP mail account could not be resolved.", false);
    const result = await this.callTool(this.config.sendTool, { accountId: session.accountId,
      to: message.toEmail, subject: message.subject, body: message.body, idempotency_key: message.id },
    session.accessToken, ["accountId", "to", "subject", "body|text"]);
    const messageId = this.findString(result, ["messageId", "message_id", "id"]);
    const threadId = this.findString(result, ["threadId", "thread_id"]);
    // A successful tools/call is the provider acknowledgement. Some MCP mail
    // servers intentionally return no provider identifiers after send_mail.
    // Preserve a stable local receipt without pretending it is a message ID.
    return { receiptId: messageId ?? `mcp-ack:${message.id}`, messageId, threadId };
  }

  async disconnect(): Promise<void> {
    const saved = this.tokens.load();
    if (saved?.revocationEndpoint) {
      const response = await this.request(saved.revocationEndpoint, { method: "POST", signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: saved.refreshToken, client_id: saved.clientId }) });
      if (!response.ok && response.status !== 400) throw new Error("Could not revoke MCP email access. Try disconnecting again.");
    }
    this.tokens.clear();
  }

  private scopes(): string[] { return this.config.scopes?.length ? this.config.scopes : defaultScopes; }
  private async refresh(saved: McpEmailTokens): Promise<McpEmailTokens> {
    if (!this.refreshing) this.refreshing = (async () => {
      const token = await this.exchange(saved.tokenEndpoint, { grant_type: "refresh_token",
        refresh_token: saved.refreshToken, client_id: saved.clientId, resource: this.config.url });
      const current = { ...saved, accessToken: token.access_token as string,
        refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : saved.refreshToken,
        expiresAt: Date.now() + (token.expires_in as number) * 1000 };
      this.tokens.save(current); return current;
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  private async exchange(endpoint: string, parameters: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.request(endpoint, { method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(parameters) });
    if (!response.ok) throw new Error(`MCP OAuth token exchange failed (HTTP ${response.status}).`);
    const token = await response.json() as Record<string, unknown>;
    if (typeof token.access_token !== "string" || typeof token.expires_in !== "number" || token.expires_in <= 0) {
      throw new Error("MCP OAuth returned incomplete credentials.");
    }
    if (typeof token.scope === "string") {
      const granted = new Set(token.scope.split(/\s+/));
      if (this.scopes().some((scope) => !granted.has(scope))) throw new Error("MCP OAuth did not grant the requested permissions.");
    }
    return token;
  }

  private async resolveProfileTool(token: string): Promise<string> {
    const tools = await this.listTools(token);
    if (this.config.profileTool) {
      if (!tools.some(({ name }) => name === this.config.profileTool)) {
        throw new Error(`Configured MCP profile tool ${this.config.profileTool} is not advertised.`);
      }
      return this.config.profileTool;
    }
    const annotated = tools.filter((tool) => tool._meta?.["openai/profile"] === true);
    if (annotated.length === 1) return annotated[0]!.name;
    throw new Error(`Set MCP_EMAIL_PROFILE_TOOL to the authenticated profile tool. Advertised tools: ${tools.map(({ name }) => name).join(", ") || "none"}.`);
  }

  private async resolveAccountId(token: string): Promise<string> {
    if (this.config.accountId) return this.config.accountId;
    const result = await this.callTool("list_mail_accounts", {}, token);
    const candidates = this.accountCandidates(result);
    const matching = candidates.filter(({ email }) => email?.toLowerCase() === this.config.expectedSender.toLowerCase());
    if (matching.length === 1) return matching[0]!.id;
    if (candidates.length === 1) return candidates[0]!.id;
    const summary = candidates.map(({ id, email }) => `${id}${email ? ` (${email})` : ""}`).join(", ");
    throw new Error(`Set MCP_EMAIL_ACCOUNT_ID to the correct mailbox account ID. Available accounts: ${summary || "none"}.`);
  }

  private accountCandidates(result: McpResult): Array<{ id: string; email?: string }> {
    const candidates: Array<{ id: string; email?: string }> = [];
    const seen = new Set<unknown>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const record = value as Record<string, unknown>;
      const id = [record.accountId, record.account_id, record.id].find((item) => typeof item === "string");
      const email = [record.email, record.address, record.username].find((item) => typeof item === "string");
      if (typeof id === "string" && !candidates.some((candidate) => candidate.id === id)) {
        candidates.push({ id, email: typeof email === "string" ? email : undefined });
      }
      Object.values(record).forEach(visit);
    };
    this.resultSources(result).forEach(visit);
    return candidates;
  }

  private async listTools(token: string): Promise<McpTool[]> {
    const session = await this.initialize(token);
    const listed = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} }, token, session);
    return ((listed.value.result as { tools?: McpTool[] } | undefined)?.tools ?? []);
  }
  private async callTool(name: string, args: Record<string, unknown>, token: string,
    required: string[] = []): Promise<McpResult> {
    const session = await this.initialize(token);
    const listed = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} }, token, session);
    const tools = ((listed.value.result as { tools?: McpTool[] } | undefined)?.tools ?? []);
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new EmailTransportError(`MCP tool ${name} is not advertised.`, false);
    const properties = tool.inputSchema?.properties ?? {};
    const missing = required.filter((field) => !field.split("|").some((alternative) => alternative in properties));
    if (missing.length) throw new EmailTransportError(
      `MCP tool ${name} is incompatible with the email adapter (missing ${missing.join(", ")}).`, false);
    const callArguments = { ...args };
    if (!("body" in properties) && "text" in properties && "body" in callArguments) {
      callArguments.text = callArguments.body; delete callArguments.body;
    }
    const toSchema = properties.to;
    if (typeof callArguments.to === "string" && toSchema && typeof toSchema === "object"
      && (toSchema as Record<string, unknown>).type === "array") callArguments.to = [callArguments.to];
    if (!("idempotency_key" in properties)) delete callArguments.idempotency_key;
    const called = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/call",
      params: { name, arguments: callArguments } }, token, session);
    const result = (called.value.result ?? {}) as McpResult;
    if (result.isError) {
      const detail = result.content?.find(({ text }) => text)?.text ?? "MCP tool rejected the request.";
      throw new EmailTransportError(detail, false);
    }
    return result;
  }
  private async initialize(token: string): Promise<string | undefined> {
    const initialized = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "initialize", params: {
      protocolVersion, capabilities: {}, clientInfo: { name: "outbound-agent", version: "1.0.0" },
    } }, token);
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, token, initialized.sessionId, true);
    return initialized.sessionId;
  }
  private async post(payload: Record<string, unknown>, token: string, sessionId?: string, allowEmpty = false):
    Promise<{ value: Record<string, unknown>; sessionId?: string }> {
    let response: Response;
    try {
      response = await this.request(this.config.url, { method: "POST", signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream",
          "Content-Type": "application/json", "MCP-Protocol-Version": protocolVersion,
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) }, body: JSON.stringify(payload) });
    } catch { throw new EmailTransportError("Could not reach the MCP email server.", true); }
    if (!response.ok) throw new EmailTransportError(`MCP request failed (HTTP ${response.status}).`,
      response.status >= 500 || response.status === 408 || response.status === 429);
    if (allowEmpty && response.status === 202) return { value: {}, sessionId };
    const body = await response.text();
    if (!body && allowEmpty) return { value: {}, sessionId };
    let value: Record<string, unknown>;
    try {
      value = response.headers.get("content-type")?.includes("text/event-stream")
        ? this.parseSse(body) : JSON.parse(body) as Record<string, unknown>;
    } catch (error) { throw new EmailTransportError(`Invalid MCP response: ${String(error)}`, true); }
    if (value.error && typeof value.error === "object") {
      const rpcError = value.error as { code?: unknown; message?: unknown };
      const code = typeof rpcError.code === "number" ? ` ${rpcError.code}` : "";
      const message = typeof rpcError.message === "string" ? rpcError.message : "MCP JSON-RPC error";
      throw new EmailTransportError(`MCP error${code}: ${message}`, false);
    }
    return { value, sessionId: response.headers.get("mcp-session-id") ?? sessionId };
  }
  private parseSse(body: string): Record<string, unknown> {
    const data = body.split(/\r?\n/).filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim()).filter(Boolean).at(-1);
    if (!data) throw new Error("SSE response contained no data event");
    return JSON.parse(data) as Record<string, unknown>;
  }
  private findString(result: McpResult, keys: string[]): string | undefined {
    for (const source of this.resultSources(result)) if (source && typeof source === "object") for (const key of keys) {
      const value = (source as Record<string, unknown>)[key];
      if (typeof value === "string" && value) return value;
    }
    return undefined;
  }
  private resultSources(result: McpResult): unknown[] {
    const sources: unknown[] = [result.structuredContent];
    for (const item of result.content ?? []) if (item.type === "text" && item.text) {
      try { sources.push(JSON.parse(item.text)); } catch { /* Human-readable text is not structured evidence. */ }
    }
    return sources;
  }
  private async getJson(url: string): Promise<Record<string, unknown>> {
    const response = await this.request(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`OAuth discovery failed (HTTP ${response.status}).`);
    return response.json() as Promise<Record<string, unknown>>;
  }
  private requireUrl(value: unknown, label: string): string {
    if (typeof value !== "string" || !this.isHttps(value)) throw new Error(`MCP ${label} must be an HTTPS URL.`);
    return new URL(value).href.replace(/\/$/, "");
  }
  private isHttps(value: string): boolean { try { return new URL(value).protocol === "https:"; } catch { return false; } }
}
