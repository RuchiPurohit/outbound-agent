import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { OutboundStore } from "../src/db/store.js";
import { GmailClient, type GmailTokens, type TokenStore } from "../src/gmail/client.js";
import { EmailSending } from "../src/gmail/sending.js";
import {
  buildDocument, buildStagePrompt, defaultSequence, defaultSetup, missingInputs, parseSequenceForm, resolveSetup,
  type SequenceStep,
} from "../src/prompts/clientSetup.js";
import { renderFollowUps } from "../src/web/followUps.js";
import { buildPrompt, listFollowUpCandidates, withSequenceSteps } from "../src/workflows/runner.js";

const sender = "sender@example.com";
const DAY = 86_400_000;
class MemoryTokens implements TokenStore {
  constructor(public value?: GmailTokens) {}
  load() { return this.value; }
  save(value: GmailTokens) { this.value = value; }
  clear() { this.value = undefined; }
}

const SEQUENCE: SequenceStep[] = [
  { kind: "email", delayDays: 3, name: "Bump with demo", length: "Under 80 words", instructions: "DEMO_TEMPLATE" },
  { kind: "linkedin", delayDays: 2, name: "LinkedIn connect", length: "", instructions: "Send a connection request" },
  { kind: "email", delayDays: 5, name: "Case study", length: "Under 90 words", instructions: "CASE_TEMPLATE" },
];

async function fixture(sequence = SEQUENCE) {
  const db = openDatabase(":memory:");
  const store = new OutboundStore(db);
  const client = store.createClient({ name: "Acme", setup: { ...defaultSetup("convokit"), sequence } });
  const campaign = store.createCampaign({ name: "Test", segment: "SaaS", clientId: client.id });
  const company = store.createCompany({ campaignId: campaign.id, name: "Example", domain: "example.com" });
  store.reviewCompany(company.id, "APPROVED");
  const contact = store.createContact({ companyId: company.id, name: "Pat" });
  store.reviewContact(contact.id, "APPROVED");
  store.recordEmailDiscovery({ contactId: contact.id, emailStatus: "PUBLICLY_LISTED", email: "pat@example.com", sourceUrl: "https://example.com/team" });
  const research = store.saveProspectResearch({ contactId: contact.id,
    signals: [{ signal: "Launched shared workspaces", sourceUrl: "https://example.com/launch" }],
    strongestSignalIndex: 0, painHypothesis: "May need conversations", relevance: "Chat infrastructure" });
  const first = store.createOutreach({ contactId: contact.id, subject: "Shared workspaces", body: "FIRST_BODY",
    researchId: research.strongestResearchId! });
  store.approveOutreachForSending(first.id);
  const gmail = new GmailClient({ clientId: "c", clientSecret: "s", redirectUri: "http://127.0.0.1:3000/gmail/callback", expectedSender: sender },
    new MemoryTokens({ clientId: "c", email: sender, accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }),
    async () => Response.json({ id: `message-${Math.random()}`, threadId: "thread-1" }));
  const sending = new EmailSending(store, gmail);
  const send = (id: number) => {
    const email = store.getOutreach(id)!;
    return sending.sendApproved(id, { fromEmail: sender, toEmail: "pat@example.com", subject: email.subject, body: email.body });
  };
  await send(first.id);
  /** Moves a sent email (or task completion) back in time by `days`. */
  const backdateSent = (id: number, days: number) => db.prepare("UPDATE outreach SET sent_at = ? WHERE id = ?")
    .run(new Date(Date.now() - days * DAY).toISOString(), id);
  return { db, store, client, campaign, first, send, backdateSent };
}

describe("Configurable sequences", () => {
  it("runs email and manual task steps in order, each after its own wait", async () => {
    const f = await fixture();
    try {
      let state = f.store.sequenceState(f.first.id);
      assert.equal(state.current?.step, 1);
      assert.equal(Math.round((state.current!.dueAt!.getTime() - new Date(f.store.getOutreach(f.first.id)!.sentAt!).getTime()) / DAY), 3);
      assert.equal(f.store.nextFollowUpStep(f.first.id), 1);

      const bump = f.store.createFollowUp({ outreachId: f.first.id, body: "BUMP" });
      assert.equal(bump.followUpStep, 1);
      f.store.approveOutreachForSending(bump.id);
      await assert.rejects(f.send(bump.id), /not due until/);
      f.backdateSent(f.first.id, 3);
      await f.send(bump.id);

      // Step 2 is a LinkedIn task: never drafted, completed by the human.
      state = f.store.sequenceState(f.first.id);
      assert.equal(state.current?.step, 2);
      assert.equal(state.current?.def.kind, "linkedin");
      assert.equal(f.store.nextFollowUpStep(f.first.id), undefined);
      assert.deepEqual(listFollowUpCandidates(f.store, f.campaign.id), []);
      assert.throws(() => f.store.createFollowUp({ outreachId: f.first.id, body: "x" }), /not an email waiting for a draft/);
      const html = renderFollowUps(f.store, f.campaign.id, f.first.id);
      assert.match(html, /Step 3 · LinkedIn connect/);
      assert.match(html, /action="\/campaigns\/\d+\/outreach\/\d+\/task"/);
      assert.match(html, /Send a connection request/);

      assert.throws(() => f.store.completeSequenceTask(f.first.id, 3, "DONE"), /Only the current step/);
      f.store.completeSequenceTask(f.first.id, 2, "DONE", "Sent request with a note");
      assert.throws(() => f.store.completeSequenceTask(f.first.id, 2, "DONE"), /Only the current step/);

      // Step 3 is an email due 5 days after the task was done; follow_up_step 3 is allowed.
      state = f.store.sequenceState(f.first.id);
      assert.equal(state.current?.step, 3);
      assert.equal(Math.round((state.current!.dueAt!.getTime() - Date.now()) / DAY), 5);
      assert.throws(() => f.store.completeSequenceTask(f.first.id, 3, "DONE"), /completed by sending/);
      const brief = withSequenceSteps(f.store, { campaignId: f.campaign.id, kind: "FOLLOW_UP_GENERATION", outreachIds: [f.first.id] });
      assert.deepEqual(brief.sequenceSteps, [{ outreachId: f.first.id, step: 3, name: "Case study", length: "Under 90 words", template: "CASE_TEMPLATE" }]);
      assert.match(buildPrompt(brief), /CASE_TEMPLATE/);
      const caseStudy = f.store.createFollowUp({ outreachId: f.first.id, body: "CASE" });
      assert.equal(caseStudy.followUpStep, 3);
      const rewrite = withSequenceSteps(f.store, { campaignId: f.campaign.id, kind: "DRAFT_REWRITE", outreachId: caseStudy.id, feedback: "shorter" });
      assert.equal(rewrite.sequenceSteps?.[0]?.template, "CASE_TEMPLATE");
      f.store.approveOutreachForSending(caseStudy.id);
      await assert.rejects(f.send(caseStudy.id), /not due until/);
      f.db.prepare("UPDATE sequence_task_completions SET completed_at = ?").run(new Date(Date.now() - 5 * DAY).toISOString());
      await f.send(caseStudy.id);

      state = f.store.sequenceState(f.first.id);
      assert.equal(state.done, true);
      assert.equal(state.current, undefined);
      const done = renderFollowUps(f.store, f.campaign.id, f.first.id);
      assert.match(done, /Sequence complete/);
      assert.match(done, /Sent request with a note/);
      assert.doesNotMatch(done, /Mark as replied/);
    } finally { f.db.close(); }
  });

  it("stops every remaining step once the prospect replies", async () => {
    const f = await fixture([{ kind: "call", delayDays: 1, name: "Call", length: "", instructions: "Call the office" }]);
    try {
      assert.equal(f.store.sequenceState(f.first.id).current?.def.kind, "call");
      f.store.markOutreachReplied(f.first.id);
      assert.equal(f.store.sequenceState(f.first.id).stopped, true);
      assert.throws(() => f.store.completeSequenceTask(f.first.id, 1, "SKIPPED"), /sequence has stopped/);
      assert.doesNotMatch(renderFollowUps(f.store, f.campaign.id), /outreach\/\d+\/task/);
    } finally { f.db.close(); }
  });

  it("keeps steps already reached when the client's sequence is later shortened", async () => {
    const f = await fixture();
    try {
      f.store.createFollowUp({ outreachId: f.first.id, body: "BUMP" });
      f.store.updateClientSequence(f.client.id, []);
      const state = f.store.sequenceState(f.first.id);
      assert.equal(state.steps.length, 1);
      assert.equal(state.current?.email?.body, "BUMP");
      assert.equal(f.store.nextFollowUpStep(f.first.id), undefined);
    } finally { f.db.close(); }
  });

  it("treats a sequence with no steps as finished after the first email", async () => {
    const f = await fixture([]);
    try {
      const state = f.store.sequenceState(f.first.id);
      assert.equal(state.done, true);
      assert.equal(f.store.nextFollowUpStep(f.first.id), undefined);
      assert.match(renderFollowUps(f.store, f.campaign.id), /No follow-up steps/);
    } finally { f.db.close(); }
  });
});

describe("Sequence setup", () => {
  it("parses editor rows, dropping removed and blank rows", () => {
    const form = new URLSearchParams();
    const rows = [
      ["email", "4", "Demo", "Under 80 words", "T1"],
      ["linkedin", "2", "Connect", "ignored for tasks", "Send a request"],
      ["email", "7", "Removed", "", "T3"],
      ["email", "7", "", "", ""],
    ];
    for (const [kind, delay, name, length, instructions] of rows) {
      form.append("kind", kind!); form.append("delayDays", delay!); form.append("name", name!);
      form.append("length", length!); form.append("instructions", instructions!);
    }
    form.append("remove", "2");
    assert.deepEqual(parseSequenceForm(form), [
      { kind: "email", delayDays: 4, name: "Demo", length: "Under 80 words", instructions: "T1" },
      { kind: "linkedin", delayDays: 2, name: "Connect", length: "", instructions: "Send a request" },
    ]);
    const bad = (overrides: Record<string, string>) => {
      const one = new URLSearchParams({ kind: "email", delayDays: "3", name: "A", length: "", instructions: "x", ...overrides });
      return () => parseSequenceForm(one);
    };
    assert.throws(bad({ kind: "fax" }), /choose a step type/);
    assert.throws(bad({ delayDays: "91" }), /0 to 90/);
    assert.throws(bad({ name: "" }), /give it a name/);
    const many = new URLSearchParams();
    for (let i = 0; i < 9; i += 1) {
      for (const [key, value] of [["kind", "email"], ["delayDays", "1"], ["name", `S${i}`], ["length", ""], ["instructions", "x"]]) many.append(key!, value!);
    }
    assert.throws(() => parseSequenceForm(many), /at most 8 steps/);
  });

  it("builds a sequence from an older client's Follow-up 1 and 2 templates", () => {
    const setup = resolveSetup({ "follow-up-generation": { followUp1: "OLD_ONE", followUp1Length: "Short", followUp2: "OLD_TWO" } });
    assert.deepEqual(setup.sequence.map(({ name, instructions, length }) => [name, instructions, length]), [
      ["Follow-up 1: live demo", "OLD_ONE", "Short"],
      ["Follow-up 2: close the loop", "OLD_TWO", defaultSequence()[1]!.length],
    ]);
    assert.deepEqual(resolveSetup({}).sequence, []);
    assert.deepEqual(resolveSetup({ sequence: [{ kind: "fax", delayDays: 1 }, { ...SEQUENCE[0] }] }).sequence, [SEQUENCE[0]]);
  });

  it("puts every step in the follow-up prompt and EMAIL_RULES.md and flags steps without instructions", () => {
    const setup = { ...defaultSetup("convokit"), sequence: SEQUENCE };
    const prompt = buildStagePrompt("follow-up-generation", setup);
    assert.match(prompt, /### Step 2: Bump with demo\n\nEmail \(threaded reply\), 3 day\(s\) after the previous step\.\n\nUnder 80 words\./);
    assert.match(prompt, /### Step 3: LinkedIn connect\n\nLinkedIn task, 2 day\(s\)[\s\S]*never drafted or sent\.\n\nSend a connection request/);
    assert.match(buildDocument("doc-email-rules", setup), /### Step 4: Case study[\s\S]*CASE_TEMPLATE/);
    assert.deepEqual(missingInputs("follow-up-generation", setup), []);
    const empty = { ...setup, sequence: [{ ...SEQUENCE[0]!, instructions: " " }] };
    assert.deepEqual(missingInputs("follow-up-generation", empty), ["Step 2 (Bump with demo) has no template"]);
  });
});

describe("Sequence edits", () => {
  it("refuses to change the type of a step prospects already reached", async () => {
    const f = await fixture();
    try {
      f.store.createFollowUp({ outreachId: f.first.id, body: "BUMP" });
      const [bump, linkedin, caseStudy] = SEQUENCE as [SequenceStep, SequenceStep, SequenceStep];
      assert.throws(() => f.store.updateClientSequence(f.client.id, [linkedin, bump]), /Step 2 already has drafted or sent emails/);
      f.store.updateClientSequence(f.client.id, [{ ...bump, name: "Renamed", delayDays: 4 }, linkedin, caseStudy,
        { kind: "call", delayDays: 1, name: "Call", length: "", instructions: "Call" }]);
      assert.equal(f.store.sequenceState(f.first.id).steps.length, 4);

      const db = f.db;
      db.prepare("INSERT INTO sequence_task_completions (outreach_id, step, status, completed_at) VALUES (?, 2, 'DONE', ?)").run(f.first.id, new Date().toISOString());
      assert.throws(() => f.store.updateClientSequence(f.client.id, [bump, caseStudy]), /Step 3 was already done as a task/);
    } finally { f.db.close(); }
  });
});
