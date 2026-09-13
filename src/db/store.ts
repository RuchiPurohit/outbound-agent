import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "./database.js";
import type {
  ApprovalStatus, Campaign, CampaignStatus, Company, Contact, EmailStatus,
  Outreach, OutreachKind,
} from "./types.js";

type Row = Record<string, unknown>;
const now = (): string => new Date().toISOString();

export class WorkflowError extends Error {}

export class OutboundStore {
  public constructor(private readonly db: SqliteDatabase) {}

  createCampaign(input: { name: string; productName: string; icp: string; status?: CampaignStatus }): Campaign {
    const timestamp = now();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO campaigns (id, name, product_name, icp, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.productName, input.icp, input.status ?? "draft", timestamp, timestamp);
    return this.getCampaign(id)!;
  }

  getCampaign(id: string): Campaign | undefined {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as Row | undefined;
    return row ? campaignFromRow(row) : undefined;
  }

  listCampaigns(): Campaign[] {
    return (this.db.prepare("SELECT * FROM campaigns ORDER BY created_at, id").all() as Row[]).map(campaignFromRow);
  }

  setCampaignStatus(id: string, status: CampaignStatus): Campaign {
    this.requireCampaign(id);
    this.db.prepare("UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
    return this.getCampaign(id)!;
  }

  createCompany(input: {
    campaignId: string; name: string; website: string; geography?: string;
    employeeCountMin?: number; employeeCountMax?: number; fitScore?: number;
    fitRationale?: string; sourceUrls?: string[];
  }): Company {
    this.requireCampaign(input.campaignId);
    const timestamp = now();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO companies (
        id, campaign_id, name, website, geography, employee_count_min,
        employee_count_max, fit_score, fit_rationale, source_urls,
        approval_status, reviewed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
    `).run(
      id, input.campaignId, input.name, input.website, input.geography ?? null,
      input.employeeCountMin ?? null, input.employeeCountMax ?? null,
      input.fitScore ?? null, input.fitRationale ?? null,
      JSON.stringify(input.sourceUrls ?? []), timestamp, timestamp,
    );
    return this.getCompany(id)!;
  }

  getCompany(id: string): Company | undefined {
    const row = this.db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as Row | undefined;
    return row ? companyFromRow(row) : undefined;
  }

  listCompanies(campaignId: string, approvalStatus?: ApprovalStatus): Company[] {
    this.requireCampaign(campaignId);
    const rows = approvalStatus
      ? this.db.prepare("SELECT * FROM companies WHERE campaign_id = ? AND approval_status = ? ORDER BY created_at, id").all(campaignId, approvalStatus)
      : this.db.prepare("SELECT * FROM companies WHERE campaign_id = ? ORDER BY created_at, id").all(campaignId);
    return (rows as Row[]).map(companyFromRow);
  }

  reviewCompany(id: string, decision: Exclude<ApprovalStatus, "pending">): Company {
    this.requireCompany(id);
    const timestamp = now();
    this.db.prepare("UPDATE companies SET approval_status = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
      .run(decision, timestamp, timestamp, id);
    return this.getCompany(id)!;
  }

  createContact(input: {
    companyId: string; fullName: string; jobTitle?: string; rolePriority?: number;
    profileUrl?: string; email?: string; emailStatus?: EmailStatus; sourceUrls?: string[];
  }): Contact {
    const company = this.requireCompany(input.companyId);
    if (company.approvalStatus !== "approved") {
      throw new WorkflowError("Contacts may only be added to approved companies");
    }
    const timestamp = now();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO contacts (
        id, company_id, full_name, job_title, role_priority, profile_url,
        email, email_status, source_urls, approval_status, reviewed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)
    `).run(
      id, input.companyId, input.fullName, input.jobTitle ?? null,
      input.rolePriority ?? null, input.profileUrl ?? null, input.email ?? null,
      input.emailStatus ?? "unknown", JSON.stringify(input.sourceUrls ?? []), timestamp, timestamp,
    );
    return this.getContact(id)!;
  }

  getContact(id: string): Contact | undefined {
    const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined;
    return row ? contactFromRow(row) : undefined;
  }

  listContacts(companyId: string, approvalStatus?: ApprovalStatus): Contact[] {
    this.requireCompany(companyId);
    const rows = approvalStatus
      ? this.db.prepare("SELECT * FROM contacts WHERE company_id = ? AND approval_status = ? ORDER BY created_at, id").all(companyId, approvalStatus)
      : this.db.prepare("SELECT * FROM contacts WHERE company_id = ? ORDER BY created_at, id").all(companyId);
    return (rows as Row[]).map(contactFromRow);
  }

  reviewContact(id: string, decision: Exclude<ApprovalStatus, "pending">): Contact {
    this.requireContact(id);
    const timestamp = now();
    this.db.prepare("UPDATE contacts SET approval_status = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
      .run(decision, timestamp, timestamp, id);
    return this.getContact(id)!;
  }

  createOutreach(input: {
    campaignId: string; companyId: string; contactId: string; kind: OutreachKind;
    sequenceNumber: number; subject: string; body: string; reason: string;
  }): Outreach {
    const company = this.requireCompany(input.companyId);
    const contact = this.requireContact(input.contactId);
    if (company.campaignId !== input.campaignId || contact.companyId !== input.companyId) {
      throw new WorkflowError("Campaign, company, and contact do not belong to the same workflow");
    }
    if (company.approvalStatus !== "approved" || contact.approvalStatus !== "approved") {
      throw new WorkflowError("Outreach requires an approved company and contact");
    }
    const timestamp = now();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO outreach (
        id, campaign_id, company_id, contact_id, kind, sequence_number,
        subject, body, reason, status, approved_at, sent_at,
        provider_draft_id, provider_message_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      id, input.campaignId, input.companyId, input.contactId, input.kind,
      input.sequenceNumber, input.subject, input.body, input.reason, timestamp, timestamp,
    );
    return this.getOutreach(id)!;
  }

  getOutreach(id: string): Outreach | undefined {
    const row = this.db.prepare("SELECT * FROM outreach WHERE id = ?").get(id) as Row | undefined;
    return row ? outreachFromRow(row) : undefined;
  }

  listOutreach(campaignId: string): Outreach[] {
    this.requireCampaign(campaignId);
    return (this.db.prepare("SELECT * FROM outreach WHERE campaign_id = ? ORDER BY created_at, id")
      .all(campaignId) as Row[]).map(outreachFromRow);
  }

  submitOutreachForApproval(id: string): Outreach {
    return this.db.transaction(() => {
      const outreach = this.requireOutreach(id);
      if (outreach.status !== "draft") throw new WorkflowError("Only draft outreach can be submitted for approval");
      this.assertContactLimit(outreach.companyId, outreach.contactId);
      this.db.prepare("UPDATE outreach SET status = 'pending_approval', updated_at = ? WHERE id = ?").run(now(), id);
      return this.getOutreach(id)!;
    })();
  }

  reviewOutreach(id: string, decision: "approved" | "rejected"): Outreach {
    const outreach = this.requireOutreach(id);
    if (outreach.status !== "pending_approval") throw new WorkflowError("Only pending outreach can be reviewed");
    const timestamp = now();
    this.db.prepare("UPDATE outreach SET status = ?, approved_at = ?, updated_at = ? WHERE id = ?")
      .run(decision, decision === "approved" ? timestamp : null, timestamp, id);
    return this.getOutreach(id)!;
  }

  markOutreachSent(id: string, providerMessageId?: string): Outreach {
    const outreach = this.requireOutreach(id);
    if (outreach.status !== "approved" || !outreach.approvedAt) {
      throw new WorkflowError("Outreach must receive explicit approval before it is sent");
    }
    const timestamp = now();
    this.db.prepare(`
      UPDATE outreach SET status = 'sent', sent_at = ?, provider_message_id = ?, updated_at = ? WHERE id = ?
    `).run(timestamp, providerMessageId ?? null, timestamp, id);
    return this.getOutreach(id)!;
  }

  private assertContactLimit(companyId: string, contactId: string): void {
    const row = this.db.prepare(`
      SELECT COUNT(DISTINCT contact_id) AS count FROM outreach
      WHERE company_id = ? AND contact_id != ?
        AND status IN ('pending_approval', 'approved', 'sent')
    `).get(companyId, contactId) as { count: number };
    if (row.count >= 2) throw new WorkflowError("No more than two contacts per company may have active outreach");
  }

  private requireCampaign(id: string): Campaign {
    const value = this.getCampaign(id);
    if (!value) throw new WorkflowError(`Campaign not found: ${id}`);
    return value;
  }
  private requireCompany(id: string): Company {
    const value = this.getCompany(id);
    if (!value) throw new WorkflowError(`Company not found: ${id}`);
    return value;
  }
  private requireContact(id: string): Contact {
    const value = this.getContact(id);
    if (!value) throw new WorkflowError(`Contact not found: ${id}`);
    return value;
  }
  private requireOutreach(id: string): Outreach {
    const value = this.getOutreach(id);
    if (!value) throw new WorkflowError(`Outreach not found: ${id}`);
    return value;
  }
}

const str = (row: Row, key: string): string => row[key] as string;
const nullableStr = (row: Row, key: string): string | null => row[key] as string | null;
const nullableNumber = (row: Row, key: string): number | null => row[key] as number | null;

function campaignFromRow(row: Row): Campaign {
  return { id: str(row, "id"), name: str(row, "name"), productName: str(row, "product_name"),
    icp: str(row, "icp"), status: str(row, "status") as CampaignStatus,
    createdAt: str(row, "created_at"), updatedAt: str(row, "updated_at") };
}

function companyFromRow(row: Row): Company {
  return { id: str(row, "id"), campaignId: str(row, "campaign_id"), name: str(row, "name"),
    website: str(row, "website"), geography: nullableStr(row, "geography"),
    employeeCountMin: nullableNumber(row, "employee_count_min"), employeeCountMax: nullableNumber(row, "employee_count_max"),
    fitScore: nullableNumber(row, "fit_score"), fitRationale: nullableStr(row, "fit_rationale"),
    sourceUrls: JSON.parse(str(row, "source_urls")) as string[], approvalStatus: str(row, "approval_status") as ApprovalStatus,
    reviewedAt: nullableStr(row, "reviewed_at"), createdAt: str(row, "created_at"), updatedAt: str(row, "updated_at") };
}

function contactFromRow(row: Row): Contact {
  return { id: str(row, "id"), companyId: str(row, "company_id"), fullName: str(row, "full_name"),
    jobTitle: nullableStr(row, "job_title"), rolePriority: nullableNumber(row, "role_priority"),
    profileUrl: nullableStr(row, "profile_url"), email: nullableStr(row, "email"),
    emailStatus: str(row, "email_status") as EmailStatus, sourceUrls: JSON.parse(str(row, "source_urls")) as string[],
    approvalStatus: str(row, "approval_status") as ApprovalStatus, reviewedAt: nullableStr(row, "reviewed_at"),
    createdAt: str(row, "created_at"), updatedAt: str(row, "updated_at") };
}

function outreachFromRow(row: Row): Outreach {
  return { id: str(row, "id"), campaignId: str(row, "campaign_id"), companyId: str(row, "company_id"),
    contactId: str(row, "contact_id"), kind: str(row, "kind") as OutreachKind,
    sequenceNumber: row.sequence_number as number, subject: str(row, "subject"), body: str(row, "body"),
    reason: str(row, "reason"), status: str(row, "status") as Outreach["status"],
    approvedAt: nullableStr(row, "approved_at"), sentAt: nullableStr(row, "sent_at"),
    providerDraftId: nullableStr(row, "provider_draft_id"), providerMessageId: nullableStr(row, "provider_message_id"),
    createdAt: str(row, "created_at"), updatedAt: str(row, "updated_at") };
}
