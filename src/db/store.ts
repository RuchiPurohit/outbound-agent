import type { SqliteDatabase } from "./database.js";
import { randomUUID } from "node:crypto";
import type {
  Campaign, CampaignStatus, ChatFeatureStatus, Company, Contact, EmailStatus, Outreach, ResearchRecord,
  ReviewStatus, WorkflowRun, WorkflowRunKind, ProspectResearch, EmailDelivery,
} from "./types.js";

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();

export class WorkflowError extends Error {}

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
    employeeCount?: number;
    score?: number;
    reason?: string;
    chatFeatureStatus?: ChatFeatureStatus;
    chatFeatureSourceUrl?: string;
  }): Company {
    this.requireCampaign(input.campaignId);
    const chatFeatureStatus = input.chatFeatureStatus ?? "UNKNOWN";
    const chatFeatureSourceUrl = input.chatFeatureSourceUrl?.trim() || null;
    if (chatFeatureStatus === "PRESENT" && !chatFeatureSourceUrl) {
      throw new WorkflowError("A public source URL is required when chat is PRESENT");
    }
    if (chatFeatureStatus !== "PRESENT" && chatFeatureSourceUrl) {
      throw new WorkflowError("A chat source URL may only be stored when chat is PRESENT");
    }
    const result = this.db.prepare(`
      INSERT INTO companies (
        campaign_id, name, domain, location, employee_count, score, reason,
        chat_feature_status, chat_feature_source_url, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED', ?)
    `).run(
      input.campaignId, input.name, input.domain, input.location ?? null,
      input.employeeCount ?? null, input.score ?? null, input.reason ?? null,
      chatFeatureStatus, chatFeatureSourceUrl, now(),
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
        throw new WorkflowError("A found email requires the exact address and a source URL");
      }
      if (!found && input.email) {
        throw new WorkflowError("EMAIL_NOT_FOUND cannot include an email address");
      }

      this.db.prepare("UPDATE contacts SET email = ?, email_status = ? WHERE id = ?")
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
      this.requireProspectEligible(input.contactId);
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
      .filter(({ status, email, emailStatus }) => status === "APPROVED" && email
        && (emailStatus === "PUBLICLY_LISTED" || emailStatus === "VERIFIED"));
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

  rewriteOutreach(id: number, input: { subject: string; body: string; researchId: number }): Outreach {
    const draft = this.requireOutreach(id);
    if (draft.status !== "DRAFT") throw new WorkflowError("Only DRAFT outreach can be rewritten");
    this.requireDraftEvidence(draft.contactId, input.researchId);
    this.db.prepare("UPDATE outreach SET subject = ?, body = ?, research_id = ? WHERE id = ?")
      .run(input.subject, input.body, input.researchId, id);
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

  listOutreach(contactId?: number): Outreach[] {
    const rows = contactId === undefined
      ? this.db.prepare("SELECT * FROM outreach ORDER BY id").all()
      : this.db.prepare("SELECT * FROM outreach WHERE contact_id = ? ORDER BY id").all(contactId);
    return (rows as Row[]).map(outreachFromRow);
  }

  approveOutreach(id: number): Outreach {
    const draft = this.requireOutreach(id);
    this.requireDraftEvidence(draft.contactId, draft.researchId ?? undefined);
    this.transitionOutreach(id, "DRAFT", "APPROVED");
    this.db.prepare(`UPDATE outreach
      SET reviewed_at = ?, approved_recipient = ?, approved_subject = ?, approved_body = ? WHERE id = ?`)
      .run(now(), this.requireContact(draft.contactId).email, draft.subject, draft.body, id);
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
    return this.transitionOutreach(id, "SENT", "REPLIED");
  }

  assertReadyToSend(id: number): Outreach {
    const draft = this.requireOutreach(id);
    if (draft.status !== "READY_TO_SEND") throw new WorkflowError("Only READY_TO_SEND emails can be sent");
    this.requireDraftEvidence(draft.contactId, draft.researchId ?? undefined);
    this.assertContactLimit(draft.contactId);
    const contact = this.requireContact(draft.contactId);
    if (!draft.reviewedAt || draft.approvedRecipient !== contact.email
      || draft.approvedSubject !== draft.subject || draft.approvedBody !== draft.body) {
      throw new WorkflowError("Recipient or content is not covered by the saved approval. Return to draft and approve again.");
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
    fromEmail: string; toEmail: string; subject: string; body: string;
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
        (id, outreach_id, kind, from_email, to_email, subject, body, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARING', ?)`)
        .run(id, input.outreachId ?? null, input.kind, input.fromEmail, input.toEmail, input.subject, input.body, now());
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

  completeEmailDelivery(id: string, result: { messageId: string; threadId: string }): EmailDelivery {
    return this.db.transaction(() => {
      const delivery = this.getEmailDelivery(id);
      if (!delivery || !["SENDING", "UNCERTAIN"].includes(delivery.status)) {
        throw new WorkflowError("Send attempt is not awaiting a Gmail result");
      }
      if (!result.messageId || !result.threadId) throw new WorkflowError("Gmail must confirm message and thread IDs");
      const sentAt = now();
      this.db.prepare(`UPDATE email_deliveries SET status = 'SENT', gmail_message_id = ?, gmail_thread_id = ?,
        finished_at = ?, error = NULL WHERE id = ?`).run(result.messageId, result.threadId, sentAt, id);
      if (delivery.outreachId !== null) {
        // Record what Gmail actually accepted; do not re-check approvals after dispatch.
        this.db.prepare("UPDATE outreach SET status = 'SENT', sent_at = ?, gmail_thread_id = ? WHERE id = ?")
          .run(sentAt, result.threadId, delivery.outreachId);
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
      error = 'Dashboard stopped during delivery. Check Gmail Sent before taking further action.', finished_at = ?
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
    if (!contact.email || !["PUBLICLY_LISTED", "VERIFIED"].includes(contact.emailStatus)) {
      throw new WorkflowError("Prospect research and drafts require a sourced business email");
    }
    return contact;
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
    employeeCount: nullableInteger(row, "employee_count"), score: nullableInteger(row, "score"),
    reason: nullableText(row, "reason"),
    chatFeatureStatus: text(row, "chat_feature_status") as Company["chatFeatureStatus"],
    chatFeatureSourceUrl: nullableText(row, "chat_feature_source_url"),
    status: text(row, "status") as Company["status"],
    createdAt: text(row, "created_at") };
}
function contactFromRow(row: Row): Contact {
  return { id: integer(row, "id"), companyId: integer(row, "company_id"), name: text(row, "name"),
    title: nullableText(row, "title"), roleCategory: nullableText(row, "role_category"),
    roleScore: nullableInteger(row, "role_score"), linkedinUrl: nullableText(row, "linkedin_url"),
    email: nullableText(row, "email"), emailStatus: text(row, "email_status") as Contact["emailStatus"],
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
    approvedBody: nullableText(row, "approved_body") };
}
function emailDeliveryFromRow(row: Row): EmailDelivery {
  return {
    id: text(row, "id"), outreachId: nullableInteger(row, "outreach_id"),
    kind: text(row, "kind") as EmailDelivery["kind"], fromEmail: text(row, "from_email"),
    toEmail: text(row, "to_email"), subject: text(row, "subject"), body: text(row, "body"),
    status: text(row, "status") as EmailDelivery["status"], gmailMessageId: nullableText(row, "gmail_message_id"),
    gmailThreadId: nullableText(row, "gmail_thread_id"), error: nullableText(row, "error"),
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
