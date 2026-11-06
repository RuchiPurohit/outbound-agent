import type { SqliteDatabase } from "./database.js";
import { randomUUID } from "node:crypto";
import { patternCandidates } from "../email/guessPatterns.js";
import {
  DEFAULT_STEP_DELAY_DAYS, defaultSetup, defaultSequence, defaultSequenceFromSetup, parseCampaignSequence, resolveSetup,
  sequenceFromClientSettings,
  type CampaignSequence, type ClientSetup, type FieldValue, type SectionId, type SequenceStep,
} from "../prompts/clientSetup.js";
import type {
  Campaign, CampaignStatus, ChatFeatureStatus, ChatImplementation, Company, CompanyScoreBreakdown,
  Contact, EmailGuessConfidence, EmailGuessPattern, EmailRecoveryOutcome, EmailStatus, FollowUpStep, GuessVerification, Outreach, ResearchRecord,
  ReviewStatus, WorkflowRun, WorkflowRunKind, ProspectResearch, EmailDelivery, Suppression, Client,
} from "./types.js";

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();

const addDays = (iso: string, days: number): Date => new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000);

/** A manual task step the human marked done or skipped. */
export interface SequenceTaskCompletion {
  step: number;
  status: "DONE" | "SKIPPED";
  note: string | null;
  completedAt: string;
}

/** One step after the first email, with where the prospect is in it. */
export interface SequenceStepState {
  /** 1-based position after the first email; follow-up emails store it as followUpStep. */
  step: number;
  def: SequenceStep;
  /** The step's current (non-rejected) email, for email steps that have a draft. */
  email?: Outreach;
  completion?: SequenceTaskCompletion;
  status: "SENT" | "DONE" | "SKIPPED" | "CURRENT" | "UPCOMING";
  /** For the current step: when it may be sent or done. */
  dueAt?: Date;
}

export interface SequenceState {
  steps: SequenceStepState[];
  current?: SequenceStepState;
  /** Every step was sent, done, or skipped. */
  done: boolean;
  /** The prospect replied or the first email bounced, so no further step runs. */
  stopped: boolean;
}

/** Local date and time a follow-up unlocks, e.g. "Oct 13, 2026, 2:34 PM". */
export function formatDueAt(date: Date): string {
  return date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

/** Follow-ups keep the original subject so they thread under the first touch. */
export function followUpSubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}
const scoreLimits: CompanyScoreBreakdown = {
  workflowFit: 30, chatImplementation: 20, timingSignal: 15,
  teamFit: 15, stackFit: 10, liveProduct: 10,
};

function checkedScore(breakdown: CompanyScoreBreakdown): number {
  const keys = Object.keys(scoreLimits) as Array<keyof CompanyScoreBreakdown>;
  for (const key of keys) {
    const value = breakdown[key];
    if (!Number.isInteger(value) || value < 0 || value > scoreLimits[key]) {
      throw new WorkflowError(`${key} score must be an integer from 0 to ${scoreLimits[key]}`);
    }
  }
  if (Object.keys(breakdown).length !== keys.length) {
    throw new WorkflowError("Score breakdown contains an unknown factor");
  }
  return keys.reduce((sum, key) => sum + breakdown[key], 0);
}

function checkPublicUrl(value: string | null, label: string): void {
  if (!value) return;
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new WorkflowError(`${label} must be a public HTTP(S) URL`); }
  if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new WorkflowError(`${label} must be a public HTTP(S) URL`);
  }
}

/** A personal LinkedIn profile URL; role sources and company pages are not profiles. */
export function checkedLinkedinProfile(value: string): string {
  const url = value.trim();
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new WorkflowError("LinkedIn profile must be a linkedin.com/in/ URL"); }
  if (parsed.protocol !== "https:" || !/(^|\.)linkedin\.com$/.test(parsed.hostname)
    || !/^\/in\/[^/]+\/?$/.test(parsed.pathname)) {
    throw new WorkflowError("LinkedIn profile must be a linkedin.com/in/ URL; record other pages as research sources");
  }
  return url;
}

function companyEmailDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new WorkflowError("Company domain is not valid for an email guess");
  }
  return domain;
}

/** The domain company mailboxes live on: the sourced email domain, else the website domain. */
export function mailDomainOf(company: Pick<Company, "domain" | "emailDomain">): string {
  return company.emailDomain ?? company.domain.trim().toLowerCase().replace(/^www\./, "");
}

/** SMTP detail written when the mail domain cannot receive mail (see smtpVerifier). */
const NO_MAIL_DETAIL = /has no MX records|does not accept mail \(null MX\)/;

function checkedGuessedEmail(value: string, company: Pick<Company, "domain" | "emailDomain">): string {
  const email = value.trim().toLowerCase();
  const match = /^([a-z0-9]+(?:[._-][a-z0-9]+)*)@([a-z0-9.-]+)$/.exec(email);
  if (!match || match[2] !== companyEmailDomain(mailDomainOf(company))) {
    throw new WorkflowError("Guessed email must be a valid address on the company domain (or its recorded email domain)");
  }
  return email;
}

export class WorkflowError extends Error {}

export interface ContactRecipient {
  address: string;
  guessed: boolean;
  /** SMTP verdict for a guessed address; null when sourced or not yet checked. */
  verification: GuessVerification | null;
}

export class OutboundStore {
  public constructor(private readonly db: SqliteDatabase) {}

  createCampaign(input: { name: string; segment: string; status?: CampaignStatus; clientId?: number; sequence?: CampaignSequence }): Campaign {
    const client = input.clientId === undefined ? undefined : this.requireClient(input.clientId);
    const sequence = input.sequence ?? { firstEmailGuidance: "", steps: client ? defaultSequenceFromSetup(client.setup) : defaultSequence() };
    const result = this.db.prepare(`
      INSERT INTO campaigns (name, segment, created_at, status, client_id, sequence) VALUES (?, ?, ?, ?, ?, ?)
    `).run(input.name, input.segment, now(), input.status ?? "DRAFT", input.clientId ?? null, JSON.stringify(sequence));
    return this.getCampaign(Number(result.lastInsertRowid))!;
  }

  /**
   * Creates the ConvoKit client from today's prompt values when no client exists yet, and
   * attaches campaigns created before clients existed to the first client.
   */
  ensureDefaultClient(): Client {
    return this.db.transaction(() => {
      const client = this.listClients()[0] ?? this.createClient({ name: "ConvoKit", setup: defaultSetup("convokit") });
      this.db.prepare("UPDATE campaigns SET client_id = ? WHERE client_id IS NULL").run(client.id);
      this.backfillConvokitClient();
      this.backfillCampaignSequences();
      return this.getClient(client.id)!;
    })();
  }

  /**
   * Gives each campaign created before campaigns had sequences its own copy of the sequence its
   * client described then (a saved client sequence, or its Follow-up 1/2 templates), otherwise
   * the standard one.
   */
  private backfillCampaignSequences(): void {
    const rows = this.db.prepare(`SELECT ca.id, cl.settings FROM campaigns ca LEFT JOIN clients cl ON cl.id = ca.client_id
      WHERE ca.sequence IS NULL`).all() as Row[];
    for (const row of rows) {
      const settings = row.settings ? JSON.parse(text(row, "settings")) as unknown : undefined;
      const steps = sequenceFromClientSettings(settings) ?? defaultSequence();
      this.db.prepare("UPDATE campaigns SET sequence = ? WHERE id = ?")
        .run(JSON.stringify({ firstEmailGuidance: "", steps }), integer(row, "id"));
    }
  }

  /**
   * Gives a ConvoKit client created by an earlier version the setup sections added since
   * (e.g. its documents), from today's values, without touching sections it already has.
   */
  private backfillConvokitClient(): void {
    const row = this.db.prepare("SELECT id, settings FROM clients WHERE name = 'ConvoKit' COLLATE NOCASE").get() as Row | undefined;
    if (!row) return;
    const stored = JSON.parse(text(row, "settings")) as Record<string, Record<string, unknown>>;
    const defaults = defaultSetup("convokit");
    let changed = false;
    // Follow-up templates moved back to the client: take them from a sequence an earlier
    // version saved on the client, so edits made there are kept.
    const saved = Array.isArray((stored as { sequence?: unknown }).sequence)
      ? ((stored as unknown as { sequence: SequenceStep[] }).sequence).filter(({ kind }) => kind === "email") : [];
    const followUps = stored["follow-up-generation"];
    if (followUps && !("followUp1" in followUps) && saved[0]) {
      Object.assign(followUps, { delayDays: saved[0].delayDays, followUp1Name: saved[0].name, followUp1Length: saved[0].length,
        followUp1: saved[0].instructions, followUp2Name: saved[1]?.name ?? "", followUp2Length: saved[1]?.length ?? "",
        followUp2: saved[1]?.instructions ?? "" });
      changed = true;
    }
    // Any section or input added since this client was saved gets today's ConvoKit value.
    for (const [sectionId, values] of Object.entries(defaults)) {
      if (!stored[sectionId]) { stored[sectionId] = values; changed = true; continue; }
      for (const [key, value] of Object.entries(values)) {
        if (!(key in stored[sectionId]!)) { stored[sectionId]![key] = value; changed = true; }
      }
    }
    // The client documents replace the repository docs an earlier version listed here.
    const docs = stored.profile?.referenceDocs;
    if (JSON.stringify(docs) === JSON.stringify(["AGENTS.md", "docs/ICP.md", "docs/PRODUCT.md", "docs/EMAIL_RULES.md"])) {
      stored.profile!.referenceDocs = ["AGENTS.md"]; changed = true;
    }
    if (changed) {
      this.db.prepare("UPDATE clients SET settings = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(stored), now(), integer(row, "id"));
    }
  }

  createClient(input: { name: string; setup?: ClientSetup }): Client {
    const name = input.name.trim();
    if (!name || name.length > 200) throw new WorkflowError("Client name is required (up to 200 characters)");
    if (this.listClients().some((client) => client.name.toLowerCase() === name.toLowerCase())) {
      throw new WorkflowError(`A client named ${name} already exists`);
    }
    const stamp = now();
    const result = this.db.prepare("INSERT INTO clients (name, settings, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(name, JSON.stringify(input.setup ?? defaultSetup("blank")), stamp, stamp);
    return this.getClient(Number(result.lastInsertRowid))!;
  }

  getClient(id: number): Client | undefined {
    const row = this.db.prepare("SELECT * FROM clients WHERE id = ?").get(id) as Row | undefined;
    return row ? clientFromRow(row) : undefined;
  }

  listClients(): Client[] {
    return (this.db.prepare("SELECT * FROM clients ORDER BY id").all() as Row[]).map(clientFromRow);
  }

  renameClient(id: number, name: string): Client {
    this.requireClient(id);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 200) throw new WorkflowError("Client name is required (up to 200 characters)");
    if (this.listClients().some((client) => client.id !== id && client.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new WorkflowError(`A client named ${trimmed} already exists`);
    }
    this.db.prepare("UPDATE clients SET name = ?, updated_at = ? WHERE id = ?").run(trimmed, now(), id);
    return this.getClient(id)!;
  }

  /** Replaces one setup section's inputs for a client. */
  updateClientSection(id: number, sectionId: SectionId, values: Record<string, FieldValue>): Client {
    const client = this.requireClient(id);
    const setup = resolveSetup({ ...client.setup, [sectionId]: values });
    this.db.prepare("UPDATE clients SET settings = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(setup), now(), id);
    return this.getClient(id)!;
  }

  private requireClient(id: number): Client {
    const client = this.getClient(id);
    if (!client) throw new WorkflowError("Client not found");
    return client;
  }

  getCampaign(id: number): Campaign | undefined {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as Row | undefined;
    return row ? campaignFromRow(row) : undefined;
  }

  listCampaigns(): Campaign[] {
    return (this.db.prepare("SELECT * FROM campaigns ORDER BY id").all() as Row[]).map(campaignFromRow);
  }

  updateCampaign(id: number, input: { name: string; segment: string }): Campaign {
    this.requireCampaign(id);
    const name = input.name.trim();
    const segment = input.segment.trim();
    if (!name || !segment) throw new WorkflowError("Campaign name and segment are required");
    this.db.prepare("UPDATE campaigns SET name = ?, segment = ? WHERE id = ?")
      .run(name, segment, id);
    return this.getCampaign(id)!;
  }

  setCampaignStatus(id: number, status: CampaignStatus): Campaign {
    this.requireCampaign(id);
    this.db.prepare("UPDATE campaigns SET status = ? WHERE id = ?").run(status, id);
    return this.getCampaign(id)!;
  }

  createCompany(input: {
    campaignId: number;
    name: string;
    domain: string;
    location?: string;
    locationSourceUrl?: string;
    employeeCount?: number;
    employeeCountRange?: string;
    employeeCountSourceUrl?: string;
    engineeringHeadcount?: number;
    engineeringHeadcountSourceUrl?: string;
    score?: number;
    scoreBreakdown?: CompanyScoreBreakdown;
    reason?: string;
    salesThesis?: string;
    chatFeatureStatus?: ChatFeatureStatus;
    chatFeatureSourceUrl?: string;
    chatImplementation?: ChatImplementation;
    chatVendorName?: string;
    chatImplementationSourceUrl?: string;
  }): Company {
    this.requireCampaign(input.campaignId);
    const chatFeatureStatus = input.chatFeatureStatus ?? "UNKNOWN";
    const chatFeatureSourceUrl = input.chatFeatureSourceUrl?.trim() || null;
    checkPublicUrl(chatFeatureSourceUrl, "Chat feature source");
    if (chatFeatureStatus === "PRESENT" && !chatFeatureSourceUrl) {
      throw new WorkflowError("A public source URL is required when chat is PRESENT");
    }
    if (chatFeatureStatus !== "PRESENT" && chatFeatureSourceUrl) {
      throw new WorkflowError("A chat source URL may only be stored when chat is PRESENT");
    }
    const employeeCountSourceUrl = input.employeeCountSourceUrl?.trim() || null;
    const engineeringHeadcountSourceUrl = input.engineeringHeadcountSourceUrl?.trim() || null;
    const locationSourceUrl = input.locationSourceUrl?.trim() || null;
    checkPublicUrl(employeeCountSourceUrl, "Headcount source");
    checkPublicUrl(engineeringHeadcountSourceUrl, "Engineering headcount source");
    checkPublicUrl(locationSourceUrl, "Location source");
    if (input.location && !locationSourceUrl) {
      throw new WorkflowError("A public source URL is required for location");
    }
    if (!input.location && locationSourceUrl) {
      throw new WorkflowError("A location source requires a location");
    }
    const employeeCountRange = input.employeeCountRange?.trim() || null;
    if ((input.employeeCount !== undefined || employeeCountRange) && !employeeCountSourceUrl) {
      throw new WorkflowError("A source URL is required for employee headcount");
    }
    if (employeeCountSourceUrl && input.employeeCount === undefined && !employeeCountRange) {
      throw new WorkflowError("A headcount source requires a stated count or range");
    }
    if (input.employeeCount !== undefined && employeeCountRange) {
      throw new WorkflowError("Use either a stated headcount or a range, not both");
    }
    if (input.engineeringHeadcount !== undefined && !engineeringHeadcountSourceUrl) {
      throw new WorkflowError("A source URL is required for engineering headcount");
    }
    if (input.engineeringHeadcount === undefined && engineeringHeadcountSourceUrl) {
      throw new WorkflowError("An engineering headcount source requires a stated count");
    }
    const chatImplementation = input.chatImplementation ?? "UNKNOWN";
    const chatVendorName = input.chatVendorName?.trim() || null;
    const chatImplementationSourceUrl = input.chatImplementationSourceUrl?.trim() || null;
    checkPublicUrl(chatImplementationSourceUrl, "Chat implementation source");
    if (chatImplementation === "VENDOR" && (!chatVendorName || !chatImplementationSourceUrl)) {
      throw new WorkflowError("A named vendor and public source URL are required for VENDOR chat");
    }
    if ((chatImplementation === "HOMEGROWN" || chatImplementation === "EXTERNAL")
      && !chatImplementationSourceUrl) {
      throw new WorkflowError("A public source URL is required for a known chat implementation");
    }
    if (chatImplementation !== "VENDOR" && chatVendorName) {
      throw new WorkflowError("Chat vendor name is only valid for VENDOR implementation");
    }
    if ((chatImplementation === "NONE_FOUND" || chatImplementation === "UNKNOWN")
      && chatImplementationSourceUrl) {
      throw new WorkflowError("A chat implementation source is only valid for a known implementation");
    }
    if (input.score !== undefined && !input.scoreBreakdown) {
      throw new WorkflowError("New company scores require a weighted scoreBreakdown");
    }
    if (input.scoreBreakdown && !input.salesThesis?.trim()) {
      throw new WorkflowError("A sales thesis is required with a company score");
    }
    const score = input.scoreBreakdown ? checkedScore(input.scoreBreakdown) : null;
    if (input.scoreBreakdown && input.score !== undefined && input.score !== score) {
      throw new WorkflowError("Company score must equal its weighted breakdown");
    }
    const result = this.db.prepare(`
      INSERT INTO companies (
        campaign_id, name, domain, location, employee_count, score, reason,
        chat_feature_status, chat_feature_source_url, employee_count_range,
        employee_count_source_url, engineering_headcount, engineering_headcount_source_url,
        location_source_url, score_breakdown, sales_thesis,
        chat_implementation, chat_vendor_name, chat_implementation_source_url,
        status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED', ?)
    `).run(
      input.campaignId, input.name, input.domain, input.location ?? null,
      input.employeeCount ?? null, score, input.reason ?? null,
      chatFeatureStatus, chatFeatureSourceUrl, employeeCountRange,
      employeeCountSourceUrl, input.engineeringHeadcount ?? null,
      engineeringHeadcountSourceUrl, locationSourceUrl,
      input.scoreBreakdown ? JSON.stringify(input.scoreBreakdown) : null,
      input.salesThesis?.trim() || null, chatImplementation, chatVendorName,
      chatImplementationSourceUrl, now(),
    );
    return this.getCompany(Number(result.lastInsertRowid))!;
  }

  getCompany(id: number): Company | undefined {
    const row = this.db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as Row | undefined;
    return row ? companyFromRow(row) : undefined;
  }

  listCompanies(filters: { campaignId?: number; status?: ReviewStatus } = {}): Company[] {
    const clauses: string[] = [];
    const values: Array<number | string> = [];
    if (filters.campaignId !== undefined) {
      clauses.push("campaign_id = ?");
      values.push(filters.campaignId);
    }
    if (filters.status !== undefined) {
      clauses.push("status = ?");
      values.push(filters.status);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM companies${where} ORDER BY id`).all(...values) as Row[])
      .map(companyFromRow);
  }

  reviewCompanies(ids: number[], decision: Exclude<ReviewStatus, "DISCOVERED">): Company[] {
    if (ids.length === 0) throw new WorkflowError("At least one company ID is required");
    return this.db.transaction(() => ids.map((id) => {
      this.requireCompany(id);
      this.db.prepare("UPDATE companies SET status = ? WHERE id = ?").run(decision, id);
      return this.getCompany(id)!;
    }))();
  }

  reviewCompany(id: number, decision: Exclude<ReviewStatus, "DISCOVERED">): Company {
    return this.reviewCompanies([id], decision)[0];
  }

  createResearchRecord(input: {
    companyId: number;
    contactId?: number;
    signal: string;
    sourceUrl: string;
    notes?: string;
  }): ResearchRecord {
    this.requireCompany(input.companyId);
    if (input.contactId !== undefined) {
      const contact = this.requireContact(input.contactId);
      if (contact.companyId !== input.companyId) {
        throw new WorkflowError("Research contact does not belong to the company");
      }
    }
    const result = this.db.prepare(`
      INSERT INTO research (company_id, contact_id, signal, source_url, notes)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.companyId, input.contactId ?? null, input.signal, input.sourceUrl,
      input.notes ?? null,
    );
    return this.getResearchRecord(Number(result.lastInsertRowid))!;
  }

  getResearchRecord(id: number): ResearchRecord | undefined {
    const row = this.db.prepare("SELECT * FROM research WHERE id = ?").get(id) as Row | undefined;
    return row ? researchFromRow(row) : undefined;
  }

  listResearch(companyId: number): ResearchRecord[] {
    this.requireCompany(companyId);
    return (this.db.prepare("SELECT * FROM research WHERE company_id = ? ORDER BY id")
      .all(companyId) as Row[]).map(researchFromRow);
  }

  createContact(input: {
    companyId: number;
    name: string;
    title?: string;
    roleCategory?: string;
    roleScore?: number;
    linkedinUrl?: string;
    email?: string;
    emailStatus?: EmailStatus;
  }): Contact {
    const company = this.requireCompany(input.companyId);
    if (company.status !== "APPROVED") {
      throw new WorkflowError("Contacts may only be added to APPROVED companies");
    }
    const result = this.db.prepare(`
      INSERT INTO contacts (
        company_id, name, title, role_category, role_score, linkedin_url,
        email, email_status, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED')
    `).run(
      input.companyId, input.name, input.title ?? null, input.roleCategory ?? null,
      input.roleScore ?? null, input.linkedinUrl ? checkedLinkedinProfile(input.linkedinUrl) : null, input.email ?? null,
      input.emailStatus ?? "UNKNOWN",
    );
    return this.getContact(Number(result.lastInsertRowid))!;
  }

  /** Sets a contact's verified LinkedIn profile, replacing any non-LinkedIn page stored there. */
  recordLinkedinProfile(input: { contactId: number; linkedinUrl: string }): Contact {
    const linkedinUrl = checkedLinkedinProfile(input.linkedinUrl);
    const contact = this.requireContact(input.contactId);
    if (contact.linkedinUrl && contact.linkedinUrl !== linkedinUrl && /linkedin\.com\/in\//.test(contact.linkedinUrl)) {
      throw new WorkflowError("This contact already has a different LinkedIn profile");
    }
    this.db.prepare("UPDATE contacts SET linkedin_url = ? WHERE id = ?").run(linkedinUrl, contact.id);
    return this.getContact(contact.id)!;
  }

  getContact(id: number): Contact | undefined {
    const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined;
    return row ? contactFromRow(row) : undefined;
  }

  listContacts(companyId?: number): Contact[] {
    const rows = companyId === undefined
      ? this.db.prepare("SELECT * FROM contacts ORDER BY id").all()
      : this.db.prepare("SELECT * FROM contacts WHERE company_id = ? ORDER BY id").all(companyId);
    return (rows as Row[]).map(contactFromRow);
  }

  recordEmailDiscovery(input: {
    contactId: number;
    emailStatus: Exclude<EmailStatus, "UNKNOWN">;
    email?: string;
    sourceUrl?: string;
    notes?: string;
  }): Contact {
    return this.db.transaction(() => {
      const contact = this.requireContact(input.contactId);
      if (contact.status !== "APPROVED") {
        throw new WorkflowError("Email discovery is only allowed for APPROVED contacts");
      }

      const found = input.emailStatus === "PUBLICLY_LISTED" || input.emailStatus === "VERIFIED";
      if (found && (!input.email || !input.sourceUrl)) {
        throw new WorkflowError("A found email requires the exact address and an evidence URL");
      }
      if (!found && input.email) {
        throw new WorkflowError("EMAIL_NOT_FOUND cannot include an email address");
      }
      // Re-recording EMAIL_NOT_FOUND changes nothing; keep the guess and its SMTP/recovery evidence.
      if (!found && contact.emailStatus === "EMAIL_NOT_FOUND") return contact;

      this.db.prepare(`UPDATE contacts SET email = ?, email_status = ?,
        guessed_email = NULL, guessed_email_pattern = NULL,
        guessed_email_confidence = NULL, guessed_email_basis = NULL,
        guessed_email_source_url = NULL, guessed_email_verification = NULL,
        guessed_email_verification_detail = NULL, guessed_email_verified_at = NULL,
        guessed_email_source = NULL, guessed_email_candidates_checked = NULL WHERE id = ?`)
        .run(found ? input.email : null, input.emailStatus, input.contactId);

      if (found) {
        this.createResearchRecord({
          companyId: contact.companyId,
          contactId: contact.id,
          signal: `Professional business email ${input.emailStatus.toLowerCase()}: ${input.email}`,
          sourceUrl: input.sourceUrl!,
          notes: input.notes ?? "Email discovery evidence",
        });
      }
      return this.getContact(input.contactId)!;
    })();
  }

  /**
   * Stores an address the human found or verified from an external source. It replaces any
   * guess and keeps a research record pointing at the source the human supplied.
   */
  recordManualEmail(input: {
    contactId: number;
    email: string;
    emailStatus: "PUBLICLY_LISTED" | "VERIFIED";
    sourceUrl: string;
    note?: string;
  }): Contact {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@<>"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)) {
      throw new WorkflowError("Enter a valid email address");
    }
    if (input.emailStatus !== "PUBLICLY_LISTED" && input.emailStatus !== "VERIFIED") {
      throw new WorkflowError("Choose whether the email is verified or publicly listed");
    }
    const sourceUrl = input.sourceUrl.trim();
    if (!sourceUrl) throw new WorkflowError("A manual email requires the source URL where you found or verified it");
    checkPublicUrl(sourceUrl, "Email source");
    const note = input.note?.trim().slice(0, 1000);
    return this.db.transaction(() => {
      const contact = this.requireContact(input.contactId);
      this.db.prepare(`UPDATE contacts SET email = ?, email_status = ?,
        guessed_email = NULL, guessed_email_pattern = NULL,
        guessed_email_confidence = NULL, guessed_email_basis = NULL,
        guessed_email_source_url = NULL, guessed_email_verification = NULL,
        guessed_email_verification_detail = NULL, guessed_email_verified_at = NULL,
        guessed_email_source = NULL, guessed_email_candidates_checked = NULL WHERE id = ?`)
        .run(email, input.emailStatus, contact.id);
      this.createResearchRecord({
        companyId: contact.companyId,
        contactId: contact.id,
        signal: `Professional business email ${input.emailStatus.toLowerCase()}: ${email}`,
        sourceUrl,
        notes: `Manually entered by the user${note ? `: ${note}` : ""}`,
      });
      return this.getContact(contact.id)!;
    })();
  }

  recordEmailGuess(input: {
    contactId: number;
    guessedEmail: string;
    pattern: EmailGuessPattern;
    confidence: EmailGuessConfidence;
    basis: string;
    sourceUrl?: string;
  }): Contact {
    const contact = this.requireContact(input.contactId);
    if (contact.status !== "APPROVED") {
      throw new WorkflowError("Email guessing is only allowed for APPROVED contacts");
    }
    if (contact.emailStatus !== "EMAIL_NOT_FOUND" || contact.email) {
      throw new WorkflowError("An email guess may only follow an EMAIL_NOT_FOUND result");
    }
    const company = this.requireCompany(contact.companyId);
    const guessedEmail = checkedGuessedEmail(input.guessedEmail, company);
    const basis = input.basis.trim();
    if (!basis) throw new WorkflowError("An email guess requires a basis");
    const sourceUrl = input.sourceUrl?.trim() || null;
    checkPublicUrl(sourceUrl, "Email pattern source");
    if (input.confidence === "PATTERN_SUPPORTED" && !sourceUrl) {
      throw new WorkflowError("PATTERN_SUPPORTED guesses require a public pattern source URL");
    }
    if (input.confidence !== "PATTERN_SUPPORTED" && sourceUrl) {
      throw new WorkflowError("A pattern source URL is only valid for PATTERN_SUPPORTED guesses");
    }
    this.db.prepare(`UPDATE contacts SET guessed_email = ?, guessed_email_pattern = ?,
      guessed_email_confidence = ?, guessed_email_basis = ?, guessed_email_source_url = ?,
      guessed_email_verification = NULL, guessed_email_verification_detail = NULL,
      guessed_email_verified_at = NULL, guessed_email_source = 'PATTERN',
      guessed_email_candidates_checked = NULL
      WHERE id = ?`).run(
      guessedEmail, input.pattern, input.confidence, basis, sourceUrl, input.contactId,
    );
    return this.getContact(input.contactId)!;
  }

  /** Approved guesses in the campaign that have no conclusive SMTP verdict yet. */
  listGuessesAwaitingVerification(campaignId: number, options: { includeInconclusive?: boolean } = {}): Contact[] {
    return this.listCompanies({ campaignId, status: "APPROVED" })
      .flatMap(({ id }) => this.listContacts(id))
      .filter((contact) => contact.status === "APPROVED" && contact.emailStatus === "EMAIL_NOT_FOUND"
        && !contact.email && !!contact.guessedEmail
        && (contact.guessedEmailVerification === null
          // INVALID from a single-guess check that predates multi-pattern probing: retry all patterns.
          || (contact.guessedEmailVerification === "INVALID" && contact.guessedEmailSource === "PATTERN"
            && contact.guessedEmailCandidatesChecked === null)
          || (options.includeInconclusive === true && contact.guessedEmailVerification === "UNKNOWN")));
  }

  /**
   * Stores an SMTP verdict on a guess. It annotates the guess only: the contact stays
   * EMAIL_NOT_FOUND and the address never moves into contacts.email.
   */
  recordGuessVerification(input: {
    contactId: number;
    guessedEmail: string;
    verdict: GuessVerification;
    detail: string;
    /** Another pattern the mail server accepted after rejecting the stored guess. */
    replacement?: { email: string; pattern: EmailGuessPattern };
    /** How many addresses were offered to the check (stored guess plus alternatives). */
    candidatesChecked?: number;
  }): Contact {
    return this.db.transaction(() => {
      const contact = this.requireContact(input.contactId);
      if (contact.emailStatus !== "EMAIL_NOT_FOUND" || contact.email || !contact.guessedEmail) {
        throw new WorkflowError("Only guessed emails for EMAIL_NOT_FOUND contacts can be SMTP-verified");
      }
      if (contact.guessedEmail.toLowerCase() !== input.guessedEmail.toLowerCase()) {
        throw new WorkflowError("The guessed email changed during verification; verify it again");
      }
      if (input.replacement) {
        if (contact.guessedEmailSource !== "PATTERN") {
          throw new WorkflowError("Only pattern guesses can be replaced by another SMTP-checked pattern");
        }
        const company = this.requireCompany(contact.companyId);
        const email = checkedGuessedEmail(input.replacement.email, company);
        const basis = `SMTP check accepted the ${input.replacement.pattern} pattern after rejecting the stored guess `
          + `${contact.guessedEmail} (${contact.guessedEmailPattern}). Earlier basis: ${contact.guessedEmailBasis}`;
        this.db.prepare(`UPDATE contacts SET guessed_email = ?, guessed_email_pattern = ?,
          guessed_email_confidence = 'COMMON_PATTERN', guessed_email_basis = ?, guessed_email_source_url = NULL
          WHERE id = ?`).run(email, input.replacement.pattern, basis, contact.id);
      }
      this.db.prepare(`UPDATE contacts SET guessed_email_verification = ?,
        guessed_email_verification_detail = ?, guessed_email_verified_at = ?,
        guessed_email_candidates_checked = ? WHERE id = ?`)
        .run(input.verdict, input.detail.slice(0, 1000), now(), input.candidatesChecked ?? 1, input.contactId);
      return this.getContact(input.contactId)!;
    })();
  }

  /**
   * Pattern guesses whose SMTP check was invalid, catch-all, or inconclusive and that have no
   * recorded Treg outcome. Contacts with a VERIFIED, CATCH_ALL_CANDIDATE, or NOT_FOUND outcome
   * are never recovered again. A contact whose recovery hit a provider error, or whose run
   * ended without recording an outcome, is eligible again once no workflow is active.
   */
  listEmailRecoveryCandidates(campaignId: number): Contact[] {
    const active = this.listWorkflowRuns(campaignId)
      .some(({ status }) => status === "RUNNING" || status === "PENDING");
    return this.listCompanies({ campaignId, status: "APPROVED" })
      .flatMap(({ id }) => this.listContacts(id))
      .filter((contact) => contact.status === "APPROVED" && contact.emailStatus === "EMAIL_NOT_FOUND"
        && !contact.email && !!contact.guessedEmail && contact.guessedEmailSource === "PATTERN"
        && contact.emailRecoveryOutcome === null && (contact.emailRecoveryStartedAt === null || !active)
        && ["INVALID", "CATCH_ALL", "UNKNOWN"].includes(contact.guessedEmailVerification ?? ""));
  }

  /**
   * Pattern guesses on domains where SMTP could not confirm the mailbox (catch-all, invalid,
   * or inconclusive) that lack public pattern evidence and have never been searched for it.
   * A guess whose domain cannot receive mail (no MX) is also a candidate once per company, so
   * the search can find the domain staff actually use.
   */
  listPatternEvidenceCandidates(campaignId: number): Contact[] {
    return this.listCompanies({ campaignId, status: "APPROVED" })
      .flatMap((company) => this.listContacts(company.id)
        .filter((contact) => contact.status === "APPROVED" && contact.emailStatus === "EMAIL_NOT_FOUND"
          && !contact.email && !!contact.guessedEmail && contact.guessedEmailSource === "PATTERN"
          && ["INVALID", "CATCH_ALL", "UNKNOWN"].includes(contact.guessedEmailVerification ?? "")
          && ((contact.guessedEmailConfidence !== "PATTERN_SUPPORTED" && contact.patternEvidenceCheckedAt === null)
            || (this.needsEmailDomainSearch(company, contact)))));
  }

  /** The guess's domain has no mail server and no other email domain has been searched for. */
  private needsEmailDomainSearch(company: Company, contact: Contact): boolean {
    return company.emailDomainCheckedAt === null && contact.guessedEmailVerification === "INVALID"
      && NO_MAIL_DETAIL.test(contact.guessedEmailVerificationDetail ?? "");
  }

  /** Marks contacts as searched for pattern evidence so the free search runs once per contact. */
  markPatternEvidenceStarted(campaignId: number, contactIds: number[]): void {
    this.db.transaction(() => {
      const candidates = new Map(this.listPatternEvidenceCandidates(campaignId).map((contact) => [contact.id, contact]));
      for (const id of contactIds) {
        const contact = candidates.get(id);
        if (!contact) throw new WorkflowError(`Contact ${id} is not awaiting a pattern-evidence search`);
        this.db.prepare("UPDATE contacts SET pattern_evidence_checked_at = ? WHERE id = ?").run(now(), id);
        if (this.needsEmailDomainSearch(this.requireCompany(contact.companyId), contact)) {
          this.db.prepare("UPDATE companies SET email_domain_checked_at = ? WHERE id = ?").run(now(), contact.companyId);
        }
      }
    })();
  }

  /**
   * Records the domain company staff use for email when it differs from the website domain,
   * backed by a public page that shows an address on it. Pattern guesses on the old domain
   * move to the same pattern on the new one and are queued for a fresh SMTP check.
   */
  recordCompanyEmailDomain(input: { companyId: number; emailDomain: string; sourceUrl: string; basis: string }): Company {
    const emailDomain = companyEmailDomain(input.emailDomain);
    const sourceUrl = input.sourceUrl.trim();
    const basis = input.basis.trim();
    if (!sourceUrl) throw new WorkflowError("An email domain requires a public source URL showing an address on it");
    checkPublicUrl(sourceUrl, "Email domain source");
    if (!basis) throw new WorkflowError("An email domain requires a basis naming the observed address");
    if (/^(gmail|googlemail|yahoo|hotmail|outlook|live|icloud|me|aol|proton|protonmail|gmx)\./.test(emailDomain)) {
      throw new WorkflowError("A personal email provider cannot be a company email domain");
    }
    return this.db.transaction(() => {
      const company = this.requireCompany(input.companyId);
      const previous = mailDomainOf(company);
      const website = mailDomainOf({ ...company, emailDomain: null });
      this.db.prepare(`UPDATE companies SET email_domain = ?, email_domain_source_url = ?, email_domain_basis = ?,
        email_domain_checked_at = COALESCE(email_domain_checked_at, ?) WHERE id = ?`)
        .run(emailDomain === website ? null : emailDomain, sourceUrl, basis.slice(0, 1000), now(), company.id);
      if (previous === emailDomain) return this.getCompany(company.id)!;
      for (const contact of this.listContacts(company.id)) {
        if (contact.emailStatus !== "EMAIL_NOT_FOUND" || contact.email || !contact.guessedEmail
          || contact.guessedEmailSource !== "PATTERN" || !contact.guessedEmail.endsWith(`@${previous}`)) continue;
        const local = contact.guessedEmail.slice(0, -previous.length - 1);
        const moved = patternCandidates(contact.name, emailDomain)
          .find(({ pattern }) => pattern === contact.guessedEmailPattern)?.email ?? `${local}@${emailDomain}`;
        this.db.prepare(`UPDATE contacts SET guessed_email = ?, guessed_email_basis = ?,
          guessed_email_verification = NULL, guessed_email_verification_detail = NULL,
          guessed_email_verified_at = NULL, guessed_email_candidates_checked = NULL WHERE id = ?`)
          .run(moved, `${contact.guessedEmailBasis ?? ""} Moved from ${previous} to the company's email domain ${emailDomain} (${sourceUrl}).`.trim(), contact.id);
      }
      return this.getCompany(company.id)!;
    })();
  }

  /** Marks contacts as handed to Treg recovery before the workflow spends any credits. */
  markEmailRecoveryStarted(campaignId: number, contactIds: number[]): void {
    this.db.transaction(() => {
      const allowed = new Set(this.listEmailRecoveryCandidates(campaignId).map(({ id }) => id));
      for (const id of contactIds) {
        if (!allowed.has(id)) throw new WorkflowError(`Contact ${id} is not awaiting Treg recovery`);
        this.db.prepare(`UPDATE contacts SET email_recovery_started_at = ?, email_recovery_outcome = NULL,
          email_recovery_notes = NULL, email_recovery_error = NULL WHERE id = ?`).run(now(), id);
      }
    })();
  }

  /**
   * Records the Treg recovery outcome for a contact handed to recovery.
   * VERIFIED requires an exact Treg `valid` verdict and promotes the address.
   * CATCH_ALL_CANDIDATE replaces the pattern guess with Treg's found address, still as an
   * unverified guess. NOT_FOUND keeps the existing guess and its SMTP evidence.
   * PROVIDER_ERROR (credits, quota, outage) keeps the guess and requeues the contact.
   */
  recordEmailRecovery(input: {
    contactId: number;
    outcome: EmailRecoveryOutcome | "PROVIDER_ERROR";
    email?: string;
    sourceUrl?: string;
    notes: string;
  }): Contact {
    return this.db.transaction(() => {
      const contact = this.requireContact(input.contactId);
      if (contact.status !== "APPROVED" || contact.emailStatus !== "EMAIL_NOT_FOUND"
        || !contact.emailRecoveryStartedAt || contact.emailRecoveryOutcome !== null) {
        throw new WorkflowError("Only approved EMAIL_NOT_FOUND contacts with a pending Treg recovery can record an outcome");
      }
      const notes = input.notes.trim();
      if (!notes) throw new WorkflowError("Treg recovery requires provenance notes (call IDs, providers, verdict, cost)");
      if (input.outcome === "PROVIDER_ERROR") {
        if (input.email) throw new WorkflowError("PROVIDER_ERROR recovery cannot include an email address");
        this.db.prepare(`UPDATE contacts SET email_recovery_started_at = NULL, email_recovery_error = ?
          WHERE id = ?`).run(notes.slice(0, 1000), contact.id);
        return this.getContact(contact.id)!;
      }
      if (input.outcome === "NOT_FOUND") {
        if (input.email) throw new WorkflowError("NOT_FOUND recovery cannot include an email address");
      } else {
        if (!input.email || !input.sourceUrl) {
          throw new WorkflowError("A Treg recovery result requires the exact address and the verifier audit URL");
        }
        checkPublicUrl(input.sourceUrl, "Treg verifier audit");
      }
      if (input.outcome === "VERIFIED") {
        this.recordEmailDiscovery({ contactId: contact.id, emailStatus: "VERIFIED",
          email: input.email, sourceUrl: input.sourceUrl, notes });
      } else if (input.outcome === "CATCH_ALL_CANDIDATE") {
        const company = this.requireCompany(contact.companyId);
        const guessedEmail = checkedGuessedEmail(input.email!, company);
        this.db.prepare(`UPDATE contacts SET guessed_email = ?, guessed_email_source = 'TREG_CATCH_ALL',
          guessed_email_pattern = NULL, guessed_email_confidence = NULL, guessed_email_basis = ?,
          guessed_email_source_url = ?, guessed_email_verification = 'CATCH_ALL',
          guessed_email_verification_detail = 'Treg verifier returned catch_all; the mailbox cannot be confirmed',
          guessed_email_verified_at = ? WHERE id = ?`)
          .run(guessedEmail, notes, input.sourceUrl, now(), contact.id);
      }
      this.db.prepare(`UPDATE contacts SET email_recovery_outcome = ?, email_recovery_notes = ?,
        email_recovery_error = NULL WHERE id = ?`).run(input.outcome, notes.slice(0, 4000), contact.id);
      return this.getContact(contact.id)!;
    })();
  }

  reviewContact(id: number, decision: Exclude<ReviewStatus, "DISCOVERED">): Contact {
    return this.reviewContacts([id], decision)[0];
  }

  reviewContacts(ids: number[], decision: Exclude<ReviewStatus, "DISCOVERED">): Contact[] {
    if (ids.length === 0) throw new WorkflowError("At least one contact ID is required");
    return this.db.transaction(() => ids.map((id) => {
      this.requireContact(id);
      this.db.prepare("UPDATE contacts SET status = ? WHERE id = ?").run(decision, id);
      return this.getContact(id)!;
    }))();
  }

  saveProspectResearch(input: {
    contactId: number;
    signals: Array<{ signal: string; sourceUrl: string; notes?: string }>;
    strongestSignalIndex?: number;
    painHypothesis?: string;
    relevance?: string;
    notes?: string;
  }): ProspectResearch {
    return this.db.transaction(() => {
      this.requireResearchEligible(input.contactId);
      if (this.getProspectResearch(input.contactId)) {
        throw new WorkflowError("Prospect research already exists; do not duplicate completed research");
      }
      if (input.signals.length > 3) throw new WorkflowError("At most three prospect signals are allowed");
      const ready = input.signals.length > 0;
      if (ready && (!Number.isInteger(input.strongestSignalIndex)
        || input.strongestSignalIndex! < 0 || input.strongestSignalIndex! >= input.signals.length
        || !input.painHypothesis?.trim() || !input.relevance?.trim())) {
        throw new WorkflowError("Select a strongest signal, pain hypothesis, and ConvoKit relevance");
      }
      const contact = this.requireContact(input.contactId);
      const records = input.signals.map((signal) => {
        this.requireSourceUrl(signal.sourceUrl);
        return this.createResearchRecord({ ...signal, companyId: contact.companyId, contactId: contact.id });
      });
      this.db.prepare(`
        INSERT INTO prospect_research (
          contact_id, status, strongest_research_id, pain_hypothesis, relevance, notes, researched_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(input.contactId, ready ? "READY" : "NO_SIGNAL",
        ready ? records[input.strongestSignalIndex!]!.id : null,
        ready ? input.painHypothesis : null, ready ? input.relevance : null, input.notes ?? null, now());
      for (const record of records) {
        this.db.prepare("INSERT INTO prospect_research_signals (contact_id, research_id) VALUES (?, ?)")
          .run(contact.id, record.id);
      }
      return this.getProspectResearch(input.contactId)!;
    })();
  }

  /**
   * Clears a NO_SIGNAL research result so the next prospect research run looks again, along
   * with every other NO_SIGNAL colleague at the same company that has no outreach and is still
   * research-eligible: an angle is mostly company-level. READY research is never reset, and
   * sourced research records stay. Returns the contacts that were reset.
   */
  resetNoSignalResearch(contactId: number): Contact[] {
    return this.db.transaction(() => {
      const contact = this.requireContact(contactId);
      const analysis = this.getProspectResearch(contactId);
      if (analysis?.status !== "NO_SIGNAL") throw new WorkflowError("Only a NO_SIGNAL research result can be rechecked");
      if (this.listOutreach(contactId).length > 0) throw new WorkflowError("This contact already has outreach");
      const company = this.requireCompany(contact.companyId);
      const eligible = new Set(this.listResearchEligibleProspects(company.campaignId).map(({ id }) => id));
      const reset = [contact, ...this.listContacts(company.id).filter((colleague) => colleague.id !== contact.id
        && eligible.has(colleague.id) && this.getProspectResearch(colleague.id)?.status === "NO_SIGNAL"
        && this.listOutreach(colleague.id).length === 0)];
      for (const { id } of reset) this.db.prepare("DELETE FROM prospect_research WHERE contact_id = ?").run(id);
      return reset;
    })();
  }

  /** Rechecks several NO_SIGNAL prospects (and their NO_SIGNAL colleagues) in one transaction. */
  resetNoSignalResearchMany(contactIds: number[]): Contact[] {
    return this.db.transaction(() => {
      const reset = new Map<number, Contact>();
      for (const id of contactIds) {
        // A colleague already reset alongside an earlier selection needs no second reset.
        if (reset.has(id)) continue;
        for (const contact of this.resetNoSignalResearch(id)) reset.set(contact.id, contact);
      }
      return [...reset.values()];
    })();
  }

  getProspectResearch(contactId: number): ProspectResearch | undefined {
    const row = this.db.prepare("SELECT * FROM prospect_research WHERE contact_id = ?")
      .get(contactId) as Row | undefined;
    return row ? {
      contactId: integer(row, "contact_id"), status: text(row, "status") as ProspectResearch["status"],
      strongestResearchId: nullableInteger(row, "strongest_research_id"),
      painHypothesis: nullableText(row, "pain_hypothesis"), relevance: nullableText(row, "relevance"),
      notes: nullableText(row, "notes"), researchedAt: text(row, "researched_at"),
    } : undefined;
  }

  listProspectSignals(contactId: number): ResearchRecord[] {
    return (this.db.prepare(`
      SELECT r.* FROM research r JOIN prospect_research_signals s ON s.research_id = r.id
      WHERE s.contact_id = ? ORDER BY r.id
    `).all(contactId) as Row[]).map(researchFromRow);
  }

  listEligibleProspects(campaignId: number): Contact[] {
    return this.listCompanies({ campaignId, status: "APPROVED" })
      .flatMap(({ id }) => this.listContacts(id))
      .filter((contact) => contact.status === "APPROVED" && !!this.recipientFor(contact)
        && !this.isContactSuppressed(contact));
  }

  /**
   * Adds addresses that replied "not interested" to the do-not-contact list. Matching contacts in
   * every campaign are blocked from research, drafting, approval, and sending, and their sent
   * first-touch emails are marked REPLIED so no follow-up goes out. Colleagues stay contactable.
   */
  addSuppressions(emails: string[], note?: string): { added: Suppression[]; alreadyListed: string[]; repliedOutreach: number } {
    const addresses = [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))];
    if (addresses.length === 0) throw new WorkflowError("Enter at least one email address");
    if (addresses.length > 200) throw new WorkflowError("Add at most 200 addresses at a time");
    const invalid = addresses.filter((email) => email.length > 254 || email.includes("..")
      || !/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email));
    if (invalid.length) throw new WorkflowError(`Not a valid email address: ${invalid.join(", ")}`);
    const cleanNote = note?.trim() || null;
    if (cleanNote && cleanNote.length > 1000) throw new WorkflowError("Keep the note under 1000 characters");
    return this.db.transaction(() => {
      const added: Suppression[] = [];
      const alreadyListed: string[] = [];
      let repliedOutreach = 0;
      for (const email of addresses) {
        if (this.db.prepare("SELECT 1 FROM suppressions WHERE email = ?").get(email)) { alreadyListed.push(email); continue; }
        const result = this.db.prepare("INSERT INTO suppressions (email, note, created_at) VALUES (?, ?, ?)")
          .run(email, cleanNote, now());
        added.push(this.listSuppressions().find(({ id }) => id === Number(result.lastInsertRowid))!);
        for (const contact of this.listSuppressionMatches(email)) {
          for (const outreach of this.listOutreach(contact.id)) {
            if (outreach.status === "SENT") { this.markOutreachReplied(outreach.id); repliedOutreach += 1; }
          }
        }
      }
      return { added, alreadyListed, repliedOutreach };
    })();
  }

  /** Removes an address from the do-not-contact list; emails already marked REPLIED stay REPLIED. */
  removeSuppression(id: number): Suppression {
    const suppression = this.listSuppressions().find((item) => item.id === id);
    if (!suppression) throw new WorkflowError("Address is not on the do-not-contact list");
    this.db.prepare("DELETE FROM suppressions WHERE id = ?").run(id);
    return suppression;
  }

  listSuppressions(): Suppression[] {
    return (this.db.prepare("SELECT * FROM suppressions ORDER BY created_at DESC, id DESC").all() as Row[])
      .map((row) => ({ id: Number(row.id), email: text(row, "email"), reason: "NOT_INTERESTED",
        note: nullableText(row, "note"), createdAt: text(row, "created_at") }));
  }

  /** Contacts in any campaign whose sourced or guessed email is this address. */
  listSuppressionMatches(email: string): Contact[] {
    return (this.db.prepare("SELECT * FROM contacts WHERE lower(email) = ? OR lower(guessed_email) = ? ORDER BY id")
      .all(email.toLowerCase(), email.toLowerCase()) as Row[]).map(contactFromRow);
  }

  isContactSuppressed(contact: Contact): boolean {
    const addresses = [contact.email, contact.guessedEmail].filter((value): value is string => !!value)
      .map((value) => value.toLowerCase());
    return addresses.some((email) => !!this.db.prepare("SELECT 1 FROM suppressions WHERE email = ?").get(email));
  }

  listResearchEligibleProspects(campaignId: number): Contact[] {
    return this.listEligibleProspects(campaignId);
  }

  getContactRecipient(contactId: number): ContactRecipient | undefined {
    return this.recipientFor(this.requireContact(contactId));
  }

  createOutreach(input: { contactId: number; subject: string; body: string; researchId?: number }): Outreach {
    return this.db.transaction(() => {
      this.requireDraftEvidence(input.contactId, input.researchId);
      const activeRun = this.listWorkflowRuns().find(({ status }) => status === "RUNNING" || status === "PENDING");
      if (activeRun) {
        const selection = activeRun.details ? JSON.parse(activeRun.details) as { contactIds?: number[] } : {};
        const company = this.requireCompany(this.requireContact(input.contactId).companyId);
        if (activeRun.kind !== "EMAIL_GENERATION" || activeRun.campaignId !== company.campaignId
          || !Array.isArray(selection.contactIds) || !selection.contactIds.includes(input.contactId)) {
          throw new WorkflowError("Draft generation is restricted to checked contacts in the active workflow");
        }
      }
      if (this.listOutreach(input.contactId).length) {
        throw new WorkflowError("A first-touch draft already exists for this prospect");
      }
      const result = this.db.prepare(`
        INSERT INTO outreach (contact_id, subject, body, status, research_id)
        VALUES (?, ?, ?, 'DRAFT', ?)
      `).run(input.contactId, input.subject, input.body, input.researchId);
      return this.getOutreach(Number(result.lastInsertRowid))!;
    })();
  }

  createFollowUp(input: { outreachId: number; body: string }): Outreach {
    return this.db.transaction(() => {
      const parent = this.requireOutreach(input.outreachId);
      if (parent.followUpOf !== null) throw new WorkflowError("Follow-ups attach to a first-touch email");
      if (parent.status !== "SENT") throw new WorkflowError("Only SENT emails without a reply can receive a follow-up");
      this.requireDraftEvidence(parent.contactId, parent.researchId ?? undefined);
      const activeRun = this.listWorkflowRuns().find(({ status }) => status === "RUNNING" || status === "PENDING");
      if (activeRun) {
        const selection = activeRun.details ? JSON.parse(activeRun.details) as { outreachIds?: number[] } : {};
        const company = this.requireCompany(this.requireContact(parent.contactId).companyId);
        if (activeRun.kind !== "FOLLOW_UP_GENERATION" || activeRun.campaignId !== company.campaignId
          || !Array.isArray(selection.outreachIds) || !selection.outreachIds.includes(parent.id)) {
          throw new WorkflowError("Follow-up generation is restricted to checked emails in the active workflow");
        }
      }
      const step = this.nextFollowUpStep(parent.id);
      if (!step) throw new WorkflowError("This email's next sequence step is not an email waiting for a draft");
      const body = input.body.trim();
      if (!body || Buffer.byteLength(body) > 100_000) {
        throw new WorkflowError("Email body must be nonempty and no larger than 100 KB");
      }
      const result = this.db.prepare(`
        INSERT INTO outreach (contact_id, subject, body, status, research_id, follow_up_of, follow_up_step)
        VALUES (?, ?, ?, 'DRAFT', ?, ?, ?)
      `).run(parent.contactId, followUpSubject(parent.subject), body, parent.researchId, parent.id, step);
      return this.getOutreach(Number(result.lastInsertRowid))!;
    })();
  }

  /** The current follow-up at a step for a first touch; rejected follow-ups can be regenerated. */
  getFollowUp(outreachId: number, step: FollowUpStep = 1): Outreach | undefined {
    const row = this.db.prepare(`SELECT * FROM outreach WHERE follow_up_of = ? AND follow_up_step = ?
      AND status != 'REJECTED' ORDER BY id DESC LIMIT 1`).get(outreachId, step) as Row | undefined;
    return row ? outreachFromRow(row) : undefined;
  }

  /** The steps after the first email for this first touch: its campaign's sequence. */
  sequenceFor(firstTouch: Outreach): SequenceStep[] {
    const contact = this.requireContact(firstTouch.contactId);
    return this.requireCampaign(this.requireCompany(contact.companyId).campaignId).sequence.steps;
  }

  /**
   * Sequence positions this campaign's prospects already reached, by what they hold. Steps are
   * stored by position, so a position with emails must stay an email step and one with completed
   * tasks must stay a task; otherwise in-flight records would land under a different step.
   */
  reachedSequenceSteps(campaignId: number): { email: Set<number>; task: Set<number> } {
    const used = (sql: string) => new Set((this.db.prepare(sql).all(campaignId) as Row[]).map((row) => integer(row, "step")));
    return {
      email: used(`SELECT DISTINCT f.follow_up_step AS step FROM outreach f
        JOIN contacts c ON c.id = f.contact_id JOIN companies co ON co.id = c.company_id
        WHERE co.campaign_id = ? AND f.follow_up_of IS NOT NULL AND f.status != 'REJECTED'`),
      task: used(`SELECT DISTINCT t.step AS step FROM sequence_task_completions t
        JOIN outreach o ON o.id = t.outreach_id JOIN contacts c ON c.id = o.contact_id
        JOIN companies co ON co.id = c.company_id WHERE co.campaign_id = ?`),
    };
  }

  /** The email steps this campaign's client's follow-up rules describe for a new sequence. */
  clientDefaultSequence(campaignId: number): SequenceStep[] {
    const campaign = this.requireCampaign(campaignId);
    const client = campaign.clientId === null ? undefined : this.getClient(campaign.clientId);
    return client ? defaultSequenceFromSetup(client.setup) : defaultSequence();
  }

  /** Replaces a campaign's sequence; a step its prospects already reached keeps its type. */
  updateCampaignSequence(campaignId: number, sequence: CampaignSequence): Campaign {
    this.requireCampaign(campaignId);
    const reached = this.reachedSequenceSteps(campaignId);
    sequence.steps.forEach((step, index) => {
      const position = index + 1;
      if (reached.email.has(position) && step.kind !== "email") {
        throw new WorkflowError(`Step ${position + 1} already has drafted or sent emails for some prospects, so it must stay an email step. Add new steps after the existing ones instead.`);
      }
      if (reached.task.has(position) && step.kind === "email") {
        throw new WorkflowError(`Step ${position + 1} was already done as a task for some prospects, so it must stay a task step. Add new steps after the existing ones instead.`);
      }
    });
    this.db.prepare("UPDATE campaigns SET sequence = ? WHERE id = ?").run(JSON.stringify(sequence), campaignId);
    return this.getCampaign(campaignId)!;
  }

  /**
   * Where a sent first touch is in its sequence. Each step is due its wait after the previous
   * step was sent (email) or done/skipped (task). Steps already recorded are kept even when the
   * campaign's sequence was later shortened.
   */
  sequenceState(outreachId: number): SequenceState {
    const first = this.requireOutreach(outreachId);
    if (first.followUpOf !== null) throw new WorkflowError("Sequences belong to a first-touch email");
    const defs = this.sequenceFor(first);
    const completions = new Map(this.listSequenceTaskCompletions(outreachId).map((item) => [item.step, item]));
    const recorded = this.listFollowUps(outreachId).reduce((max, item) => Math.max(max, item.followUpStep ?? 0), 0);
    const count = Math.max(defs.length, recorded, ...completions.keys());
    const steps: SequenceStepState[] = [];
    let previousDoneAt = first.sentAt ?? undefined;
    let current: SequenceStepState | undefined;
    for (let step = 1; step <= count; step += 1) {
      const def = defs[step - 1] ?? { kind: "email", delayDays: DEFAULT_STEP_DELAY_DAYS, name: `Step ${step + 1}`, instructions: "", length: "" };
      const email = this.getFollowUp(outreachId, step);
      const completion = completions.get(step);
      const state: SequenceStepState = { step, def, email, completion, status: "UPCOMING" };
      if (email?.status === "SENT" && email.sentAt) {
        state.status = "SENT";
        previousDoneAt = email.sentAt;
      } else if (completion) {
        state.status = completion.status;
        previousDoneAt = completion.completedAt;
      } else if (!current && previousDoneAt) {
        state.status = "CURRENT";
        state.dueAt = addDays(previousDoneAt, def.delayDays);
        current = state;
      }
      steps.push(state);
    }
    return { steps, current, done: !current && steps.every(({ status }) => status !== "UPCOMING"),
      stopped: first.status !== "SENT" };
  }

  /**
   * The email step a first touch can receive a draft for next, or undefined when the current
   * step is a manual task, already has a draft, or the sequence is finished or stopped.
   */
  nextFollowUpStep(outreachId: number): FollowUpStep | undefined {
    const state = this.sequenceState(outreachId);
    const current = state.current;
    return !state.stopped && current && current.def.kind === "email" && !current.email ? current.step : undefined;
  }

  /** When a follow-up email may be sent; undefined until the previous step is sent or completed. */
  followUpSendableAt(followUp: Outreach): Date | undefined {
    if (followUp.followUpOf === null || followUp.followUpStep === null) return undefined;
    const state = this.sequenceState(followUp.followUpOf).steps[followUp.followUpStep - 1];
    return state?.status === "CURRENT" ? state.dueAt : undefined;
  }

  listSequenceTaskCompletions(outreachId: number): SequenceTaskCompletion[] {
    return (this.db.prepare("SELECT * FROM sequence_task_completions WHERE outreach_id = ? ORDER BY step")
      .all(outreachId) as Row[]).map((row) => ({ step: integer(row, "step"), status: text(row, "status") as "DONE" | "SKIPPED",
      note: nullableText(row, "note"), completedAt: text(row, "completed_at") }));
  }

  /** Records that the human did (or skipped) the current manual task step of a sequence. */
  completeSequenceTask(outreachId: number, step: number, status: "DONE" | "SKIPPED", note?: string): SequenceTaskCompletion {
    return this.db.transaction(() => {
      const state = this.sequenceState(outreachId);
      if (state.stopped) throw new WorkflowError("The prospect replied or the first email bounced; the sequence has stopped");
      const current = state.current;
      if (!current || current.step !== step) throw new WorkflowError("Only the current step of the sequence can be completed");
      if (current.def.kind === "email" || current.email) throw new WorkflowError("Email steps are completed by sending them");
      const cleanNote = note?.trim() || null;
      if (cleanNote && cleanNote.length > 1000) throw new WorkflowError("Keep the note under 1000 characters");
      this.db.prepare("INSERT INTO sequence_task_completions (outreach_id, step, status, note, completed_at) VALUES (?, ?, ?, ?, ?)")
        .run(outreachId, step, status, cleanNote, now());
      return this.listSequenceTaskCompletions(outreachId).find((item) => item.step === step)!;
    })();
  }

  listFollowUps(outreachId: number): Outreach[] {
    return (this.db.prepare("SELECT * FROM outreach WHERE follow_up_of = ? ORDER BY id")
      .all(outreachId) as Row[]).map(outreachFromRow);
  }

  rewriteOutreach(id: number, input: { subject: string; body: string; researchId: number }): Outreach {
    const draft = this.requireOutreach(id);
    if (draft.status !== "DRAFT") throw new WorkflowError("Only DRAFT outreach can be rewritten");
    this.requireDraftEvidence(draft.contactId, input.researchId);
    if (draft.followUpOf !== null && input.researchId !== draft.researchId) {
      throw new WorkflowError("A follow-up keeps the signal cited by its first-touch email");
    }
    const subject = draft.followUpOf !== null ? draft.subject : input.subject;
    this.db.prepare("UPDATE outreach SET subject = ?, body = ?, research_id = ? WHERE id = ?")
      .run(subject, input.body, input.researchId, id);
    return this.getOutreach(id)!;
  }

  editOutreach(id: number, input: { subject: string; body: string }): Outreach {
    const draft = this.requireOutreach(id);
    if (draft.status !== "DRAFT") throw new WorkflowError("Only DRAFT outreach can be edited");
    // Changing a follow-up subject would break threading under the first touch.
    const subject = draft.followUpOf !== null ? draft.subject : input.subject.trim();
    const body = input.body.trim();
    if (!subject || subject.length > 250 || /[\r\n\x00]/.test(subject)) {
      throw new WorkflowError("Email subject must be nonempty, under 250 characters, and contain no newlines");
    }
    if (!body || Buffer.byteLength(body) > 100_000) {
      throw new WorkflowError("Email body must be nonempty and no larger than 100 KB");
    }
    this.db.prepare(`UPDATE outreach SET subject = ?, body = ?, reviewed_at = NULL,
      approved_recipient = NULL, approved_subject = NULL, approved_body = NULL WHERE id = ?`)
      .run(subject, body, id);
    return this.getOutreach(id)!;
  }

  rejectOutreach(id: number): Outreach {
    const draft = this.transitionOutreach(id, "DRAFT", "REJECTED");
    this.db.prepare("UPDATE outreach SET reviewed_at = ? WHERE id = ?").run(now(), id);
    return this.getOutreach(draft.id)!;
  }

  approveOutreachForSending(id: number): Outreach {
    return this.db.transaction(() => {
      this.approveOutreach(id);
      return this.markOutreachReady(id);
    })();
  }

  getOutreach(id: number): Outreach | undefined {
    const row = this.db.prepare("SELECT * FROM outreach WHERE id = ?").get(id) as Row | undefined;
    return row ? outreachFromRow(row) : undefined;
  }

  /** First-touch outreach for every contact in a campaign. */
  listCampaignOutreach(campaignId: number): Outreach[] {
    return (this.db.prepare(`SELECT o.* FROM outreach o
      JOIN contacts c ON c.id = o.contact_id JOIN companies co ON co.id = c.company_id
      WHERE co.campaign_id = ? AND o.follow_up_of IS NULL ORDER BY o.id`).all(campaignId) as Row[]).map(outreachFromRow);
  }

  /** First-touch outreach only; use listFollowUps/getFollowUp for follow-ups. */
  listOutreach(contactId?: number): Outreach[] {
    const rows = contactId === undefined
      ? this.db.prepare("SELECT * FROM outreach WHERE follow_up_of IS NULL ORDER BY id").all()
      : this.db.prepare("SELECT * FROM outreach WHERE contact_id = ? AND follow_up_of IS NULL ORDER BY id").all(contactId);
    return (rows as Row[]).map(outreachFromRow);
  }

  approveOutreach(id: number): Outreach {
    const draft = this.requireOutreach(id);
    this.requireDraftEvidence(draft.contactId, draft.researchId ?? undefined);
    this.transitionOutreach(id, "DRAFT", "APPROVED");
    const recipient = this.requireContactRecipient(draft.contactId);
    this.db.prepare(`UPDATE outreach
      SET reviewed_at = ?, approved_recipient = ?, approved_subject = ?, approved_body = ? WHERE id = ?`)
      .run(now(), recipient.address, draft.subject, draft.body, id);
    return this.getOutreach(id)!;
  }

  markOutreachReady(id: number): Outreach {
    return this.db.transaction(() => {
      const outreach = this.requireOutreach(id);
      if (outreach.status !== "APPROVED") {
        throw new WorkflowError("Only APPROVED outreach can become READY_TO_SEND");
      }
      this.requireCurrentApprovals(outreach.contactId);
      this.requireDraftEvidence(outreach.contactId, outreach.researchId ?? undefined);
      if (!outreach.reviewedAt) throw new WorkflowError("Explicit human draft approval is required");
      this.assertContactLimit(outreach.contactId);
      this.db.prepare("UPDATE outreach SET status = 'READY_TO_SEND' WHERE id = ?").run(id);
      return this.getOutreach(id)!;
    })();
  }

  markOutreachSent(id: number, gmailThreadId?: string): Outreach {
    const outreach = this.requireOutreach(id);
    if (outreach.status !== "READY_TO_SEND") {
      throw new WorkflowError("Only READY_TO_SEND outreach can be marked SENT");
    }
    this.requireCurrentApprovals(outreach.contactId);
    this.requireDraftEvidence(outreach.contactId, outreach.researchId ?? undefined);
    this.assertContactLimit(outreach.contactId);
    this.db.prepare(`
      UPDATE outreach SET status = 'SENT', sent_at = ?, gmail_thread_id = ? WHERE id = ?
    `).run(now(), gmailThreadId ?? null, id);
    return this.getOutreach(id)!;
  }

  markOutreachReplied(id: number): Outreach {
    if (this.requireOutreach(id).followUpOf !== null) throw new WorkflowError("Mark the first-touch email as replied");
    return this.transitionOutreach(id, "SENT", "REPLIED");
  }

  /** Records a delivery-failure notice for a sent email; its follow-ups will not be sent. */
  markOutreachBounced(id: number, detail: string): Outreach {
    const outreach = this.requireOutreach(id);
    if (!detail.trim()) throw new WorkflowError("Record the bounce notice's sender, date, and reason");
    if (outreach.status !== "SENT") throw new WorkflowError("Only SENT emails can be marked as bounced");
    // A bounced follow-up still means the address is dead, so the whole thread is marked.
    const firstTouch = this.requireOutreach(outreach.followUpOf ?? outreach.id);
    if (firstTouch.status !== "SENT") throw new WorkflowError(`The first-touch email is already ${firstTouch.status}`);
    this.db.prepare("UPDATE outreach SET status = 'BOUNCED', bounced_at = ?, bounce_detail = ? WHERE id = ?")
      .run(now(), detail.trim(), firstTouch.id);
    return this.getOutreach(firstTouch.id)!;
  }

  assertReadyToSend(id: number): Outreach {
    const draft = this.requireOutreach(id);
    if (draft.status !== "READY_TO_SEND") throw new WorkflowError("Only READY_TO_SEND emails can be sent");
    this.requireDraftEvidence(draft.contactId, draft.researchId ?? undefined);
    this.assertContactLimit(draft.contactId);
    const recipient = this.requireContactRecipient(draft.contactId);
    if (!draft.reviewedAt || draft.approvedRecipient !== recipient.address
      || draft.approvedSubject !== draft.subject || draft.approvedBody !== draft.body) {
      throw new WorkflowError("Recipient or content is not covered by the saved approval. Return to draft and approve again.");
    }
    if (draft.followUpOf !== null) {
      const parent = this.requireOutreach(draft.followUpOf);
      if (parent.status === "REPLIED") throw new WorkflowError("The prospect replied; this follow-up will not be sent");
      if (parent.status === "BOUNCED") throw new WorkflowError("The first email bounced; this follow-up will not be sent");
      if (parent.status !== "SENT" || !parent.sentAt) throw new WorkflowError("The first-touch email has not been sent");
      const due = this.followUpSendableAt(draft);
      if (!due) throw new WorkflowError("The previous step of the sequence must be sent or completed first");
      if (Date.now() < due.getTime()) {
        throw new WorkflowError(`This follow-up is not due until ${formatDueAt(due)}`);
      }
    }
    return draft;
  }

  /**
   * READY_TO_SEND emails in a campaign that pass every send check right now and have no
   * active, sent, or uncertain delivery: first touches, or follow-ups whose send date has come.
   */
  listSendableOutreach(campaignId: number, scope: "first-touch" | "follow-ups"): Outreach[] {
    const firstTouches = this.listCampaignOutreach(campaignId);
    const candidates = scope === "first-touch" ? firstTouches
      : firstTouches.flatMap(({ id }) => this.listFollowUps(id));
    const deliveries = this.listEmailDeliveries();
    return candidates.filter((email) => {
      if (email.status !== "READY_TO_SEND") return false;
      if (deliveries.some((item) => item.outreachId === email.id && item.status !== "FAILED")) return false;
      try { this.assertReadyToSend(email.id); return true; } catch { return false; }
    });
  }

  withdrawOutreachApproval(id: number): Outreach {
    return this.db.transaction(() => {
      const draft = this.requireOutreach(id);
      if (draft.status !== "READY_TO_SEND" && draft.status !== "APPROVED") {
        throw new WorkflowError("Only unsent approved emails can return to draft");
      }
      if (this.listEmailDeliveries().some((delivery) => delivery.outreachId === id && delivery.status !== "FAILED")) {
        throw new WorkflowError("Cannot change an email while delivery is active, sent, or uncertain");
      }
      this.db.prepare(`UPDATE outreach SET status = 'DRAFT', reviewed_at = NULL,
        approved_recipient = NULL, approved_subject = NULL, approved_body = NULL WHERE id = ?`).run(id);
      return this.getOutreach(id)!;
    })();
  }

  beginEmailDelivery(input: {
    id?: string; outreachId?: number; kind: EmailDelivery["kind"];
    provider?: string; fromEmail: string; toEmail: string; subject: string; body: string;
  }): EmailDelivery {
    return this.db.transaction(() => {
      const id = input.id ?? randomUUID();
      if (this.getEmailDelivery(id)) throw new WorkflowError("This send request has already been submitted");
      if (input.kind === "OUTREACH") {
        if (input.outreachId === undefined) throw new WorkflowError("Outreach ID is required");
        const draft = this.assertReadyToSend(input.outreachId);
        if (draft.approvedRecipient !== input.toEmail || draft.subject !== input.subject || draft.body !== input.body) {
          throw new WorkflowError("Send content must exactly match the approved email");
        }
        if (this.listEmailDeliveries().some((delivery) => delivery.outreachId === input.outreachId
          && delivery.status !== "FAILED")) throw new WorkflowError("This email is already sending, sent, or uncertain; sending again is blocked");
      } else if (input.outreachId !== undefined) {
        throw new WorkflowError("Test emails cannot be attached to prospect outreach");
      }
      this.db.prepare(`INSERT INTO email_deliveries
        (id, outreach_id, kind, provider, from_email, to_email, subject, body, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PREPARING', ?)`)
        .run(id, input.outreachId ?? null, input.kind, input.provider ?? "gmail",
          input.fromEmail, input.toEmail, input.subject, input.body, now());
      return this.getEmailDelivery(id)!;
    })();
  }

  getEmailDelivery(id: string): EmailDelivery | undefined {
    const row = this.db.prepare("SELECT * FROM email_deliveries WHERE id = ?").get(id) as Row | undefined;
    return row ? emailDeliveryFromRow(row) : undefined;
  }

  listEmailDeliveries(): EmailDelivery[] {
    return (this.db.prepare("SELECT * FROM email_deliveries ORDER BY created_at DESC, rowid DESC")
      .all() as Row[]).map(emailDeliveryFromRow);
  }

  markDeliverySending(id: string): void {
    const changed = this.db.prepare("UPDATE email_deliveries SET status = 'SENDING' WHERE id = ? AND status = 'PREPARING'")
      .run(id).changes;
    if (!changed) throw new WorkflowError("Only a new send attempt may be dispatched");
  }

  completeEmailDelivery(id: string, result: {
    receiptId: string; messageId?: string; threadId?: string; sentCopy?: { folder: string; uid: number };
  }): EmailDelivery {
    return this.db.transaction(() => {
      const delivery = this.getEmailDelivery(id);
      if (!delivery || !["SENDING", "UNCERTAIN"].includes(delivery.status)) {
        throw new WorkflowError("Send attempt is not awaiting an email provider result");
      }
      if (!result.receiptId) throw new WorkflowError("Email provider must confirm a delivery receipt");
      const sentAt = now();
      this.db.prepare(`UPDATE email_deliveries SET status = 'SENT', provider_receipt = ?,
        gmail_message_id = ?, gmail_thread_id = ?, sent_folder = ?, sent_uid = ?, finished_at = ?, error = NULL WHERE id = ?`)
        .run(result.receiptId, result.messageId ?? null, result.threadId ?? null,
          result.sentCopy?.folder ?? null, result.sentCopy?.uid ?? null, sentAt, id);
      if (delivery.outreachId !== null) {
        // Record what the provider actually accepted; do not re-check approvals after dispatch.
        this.db.prepare("UPDATE outreach SET status = 'SENT', sent_at = ?, gmail_thread_id = ? WHERE id = ?")
          .run(sentAt, result.threadId ?? null, delivery.outreachId);
      }
      return this.getEmailDelivery(id)!;
    })();
  }

  failEmailDelivery(id: string, status: "FAILED" | "UNCERTAIN", error: string): void {
    this.db.prepare(`UPDATE email_deliveries SET status = ?, error = ?, finished_at = ?
      WHERE id = ? AND status IN ('PREPARING', 'SENDING')`).run(status, error, now(), id);
  }

  recoverInterruptedDeliveries(): number {
    return this.db.prepare(`UPDATE email_deliveries SET status = 'UNCERTAIN',
      error = 'Dashboard stopped during delivery. Check the sender Sent folder before taking further action.', finished_at = ?
      WHERE status IN ('PREPARING', 'SENDING')`).run(now()).changes;
  }

  createWorkflowRun(input: {
    campaignId: number;
    kind: WorkflowRunKind;
    details?: string;
  }): WorkflowRun {
    this.requireCampaign(input.campaignId);
    const active = this.db.prepare(`
      SELECT id FROM workflow_runs WHERE status IN ('PENDING', 'RUNNING') LIMIT 1
    `).get() as { id: number } | undefined;
    if (active) throw new WorkflowError(`Workflow run ${active.id} is already active`);

    const result = this.db.prepare(`
      INSERT INTO workflow_runs (
        campaign_id, kind, status, details, output, error, requested_at, started_at, finished_at
      ) VALUES (?, ?, 'PENDING', ?, '', NULL, ?, NULL, NULL)
    `).run(input.campaignId, input.kind, input.details ?? null, now());
    return this.getWorkflowRun(Number(result.lastInsertRowid))!;
  }

  getWorkflowRun(id: number): WorkflowRun | undefined {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(id) as Row | undefined;
    return row ? workflowRunFromRow(row) : undefined;
  }

  listWorkflowRuns(campaignId?: number): WorkflowRun[] {
    const rows = campaignId === undefined
      ? this.db.prepare("SELECT * FROM workflow_runs ORDER BY id DESC").all()
      : this.db.prepare(`
          SELECT * FROM workflow_runs WHERE campaign_id = ? ORDER BY id DESC
        `).all(campaignId);
    return (rows as Row[]).map(workflowRunFromRow);
  }

  startWorkflowRun(id: number): WorkflowRun {
    const run = this.requireWorkflowRun(id);
    if (run.status !== "PENDING") throw new WorkflowError("Only PENDING workflow runs can start");
    this.db.prepare(`
      UPDATE workflow_runs SET status = 'RUNNING', started_at = ? WHERE id = ?
    `).run(now(), id);
    return this.getWorkflowRun(id)!;
  }

  appendWorkflowOutput(id: number, output: string): void {
    this.requireWorkflowRun(id);
    this.db.prepare("UPDATE workflow_runs SET output = output || ? WHERE id = ?").run(output, id);
  }

  completeWorkflowRun(id: number): WorkflowRun {
    const run = this.requireWorkflowRun(id);
    if (run.status !== "RUNNING") throw new WorkflowError("Only RUNNING workflow runs can complete");
    this.db.prepare(`
      UPDATE workflow_runs SET status = 'COMPLETED', finished_at = ? WHERE id = ?
    `).run(now(), id);
    return this.getWorkflowRun(id)!;
  }

  failWorkflowRun(id: number, error: string): WorkflowRun {
    const run = this.requireWorkflowRun(id);
    if (run.status !== "PENDING" && run.status !== "RUNNING") {
      throw new WorkflowError("Only active workflow runs can fail");
    }
    this.db.prepare(`
      UPDATE workflow_runs SET status = 'FAILED', error = ?, finished_at = ? WHERE id = ?
    `).run(error, now(), id);
    return this.getWorkflowRun(id)!;
  }

  failInterruptedWorkflowRuns(): number {
    const result = this.db.prepare(`
      UPDATE workflow_runs
      SET status = 'FAILED', error = 'Dashboard stopped before this run finished', finished_at = ?
      WHERE status IN ('PENDING', 'RUNNING')
    `).run(now());
    return result.changes;
  }

  private transitionOutreach(id: number, from: Outreach["status"], to: Outreach["status"]): Outreach {
    const outreach = this.requireOutreach(id);
    if (outreach.status !== from) throw new WorkflowError(`Only ${from} outreach can become ${to}`);
    this.db.prepare("UPDATE outreach SET status = ? WHERE id = ?").run(to, id);
    return this.getOutreach(id)!;
  }

  private assertContactLimit(contactId: number): void {
    const contact = this.requireContact(contactId);
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT o.contact_id) AS count
      FROM outreach o
      JOIN contacts c ON c.id = o.contact_id
      WHERE c.company_id = ? AND o.contact_id != ?
        AND o.status IN ('READY_TO_SEND', 'SENT')
    `).get(contact.companyId, contactId) as { count: number };
    if (row.count >= 2) throw new WorkflowError("No more than two contacts per company may have active outreach");
  }

  private requireCurrentApprovals(contactId: number): void {
    const contact = this.requireContact(contactId);
    const company = this.requireCompany(contact.companyId);
    if (company.status !== "APPROVED" || contact.status !== "APPROVED") {
      throw new WorkflowError("Sending requires a currently APPROVED company and contact");
    }
  }

  private requireProspectEligible(contactId: number): Contact {
    this.requireCurrentApprovals(contactId);
    const contact = this.requireContact(contactId);
    this.requireContactRecipient(contactId);
    return contact;
  }

  private requireResearchEligible(contactId: number): Contact {
    return this.requireProspectEligible(contactId);
  }

  private recipientFor(contact: Contact): ContactRecipient | undefined {
    if (contact.email && ["PUBLICLY_LISTED", "VERIFIED"].includes(contact.emailStatus)) {
      return { address: contact.email, guessed: false, verification: null };
    }
    // A mailbox the recipient's server rejected would only bounce, so it is not a recipient.
    if (contact.emailStatus === "EMAIL_NOT_FOUND" && contact.guessedEmail
      && contact.guessedEmailVerification !== "INVALID") {
      return { address: contact.guessedEmail, guessed: true, verification: contact.guessedEmailVerification };
    }
    return undefined;
  }

  private requireContactRecipient(contactId: number): ContactRecipient {
    const contact = this.requireContact(contactId);
    const recipient = this.recipientFor(contact);
    if (!recipient && contact.guessedEmailVerification === "INVALID") {
      throw new WorkflowError("The guessed email was rejected by the recipient's mail server (SMTP invalid)");
    }
    if (!recipient) {
      throw new WorkflowError("Prospect workflow requires a sourced or explicitly guessed business email");
    }
    if (this.isContactSuppressed(contact)) {
      throw new WorkflowError(`${recipient.address} replied not interested and is on the do-not-contact list`);
    }
    return recipient;
  }

  private requireDraftEvidence(contactId: number, researchId: number | undefined): void {
    const contact = this.requireProspectEligible(contactId);
    const analysis = this.getProspectResearch(contactId);
    const evidence = researchId === undefined ? undefined : this.getResearchRecord(researchId);
    if (analysis?.status !== "READY" || !evidence || evidence.contactId !== contactId
      || evidence.companyId !== contact.companyId
      || !this.listProspectSignals(contactId).some(({ id }) => id === researchId)) {
      throw new WorkflowError("Every draft must reference a sourced prospect research signal");
    }
    this.requireSourceUrl(evidence.sourceUrl);
  }

  private requireSourceUrl(sourceUrl: string): void {
    try {
      const url = new URL(sourceUrl);
      if (url.protocol === "http:" || url.protocol === "https:") return;
    } catch { /* Invalid source URL. */ }
    throw new WorkflowError("Research requires a public HTTP(S) source URL");
  }

  private requireCampaign(id: number): Campaign {
    const value = this.getCampaign(id);
    if (!value) throw new WorkflowError(`Campaign not found: ${id}`);
    return value;
  }
  private requireCompany(id: number): Company {
    const value = this.getCompany(id);
    if (!value) throw new WorkflowError(`Company not found: ${id}`);
    return value;
  }
  private requireContact(id: number): Contact {
    const value = this.getContact(id);
    if (!value) throw new WorkflowError(`Contact not found: ${id}`);
    return value;
  }
  private requireOutreach(id: number): Outreach {
    const value = this.getOutreach(id);
    if (!value) throw new WorkflowError(`Outreach not found: ${id}`);
    return value;
  }
  private requireWorkflowRun(id: number): WorkflowRun {
    const value = this.getWorkflowRun(id);
    if (!value) throw new WorkflowError(`Workflow run not found: ${id}`);
    return value;
  }
}

const text = (row: Row, key: string): string => row[key] as string;
const integer = (row: Row, key: string): number => row[key] as number;
const nullableText = (row: Row, key: string): string | null => row[key] as string | null;
const nullableInteger = (row: Row, key: string): number | null => row[key] as number | null;

function campaignFromRow(row: Row): Campaign {
  return { id: integer(row, "id"), name: text(row, "name"), segment: text(row, "segment"),
    createdAt: text(row, "created_at"), status: text(row, "status") as Campaign["status"],
    clientId: nullableInteger(row, "client_id"), sequence: parseCampaignSequence(nullableText(row, "sequence")) };
}
function clientFromRow(row: Row): Client {
  return { id: integer(row, "id"), name: text(row, "name"), setup: resolveSetup(JSON.parse(text(row, "settings"))),
    createdAt: text(row, "created_at"), updatedAt: text(row, "updated_at") };
}
function companyFromRow(row: Row): Company {
  return { id: integer(row, "id"), campaignId: integer(row, "campaign_id"), name: text(row, "name"),
    domain: text(row, "domain"), location: nullableText(row, "location"),
    locationSourceUrl: nullableText(row, "location_source_url"),
    employeeCount: nullableInteger(row, "employee_count"), score: nullableInteger(row, "score"),
    employeeCountRange: nullableText(row, "employee_count_range"),
    employeeCountSourceUrl: nullableText(row, "employee_count_source_url"),
    engineeringHeadcount: nullableInteger(row, "engineering_headcount"),
    engineeringHeadcountSourceUrl: nullableText(row, "engineering_headcount_source_url"),
    scoreBreakdown: row.score_breakdown ? JSON.parse(text(row, "score_breakdown")) as CompanyScoreBreakdown : null,
    reason: nullableText(row, "reason"),
    salesThesis: nullableText(row, "sales_thesis"),
    chatFeatureStatus: text(row, "chat_feature_status") as Company["chatFeatureStatus"],
    chatFeatureSourceUrl: nullableText(row, "chat_feature_source_url"),
    chatImplementation: text(row, "chat_implementation") as Company["chatImplementation"],
    chatVendorName: nullableText(row, "chat_vendor_name"),
    chatImplementationSourceUrl: nullableText(row, "chat_implementation_source_url"),
    emailDomain: nullableText(row, "email_domain"),
    emailDomainSourceUrl: nullableText(row, "email_domain_source_url"),
    emailDomainBasis: nullableText(row, "email_domain_basis"),
    emailDomainCheckedAt: nullableText(row, "email_domain_checked_at"),
    status: text(row, "status") as Company["status"],
    createdAt: text(row, "created_at") };
}
function contactFromRow(row: Row): Contact {
  return { id: integer(row, "id"), companyId: integer(row, "company_id"), name: text(row, "name"),
    title: nullableText(row, "title"), roleCategory: nullableText(row, "role_category"),
    roleScore: nullableInteger(row, "role_score"), linkedinUrl: nullableText(row, "linkedin_url"),
    email: nullableText(row, "email"), emailStatus: text(row, "email_status") as Contact["emailStatus"],
    guessedEmail: nullableText(row, "guessed_email"),
    guessedEmailPattern: nullableText(row, "guessed_email_pattern") as Contact["guessedEmailPattern"],
    guessedEmailConfidence: nullableText(row, "guessed_email_confidence") as Contact["guessedEmailConfidence"],
    guessedEmailBasis: nullableText(row, "guessed_email_basis"),
    guessedEmailSourceUrl: nullableText(row, "guessed_email_source_url"),
    guessedEmailVerification: nullableText(row, "guessed_email_verification") as Contact["guessedEmailVerification"],
    guessedEmailVerificationDetail: nullableText(row, "guessed_email_verification_detail"),
    guessedEmailVerifiedAt: nullableText(row, "guessed_email_verified_at"),
    guessedEmailSource: nullableText(row, "guessed_email_source") as Contact["guessedEmailSource"],
    emailRecoveryStartedAt: nullableText(row, "email_recovery_started_at"),
    emailRecoveryOutcome: nullableText(row, "email_recovery_outcome") as Contact["emailRecoveryOutcome"],
    emailRecoveryNotes: nullableText(row, "email_recovery_notes"),
    emailRecoveryError: nullableText(row, "email_recovery_error"),
    guessedEmailCandidatesChecked: nullableInteger(row, "guessed_email_candidates_checked"),
    patternEvidenceCheckedAt: nullableText(row, "pattern_evidence_checked_at"),
    status: text(row, "status") as Contact["status"] };
}
function researchFromRow(row: Row): ResearchRecord {
  return { id: integer(row, "id"), companyId: integer(row, "company_id"),
    contactId: nullableInteger(row, "contact_id"), signal: text(row, "signal"),
    sourceUrl: text(row, "source_url"), notes: nullableText(row, "notes") };
}
function outreachFromRow(row: Row): Outreach {
  return { id: integer(row, "id"), contactId: integer(row, "contact_id"), subject: text(row, "subject"),
    body: text(row, "body"), status: text(row, "status") as Outreach["status"],
    sentAt: nullableText(row, "sent_at"), gmailThreadId: nullableText(row, "gmail_thread_id"),
    researchId: nullableInteger(row, "research_id"), reviewedAt: nullableText(row, "reviewed_at"),
    approvedRecipient: nullableText(row, "approved_recipient"), approvedSubject: nullableText(row, "approved_subject"),
    approvedBody: nullableText(row, "approved_body"), followUpOf: nullableInteger(row, "follow_up_of"),
    followUpStep: nullableInteger(row, "follow_up_step") as Outreach["followUpStep"],
    bouncedAt: nullableText(row, "bounced_at"), bounceDetail: nullableText(row, "bounce_detail") };
}
function emailDeliveryFromRow(row: Row): EmailDelivery {
  return {
    id: text(row, "id"), provider: text(row, "provider"), outreachId: nullableInteger(row, "outreach_id"),
    kind: text(row, "kind") as EmailDelivery["kind"], fromEmail: text(row, "from_email"),
    toEmail: text(row, "to_email"), subject: text(row, "subject"), body: text(row, "body"),
    status: text(row, "status") as EmailDelivery["status"], providerReceipt: nullableText(row, "provider_receipt"),
    gmailMessageId: nullableText(row, "gmail_message_id"),
    gmailThreadId: nullableText(row, "gmail_thread_id"),
    sentFolder: nullableText(row, "sent_folder"), sentUid: nullableInteger(row, "sent_uid"),
    error: nullableText(row, "error"),
    createdAt: text(row, "created_at"), finishedAt: nullableText(row, "finished_at"),
  };
}
function workflowRunFromRow(row: Row): WorkflowRun {
  return {
    id: integer(row, "id"), campaignId: integer(row, "campaign_id"),
    kind: text(row, "kind") as WorkflowRun["kind"],
    status: text(row, "status") as WorkflowRun["status"],
    details: nullableText(row, "details"), output: text(row, "output"),
    error: nullableText(row, "error"), requestedAt: text(row, "requested_at"),
    startedAt: nullableText(row, "started_at"), finishedAt: nullableText(row, "finished_at"),
  };
}
