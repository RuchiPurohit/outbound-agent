import { randomBytes } from "node:crypto";
import { resolveMx as dnsResolveMx } from "node:dns/promises";
import { connect as netConnect, type Socket } from "node:net";
import { hostname } from "node:os";
import type { GuessVerification } from "../db/types.js";

export interface SmtpVerificationResult {
  verdict: GuessVerification;
  /** MX host and server replies, kept as evidence for the human reviewer. */
  detail: string;
}

export interface CandidateVerificationResult extends SmtpVerificationResult {
  /** The accepted candidate, or the first candidate when none was accepted. */
  address: string;
}

export interface SmtpVerifierOptions {
  /** Name announced in EHLO. Defaults to SMTP_VERIFY_HELO or the machine hostname. */
  heloName?: string;
  /** Envelope sender. Defaults to SMTP_VERIFY_FROM or the null sender (<>). */
  mailFrom?: string;
  port?: number;
  timeoutMs?: number;
  /** MX hosts tried before giving up; later hosts are only tried when a connection fails. */
  maxHosts?: number;
  resolveMx?: (domain: string) => Promise<{ exchange: string; priority: number }[]>;
  connect?: (host: string, port: number) => Socket;
}

interface SmtpReply { code: number; text: string }

// Replies that reject the probe itself (IP reputation, policy) rather than the mailbox.
const BLOCK_PATTERN = /block|spamhaus|blacklist|blocklist|reputation|policy|denied|not allowed|rbl|banned|abuse/i;

export class SmtpVerifier {
  private readonly heloName: string;
  private readonly mailFrom: string;
  private readonly port: number;
  private readonly timeoutMs: number;
  private readonly maxHosts: number;
  private readonly resolveMx: NonNullable<SmtpVerifierOptions["resolveMx"]>;
  private readonly connect: NonNullable<SmtpVerifierOptions["connect"]>;

  constructor(options: SmtpVerifierOptions = {}) {
    this.heloName = options.heloName ?? process.env.SMTP_VERIFY_HELO ?? hostname();
    this.mailFrom = options.mailFrom ?? process.env.SMTP_VERIFY_FROM ?? "";
    this.port = options.port ?? 25;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxHosts = options.maxHosts ?? 2;
    this.resolveMx = options.resolveMx ?? dnsResolveMx;
    this.connect = options.connect ?? ((host, port) => netConnect({ host, port }));
  }

  async verify(address: string): Promise<SmtpVerificationResult> {
    const { verdict, detail } = await this.verifyCandidates([address]);
    return { verdict, detail };
  }

  /**
   * Probes same-domain candidates in order within one SMTP session and stops at the first
   * accepted mailbox. `address` is the accepted candidate, or the first candidate when none
   * was accepted. INVALID means every candidate was rejected.
   */
  async verifyCandidates(candidates: string[]): Promise<CandidateVerificationResult> {
    const [first] = candidates;
    const domain = first?.split("@")[1]?.toLowerCase();
    if (!domain) return { address: first ?? "", verdict: "INVALID", detail: "Address has no domain" };
    if (candidates.some((candidate) => candidate.split("@")[1]?.toLowerCase() !== domain)) {
      throw new Error("All SMTP candidates must share one domain");
    }

    let hosts: string[];
    try {
      hosts = (await this.resolveMx(domain))
        .sort((left, right) => left.priority - right.priority)
        .map(({ exchange }) => exchange.replace(/\.$/, ""));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOTFOUND" || code === "ENODATA") {
        return { address: first, verdict: "INVALID", detail: `${domain} has no MX records (${code})` };
      }
      return { address: first, verdict: "UNKNOWN", detail: `MX lookup failed for ${domain}: ${messageOf(error)}` };
    }
    // RFC 7505 null MX: the domain explicitly accepts no mail.
    if (hosts.length === 0 || hosts.every((host) => host === "")) {
      return { address: first, verdict: "INVALID", detail: `${domain} does not accept mail (null MX)` };
    }

    const failures: string[] = [];
    for (const host of hosts.slice(0, this.maxHosts)) {
      try {
        return await this.probe(host, candidates, domain);
      } catch (error) {
        failures.push(`${host}: ${messageOf(error)}`);
      }
    }
    return { address: first, verdict: "UNKNOWN",
      detail: `Could not complete SMTP check (outbound port 25 may be blocked). ${failures.join("; ")}` };
  }

  private async probe(host: string, candidates: string[], domain: string): Promise<CandidateVerificationResult> {
    const [first] = candidates;
    const session = new SmtpSession(this.connect(host, this.port), this.timeoutMs);
    try {
      expect(await session.read(), 220, "greeting");
      expect(await session.command(`EHLO ${this.heloName}`), 250, "EHLO");
      const sender = await session.command(`MAIL FROM:<${this.mailFrom}>`);
      if (sender.code !== 250) {
        return { address: first, verdict: "UNKNOWN", detail: `${host} refused the envelope sender: ${describe(sender)}` };
      }

      const rejected: string[] = [];
      let accepted: { address: string; reply: SmtpReply } | undefined;
      for (const address of candidates) {
        const reply = await session.command(`RCPT TO:<${address}>`);
        if (reply.code === 250 || reply.code === 251) { accepted = { address, reply }; break; }
        const definitive = reply.code >= 500 && (/\b5\.1\.\d\b/.test(reply.text)
          || ([550, 551, 553].includes(reply.code) && !BLOCK_PATTERN.test(reply.text)));
        if (!definitive) {
          const reason = reply.code >= 500 ? "rejected the probe, not clearly the mailbox"
            : "deferred the mailbox (possibly greylisting)";
          return { address: first, verdict: "UNKNOWN", detail: `${host} ${reason} for ${address}: ${describe(reply)}` };
        }
        rejected.push(address);
      }
      const rejectedNote = rejected.length ? ` Rejected first: ${rejected.join(", ")}.` : "";
      if (!accepted) {
        return { address: first, verdict: "INVALID", detail: `${host} rejected every candidate: ${rejected.join(", ")}` };
      }

      const decoy = `${randomBytes(9).toString("hex")}@${domain}`;
      const control = await session.command(`RCPT TO:<${decoy}>`);
      if (control.code === 250 || control.code === 251) {
        return { address: accepted.address, verdict: "CATCH_ALL",
          detail: `${host} accepts any address on ${domain}, so the mailbox cannot be confirmed: ${describe(accepted.reply)}${rejectedNote}` };
      }
      if (control.code >= 500) {
        return { address: accepted.address, verdict: "VALID",
          detail: `${host} accepted ${accepted.address} and rejected a random address: ${describe(accepted.reply)}${rejectedNote}` };
      }
      return { address: accepted.address, verdict: "UNKNOWN",
        detail: `${host} accepted ${accepted.address} but catch-all status is undetermined: ${describe(control)}${rejectedNote}` };
    } finally {
      await session.quit();
    }
  }
}

/** Minimal line-based SMTP client: one command in flight at a time, no message is ever sent. */
class SmtpSession {
  private buffer = "";
  private readonly lines: string[] = [];
  private waiter?: () => void;
  private failure?: Error;

  constructor(private readonly socket: Socket, timeoutMs: number) {
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      const parts = this.buffer.split(/\r?\n/);
      this.buffer = parts.pop() ?? "";
      this.lines.push(...parts);
      this.waiter?.();
    });
    socket.on("timeout", () => this.fail(new Error("SMTP timeout")));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Connection closed")));
  }

  async command(line: string): Promise<SmtpReply> {
    this.socket.write(`${line}\r\n`);
    return this.read();
  }

  async read(): Promise<SmtpReply> {
    const text: string[] = [];
    for (;;) {
      const line = await this.nextLine();
      const match = line.match(/^(\d{3})([ -])(.*)$/);
      if (!match) throw new Error(`Unexpected SMTP reply: ${line.slice(0, 120)}`);
      text.push(match[3]);
      if (match[2] === " ") return { code: Number(match[1]), text: text.join(" ") };
    }
  }

  async quit(): Promise<void> {
    if (!this.failure) this.socket.write("QUIT\r\n");
    this.socket.end();
    this.socket.destroy();
  }

  private async nextLine(): Promise<string> {
    while (this.lines.length === 0) {
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => { this.waiter = resolve; });
      this.waiter = undefined;
    }
    return this.lines.shift()!;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.waiter?.();
  }
}

function expect(reply: SmtpReply, code: number, stage: string): void {
  if (reply.code !== code) throw new Error(`Unexpected ${stage} reply: ${describe(reply)}`);
}

const describe = (reply: SmtpReply): string => `${reply.code} ${reply.text}`.slice(0, 300);
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
