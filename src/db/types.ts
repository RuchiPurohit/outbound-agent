export type CampaignStatus = "draft" | "active" | "paused" | "completed";
export type ApprovalStatus = "pending" | "approved" | "rejected";
export type EmailStatus = "unknown" | "verified" | "not_found";
export type OutreachKind = "first_touch" | "follow_up";
export type OutreachStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "sent"
  | "failed"
  | "replied"
  | "completed"
  | "cancelled";

export interface Campaign {
  id: string;
  name: string;
  productName: string;
  icp: string;
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
}

export interface Company {
  id: string;
  campaignId: string;
  name: string;
  website: string;
  geography: string | null;
  employeeCountMin: number | null;
  employeeCountMax: number | null;
  fitScore: number | null;
  fitRationale: string | null;
  sourceUrls: string[];
  approvalStatus: ApprovalStatus;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  companyId: string;
  fullName: string;
  jobTitle: string | null;
  rolePriority: number | null;
  profileUrl: string | null;
  email: string | null;
  emailStatus: EmailStatus;
  sourceUrls: string[];
  approvalStatus: ApprovalStatus;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Outreach {
  id: string;
  campaignId: string;
  companyId: string;
  contactId: string;
  kind: OutreachKind;
  sequenceNumber: number;
  subject: string;
  body: string;
  reason: string;
  status: OutreachStatus;
  approvedAt: string | null;
  sentAt: string | null;
  providerDraftId: string | null;
  providerMessageId: string | null;
  createdAt: string;
  updatedAt: string;
}
