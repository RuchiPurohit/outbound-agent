import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FileMcpTokenStore, McpEmailTransport, type McpEmailTokens, type McpTokenStore } from "../src/email/mcpTransport.js";
import { EmailTransportError } from "../src/email/transport.js";

const endpoint = "https://mail.example/mcp";
const sender = "sender@example.com";
const redirectUri = "http://127.0.0.1:3000/gmail/callback";
const config = { url: endpoint, redirectUri, expectedSender: sender, sendTool: "send_email" };

class MemoryTokens implements McpTokenStore {
  constructor(public value?: McpEmailTokens) {}
  load() { return this.value; }
  save(value: McpEmailTokens) { this.value = value; }
  clear() { this.value = undefined; }
}

function mockServer(options: {
  profileEmail?: string; incompatibleSend?: boolean; omitSendIds?: boolean; sendRpcError?: boolean;
} = {}) {
  const calls: Array<{ url: string; payload?: Record<string, any> }> = [];
  const tools = [
    { name: "account_profile", inputSchema: { properties: {} }, _meta: { "openai/profile": true } },
    { name: "list_mail_accounts", inputSchema: { properties: {} } },
    { name: "send_email", inputSchema: { properties: options.incompatibleSend
      ? { recipient: {}, subject: {}, body: {} }
      : { accountId: {}, to: { type: "array", items: { type: "string" } },
        subject: {}, text: {}, idempotency_key: {} } } },
  ];
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    const payload = init?.body && String(init.body).startsWith("{")
      ? JSON.parse(String(init.body)) as Record<string, any> : undefined;
    calls.push({ url, payload });
    if (url.endsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: endpoint, authorization_servers: ["https://mail.example"] });
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) return Response.json({
      authorization_endpoint: "https://mail.example/authorize", token_endpoint: "https://mail.example/token",
      registration_endpoint: "https://mail.example/register", revocation_endpoint: "https://mail.example/revoke",
      code_challenge_methods_supported: ["S256"],
    });
    if (url.endsWith("/register")) return Response.json({ client_id: "dynamic-client" });
    if (url.endsWith("/token")) return Response.json({ access_token: "access", refresh_token: "refresh",
      expires_in: 3600, scope: "profile mail:read mail:send" });
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer access");
    if (payload?.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (payload?.method === "initialize") return Response.json({ jsonrpc: "2.0", id: payload.id,
      result: { protocolVersion: "2025-06-18", capabilities: {} } }, { headers: { "Mcp-Session-Id": "session" } });
    if (payload?.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: payload.id, result: { tools } });
    if (payload?.params?.name === "account_profile") return Response.json({ jsonrpc: "2.0", id: payload.id,
      result: { structuredContent: { email: options.profileEmail ?? sender } } });
    if (payload?.params?.name === "list_mail_accounts") return Response.json({ jsonrpc: "2.0", id: payload.id,
      result: { structuredContent: { accounts: [{ accountId: "account-1", email: sender }] } } });
    if (payload?.params?.name === "send_email") return options.sendRpcError
      ? Response.json({ jsonrpc: "2.0", id: payload.id, error: { code: -32602, message: "Invalid arguments" } })
      : Response.json({ jsonrpc: "2.0", id: payload.id,
        result: { structuredContent: options.omitSendIds ? {} : { messageId: "mcp-message", threadId: "mcp-thread" } } });
    throw new Error(`Unexpected request ${url}`);
  };
  return { request, calls };
}

describe("MCP email OAuth transport", () => {
  it("connects with DCR and PKCE, verifies the sender, and sends with stable IDs", async () => {
    const tokens = new MemoryTokens();
    const mock = mockServer();
    const transport = new McpEmailTransport(config, tokens, mock.request);
    const authorization = await transport.beginAuthorization();
    const url = new URL(authorization.url);
    assert.equal(url.origin + url.pathname, "https://mail.example/authorize");
    assert.equal(url.searchParams.get("client_id"), "dynamic-client");
    assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
    assert.equal(url.searchParams.get("resource"), endpoint);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("scope"), "profile mail:read mail:send");
    assert.ok(url.searchParams.get("code_challenge"));
    assert.equal(await transport.finishAuthorization("code", authorization.state, authorization.state), sender);
    assert.equal(transport.connectedEmail(), sender);
    assert.equal(tokens.value?.refreshToken, "refresh");

    const session = await transport.authorizedSession();
    const result = await transport.send(session, { id: "request-id", fromEmail: sender,
      toEmail: "prospect@example.com", subject: "Subject", body: "Body", raw: "unused" });
    assert.deepEqual(result, { receiptId: "mcp-message", messageId: "mcp-message", threadId: "mcp-thread" });
    const send = mock.calls.find(({ payload }) => payload?.params?.name === "send_email");
    assert.deepEqual(send?.payload?.params.arguments, { accountId: "account-1", to: ["prospect@example.com"],
      subject: "Subject", text: "Body", idempotency_key: "request-id" });
    await transport.disconnect();
    assert.equal(tokens.value, undefined);
  });

  it("records a successful acknowledgement when the MCP server omits provider IDs", async () => {
    const tokens = new MemoryTokens();
    const mock = mockServer({ omitSendIds: true });
    const transport = new McpEmailTransport(config, tokens, mock.request);
    const authorization = await transport.beginAuthorization();
    await transport.finishAuthorization("code", authorization.state, authorization.state);
    const session = await transport.authorizedSession();
    const result = await transport.send(session, { id: "request-id", fromEmail: sender,
      toEmail: "prospect@example.com", subject: "Subject", body: "Body", raw: "unused" });
    assert.deepEqual(result, { receiptId: "mcp-ack:request-id", messageId: undefined, threadId: undefined });
  });

  it("treats a JSON-RPC validation error as a definite rejection", async () => {
    const tokens = new MemoryTokens();
    const mock = mockServer({ sendRpcError: true });
    const transport = new McpEmailTransport(config, tokens, mock.request);
    const authorization = await transport.beginAuthorization();
    await transport.finishAuthorization("code", authorization.state, authorization.state);
    const session = await transport.authorizedSession();
    await assert.rejects(transport.send(session, { id: "request-id", fromEmail: sender,
      toEmail: "prospect@example.com", subject: "Subject", body: "Body", raw: "unused" }),
    (error) => error instanceof EmailTransportError && !error.uncertain && /-32602/.test(error.message));
  });

  it("rejects a mismatched mailbox and never stores its credentials", async () => {
    const tokens = new MemoryTokens();
    const mock = mockServer({ profileEmail: "other@example.com" });
    const transport = new McpEmailTransport(config, tokens, mock.request);
    const authorization = await transport.beginAuthorization();
    await assert.rejects(transport.finishAuthorization("code", authorization.state, authorization.state), /does not match/);
    assert.equal(tokens.value, undefined);
  });

  it("blocks an incompatible send schema before invoking the send tool", async () => {
    const tokens = new MemoryTokens();
    const mock = mockServer({ incompatibleSend: true });
    const transport = new McpEmailTransport(config, tokens, mock.request);
    const authorization = await transport.beginAuthorization();
    await transport.finishAuthorization("code", authorization.state, authorization.state);
    const session = await transport.authorizedSession();
    await assert.rejects(transport.send(session, { id: "request-id", fromEmail: sender,
      toEmail: "prospect@example.com", subject: "Subject", body: "Body", raw: "unused" }), /incompatible/);
    assert.equal(mock.calls.filter(({ payload }) => payload?.params?.name === "send_email").length, 0);
  });

  it("stores OAuth credentials with owner-only permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "outbound-mcp-token-"));
    const filename = join(directory, "mcp-email-oauth.json");
    try {
      const store = new FileMcpTokenStore(filename);
      store.save({ clientId: "client", email: sender, accessToken: "access", refreshToken: "refresh",
        expiresAt: Date.now() + 3600_000, tokenEndpoint: "https://mail.example/token" });
      assert.equal(statSync(filename).mode & 0o777, 0o600);
      assert.equal(store.load()?.email, sender);
    } finally { rmSync(directory, { recursive: true }); }
  });
});
