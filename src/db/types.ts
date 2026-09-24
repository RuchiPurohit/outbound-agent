export type CampaignStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "COMPLETED";
export type ReviewStatus = "DISCOVERED" | "APPROVED" | "REJECTED";
export type ChatFeatureStatus = "PRESENT" | "NO_PUBLIC_EVIDENCE" | "UNKNOWN";
export type ChatImplementation = "HOMEGROWN" | "VENDOR" | "EXTERNAL" | "NONE_FOUND" | "UNKNOWN";
export interface CompanyScoreBreakdown {
  workflowFit: number;
  chatImplementation: number;
  timingSignal: number;
  teamFit: number;
  stackFit: number;
  liveProduct: number;
}
export type EmailStatus = "UNKNOWN" | "PUBLICLY_LISTED" | "VERIFIED" | "EMAIL_NOT_FOUND";
export type EmailGuessConfidence = "PATTERN_SUPPORTED" | "COMMON_PATTERN" | "AMBIGUOUS";
export type EmailGuessPattern = "firstname" | "firstname.lastname" | "firstnamelastname"
  | "firstinitiallastname" | "firstname_lastname";
export type OutreachStatus = "DRAFT" | "APPROVED" | "READY_TO_SEND" | "SENT" | "REPLIED" | "REJECTED";
export type WorkflowRunKind = "COMPANY_DISCOVERY" | "CONTACT_DISCOVERY" | "EMAIL_DISCOVERY"
  | "PROSPECT_RESEARCH" | "EMAIL_GENERATION" | "DRAFT_REWRITE";
export type WorkflowRunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

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
  locationSourceUrl: string | null;
  employeeCount: number | null;
  employeeCountRange: string | null;
  employeeCountSourceUrl: string | null;
  engineeringHeadcount: number | null;
  engineeringHeadcountSourceUrl: string | null;
  score: number | null;
  scoreBreakdown: CompanyScoreBreakdown | null;
  reason: string | null;
  salesThesis: string | null;
  chatFeatureStatus: ChatFeatureStatus;
  chatFeatureSourceUrl: string | null;
  chatImplementation: ChatImplementation;
  chatVendorName: string | null;
  chatImplementationSourceUrl: string | null;
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
  guessedEmail: string | null;
  guessedEmailPattern: EmailGuessPattern | null;
  guessedEmailConfidence: EmailGuessConfidence | null;
  guessedEmailBasis: string | null;
  guessedEmailSourceUrl: string | null;
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
  researchId: number | null;
  reviewedAt: string | null;
  approvedRecipient: string | null;
  approvedSubject: string | null;
  approvedBody: string | null;
}

export type DeliveryStatus = "PREPARING" | "SENDING" | "SENT" | "FAILED" | "UNCERTAIN";

export interface EmailDelivery {
  id: string;
  outreachId: number | null;
  kind: "OUTREACH" | "TEST";
  fromEmail: string;
  toEmail: string;
  subject: string;
  body: string;
  status: DeliveryStatus;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface ProspectResearch {
  contactId: number;
  status: "READY" | "NO_SIGNAL";
  strongestResearchId: number | null;
  painHypothesis: string | null;
  relevance: string | null;
  notes: string | null;
  researchedAt: string;
}

export interface WorkflowRun {
  id: number;
  campaignId: number;
  kind: WorkflowRunKind;
  status: WorkflowRunStatus;
  details: string | null;
  output: string;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}
