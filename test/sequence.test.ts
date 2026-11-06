import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDatabase } from "../src/db/database.js";
import { OutboundStore } from "../src/db/store.js";
import { GmailClient, type GmailTokens, type TokenStore } from "../src/gmail/client.js";
import { EmailSending } from "../src/gmail/sending.js";
import {
  buildDocument, buildStagePrompt, defaultSequence, defaultSetup, parseSequenceForm, sequenceFromClientSettings,
  sequenceIssues, type SequenceStep,
} from "../src/prompts/clientSetup.js";
import { renderFollowUps } from "../src/web/followUps.js";
import { renderSequenceEditor } from "../src/web/sequencePage.js";
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
  const client = store.createClient({ name: "Acme", setup: defaultSetup("convokit") });
  const campaign = store.createCampaign({ name: "Test", segment: "SaaS", clientId: client.id,
    sequence: { firstEmailGuidance: "Lead with match coordination", steps: sequence } });
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
      f.store.updateCampaignSequence(f.campaign.id, { firstEmailGuidance: "", steps: [] });
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
    form.append("firstEmailGuidance", "  Mention the SDK\r\nKeep it short ");
    assert.deepEqual(parseSequenceForm(form), { firstEmailGuidance: "Mention the SDK\nKeep it short", steps: [
      { kind: "email", delayDays: 4, name: "Demo", length: "Under 80 words", instructions: "T1" },
      { kind: "linkedin", delayDays: 2, name: "Connect", length: "", instructions: "Send a request" },
    ] });
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

  it("reads an older client's saved sequence or Follow-up 1 and 2 templates", () => {
    const legacy = sequenceFromClientSettings({ "follow-up-generation": { followUp1: "OLD_ONE", followUp1Length: "Short", followUp2: "OLD_TWO" } });
    assert.deepEqual(legacy?.map(({ name, instructions, length }) => [name, instructions, length]), [
      ["Follow-up 1: live demo", "OLD_ONE", "Short"],
      ["Follow-up 2: close the loop", "OLD_TWO", defaultSequence()[1]!.length],
    ]);
    assert.equal(sequenceFromClientSettings({}), undefined);
    assert.deepEqual(sequenceFromClientSettings({ sequence: [{ kind: "fax", delayDays: 1 }, { ...SEQUENCE[0] }] }), [SEQUENCE[0]]);
  });

  it("flags steps without a template or note and keeps sequences out of client prompts", () => {
    assert.deepEqual(sequenceIssues(SEQUENCE), []);
    assert.deepEqual(sequenceIssues([{ ...SEQUENCE[0]!, instructions: " " }]), ["Step 2 (Bump with demo) has no template"]);
    const setup = defaultSetup("convokit");
    assert.match(buildStagePrompt("follow-up-generation", setup), /Each campaign has its own sequence/);
    assert.match(buildDocument("doc-email-rules", setup), /Each campaign\nhas its own sequence/);
    assert.doesNotMatch(buildStagePrompt("follow-up-generation", setup), /Follow-up 2: close the loop/);
  });
});

describe("Sequence edits", () => {
  it("refuses to change the type of a step prospects already reached", async () => {
    const f = await fixture();
    try {
      f.store.createFollowUp({ outreachId: f.first.id, body: "BUMP" });
      const [bump, linkedin, caseStudy] = SEQUENCE as [SequenceStep, SequenceStep, SequenceStep];
      const save = (steps: SequenceStep[]) => f.store.updateCampaignSequence(f.campaign.id, { firstEmailGuidance: "", steps });
      assert.throws(() => save([linkedin, bump]), /Step 2 already has drafted or sent emails/);
      save([{ ...bump, name: "Renamed", delayDays: 4 }, linkedin, caseStudy,
        { kind: "call", delayDays: 1, name: "Call", length: "", instructions: "Call" }]);
      assert.equal(f.store.sequenceState(f.first.id).steps.length, 4);

      const db = f.db;
      db.prepare("INSERT INTO sequence_task_completions (outreach_id, step, status, completed_at) VALUES (?, 2, 'DONE', ?)").run(f.first.id, new Date().toISOString());
      assert.throws(() => save([bump, caseStudy]), /Step 3 was already done as a task/);
      const editor = renderSequenceEditor(f.store, f.store.getCampaign(f.campaign.id)!);
      assert.equal(editor.match(/Reached by prospects/g)?.length, 2);
    } finally { f.db.close(); }
  });
});

describe("Campaign sequences", () => {
  it("passes the campaign's first-email guidance to first-email drafting and rewrites", async () => {
    const f = await fixture();
    try {
      const generation = withSequenceSteps(f.store, { campaignId: f.campaign.id, kind: "EMAIL_GENERATION", contactIds: [1] });
      assert.equal(generation.firstEmailGuidance, "Lead with match coordination");
      assert.match(buildPrompt(generation), /guidance for its first emails[\s\S]*"Lead with match coordination"/);
      const rewrite = withSequenceSteps(f.store, { campaignId: f.campaign.id, kind: "DRAFT_REWRITE", outreachId: f.first.id, feedback: "x" });
      assert.equal(rewrite.firstEmailGuidance, "Lead with match coordination");
      f.store.updateCampaignSequence(f.campaign.id, { firstEmailGuidance: " ", steps: SEQUENCE });
      assert.equal(withSequenceSteps(f.store, { campaignId: f.campaign.id, kind: "EMAIL_GENERATION", contactIds: [1] }).firstEmailGuidance, undefined);
    } finally { f.db.close(); }
  });

  it("gives each existing campaign its client's sequence once and new campaigns the standard one", () => {
    const db = openDatabase(":memory:");
    try {
      const store = new OutboundStore(db);
      const legacy = { ...defaultSetup("convokit"), sequence: [SEQUENCE[1]] };
      db.prepare("INSERT INTO clients (name, settings, created_at, updated_at) VALUES ('ConvoKit', ?, 'x', 'x')").run(JSON.stringify(legacy));
      db.prepare("INSERT INTO campaigns (name, segment, created_at, status, client_id) VALUES ('Old', 'SaaS', 'x', 'ACTIVE', 1)").run();
      db.prepare("INSERT INTO campaigns (name, segment, created_at, status) VALUES ('Orphan', 'SaaS', 'x', 'ACTIVE')").run();
      store.ensureDefaultClient();
      assert.deepEqual(store.getCampaign(1)!.sequence, { firstEmailGuidance: "", steps: [SEQUENCE[1]] });
      assert.deepEqual(store.getCampaign(2)!.sequence.steps, [SEQUENCE[1]]);
      store.updateCampaignSequence(1, { firstEmailGuidance: "Edited", steps: [] });
      store.ensureDefaultClient();
      assert.equal(store.getCampaign(1)!.sequence.firstEmailGuidance, "Edited");
      const fresh = store.createCampaign({ name: "New", segment: "SaaS", clientId: 1 });
      assert.deepEqual(fresh.sequence, { firstEmailGuidance: "", steps: defaultSequence() });
      const editor = renderSequenceEditor(store, fresh);
      assert.match(editor, /Step 1: First email/);
      assert.match(editor, /Step 3: Email/);
      assert.match(editor, /First email \+ 2 step\(s\)/);
      assert.match(editor, /action="\/campaigns\/3\/sequence"/);
    } finally { db.close(); }
  });
});

describe("Default follow-ups from client rules", () => {
  it("builds a new campaign's steps from its client's follow-up templates", () => {
    const db = openDatabase(":memory:");
    try {
      const store = new OutboundStore(db);
      const setup = defaultSetup("blank");
      setup["follow-up-generation"] = { ...setup["follow-up-generation"], delayDays: 4, followUp1Name: "",
        followUp1Length: "Under 70 words", followUp1: "ACME_ONE", followUp2: "" };
      const acme = store.createClient({ name: "Acme", setup });
      const campaign = store.createCampaign({ name: "Acme · Clinics", segment: "Clinics", clientId: acme.id });
      assert.deepEqual(campaign.sequence.steps, [{ kind: "email", delayDays: 4, name: "Follow-up 1", length: "Under 70 words", instructions: "ACME_ONE" }]);
      assert.match(buildDocument("doc-email-rules", acme.setup), /### Default follow-up emails[\s\S]*4 day\(s\) apart[\s\S]*ACME_ONE/);
      assert.doesNotMatch(buildDocument("doc-email-rules", acme.setup), /#### Follow-up 2/);

      store.updateClientSection(acme.id, "follow-up-generation", { ...acme.setup["follow-up-generation"], followUp2: "ACME_TWO", followUp2Name: "Last note" });
      assert.deepEqual(store.clientDefaultSequence(campaign.id).map(({ name, instructions }) => [name, instructions]),
        [["Follow-up 1", "ACME_ONE"], ["Last note", "ACME_TWO"]]);
      const convokit = store.createClient({ name: "ConvoKit", setup: defaultSetup("convokit") });
      assert.deepEqual(store.createCampaign({ name: "C", segment: "S", clientId: convokit.id }).sequence.steps, defaultSequence());
    } finally { db.close(); }
  });

  it("gives an older ConvoKit client its follow-up templates back, keeping a sequence it saved", () => {
    const db = openDatabase(":memory:");
    try {
      const store = new OutboundStore(db);
      const old = defaultSetup("convokit") as Record<string, Record<string, unknown>> & { sequence?: unknown };
      for (const key of ["delayDays", "followUp1Name", "followUp1Length", "followUp1", "followUp2Name", "followUp2Length", "followUp2"]) {
        delete old["follow-up-generation"]![key];
      }
      old.sequence = [SEQUENCE[1], { ...SEQUENCE[0], name: "Edited bump", instructions: "EDITED" }];
      db.prepare("INSERT INTO clients (name, settings, created_at, updated_at) VALUES ('ConvoKit', ?, 'x', 'x')").run(JSON.stringify(old));
      const client = store.ensureDefaultClient();
      const rules = client.setup["follow-up-generation"];
      assert.equal(rules.followUp1Name, "Edited bump");
      assert.equal(rules.followUp1, "EDITED");
      assert.equal(rules.delayDays, 3);
      assert.equal(rules.followUp2, "");
      assert.deepEqual(rules.bannedPhrases, ["just checking in", "bumping this", "following up on my last email"]);
    } finally { db.close(); }
  });

  it("resets a campaign to its client's defaults but keeps reached steps' types", async () => {
    const f = await fixture([{ kind: "linkedin", delayDays: 1, name: "Connect", length: "", instructions: "Connect" }]);
    try {
      const defaults = f.store.clientDefaultSequence(f.campaign.id);
      assert.deepEqual(defaults, defaultSequence());
      f.store.completeSequenceTask(f.first.id, 1, "DONE");
      assert.throws(() => f.store.updateCampaignSequence(f.campaign.id, { firstEmailGuidance: "", steps: defaults }), /must stay a task step/);
      const editor = renderSequenceEditor(f.store, f.store.getCampaign(f.campaign.id)!);
      assert.match(editor, /action="\/campaigns\/\d+\/sequence\/reset"/);
      assert.match(editor, /Acme's follow-up rules/);
    } finally { f.db.close(); }
  });
});
