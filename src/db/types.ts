export type CampaignStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED";
export type ReviewStatus = "DISCOVERED" | "APPROVED" | "REJECTED";
export type EmailStatus = "UNKNOWN" | "VERIFIED" | "EMAIL_NOT_FOUND";
export type OutreachStatus = "DRAFT" | "APPROVED" | "READY_TO_SEND" | "SENT" | "REPLIED";

export interface Campaign {
  id: number;
  name: string;
  segment: string;
  createdAt: string;
  status: CampaignStatus;
}

export interface Company {
  id: number;
  campaignId: number;
  name: string;
  domain: string;
  location: string | null;
  employeeCount: number | null;
  score: number | null;
  reason: string | null;
  status: ReviewStatus;
  createdAt: string;
}

export interface Contact {
  id: number;
  companyId: number;
  name: string;
  title: string | null;
  roleCategory: string | null;
  roleScore: number | null;
  linkedinUrl: string | null;
  email: string | null;
  emailStatus: EmailStatus;
  status: ReviewStatus;
}

export interface ResearchRecord {
  id: number;
  companyId: number;
  contactId: number | null;
  signal: string;
  sourceUrl: string;
  notes: string | null;
}

export interface Outreach {
  id: number;
  contactId: number;
  subject: string;
  body: string;
  status: OutreachStatus;
  sentAt: string | null;
  gmailThreadId: string | null;
}
