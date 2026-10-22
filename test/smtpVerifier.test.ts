import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Server } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { OutboundStore } from "../src/db/store.js";
import { SmtpVerifier } from "../src/email/smtpVerifier.js";
import { patternCandidates } from "../src/email/guessPatterns.js";
import { verifyGuessedEmails, type MailboxVerifier } from "../src/email/verifyGuesses.js";
import type { GuessVerification } from "../src/db/types.js";
import { renderEmailPipelineStatus, renderEmailResults } from "../src/web/emailResults.js";
import {
  buildPrompt, isCheckingGuesses, launchEmailRecovery, launchPatternEvidence, launchWorkflow, startGuessCheck,
  validateRequest,
} from "../src/workflows/runner.js";

/** Fake MX: replies to RCPT TO by looking up the mailbox, or `*` for any other address. */
function fakeMx(rcpt: Record<string, string>, greeting = "220 mx.test ESMTP"): Server {
  return createServer((socket) => {
    socket.setEncoding("utf8");
    socket.write(`${greeting}\r\n`);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (line.startsWith("EHLO")) socket.write("250-mx.test\r\n250-SIZE 1000\r\n250 OK\r\n");
        else if (line.startsWith("MAIL FROM")) socket.write("250 2.1.0 OK\r\n");
        else if (line.startsWith("RCPT TO")) {
          const address = line.match(/<(.*)>/)![1];
          socket.write(`${rcpt[address] ?? rcpt["*"]}\r\n`);
        } else if (line === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("502 Unknown\r\n");
      }
    });
    socket.on("error", () => undefined);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const verifierFor = (port: number): SmtpVerifier => new SmtpVerifier({
  port, heloName: "test.local", mailFrom: "", timeoutMs: 2000,
  resolveMx: async () => [{ exchange: "127.0.0.1", priority: 10 }],
});

describe("SMTP mailbox verifier", () => {
  const servers: Server[] = [];
  const start = async (rcpt: Record<string, string>, greeting?: string): Promise<SmtpVerifier> => {
    const server = fakeMx(rcpt, greeting);
    servers.push(server);
    return verifierFor(await listen(server));
  };
  after(() => servers.forEach((server) => server.close()));

  it("reports VALID when the mailbox is accepted and a random address is rejected", async () => {
    const verifier = await start({ "pat@example.com": "250 2.1.5 OK", "*": "550 5.1.1 No such user" });
    const result = await verifier.verify("pat@example.com");
    assert.equal(result.verdict, "VALID");
    assert.match(result.detail, /accepted pat@example.com and rejected a random address/);
  });

  it("reports INVALID when the server rejects the mailbox", async () => {
    const verifier = await start({ "*": "550 5.1.1 The email account that you tried to reach does not exist" });
    assert.equal((await verifier.verify("nobody@example.com")).verdict, "INVALID");
  });

  it("reports CATCH_ALL when any address is accepted", async () => {
    const verifier = await start({ "*": "250 OK" });
    assert.equal((await verifier.verify("pat@example.com")).verdict, "CATCH_ALL");
  });

  it("reports UNKNOWN for greylisting and IP blocks rather than INVALID", async () => {
    const greylist = await start({ "*": "451 4.7.1 Try again later" });
    assert.equal((await greylist.verify("pat@example.com")).verdict, "UNKNOWN");
    const blocked = await start({ "*": "554 5.7.1 Client host blocked using Spamhaus" });
    assert.equal((await blocked.verify("pat@example.com")).verdict, "UNKNOWN");
  });

  it("reports UNKNOWN when no MX host accepts a connection", async () => {
    const server = fakeMx({});
    const port = await listen(server);
    await new Promise((resolve) => server.close(resolve));
    const result = await verifierFor(port).verify("pat@example.com");
    assert.equal(result.verdict, "UNKNOWN");
    assert.match(result.detail, /port 25 may be blocked/);
  });

  it("reports INVALID for domains without MX records", async () => {
    const verifier = new SmtpVerifier({
      resolveMx: async () => { throw Object.assign(new Error("queryMx ENOTFOUND"), { code: "ENOTFOUND" }); },
    });
    assert.equal((await verifier.verify("pat@missing.example")).verdict, "INVALID");
  });

  it("returns the first accepted candidate after rejected ones", async () => {
    const verifier = await start({ "pat.lee@example.com": "250 OK", "*": "550 5.1.1 No such user" });
    const result = await verifier.verifyCandidates(["pat@example.com", "pat.lee@example.com", "patlee@example.com"]);
    assert.equal(result.verdict, "VALID");
    assert.equal(result.address, "pat.lee@example.com");
    assert.match(result.detail, /Rejected first: pat@example.com/);
  });

  it("reports INVALID with the first candidate when every candidate is rejected", async () => {
    const verifier = await start({ "*": "550 5.1.1 No such user" });
    const result = await verifier.verifyCandidates(["pat@example.com", "pat.lee@example.com"]);
    assert.equal(result.verdict, "INVALID");
    assert.equal(result.address, "pat@example.com");
  });

  it("stops at the first inconclusive reply instead of probing more patterns", async () => {
    const verifier = await start({ "pat@example.com": "550 5.1.1 No such user", "*": "451 4.7.1 Try later" });
    const result = await verifier.verifyCandidates(["pat@example.com", "pat.lee@example.com", "patlee@example.com"]);
    assert.equal(result.verdict, "UNKNOWN");
    assert.equal(result.address, "pat@example.com");
  });
});

describe("Pattern candidates", () => {
  it("follows the runbook order and normalizes names", () => {
    assert.deepEqual(patternCandidates("José García-López", "www.Acme.io").map(({ email }) => email), [
      "jose@acme.io", "jose.garcialopez@acme.io", "josegarcialopez@acme.io", "jgarcialopez@acme.io", "jose_garcialopez@acme.io",
    ]);
    assert.deepEqual(patternCandidates("Dr. Pat Lee, PhD", "acme.io").map(({ pattern }) => pattern),
      ["firstname", "firstname.lastname", "firstnamelastname", "firstinitiallastname", "firstname_lastname"]);
    assert.deepEqual(patternCandidates("Cher", "acme.io").map(({ email }) => email), ["cher@acme.io"]);
    assert.deepEqual(patternCandidates("李 雷", "acme.io"), []);
  });
});

/** Fake verifier: per-address verdicts, probed in order like the real one. */
function fakeVerifier(verdicts: Record<string, GuessVerification>, probed: string[][] = []): MailboxVerifier {
  return {
    verifyCandidates: async (candidates) => {
      probed.push(candidates);
      for (const address of candidates) {
        const verdict = verdicts[address] ?? "INVALID";
        if (verdict !== "INVALID") return { address, verdict, detail: `${verdict} for ${address}` };
      }
      return { address: candidates[0]!, verdict: "INVALID", detail: "all rejected" };
    },
  };
}

function guessFixture(verdict?: "INVALID" | "CATCH_ALL" | "UNKNOWN") {
  const db = openDatabase(":memory:");
  const store = new OutboundStore(db);
  const campaign = store.createCampaign({ name: "Recovery", segment: "SaaS" });
  const company = store.createCompany({ campaignId: campaign.id, name: "Acme", domain: "acme.test" });
  store.reviewCompany(company.id, "APPROVED");
  const contact = store.createContact({ companyId: company.id, name: "Pat Lee" });
  store.reviewContact(contact.id, "APPROVED");
  store.recordEmailDiscovery({ contactId: contact.id, emailStatus: "EMAIL_NOT_FOUND" });
  store.recordEmailGuess({ contactId: contact.id, guessedEmail: "pat@acme.test",
    pattern: "firstname", confidence: "COMMON_PATTERN", basis: "Common pattern" });
  if (verdict) store.recordGuessVerification({ contactId: contact.id, guessedEmail: "pat@acme.test", verdict, detail: "test" });
  return { db, store, campaign, company, contact };
}

const noCodex = { resolveExecutable: () => "simulated-codex",
  spawnProcess: () => spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"]) };

async function waitIdle(store: OutboundStore, campaignId: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (!isCheckingGuesses(campaignId) && store.listWorkflowRuns(campaignId)
      .every(({ status }) => status === "COMPLETED" || status === "FAILED")) return;
    await sleep(10);
  }
  assert.fail("Workflow did not settle");
}

describe("Guess verification workflow", () => {
  let db: ReturnType<typeof openDatabase>;
  let store: OutboundStore;
  before(() => { db = openDatabase(":memory:"); store = new OutboundStore(db); });
  after(() => db.close());

  it("probes only guesses, never sourced emails, and never promotes a guess", async () => {
    const campaign = store.createCampaign({ name: "Test", segment: "SaaS" });
    const company = store.createCompany({ campaignId: campaign.id, name: "Example", domain: "example.com" });
    store.reviewCompany(company.id, "APPROVED");
    const [listed, verified, guessed] = ["Ann Listed", "Ben Verified", "Cat Guess"].map((name) => {
      const contact = store.createContact({ companyId: company.id, name });
      store.reviewContact(contact.id, "APPROVED");
      return contact;
    });
    store.recordEmailDiscovery({ contactId: listed.id, emailStatus: "PUBLICLY_LISTED",
      email: "ann@example.com", sourceUrl: "https://example.com/team" });
    store.recordEmailDiscovery({ contactId: verified.id, emailStatus: "VERIFIED",
      email: "ben@example.com", sourceUrl: "https://example.com/treg" });
    store.recordEmailDiscovery({ contactId: guessed.id, emailStatus: "EMAIL_NOT_FOUND" });
    store.recordEmailGuess({ contactId: guessed.id, guessedEmail: "cat@example.com",
      pattern: "firstname", confidence: "COMMON_PATTERN", basis: "Common pattern" });

    const probed: string[][] = [];
    const summary = await verifyGuessedEmails(store, campaign.id, fakeVerifier({ "cat@example.com": "VALID" }, probed));
    assert.equal(probed.length, 1);
    assert.equal(probed[0]![0], "cat@example.com");
    assert.ok(probed.flat().every((address) => address.endsWith("@example.com") && !/^(ann|ben)/.test(address)));
    assert.equal(summary.VALID, 1);
    assert.equal(summary.replaced, 0);

    const after = store.getContact(guessed.id)!;
    assert.equal(after.guessedEmailVerification, "VALID");
    assert.equal(after.emailStatus, "EMAIL_NOT_FOUND");
    assert.equal(after.email, null);
    assert.deepEqual(store.getContactRecipient(guessed.id), { address: "cat@example.com", guessed: true, verification: "VALID" });
    assert.equal(store.listGuessesAwaitingVerification(campaign.id).length, 0);
    assert.equal(store.listEmailRecoveryCandidates(campaign.id).length, 0);

    assert.throws(() => store.recordGuessVerification({ contactId: listed.id,
      guessedEmail: "ann@example.com", verdict: "VALID", detail: "" }), /Only guessed emails/);
  });

  it("replaces a rejected guess with the first accepted pattern", async () => {
    const { db, store, campaign, contact } = guessFixture();
    try {
      const probed: string[][] = [];
      const summary = await verifyGuessedEmails(store, campaign.id,
        fakeVerifier({ "pat.lee@acme.test": "VALID" }, probed));
      assert.deepEqual(probed[0], ["pat@acme.test", "pat.lee@acme.test", "patlee@acme.test", "plee@acme.test", "pat_lee@acme.test"]);
      assert.equal(summary.replaced, 1);
      const after = store.getContact(contact.id)!;
      assert.equal(after.guessedEmail, "pat.lee@acme.test");
      assert.equal(after.guessedEmailPattern, "firstname.lastname");
      assert.equal(after.guessedEmailVerification, "VALID");
      assert.equal(after.guessedEmailSource, "PATTERN");
      assert.equal(after.emailStatus, "EMAIL_NOT_FOUND");
      assert.match(after.guessedEmailBasis!, /rejecting the stored guess pat@acme.test/);
    } finally { db.close(); }
  });

  it("keeps the stored guess as INVALID when every pattern is rejected", async () => {
    const { db, store, campaign, contact } = guessFixture();
    try {
      await verifyGuessedEmails(store, campaign.id, fakeVerifier({}));
      const after = store.getContact(contact.id)!;
      assert.equal(after.guessedEmail, "pat@acme.test");
      assert.equal(after.guessedEmailVerification, "INVALID");
      assert.equal(store.getContactRecipient(contact.id), undefined);
      assert.deepEqual(store.listEmailRecoveryCandidates(campaign.id).map(({ id }) => id), [contact.id]);
    } finally { db.close(); }
  });

  it("drops an INVALID guess as a recipient and resets the verdict when the guess changes", () => {
    const { db, store, campaign, contact } = guessFixture();
    try {
      assert.throws(() => store.recordGuessVerification({ contactId: contact.id,
        guessedEmail: "other@acme.test", verdict: "INVALID", detail: "" }), /changed during verification/);
      store.recordGuessVerification({ contactId: contact.id, guessedEmail: "pat@acme.test",
        verdict: "INVALID", detail: "550 5.1.1" });
      assert.equal(store.getContactRecipient(contact.id), undefined);
      assert.equal(store.listEligibleProspects(campaign.id).length, 0);

      store.recordEmailGuess({ contactId: contact.id, guessedEmail: "pat.lee@acme.test",
        pattern: "firstname.lastname", confidence: "COMMON_PATTERN", basis: "Next common pattern" });
      assert.equal(store.getContact(contact.id)!.guessedEmailVerification, null);
      assert.equal(store.getContactRecipient(contact.id)?.address, "pat.lee@acme.test");
    } finally { db.close(); }
  });

  it("does not queue a contact whose SMTP verdict could not be saved", async () => {
    const { db, store, campaign } = guessFixture();
    try {
      const summary = await verifyGuessedEmails(store, campaign.id, {
        verifyCandidates: async () => { throw new Error("guess changed"); },
      });
      assert.equal(summary.failed, 1);
      assert.equal(store.listEmailRecoveryCandidates(campaign.id).length, 0);
    } finally { db.close(); }
  });
});

describe("Email pipeline orchestration", () => {
  it("never calls Treg during normal discovery and runs it only on request", () => {
    const discovery = buildPrompt({ campaignId: 1, kind: "EMAIL_DISCOVERY" });
    assert.match(discovery, /Do not use Treg in this run/);
    assert.doesNotMatch(discovery, /Use Treg first/);
    const recovery = buildPrompt({ campaignId: 1, kind: "EMAIL_DISCOVERY", contactIds: [7] });
    assert.match(recovery, /post-SMTP Treg email recovery/);
    assert.match(recovery, /PROVIDER_ERROR/);
  });

  it("chains discovery → SMTP check → research and never starts Treg automatically", async () => {
    const { db, store, campaign, contact } = guessFixture();
    try {
      const prompts: string[] = [];
      const done = startGuessCheck(db, campaign.id, { continueToResearch: true, dependencies: {
        verifier: fakeVerifier({ "pat@acme.test": "CATCH_ALL" }),
        resolveExecutable: () => "simulated-codex",
        spawnProcess: (_executable, args) => { prompts.push(args[args.length - 1]!); return noCodex.spawnProcess(); },
      } });
      assert.equal(isCheckingGuesses(campaign.id), true);
      assert.throws(() => launchWorkflow(db, { campaignId: campaign.id, kind: "PROSPECT_RESEARCH" }, noCodex), /SMTP check/);
      assert.match(await done, /1 catch-all.*Automatically started PROSPECT_RESEARCH/);
      await waitIdle(store, campaign.id);
      assert.deepEqual(store.listWorkflowRuns(campaign.id).map(({ kind }) => kind), ["PROSPECT_RESEARCH"]);
      assert.equal(prompts.length, 1);
      assert.doesNotMatch(prompts[0]!, /Treg email recovery/);
      assert.deepEqual(store.listEmailRecoveryCandidates(campaign.id).map(({ id }) => id), [contact.id]);
    } finally { db.close(); }
  });

  it("refuses to launch while another workflow runs in the same campaign", () => {
    const { db, store, campaign, contact } = guessFixture("CATCH_ALL");
    try {
      store.startWorkflowRun(store.createWorkflowRun({ campaignId: campaign.id, kind: "PROSPECT_RESEARCH" }).id);
      assert.throws(() => launchEmailRecovery(db, campaign.id, noCodex), /No contacts need Treg recovery|active workflow/);
      assert.equal(store.getContact(contact.id)!.emailRecoveryStartedAt, null);
    } finally { db.close(); }
  });
});

describe("Post-SMTP Treg recovery", () => {
  const audit = "https://treg.example/calls/abc";
  const notes = "finder call f1 (provider X), verifier call v1, cost $0.01";

  it("recovers a contact once, and never again after a recorded outcome", async () => {
    const { db, store, campaign, contact } = guessFixture("UNKNOWN");
    try {
      const run = launchEmailRecovery(db, campaign.id, noCodex);
      assert.deepEqual(JSON.parse(run.details!).contactIds, [contact.id]);
      assert.ok(store.getContact(contact.id)!.emailRecoveryStartedAt);
      assert.equal(store.listEmailRecoveryCandidates(campaign.id).length, 0);
      store.recordEmailRecovery({ contactId: contact.id, outcome: "NOT_FOUND", notes });
      await waitIdle(store, campaign.id);

      await verifyGuessedEmails(store, campaign.id, fakeVerifier({ "pat@acme.test": "UNKNOWN" }));
      assert.equal(store.listEmailRecoveryCandidates(campaign.id).length, 0);
      assert.throws(() => launchEmailRecovery(db, campaign.id, noCodex), /No contacts need Treg recovery/);
      assert.throws(() => validateRequest(store, { campaignId: campaign.id, kind: "EMAIL_DISCOVERY",
        contactIds: [contact.id] }), /no earlier Treg recovery/);
    } finally { db.close(); }
  });

  it("requeues contacts after a provider error or a run that recorded no outcome", async () => {
    const { db, store, campaign, contact } = guessFixture("CATCH_ALL");
    try {
      launchEmailRecovery(db, campaign.id, noCodex);
      store.recordEmailRecovery({ contactId: contact.id, outcome: "PROVIDER_ERROR", notes: "402 insufficient credits" });
      const paused = store.getContact(contact.id)!;
      assert.equal(paused.emailRecoveryStartedAt, null);
      assert.equal(paused.emailRecoveryError, "402 insufficient credits");
      assert.equal(paused.guessedEmail, "pat@acme.test");
      assert.match(renderEmailResults(store.listCompanies(), [paused], []), /paused \(will retry\): 402 insufficient credits/);
      await waitIdle(store, campaign.id);

      launchEmailRecovery(db, campaign.id, noCodex);
      assert.equal(store.getContact(contact.id)!.emailRecoveryError, null);
      assert.equal(store.listEmailRecoveryCandidates(campaign.id).length, 0);
      await waitIdle(store, campaign.id);
      // The run ended without recording an outcome, so the contact is eligible again.
      assert.deepEqual(store.listEmailRecoveryCandidates(campaign.id).map(({ id }) => id), [contact.id]);
    } finally { db.close(); }
  });

  it("keeps the guess when EMAIL_NOT_FOUND is recorded again", () => {
    const { db, store, contact } = guessFixture("CATCH_ALL");
    try {
      store.recordEmailDiscovery({ contactId: contact.id, emailStatus: "EMAIL_NOT_FOUND" });
      const after = store.getContact(contact.id)!;
      assert.equal(after.guessedEmail, "pat@acme.test");
      assert.equal(after.guessedEmailVerification, "CATCH_ALL");
    } finally { db.close(); }
  });

  it("records VERIFIED, CATCH_ALL_CANDIDATE, and NOT_FOUND outcomes", () => {
    for (const outcome of ["VERIFIED", "CATCH_ALL_CANDIDATE", "NOT_FOUND"] as const) {
      const { db, store, campaign, contact } = guessFixture("CATCH_ALL");
      try {
        assert.throws(() => store.recordEmailRecovery({ contactId: contact.id, outcome: "NOT_FOUND", notes }),
          /pending Treg recovery/);
        store.markEmailRecoveryStarted(campaign.id, [contact.id]);
        const email = outcome === "NOT_FOUND" ? undefined : "p.lee@acme.test";
        const after = store.recordEmailRecovery({ contactId: contact.id, outcome, email,
          sourceUrl: email ? audit : undefined, notes });
        assert.equal(after.emailRecoveryOutcome, outcome);
        if (outcome === "VERIFIED") {
          assert.equal(after.email, "p.lee@acme.test");
          assert.equal(after.emailStatus, "VERIFIED");
          assert.equal(after.guessedEmail, null);
        } else if (outcome === "CATCH_ALL_CANDIDATE") {
          assert.equal(after.email, null);
          assert.equal(after.emailStatus, "EMAIL_NOT_FOUND");
          assert.equal(after.guessedEmail, "p.lee@acme.test");
          assert.equal(after.guessedEmailSource, "TREG_CATCH_ALL");
          assert.equal(after.guessedEmailVerification, "CATCH_ALL");
          assert.deepEqual(store.getContactRecipient(contact.id),
            { address: "p.lee@acme.test", guessed: true, verification: "CATCH_ALL" });
          assert.match(renderEmailResults(store.listCompanies(), [after], []), /Treg finder, catch-all/);
        } else {
          assert.equal(after.guessedEmail, "pat@acme.test");
          assert.equal(after.guessedEmailSource, "PATTERN");
        }
        assert.throws(() => store.recordEmailRecovery({ contactId: contact.id, outcome: "NOT_FOUND", notes }));
        assert.equal(store.listEmailRecoveryCandidates(campaign.id).length, 0);
      } finally { db.close(); }
    }
  });

  it("rejects a catch-all candidate off the company domain", () => {
    const { db, store, campaign, contact } = guessFixture("CATCH_ALL");
    try {
      store.markEmailRecoveryStarted(campaign.id, [contact.id]);
      assert.throws(() => store.recordEmailRecovery({ contactId: contact.id, outcome: "CATCH_ALL_CANDIDATE",
        email: "pat@gmail.com", sourceUrl: audit, notes: "n" }), /company domain/);
    } finally { db.close(); }
  });
});

describe("Pipeline visibility", () => {
  it("auto-approves Treg tool calls only for recovery runs", async () => {
    const { db, store, campaign } = guessFixture("CATCH_ALL");
    try {
      const calls: string[][] = [];
      const capture = { resolveExecutable: () => "simulated-codex",
        spawnProcess: (_executable: string, args: string[]) => { calls.push(args); return noCodex.spawnProcess(); } };
      launchEmailRecovery(db, campaign.id, capture);
      await waitIdle(store, campaign.id);
      store.reviewContact(store.createContact({ companyId: store.listCompanies()[0]!.id, name: "New Person" }).id, "APPROVED");
      launchWorkflow(db, { campaignId: campaign.id, kind: "EMAIL_DISCOVERY" }, capture);
      await waitIdle(store, campaign.id);
      const approval = 'mcp_servers.treg.default_tools_approval_mode="approve"';
      assert.ok(calls[0]!.includes(approval));
      assert.ok(calls[0]!.indexOf(approval) < calls[0]!.indexOf("exec"));
      assert.ok(!calls[1]!.includes(approval));
    } finally { db.close(); }
  });

  it("counts only unchecked guesses unless inconclusive ones are requested", () => {
    const { db, store, campaign } = guessFixture("UNKNOWN");
    try {
      assert.equal(store.listGuessesAwaitingVerification(campaign.id).length, 0);
      assert.equal(store.listGuessesAwaitingVerification(campaign.id, { includeInconclusive: true }).length, 1);
    } finally { db.close(); }
  });

  it("reports SMTP totals, a running recovery, and a recovery that recorded nothing", () => {
    const { db, store, campaign, contact } = guessFixture("CATCH_ALL");
    try {
      const contacts = () => store.listContacts();
      assert.match(renderEmailPipelineStatus(contacts(), [], { checking: false }),
        /all guesses checked · 0 valid · 0 invalid · 1 catch-all · 0 inconclusive/);
      assert.match(renderEmailPipelineStatus(contacts(), [], { checking: true }), /SMTP check running/);

      store.markEmailRecoveryStarted(campaign.id, [contact.id]);
      const run = store.createWorkflowRun({ campaignId: campaign.id, kind: "EMAIL_DISCOVERY",
        details: JSON.stringify({ campaignId: campaign.id, kind: "EMAIL_DISCOVERY", contactIds: [contact.id] }) });
      store.startWorkflowRun(run.id);
      assert.match(renderEmailPipelineStatus(contacts(), store.listWorkflowRuns(campaign.id), { checking: false }),
        new RegExp(`Treg recovery running</strong> \\(run ${run.id}\\)`));
      store.completeWorkflowRun(run.id);
      const silent = renderEmailPipelineStatus(contacts(), store.listWorkflowRuns(campaign.id), { checking: false });
      assert.match(silent, /recorded no outcome for 1 contact/);
      assert.deepEqual(store.listEmailRecoveryCandidates(campaign.id).map(({ id }) => id), [contact.id]);
    } finally { db.close(); }
  });
});

describe("Free follow-ups for unconfirmed guesses", () => {
  it("re-checks every pattern for INVALID results from older single-guess checks", async () => {
    const { db, store, campaign, contact } = guessFixture();
    try {
      // Simulate a pre-upgrade row: INVALID with no recorded candidate count.
      db.prepare("UPDATE contacts SET guessed_email_verification = 'INVALID', guessed_email_candidates_checked = NULL WHERE id = ?")
        .run(contact.id);
      assert.deepEqual(store.listGuessesAwaitingVerification(campaign.id).map(({ id }) => id), [contact.id]);
      const probed: string[][] = [];
      await verifyGuessedEmails(store, campaign.id, fakeVerifier({ "plee@acme.test": "VALID" }, probed));
      assert.equal(probed[0]!.length, 5);
      const after = store.getContact(contact.id)!;
      assert.equal(after.guessedEmail, "plee@acme.test");
      assert.equal(after.guessedEmailVerification, "VALID");
      assert.equal(after.guessedEmailCandidatesChecked, 5);

      // A fully checked INVALID result is not probed again.
      await verifyGuessedEmails(store, campaign.id, fakeVerifier({}));
      store.recordEmailGuess({ contactId: contact.id, guessedEmail: "pat@acme.test",
        pattern: "firstname", confidence: "COMMON_PATTERN", basis: "Common pattern" });
      await verifyGuessedEmails(store, campaign.id, fakeVerifier({}));
      assert.equal(store.getContact(contact.id)!.guessedEmailCandidatesChecked, 5);
      assert.equal(store.listGuessesAwaitingVerification(campaign.id).length, 0);
    } finally { db.close(); }
  });

  it("runs the free pattern-evidence search once per contact without Treg, then re-checks", async () => {
    const { db, store, campaign, contact } = guessFixture("CATCH_ALL");
    try {
      assert.deepEqual(store.listPatternEvidenceCandidates(campaign.id).map(({ id }) => id), [contact.id]);
      const prompts: string[][] = [];
      const run = launchPatternEvidence(db, campaign.id, {
        verifier: fakeVerifier({ "pat.lee@acme.test": "CATCH_ALL" }),
        resolveExecutable: () => "simulated-codex",
        spawnProcess: (_executable, args) => {
          prompts.push(args);
          store.recordEmailGuess({ contactId: contact.id, guessedEmail: "pat.lee@acme.test",
            pattern: "firstname.lastname", confidence: "PATTERN_SUPPORTED",
            basis: "Observed sam.jones@acme.test on the team page", sourceUrl: "https://acme.test/team" });
          return noCodex.spawnProcess();
        },
      });
      const args = prompts[0]!;
      assert.match(args[args.length - 1]!, /public email-pattern evidence/);
      assert.match(args[args.length - 1]!, /Do not use Treg/);
      assert.ok(!args.includes('mcp_servers.treg.default_tools_approval_mode="approve"'));
      assert.equal(store.listPatternEvidenceCandidates(campaign.id).length, 0);
      assert.throws(() => launchPatternEvidence(db, campaign.id, noCodex), /No guesses need|active workflow/);

      await waitIdle(store, campaign.id);
      for (let i = 0; i < 100 && store.getContact(contact.id)!.guessedEmailVerification === null; i++) await sleep(10);
      const after = store.getContact(contact.id)!;
      assert.equal(after.guessedEmailConfidence, "PATTERN_SUPPORTED");
      assert.equal(after.guessedEmailVerification, "CATCH_ALL");
      assert.ok(after.patternEvidenceCheckedAt);
      assert.match(renderEmailPipelineStatus(store.listContacts(), store.listWorkflowRuns(campaign.id),
        { checking: false }), new RegExp(`pattern-evidence search</strong> \\(run ${run.id}, completed\\): 1 of 1`));
      assert.doesNotMatch(renderEmailPipelineStatus(store.listContacts(), store.listWorkflowRuns(campaign.id),
        { checking: false }), /Last Treg recovery/);
    } finally { db.close(); }
  });
});

describe("Company email domain", () => {
  it("re-searches a no-MX guess once, moves guesses to the sourced mail domain, and re-checks them", async () => {
    const db = openDatabase(":memory:");
    try {
      const store = new OutboundStore(db);
      const campaign = store.createCampaign({ name: "Mail domain", segment: "Games" });
      const company = store.createCompany({ campaignId: campaign.id, name: "ENVER", domain: "enver.test" });
      store.reviewCompany(company.id, "APPROVED");
      const contact = store.createContact({ companyId: company.id, name: "Greg Bickford" });
      store.reviewContact(contact.id, "APPROVED");
      store.recordEmailDiscovery({ contactId: contact.id, emailStatus: "EMAIL_NOT_FOUND" });
      store.recordEmailGuess({ contactId: contact.id, guessedEmail: "greg@enver.test",
        pattern: "firstname", confidence: "COMMON_PATTERN", basis: "Common pattern" });
      store.recordGuessVerification({ contactId: contact.id, guessedEmail: "greg@enver.test",
        verdict: "INVALID", detail: "enver.test has no MX records (ENODATA)", candidatesChecked: 5 });

      // Searched before, but the website domain has no mail server: one more search per company.
      db.prepare("UPDATE contacts SET pattern_evidence_checked_at = ? WHERE id = ?").run(new Date().toISOString(), contact.id);
      assert.deepEqual(store.listPatternEvidenceCandidates(campaign.id).map(({ id }) => id), [contact.id]);
      store.markPatternEvidenceStarted(campaign.id, [contact.id]);
      assert.ok(store.getCompany(company.id)!.emailDomainCheckedAt);
      assert.equal(store.listPatternEvidenceCandidates(campaign.id).length, 0);

      assert.throws(() => store.recordCompanyEmailDomain({ companyId: company.id, emailDomain: "gmail.com",
        sourceUrl: "https://enver.test/contact", basis: "x" }), /personal email provider/);
      assert.throws(() => store.recordCompanyEmailDomain({ companyId: company.id, emailDomain: "enverstudio.test",
        sourceUrl: "", basis: "x" }), /source URL/);
      const updated = store.recordCompanyEmailDomain({ companyId: company.id, emailDomain: "EnverStudio.test",
        sourceUrl: "https://enver.test/contact", basis: "Contact page lists hi@enverstudio.test" });
      assert.equal(updated.emailDomain, "enverstudio.test");
      const moved = store.getContact(contact.id)!;
      assert.equal(moved.guessedEmail, "greg@enverstudio.test");
      assert.equal(moved.guessedEmailVerification, null);
      assert.match(moved.guessedEmailBasis!, /Moved from enver.test to the company's email domain enverstudio.test/);

      // Guesses now validate against the mail domain, and SMTP alternatives use it.
      assert.throws(() => store.recordEmailGuess({ contactId: contact.id, guessedEmail: "greg@enver.test",
        pattern: "firstname", confidence: "COMMON_PATTERN", basis: "Common pattern" }), /email domain/);
      const probed: string[][] = [];
      await verifyGuessedEmails(store, campaign.id, fakeVerifier({ "greg.bickford@enverstudio.test": "VALID" }, probed));
      assert.ok(probed[0]!.every((address) => address.endsWith("@enverstudio.test")));
      assert.equal(store.getContact(contact.id)!.guessedEmail, "greg.bickford@enverstudio.test");
      assert.equal(store.getContact(contact.id)!.guessedEmailVerification, "VALID");

      assert.match(buildPrompt({ campaignId: campaign.id, kind: "EMAIL_DISCOVERY", contactIds: [contact.id],
        emailTask: "PATTERN_EVIDENCE" }), /recordCompanyEmailDomain/);
      assert.match(renderEmailResults([store.getCompany(company.id)!], store.listContacts(company.id), []),
        /Email domain: enverstudio.test/);
    } finally { db.close(); }
  });
});
