import type { SqliteDatabase } from "./database.js";
import { randomUUID } from "node:crypto";
import { patternCandidates } from "../email/guessPatterns.js";
import type {
  Campaign, CampaignStatus, ChatFeatureStatus, ChatImplementation, Company, CompanyScoreBreakdown,
  Contact, EmailGuessConfidence, EmailGuessPattern, EmailRecoveryOutcome, EmailStatus, GuessVerification, Outreach, ResearchRecord,
  ReviewStatus, WorkflowRun, WorkflowRunKind, ProspectResearch, EmailDelivery,
} from "./types.js";

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();

export const FOLLOW_UP_DELAY_DAYS = 7;

/** When a follow-up to a sent first touch may be sent. */
export function followUpDueAt(sentAt: string): Date {
  return new Date(new Date(sentAt).getTime() + FOLLOW_UP_DELAY_DAYS * 24 * 60 * 60 * 1000);
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

  createCampaign(input: { name: string; segment: string; status?: CampaignStatus }): Campaign {
    const result = this.db.prepare(`
      INSERT INTO campaigns (name, segment, created_at, status) VALUES (?, ?, ?, ?)
    `).run(input.name, input.segment, now(), input.status ?? "DRAFT");
    return this.getCampaign(Number(result.lastInsertRowid))!;
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
      input.roleScore ?? null, input.linkedinUrl ?? null, input.email ?? null,
      input.emailStatus ?? "UNKNOWN",
    );
    return this.getContact(Number(result.lastInsertRowid))!;
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
      .filter((contact) => contact.status === "APPROVED" && !!this.recipientFor(contact));
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
      if (this.getFollowUp(parent.id)) throw new WorkflowError("A follow-up already exists for this email");
      const body = input.body.trim();
      if (!body || Buffer.byteLength(body) > 100_000) {
        throw new WorkflowError("Email body must be nonempty and no larger than 100 KB");
      }
      const result = this.db.prepare(`
        INSERT INTO outreach (contact_id, subject, body, status, research_id, follow_up_of)
        VALUES (?, ?, ?, 'DRAFT', ?, ?)
      `).run(parent.contactId, followUpSubject(parent.subject), body, parent.researchId, parent.id);
      return this.getOutreach(Number(result.lastInsertRowid))!;
    })();
  }

  /** The current follow-up for a first touch; rejected follow-ups can be regenerated. */
  getFollowUp(outreachId: number): Outreach | undefined {
    const row = this.db.prepare(`SELECT * FROM outreach WHERE follow_up_of = ? AND status != 'REJECTED'
      ORDER BY id DESC LIMIT 1`).get(outreachId) as Row | undefined;
    return row ? outreachFromRow(row) : undefined;
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
      if (parent.status !== "SENT" || !parent.sentAt) throw new WorkflowError("The first-touch email has not been sent");
      const due = followUpDueAt(parent.sentAt);
      if (Date.now() < due.getTime()) {
        throw new WorkflowError(`This follow-up is not due until ${formatDueAt(due)}`);
      }
    }
    return draft;
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
    createdAt: text(row, "created_at"), status: text(row, "status") as Campaign["status"] };
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
    approvedBody: nullableText(row, "approved_body"), followUpOf: nullableInteger(row, "follow_up_of") };
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
