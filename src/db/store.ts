import type { SqliteDatabase } from "./database.js";
import type {
  Campaign, CampaignStatus, Company, Contact, EmailStatus, Outreach, ResearchRecord,
  ReviewStatus,
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
  }): Company {
    this.requireCampaign(input.campaignId);
    const result = this.db.prepare(`
      INSERT INTO companies (
        campaign_id, name, domain, location, employee_count, score, reason, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DISCOVERED', ?)
    `).run(
      input.campaignId, input.name, input.domain, input.location ?? null,
      input.employeeCount ?? null, input.score ?? null, input.reason ?? null, now(),
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

  createOutreach(input: { contactId: number; subject: string; body: string }): Outreach {
    const contact = this.requireContact(input.contactId);
    const company = this.requireCompany(contact.companyId);
    if (company.status !== "APPROVED" || contact.status !== "APPROVED") {
      throw new WorkflowError("Outreach requires an APPROVED company and contact");
    }
    const result = this.db.prepare(`
      INSERT INTO outreach (contact_id, subject, body, status, sent_at, gmail_thread_id)
      VALUES (?, ?, ?, 'DRAFT', NULL, NULL)
    `).run(input.contactId, input.subject, input.body);
    return this.getOutreach(Number(result.lastInsertRowid))!;
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
    return this.transitionOutreach(id, "DRAFT", "APPROVED");
  }

  markOutreachReady(id: number): Outreach {
    return this.db.transaction(() => {
      const outreach = this.requireOutreach(id);
      if (outreach.status !== "APPROVED") {
        throw new WorkflowError("Only APPROVED outreach can become READY_TO_SEND");
      }
      this.requireCurrentApprovals(outreach.contactId);
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
    this.db.prepare(`
      UPDATE outreach SET status = 'SENT', sent_at = ?, gmail_thread_id = ? WHERE id = ?
    `).run(now(), gmailThreadId ?? null, id);
    return this.getOutreach(id)!;
  }

  markOutreachReplied(id: number): Outreach {
    return this.transitionOutreach(id, "SENT", "REPLIED");
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
    reason: nullableText(row, "reason"), status: text(row, "status") as Company["status"],
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
    sentAt: nullableText(row, "sent_at"), gmailThreadId: nullableText(row, "gmail_thread_id") };
}
